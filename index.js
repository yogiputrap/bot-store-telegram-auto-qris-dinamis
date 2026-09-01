process.env.NTBA_FIX_350 = '1';
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
const https = require('https');
const axios = require('axios');
const AdmZip = require('adm-zip');
const QRCode = require('qrcode');

const config = require('./config.js');
const {
  dbDir,
  backupDir,
  dbPath,
  dbRun,
  dbGet,
  dbAll,
  dbTransaction,
  initDatabase
} = require('./database.js');
const PaymentService = require('./payment.js');
const OtpService = require('./otp.js');
const CodeGatraService = require('./codegatra.js');

let createCanvas = null;
try {
  const canvasPkg = require('canvas');
  createCanvas = canvasPkg.createCanvas;
} catch (e) {
  // Canvas unavailable or not compiled
}

const bot = new TelegramBot(config.BOT_TOKEN, { polling: true });
const userStates = {};

// GLOBAL ERROR BOUNDARY TO PREVENT PROCESS CRASH
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION]:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]:', err);
});

const formatRupiah = (num) => {
  const val = Number(num);
  const cleanVal = isNaN(val) ? 0 : val;
  return `${config.CURRENCY || 'Rp'} ${new Intl.NumberFormat('id-ID').format(cleanVal)}`;
};

const getCurrentTimeString = () => new Date().toLocaleTimeString('en-US', { hour12: true });

const getFormattedDate = () => {
  const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const now = new Date();
  return `${days[now.getDay()]}, ${String(now.getDate()).padStart(2, '0')} ${months[now.getMonth()]} ${now.getFullYear()} pukul ${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')}.${String(now.getSeconds()).padStart(2, '0')}`;
};

const getShortTimeString = () => {
  const now = new Date();
  return `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()} • ${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')} WIB`;
};

const formatExpiryWib = (expDate, expMinutes = 10) => {
  const dateObj = expDate instanceof Date ? expDate : (expDate ? new Date(expDate) : new Date(Date.now() + (expMinutes * 60 * 1000)));
  return dateObj.toLocaleTimeString('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).replace(':', '.');
};

function isAdmin(userOrFromId) {
  if (!userOrFromId) return false;
  if (typeof userOrFromId === 'object') {
    if (userOrFromId.role === 'admin' || userOrFromId.role === 'owner') return true;
    const tid = Number(userOrFromId.telegram_id || userOrFromId.id);
    if (tid && (tid === Number(config.OWNER_ID) || (config.ADMIN_IDS && config.ADMIN_IDS.map(Number).includes(tid)))) return true;
  } else {
    const tid = Number(userOrFromId);
    if (tid && (tid === Number(config.OWNER_ID) || (config.ADMIN_IDS && config.ADMIN_IDS.map(Number).includes(tid)))) return true;
  }
  return false;
}

// SANITIZE INLINE & REPLY KEYBOARDS
function sanitizeReplyMarkup(replyMarkup) {
  if (!replyMarkup) return undefined;
  const cleanMarkup = JSON.parse(JSON.stringify(replyMarkup));

  if (cleanMarkup.inline_keyboard) {
    cleanMarkup.inline_keyboard = cleanMarkup.inline_keyboard.map(row =>
      row.map(btn => {
        const cleanBtn = { text: btn.text };
        if (btn.callback_data !== undefined) cleanBtn.callback_data = btn.callback_data;
        if (btn.url !== undefined) cleanBtn.url = btn.url;
        if (btn.web_app !== undefined) cleanBtn.web_app = btn.web_app;
        return cleanBtn;
      })
    );
  }

  if (cleanMarkup.keyboard) {
    cleanMarkup.keyboard = cleanMarkup.keyboard.map(row =>
      row.map(btn => ({ text: btn.text }))
    );
  }

  return cleanMarkup;
}

// SMART EDIT MESSAGE HELPER
async function editOrSendMessage(chatId, messageId, captionText, replyMarkup) {
  const safeMarkup = sanitizeReplyMarkup(replyMarkup);

  if (messageId) {
    try {
      await bot.editMessageCaption(captionText, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML',
        reply_markup: safeMarkup
      });
      return;
    } catch (e) {
      try {
        await bot.editMessageText(captionText, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          reply_markup: safeMarkup
        });
        return;
      } catch (err) {}
    }
  }

  if (config.BANNER_URL) {
    try {
      let photoSource = config.BANNER_URL;
      if (photoSource.startsWith('http') || fs.existsSync(photoSource)) {
        await bot.sendPhoto(chatId, photoSource, {
          caption: captionText,
          parse_mode: 'HTML',
          reply_markup: safeMarkup
        });
        return;
      }
    } catch (photoErr) {
      // Fallback to text
    }
  }

  await bot.sendMessage(chatId, captionText, {
    parse_mode: 'HTML',
    reply_markup: safeMarkup
  });
}

// ROBUST RESOLVE QRIS BUFFER HELPER (BUFFER, QR_STRING, BASE64, URL, OR DYNAMIC EMVCO)
async function resolveQrBuffer(paymentObj) {
  if (!paymentObj) return null;

  // 1. Direct Buffer passed
  if (Buffer.isBuffer(paymentObj)) return paymentObj;

  // 2. Buffer inside object
  if (paymentObj.qrBuffer && Buffer.isBuffer(paymentObj.qrBuffer)) return paymentObj.qrBuffer;
  if (paymentObj.qr_buffer && Buffer.isBuffer(paymentObj.qr_buffer)) return paymentObj.qr_buffer;

  // 3. String candidates from object or direct string
  const qrString = paymentObj.qrString || paymentObj.qr_string || paymentObj.raw_qr || paymentObj.qr_code || paymentObj.qris_data || paymentObj.qris || paymentObj.payload || (typeof paymentObj === 'string' && paymentObj.length > 10 && !paymentObj.startsWith('http') ? paymentObj : null);
  let qrImage = paymentObj.qr_image_url || paymentObj.qrImage || paymentObj.qr_image || paymentObj.qr_url || paymentObj.qr_link || paymentObj.image_url || paymentObj.image || (typeof paymentObj === 'string' && (paymentObj.startsWith('http') || paymentObj.startsWith('data:image')) ? paymentObj : null);

  // 4. Render from qrString if present
  if (qrString && typeof qrString === 'string' && qrString.length > 5 && !qrString.startsWith('http')) {
    try {
      const buf = await QRCode.toBuffer(qrString, {
        type: 'png',
        width: 600,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' }
      });
      if (buf && buf.length > 0) return buf;
    } catch (e) {
      console.error('[QRCODE STRING RENDER ERROR]:', e.message);
    }
  }

  // 5. Handle base64 Data URL or raw base64 string in qrImage
  if (qrImage && typeof qrImage === 'string') {
    if (qrImage.startsWith('data:image')) {
      try {
        const base64Data = qrImage.replace(/^data:image\/\w+;base64,/, '');
        const buf = Buffer.from(base64Data, 'base64');
        if (buf && buf.length > 0) return buf;
      } catch (e) {}
    } else if (/^[A-Za-z0-9+/=]{100,}$/.test(qrImage.trim())) {
      try {
        const buf = Buffer.from(qrImage.trim(), 'base64');
        if (buf && buf.length > 0) return buf;
      } catch (e) {}
    }

    // 6. Handle HTTP/HTTPS URL in qrImage - Download directly into Buffer
    if (qrImage.startsWith('http://') || qrImage.startsWith('https://')) {
      try {
        const dlRes = await axios.get(qrImage, {
          responseType: 'arraybuffer',
          timeout: 15000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'image/*,*/*'
          }
        });
        if (dlRes.data && dlRes.data.byteLength > 0) {
          return Buffer.from(dlRes.data);
        }
      } catch (e) {
        console.error('[AXIOS DOWNLOAD QR IMAGE ERROR]:', e.message);
      }
    }

    // 7. Handle raw EMVCo string in qrImage
    if (qrImage.length > 20 && !qrImage.startsWith('http')) {
      try {
        const buf = await QRCode.toBuffer(qrImage, {
          type: 'png',
          width: 600,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' }
        });
        if (buf && buf.length > 0) return buf;
      } catch (e) {}
    }
  }

  // 8. Fallback: Generate dynamic QRIS from amount/details
  try {
    const totalAmt = paymentObj.totalAmount || paymentObj.total_amount || paymentObj.amount || 10000;
    const dynamicQr = CodeGatraService.generateDynamicQris(config.QRIS_STRING, totalAmt);
    const buf = await QRCode.toBuffer(dynamicQr, {
      type: 'png',
      width: 600,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });
    if (buf && buf.length > 0) return buf;
  } catch (e) {
    console.error('[RESOLVE QR BUFFER FALLBACK ERROR]:', e.message);
  }

  return null;
}

// ROBUST SEND QRIS PHOTO HELPER (BUFFER-FIRST, MULTI-TIER FALLBACK)
async function sendQrPhotoOrMessage(chatId, paymentObj, captionText, replyMarkup = null) {
  const safeMarkup = replyMarkup ? sanitizeReplyMarkup(replyMarkup) : undefined;
  try {
    const photoBuffer = await resolveQrBuffer(paymentObj);

    if (photoBuffer && Buffer.isBuffer(photoBuffer)) {
      // Telegram photo caption limit is 1024 characters
      let caption = captionText;
      let extraText = null;
      if (caption.length > 1000) {
        caption = captionText.slice(0, 1000) + '...';
        extraText = captionText;
      }

      // Attempt 1: Send Photo with HTML Caption
      try {
        const photoOptions = { caption: caption, parse_mode: 'HTML' };
        if (safeMarkup) photoOptions.reply_markup = safeMarkup;

        await bot.sendPhoto(
          chatId,
          photoBuffer,
          photoOptions,
          { filename: `qris_${Date.now()}.png`, contentType: 'image/png' }
        );
        if (extraText) {
          await bot.sendMessage(chatId, extraText, { parse_mode: 'HTML', reply_markup: safeMarkup });
        }
        return;
      } catch (sendPhotoErr) {
        console.warn('[SEND PHOTO RETRY 1]: HTML caption failed, retrying plain text...', sendPhotoErr.message);

        // Attempt 2: Strip HTML tags and send plain caption
        const plainCaption = caption.replace(/<[^>]*>?/gm, '');
        try {
          const photoOptions = { caption: plainCaption };
          if (safeMarkup) photoOptions.reply_markup = safeMarkup;

          await bot.sendPhoto(
            chatId,
            photoBuffer,
            photoOptions,
            { filename: `qris_${Date.now()}.png`, contentType: 'image/png' }
          );
          if (extraText) {
            await bot.sendMessage(chatId, extraText, { parse_mode: 'HTML', reply_markup: safeMarkup });
          }
          return;
        } catch (plainErr) {
          console.warn('[SEND PHOTO RETRY 2]: Retrying photo without caption...', plainErr.message);

          // Attempt 3: Send photo alone, then send caption text
          try {
            await bot.sendPhoto(
              chatId,
              photoBuffer,
              {},
              { filename: `qris_${Date.now()}.png`, contentType: 'image/png' }
            );
            await bot.sendMessage(chatId, captionText, { parse_mode: 'HTML', reply_markup: safeMarkup });
            return;
          } catch (photoOnlyErr) {
            console.error('[SEND PHOTO RETRY 3 FAILED]:', photoOnlyErr.message);
          }
        }
      }
    }
  } catch (err) {
    console.error('[SEND QR PHOTO OVERALL ERROR]:', err.message);
  }

  // Fallback to text message if photo could not be delivered
  await bot.sendMessage(chatId, captionText, { parse_mode: 'HTML', reply_markup: safeMarkup });
}

// RATE-LIMITED MESSAGE SENDER FOR SAFE BROADCAST (35ms delay)
async function sendRateLimitedBroadcast(recipients, sendCallback) {
  let successCount = 0;
  for (const item of recipients) {
    try {
      await sendCallback(item);
      successCount++;
    } catch (err) {
      // User blocked bot or deleted account
    }
    await new Promise(resolve => setTimeout(resolve, 35));
  }
  return successCount;
}

// DYNAMIC RESTOCK CARD GENERATOR
function drawRoundRect(ctx, x, y, w, h, r, fill = false, stroke = true) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

function drawInfoBox(ctx, x, y, w, h, label, val, valColor) {
  ctx.fillStyle = 'rgba(13, 38, 33, 0.65)';
  ctx.strokeStyle = 'rgba(0, 242, 173, 0.25)';
  ctx.lineWidth = 1.5;
  drawRoundRect(ctx, x, y, w, h, 16, true, true);

  ctx.fillStyle = '#7a9e96';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(label, x + 25, y + 30);

  ctx.fillStyle = valColor;
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText(val, x + 25, y + 58);
}

async function generateRestockCard({ productName, addedCount, totalStock, addedBy, dateStr }) {
  if (!createCanvas) return null;
  try {
    const width = 1000;
    const height = 700;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const bgGrad = ctx.createLinearGradient(0, 0, width, height);
    bgGrad.addColorStop(0, '#051310');
    bgGrad.addColorStop(0.5, '#0b231f');
    bgGrad.addColorStop(1, '#061613');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(0, 242, 173, 0.05)';
    ctx.lineWidth = 2;
    for (let i = -200; i < width + 200; i += 40) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + 300, height);
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    drawRoundRect(ctx, width - 260, 30, 220, 38, 19, true, true);

    ctx.fillStyle = '#8ea8a2';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`🕒 ${dateStr}`, width - 150, 54);

    ctx.fillStyle = 'rgba(0, 242, 173, 0.08)';
    ctx.strokeStyle = '#00f2ad';
    ctx.lineWidth = 2;
    drawRoundRect(ctx, width / 2 - 45, 75, 90, 90, 22, true, true);

    ctx.fillStyle = '#00f2ad';
    ctx.font = '40px sans-serif';
    ctx.fillText('📦', width / 2, 133);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 32px sans-serif';
    ctx.fillText(`Restock ${productName.toUpperCase()}`, width / 2, 218);

    ctx.fillStyle = '#00f2ad';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('❖  RESTOCK AKUN  ❖', width / 2, 248);

    drawInfoBox(ctx, 80, 280, 410, 85, 'MASUK', `+${addedCount} pcs`, '#00f2ad');
    drawInfoBox(ctx, 510, 280, 410, 85, 'STOK', `${totalStock} pcs`, '#ffcc00');
    drawInfoBox(ctx, 80, 385, 410, 85, 'DITAMBAH', `@${addedBy.replace('@', '')}`, '#4ba3ff');
    drawInfoBox(ctx, 510, 385, 410, 85, 'WAKTU', dateStr, '#ffffff');

    const btnGrad = ctx.createLinearGradient(300, 510, 700, 510);
    btnGrad.addColorStop(0, '#00f2ad');
    btnGrad.addColorStop(1, '#00aaff');
    ctx.fillStyle = btnGrad;
    drawRoundRect(ctx, 300, 500, 400, 68, 34, true, false);

    ctx.fillStyle = '#05110e';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText('🛒 ORDER SEKARANG!', width / 2, 542);

    ctx.fillStyle = '#5c7873';
    ctx.font = '14px sans-serif';
    ctx.fillText(`✦  ${config.STORE_NAME || 'JEPZ STORE'}  •  Proses Otomatis 24 Jam  ✦`, width / 2, 640);

    return canvas.toBuffer('image/png');
  } catch (e) {
    return null;
  }
}

async function sendRestockNotificationCard({ productId, addedCount, addedBy }) {
  try {
    const product = await dbGet('SELECT * FROM products WHERE id = ?', [productId]);
    if (!product) return;

    const stock = await dbGet('SELECT COUNT(*) as count FROM product_stock WHERE product_id = ? AND status = \'available\'', [productId]);
    const totalStock = stock ? stock.count : 0;
    const dateStr = getShortTimeString();

    const imageBuffer = await generateRestockCard({
      productName: `${product.category} - ${product.name}`,
      addedCount: addedCount,
      totalStock: totalStock,
      addedBy: addedBy || 'Admin',
      dateStr: dateStr
    });

    const caption = `🚀 <b>RESTOCK PRODUK BARU!</b>\n\nProduk <b>${product.category} - ${product.name}</b> telah diperbarui stoknya.\n\n📦 <b>Masuk:</b> +${addedCount} pcs\n📊 <b>Total Stok:</b> ${totalStock} pcs\n\nYuk diorder sebelum kehabisan! 👇`;

    const inlineButtons = [
      [{ text: '🛒 Beli / Order Sekarang', url: `https://t.me/${config.STORE_USERNAME || 'bot'}?start=prod_${product.id}` }]
    ];

    if (config.CHANNEL_ID && config.CHANNEL_ID.startsWith('-100')) {
      try {
        if (imageBuffer) {
          await bot.sendPhoto(config.CHANNEL_ID, imageBuffer, {
            caption: caption,
            parse_mode: 'HTML',
            reply_markup: sanitizeReplyMarkup({ inline_keyboard: inlineButtons })
          });
        } else {
          await bot.sendMessage(config.CHANNEL_ID, caption, {
            parse_mode: 'HTML',
            reply_markup: sanitizeReplyMarkup({ inline_keyboard: inlineButtons })
          });
        }
      } catch (err) {
        console.error('[RESTOCK CHANNEL SEND ERROR]:', err.message);
      }
    }
  } catch (err) {
    console.error('[GENERATE RESTOCK CARD ERROR]:', err.message);
  }
}

// AUTO BACKUP SERVICE (Daily / Scheduled)
function startAutoBackupService() {
  const intervalHours = config.AUTO_BACKUP_HOURS || 24;
  setInterval(async () => {
    try {
      if (!fs.existsSync(dbPath)) return;
      const zip = new AdmZip();
      zip.addLocalFile(dbPath);

      const timeStamp = new Date().toISOString().replace(/[:.]/g, '-');
      const zipFileName = `backup_db_${timeStamp}.zip`;
      const zipFilePath = path.join(backupDir, zipFileName);

      zip.writeZip(zipFilePath);

      if (config.OWNER_ID) {
        await bot.sendDocument(config.OWNER_ID, zipFilePath, {
          caption: `💾 <b>AUTO BACKUP DATABASE (${intervalHours}H)</b>\n\n📅 Waktu: <code>${getFormattedDate()}</code>`,
          parse_mode: 'HTML'
        });
      }
    } catch (err) {
      console.error('[AUTO BACKUP SERVICE ERROR]:', err.message);
    }
  }, intervalHours * 60 * 60 * 1000);
}

// USER & ADMIN KEYBOARDS
async function getUserReplyKeyboard() {
  const categories = await dbAll('SELECT DISTINCT category FROM products WHERE status = \'active\'');
  const totalCount = categories.length;

  const keyboard = [
    [
      { text: '🛍️ Katalog' },
      { text: '📱 Order OTP' }
    ],
    [
      { text: '💳 Cek Saldo' },
      { text: '💰 Deposit' }
    ]
  ];

  let numberRow = [];
  for (let i = 1; i <= totalCount; i++) {
    numberRow.push({ text: `${i}` });
    if (numberRow.length === 5) {
      keyboard.push(numberRow);
      numberRow = [];
    }
  }
  if (numberRow.length > 0) keyboard.push(numberRow);

  keyboard.push([
    { text: '📜 Riwayat Transaksi' },
    { text: '🔍 Cari Produk' }
  ]);

  keyboard.push([
    { text: '🎟️ Klaim Voucher' },
    { text: '🛡️ Klaim Garansi' }
  ]);

  keyboard.push([
    { text: '🌐 BANTUAN' },
    { text: '🔥 Populer' }
  ]);

  return { reply_markup: { keyboard, resize_keyboard: true } };
}

const ADMIN_REPLY_KEYBOARD = {
  reply_markup: {
    keyboard: [
      [{ text: '🏷️ Kelola Produk' }, { text: '🎟️ Voucher' }],
      [{ text: '📦 Laporan Stok' }, { text: '💳 Saldo RumahOTP' }],
      [{ text: '🛒 Pesanan App' }, { text: '📱 Pesanan OTP' }],
      [{ text: '➕ Add Product' }, { text: '📥 Add Stock' }],
      [{ text: '➕ Deposit RumahOTP' }, { text: '📢 Broadcast' }],
      [{ text: '📊 Statistik & Export' }, { text: '⚙️ Status CodeGatra' }],
      [{ text: '🏠 Menu User' }]
    ],
    resize_keyboard: true
  }
};

async function checkChannelMember(userId) {
  if (!config.CHANNEL_ID || !config.CHANNEL_ID.startsWith('-100')) return true;
  try {
    const member = await bot.getChatMember(config.CHANNEL_ID, userId);
    return ['creator', 'administrator', 'member'].includes(member.status);
  } catch (err) {
    return true;
  }
}

function downloadTextFile(fileId) {
  return new Promise(async (resolve, reject) => {
    try {
      const fileLink = await bot.getFileLink(fileId);
      https.get(fileLink, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}

async function registerUser(from) {
  if (!from || !from.id) return null;
  const role = (Number(from.id) === Number(config.OWNER_ID) || (config.ADMIN_IDS && config.ADMIN_IDS.map(Number).includes(Number(from.id)))) ? 'owner' : 'user';

  try {
    await dbRun(
      `INSERT INTO users (telegram_id, username, first_name, role) 
       VALUES (?, ?, ?, ?) 
       ON CONFLICT(telegram_id) DO UPDATE SET 
         username = excluded.username, 
         first_name = excluded.first_name, 
         role = excluded.role`,
      [from.id, from.username || '', from.first_name || '', role]
    );
  } catch (err) {
    try {
      await dbRun(
        'UPDATE users SET username = ?, first_name = ?, role = ? WHERE telegram_id = ?',
        [from.username || '', from.first_name || '', role, from.id]
      );
    } catch (updateErr) {}
  }

  let user = await dbGet('SELECT * FROM users WHERE telegram_id = ?', [from.id]);
  return user;
}

// RENDER KATALOG UTAMA
async function renderCatalog(chatId, page = 1, messageId = null) {
  const query = `
    SELECT p.category,
           MIN(p.price) as min_price,
           MAX(p.price) as max_price,
           COUNT(DISTINCT p.id) as var_count,
           COUNT(s.id) as total_stock
    FROM products p
    LEFT JOIN product_stock s ON p.id = s.product_id AND s.status = 'available'
    WHERE p.status = 'active'
    GROUP BY p.category
    ORDER BY CASE WHEN COUNT(s.id) > 0 THEN 0 ELSE 1 END, p.category ASC
  `;

  const categories = await dbAll(query);
  const totalCategories = categories.length;
  const itemsPerPage = config.ITEMS_PER_PAGE || 6;
  const totalPages = Math.ceil(totalCategories / itemsPerPage) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));

  const startIndex = (currentPage - 1) * itemsPerPage;
  const pageCategories = categories.slice(startIndex, startIndex + itemsPerPage);

  let caption = `🛍️ <b>KATALOG PRODUK ${config.STORE_NAME || 'MOAKUN STORE'}</b>\n`;
  caption += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  caption += `<i>Pilih kategori produk di bawah untuk melihat variasi & harga:</i>\n\n`;

  let idx = startIndex + 1;
  pageCategories.forEach((c) => {
    const priceDisplay = c.min_price === c.max_price
      ? formatRupiah(c.min_price)
      : `${formatRupiah(c.min_price)} - ${formatRupiah(c.max_price)}`;

    caption += `<b>[${idx}] ${c.category.toUpperCase()}</b>\n`;
    caption += `   └ 💰 ${priceDisplay} (${c.var_count} Pilihan)\n\n`;
    idx++;
  });

  caption += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  caption += `👉 <b>Cara Beli:</b> Ketik angka <b>(1-${totalCategories})</b> di keyboard atau klik tombol di bawah.\n`;
  caption += `📄 <i>Halaman ${currentPage} dari ${totalPages}</i>`;

  const inlineButtons = [];

  // Direct category buttons for easy 1-tap UX
  pageCategories.forEach((c, i) => {
    const num = startIndex + i + 1;
    inlineButtons.push([{
      text: `[${num}] ${c.category.toUpperCase()}`,
      callback_data: `sel_cat_idx_${num}`
    }]);
  });

  const navRow = [];
  if (currentPage > 1) navRow.push({ text: '◀️ Sebelumnya', callback_data: `cat_page_${currentPage - 1}` });
  if (currentPage < totalPages) navRow.push({ text: 'Berikutnya ▶️', callback_data: `cat_page_${currentPage + 1}` });
  if (navRow.length > 0) inlineButtons.push(navRow);

  inlineButtons.push([
    { text: '🔍 Cari Produk', callback_data: 'search_prompt' },
    { text: '⚡ Flash Sale', callback_data: 'show_flash_sale' }
  ]);

  await editOrSendMessage(chatId, messageId, caption, { inline_keyboard: inlineButtons });
}

// DETAIL CATEGORY & VARIANTS
async function showCategoryByIndex(chatId, index, messageId = null) {
  const categories = await dbAll(`
    SELECT category FROM products WHERE status = 'active' GROUP BY category
    ORDER BY (SELECT COUNT(*) FROM product_stock s JOIN products p2 ON s.product_id = p2.id WHERE p2.category = products.category AND s.status = 'available') DESC, category ASC
  `);

  if (index < 1 || index > categories.length) {
    return bot.sendMessage(chatId, `❌ Nomor produk tidak valid. Silakan pilih nomor (1-${categories.length}).`);
  }

  const categoryName = categories[index - 1].category;

  const variants = await dbAll(`
    SELECT p.*, COUNT(s.id) as stock_count
    FROM products p
    LEFT JOIN product_stock s ON p.id = s.product_id AND s.status = 'available'
    WHERE p.category = ? AND p.status = 'active'
    GROUP BY p.id
    ORDER BY p.price ASC
  `, [categoryName]);

  const soldRow = await dbGet(`
    SELECT COUNT(*) as sold_count
    FROM product_stock s
    JOIN products p ON s.product_id = p.id
    WHERE p.category = ? AND s.status = 'sold'
  `, [categoryName]);

  const soldCount = soldRow ? soldRow.sold_count : 0;
  const firstDesc = variants.length > 0 ? (variants[0].description || 'Full akses garansi 100%') : '-';

  let caption = `🛍️ <b>DETAIL PRODUK: ${categoryName.toUpperCase()}</b>\n`;
  caption += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  caption += `📝 <b>Info:</b> <i>${firstDesc}</i>\n`;
  caption += `📊 <b>Total Terjual:</b> <b>${soldCount} Akun</b>\n`;
  caption += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  caption += `👇 <b>Silakan pilih variasi akun yang ingin dibeli:</b>\n\n`;

  const inlineButtons = [];

  variants.forEach((v, i) => {
    const isAvailable = v.stock_count > 0;
    const stockBadge = isAvailable ? `🟢 Ready: <b>${v.stock_count} Akun</b>` : `🔴 <i>Stok Habis</i>`;

    caption += `<b>${i + 1}. ${v.name}</b>\n`;
    caption += `   ├ 💰 Harga: <b>${formatRupiah(v.price)}</b>\n`;
    caption += `   └ 📦 Stok: ${stockBadge}\n\n`;

    const label = isAvailable
      ? `🛒 ${v.name} • ${formatRupiah(v.price)} (${v.stock_count})`
      : `🔴 ${v.name} • [HABIS]`;

    inlineButtons.push([{
      text: label,
      callback_data: isAvailable ? `prod_detail_${v.id}` : 'noop'
    }]);
  });

  inlineButtons.push([{ text: '🔙 Kembali ke Katalog', callback_data: 'cat_page_1' }]);

  await editOrSendMessage(chatId, messageId, caption, { inline_keyboard: inlineButtons });
}

// DASHBOARD START (USER)
async function sendStartDashboard(chatId, user) {
  const userSpent = await dbGet('SELECT SUM(amount) as s FROM orders WHERE user_id = ? AND status = \'completed\'', [user.id]);

  let text = `Halo <b>${user.first_name || 'Kak'}</b> | Open! 👏\n`;
  text += `Selamat datang di <b>${config.STORE_NAME || 'Moakun Store'}</b>\n`;
  text += `${getFormattedDate()}\n\n`;

  text += `User Info :\n`;
  text += `└ ID : <code>${user.telegram_id}</code>\n`;
  text += `└ Username : @${user.username || 'User'}\n`;
  text += `└ Transaksi Kamu : ${formatRupiah(userSpent ? userSpent.s : 0)}\n`;
  text += `└ Saldo Anda : <b>${formatRupiah(user.balance)}</b>\n\n`;

  text += `⚡ <b>Fitur Unggulan:</b>\n`;
  text += `• <b>Auto QRIS 24 Jam</b> (Deposit & Order instan otomatis)\n`;
  text += `• <b>Virtual SMS OTP</b> (Otomatis masuk & refund jika timeout)\n`;
  text += `• <b>Klaim Voucher Diskon</b> & <b>Riwayat Akun Tersimpan</b>\n\n`;

  text += `Shortcuts:\n`;
  text += `/katalog – Lihat daftar produk\n`;
  text += `/saldo – Cek saldo akun\n`;
  text += `/deposit – Isi saldo via QRIS otomatis\n`;
  text += `/riwayat – Lihat detail akun yang pernah dibeli\n`;
  text += `/cari – Cari produk spesifik\n`;

  const keyboardMarkup = await getUserReplyKeyboard();
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...keyboardMarkup });
}

// DASHBOARD ADMIN (OWNER / ADMIN)
async function sendAdminDashboard(chatId, user) {
  const totalSold = await dbGet('SELECT COUNT(*) as c FROM orders WHERE status = \'completed\'');
  const totalRev = await dbGet('SELECT SUM(amount) as s FROM orders WHERE status = \'completed\'');
  const totalUsers = await dbGet('SELECT COUNT(*) as c FROM users');
  const totalStock = await dbGet('SELECT COUNT(*) as c FROM product_stock WHERE status = \'available\'');

  // Top 3 Best Selling Products
  const topProducts = await dbAll(`
    SELECT p.category, p.name, SUM(o.qty) as sold_qty, SUM(o.amount) as total_sales
    FROM orders o
    JOIN products p ON o.product_id = p.id
    WHERE o.status = 'completed'
    GROUP BY p.id
    ORDER BY sold_qty DESC, total_sales DESC
    LIMIT 3
  `);

  // Top 3 Loyal Users / Spenders
  const topUsers = await dbAll(`
    SELECT u.username, u.first_name, u.telegram_id, COUNT(o.id) as order_count, SUM(o.amount) as total_spent
    FROM orders o
    JOIN users u ON o.user_id = u.id
    WHERE o.status = 'completed'
    GROUP BY u.id
    ORDER BY total_spent DESC, order_count DESC
    LIMIT 3
  `);

  let text = `👑 <b>ADMIN PANEL ${config.STORE_NAME || 'MOAKUN STORE'}</b>\n`;
  text += `${getFormattedDate()}\n\n`;

  text += `📊 <b>RINGKASAN STATISTIK TOKO:</b>\n`;
  text += `├ 👥 Total Pengguna: <b>${totalUsers ? totalUsers.c : 0} User</b>\n`;
  text += `├ 🛒 Total Order Selesai: <b>${totalSold ? totalSold.c : 0} Pesanan</b>\n`;
  text += `├ 💰 Total Omzet: <b>${formatRupiah(totalRev ? totalRev.s : 0)}</b>\n`;
  text += `└ 📦 Total Stok Ready: <b>${totalStock ? totalStock.c : 0} Account</b>\n\n`;

  text += `🏆 <b>TOP 3 PRODUK TERLARIS:</b>\n`;
  if (!topProducts || topProducts.length === 0) {
    text += `<i>Belum ada data penjualan selesai.</i>\n\n`;
  } else {
    const medals = ['🥇', '🥈', '🥉'];
    topProducts.forEach((p, idx) => {
      text += `${medals[idx] || '•'} <b>${p.category} - ${p.name}</b>\n`;
      text += `   └ Terjual: <b>${p.sold_qty || 1} pcs</b> | Omzet: <b>${formatRupiah(p.total_sales)}</b>\n`;
    });
    text += `\n`;
  }

  text += `💎 <b>TOP 3 USER PALING LOYAL (TOP SPENDER):</b>\n`;
  if (!topUsers || topUsers.length === 0) {
    text += `<i>Belum ada data transaksi pembeli.</i>\n\n`;
  } else {
    const crowns = ['🥇', '🥈', '🥉'];
    topUsers.forEach((u, idx) => {
      const name = u.username ? `@${u.username}` : (u.first_name || `ID ${u.telegram_id}`);
      text += `${crowns[idx] || '•'} <b>${name}</b> (<code>${u.telegram_id}</code>)\n`;
      text += `   └ Total Belanja: <b>${formatRupiah(u.total_spent)}</b> (${u.order_count}x order)\n`;
    });
    text += `\n`;
  }

  text += `Silakan pilih menu kelola toko di bawah:`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    ...ADMIN_REPLY_KEYBOARD
  });
}

// SEARCH PRODUCTS
async function searchProducts(chatId, keyword, messageId = null) {
  const query = `
    SELECT p.*, COUNT(s.id) as stock_count
    FROM products p
    LEFT JOIN product_stock s ON p.id = s.product_id AND s.status = 'available'
    WHERE (p.name LIKE ? OR p.category LIKE ? OR p.description LIKE ?) AND p.status = 'active'
    GROUP BY p.id
    ORDER BY stock_count DESC, p.price ASC
    LIMIT 10
  `;
  const term = `%${keyword}%`;
  const results = await dbAll(query, [term, term, term]);

  if (results.length === 0) {
    let msg = `🔍 Hasil pencarian untuk: <b>"${keyword}"</b>\n\n❌ Tidak ditemukan produk yang cocok.\nCoba cari kata kunci lain seperti <i>netflix, spotify, canva, capcut</i>.`;
    const buttons = [[{ text: '🔙 Kembali ke Katalog', callback_data: 'cat_page_1' }]];
    return editOrSendMessage(chatId, messageId, msg, { inline_keyboard: buttons });
  }

  let text = `🔍 <b>HASIL PENCARIAN ("${keyword}"):</b>\n\nDitemukan <b>${results.length}</b> produk:\n\n`;
  const buttons = [];

  results.forEach((p, idx) => {
    const stockBadge = p.stock_count > 0 ? `(Stok: ${p.stock_count})` : `(🔴 Habis)`;
    text += `<b>${idx + 1}. ${p.category} - ${p.name}</b>\n`;
    text += `   💰 Harga: <b>${formatRupiah(p.price)}</b> | ${stockBadge}\n\n`;

    buttons.push([{
      text: `${p.category} - ${p.name} (${formatRupiah(p.price)})`,
      callback_data: `prod_detail_${p.id}`
    }]);
  });

  buttons.push([{ text: '🔙 Kembali ke Katalog', callback_data: 'cat_page_1' }]);
  await editOrSendMessage(chatId, messageId, text, { inline_keyboard: buttons });
}

// USER ORDER HISTORY
async function showUserHistory(chatId, user, messageId = null) {
  const productOrders = await dbAll(`
    SELECT o.*, p.name as prod_name, p.category, s.email, s.password, s.extra_data
    FROM orders o
    JOIN products p ON o.product_id = p.id
    LEFT JOIN product_stock s ON o.stock_id = s.id
    WHERE o.user_id = ? AND o.status = 'completed'
    ORDER BY o.id DESC
    LIMIT 5
  `, [user.id]);

  const otpOrders = await dbAll(`
    SELECT * FROM otp_orders
    WHERE user_id = ? AND status = 'completed'
    ORDER BY id DESC
    LIMIT 5
  `, [user.id]);

  let text = `📜 <b>RIWAYAT TRANSAKSI KAMU</b>\n\n`;

  if (productOrders.length === 0 && otpOrders.length === 0) {
    text += `Kamu belum memiliki riwayat transaksi selesai.\nYuk mulai belanja di katalog!`;
    const buttons = [[{ text: '🛒 Buka Katalog', callback_data: 'cat_page_1' }]];
    return editOrSendMessage(chatId, messageId, text, { inline_keyboard: buttons });
  }

  if (productOrders.length > 0) {
    text += `📦 <b>5 PESANAN AKUN DIGITAL TERAKHIR:</b>\n\n`;
    productOrders.forEach((o, i) => {
      text += `<b>[${i + 1}] #${o.order_code}</b> • ${o.category} (${o.prod_name})\n`;
      text += `💰 Total: ${formatRupiah(o.amount)} (${o.qty || 1} pcs)\n`;
      if (o.email) {
        text += `📧 Email: <code>${o.email}</code>\n`;
        text += `🔑 Pass: <code>${o.password}</code>\n`;
      }
      if (o.extra_data) text += `ℹ️ Extra: <code>${o.extra_data}</code>\n`;
      text += `📅 ${o.completed_at || o.created_at}\n\n`;
    });
  }

  if (otpOrders.length > 0) {
    text += `📱 <b>5 PESANAN OTP TERAKHIR:</b>\n\n`;
    otpOrders.forEach((o, i) => {
      text += `<b>[${i + 1}] #${o.order_code}</b> • ${o.service_name}\n`;
      text += `📞 No: <code>${o.phone_number}</code>\n`;
      text += `🔑 OTP: <code>${o.otp_code}</code>\n`;
      text += `📅 ${o.completed_at || o.created_at}\n\n`;
    });
  }

  const buttons = [
    [{ text: '🛡️ Klaim Garansi Akun', callback_data: 'warranty_prompt' }],
    [{ text: '🔙 Kembali ke Menu', callback_data: 'cat_page_1' }]
  ];

  await editOrSendMessage(chatId, messageId, text, { inline_keyboard: buttons });
}

// FLASH SALE DATA & HELPER
const FLASH_SALE_ITEMS = [
  { id: 1, name: 'Link Redem Gemini 3 Bulan', category: '⚡ FLASH SALE', price: 13000, origPrice: 25000, shortLabel: 'Gemini 3B (13K)' },
  { id: 2, name: 'Gemini Head Akun 3 Bulan', category: '⚡ FLASH SALE', price: 35000, origPrice: 45000, shortLabel: 'Gemini Head (35K)' },
  { id: 3, name: 'CapCut Pro 1 Bulan', category: '⚡ FLASH SALE', price: 25000, origPrice: 35000, shortLabel: 'CapCut Pro 1B (25K)' },
  { id: 4, name: 'Link Redem Gemini 18 Bulan', category: '⚡ FLASH SALE', price: 15000, origPrice: 25000, shortLabel: 'Gemini 18B (15K)' },
  { id: 5, name: 'Leonardo Kredit 8500', category: '⚡ FLASH SALE', price: 10000, origPrice: 15000, shortLabel: 'Leonardo 8.5K (10K)' },
  { id: 6, name: 'ChatGPT Plus 1 Bulan', category: '⚡ FLASH SALE', price: 45000, origPrice: 55000, shortLabel: 'ChatGPT+ 1B (45K)' },
  { id: 7, name: 'Spotify 1 Bulan', category: '⚡ FLASH SALE', price: 15000, origPrice: 25000, shortLabel: 'Spotify 1B (15K)' }
];

async function getOrCreateFlashSaleProduct(item) {
  let prod = await dbGet('SELECT * FROM products WHERE name = ? AND category = \'⚡ FLASH SALE\' AND status = \'active\' LIMIT 1', [
    item.name
  ]);

  if (!prod) {
    const res = await dbRun(
      'INSERT INTO products (category, name, price, description, status) VALUES (?, ?, ?, ?, \'active\')',
      ['⚡ FLASH SALE', item.name, item.price, `Promo Flash Sale ${item.name}. Full garansi 100%.`]
    );
    prod = await dbGet('SELECT * FROM products WHERE id = ?', [res.lastID]);
  }
  return prod;
}

// FLASH SALE SCREEN
async function showFlashSale(chatId, messageId = null) {
  let text = `┊ ⚡ <b>FLASH SALE</b> ⚡\n`;
  text += `┊\n`;
  text += `┊ 🔥 <b>LINK REDEM GEMINI 3 BULAN</b>\n`;
  text += `┊    Rp25.000 ➜ Rp13.000\n`;
  text += `┊\n`;
  text += `┊ 🔥 <b>GEMINI HEAD AKUN 3 BULAN</b>\n`;
  text += `┊    Rp45.000 ➜ Rp35.000\n`;
  text += `┊\n`;
  text += `┊ 🔥 <b>CAPCUT PRO 1 BULAN</b>\n`;
  text += `┊    Rp35.000 ➜ Rp25.000\n`;
  text += `┊\n`;
  text += `┊ 🔥 <b>LINK REDEM GEMINI 18 BULAN</b>\n`;
  text += `┊    Rp25.000 ➜ Rp15.000\n`;
  text += `┊\n`;
  text += `┊ 🔥 <b>LEONARDO KREDIT 8500</b>\n`;
  text += `┊    Rp15.000 ➜ Rp10.000\n`;
  text += `┊\n`;
  text += `┊ 🔥 <b>ChatGpt PLUS 1 BULAN</b>\n`;
  text += `┊    Rp55.000 ➜ Rp45.000\n`;
  text += `┊\n`;
  text += `┊ 🔥 <b>Spotify 1 Bulan</b>\n`;
  text += `┊    Rp25.000 ➜ Rp15.000\n`;
  text += `╰─────────────────✧\n\n`;
  text += `<i>⚠️ Stok terbatas! Klik produk di bawah untuk langsung beli:</i>`;

  const buttons = [
    [
      { text: '🔥 [1] Gemini 3B (13K)', callback_data: 'fs_buy_1' },
      { text: '🔥 [2] Gemini Head (35K)', callback_data: 'fs_buy_2' }
    ],
    [
      { text: '🔥 [3] CapCut Pro 1B (25K)', callback_data: 'fs_buy_3' },
      { text: '🔥 [4] Gemini 18B (15K)', callback_data: 'fs_buy_4' }
    ],
    [
      { text: '🔥 [5] Leonardo 8.5K (10K)', callback_data: 'fs_buy_5' },
      { text: '🔥 [6] ChatGPT+ 1B (45K)', callback_data: 'fs_buy_6' }
    ],
    [
      { text: '🔥 [7] Spotify 1B (15K)', callback_data: 'fs_buy_7' }
    ],
    [
      { text: '🔙 Kembali ke Katalog', callback_data: 'cat_page_1' }
    ]
  ];

  await editOrSendMessage(chatId, messageId, text, { inline_keyboard: buttons });
}

// PAYMENT CHOICE & CHECKOUT SCREEN
async function sendPaymentChoice(chatId, messageId, user, product, qty = 1, appliedVoucher = null) {
  const stock = await dbGet('SELECT COUNT(*) as count FROM product_stock WHERE product_id = ? AND status = \'available\'', [product.id]);

  if (stock.count < qty) {
    return bot.sendMessage(chatId, `❌ Stok tidak mencukupi! Stok <b>${product.name}</b> saat ini hanya tersedia <b>${stock.count} Account</b>.`, { parse_mode: 'HTML' });
  }

  const grossTotal = product.price * qty;
  let discountAmount = 0;
  let voucherCode = '';

  if (appliedVoucher) {
    discountAmount = appliedVoucher.discountAmount || 0;
    voucherCode = appliedVoucher.code || '';
  }

  const finalTotal = Math.max(0, grossTotal - discountAmount);

  let text = `🛒 <b>KONFIRMASI PEMBELIAN</b>\n\n`;
  text += `Produk: <b>${product.category} - ${product.name}</b>\n`;
  text += `Jumlah: <b>${qty} Pcs</b>\n`;
  text += `Harga Satuan: <b>${formatRupiah(product.price)}</b>\n`;
  text += `Total Bruto: ${formatRupiah(grossTotal)}\n`;

  if (discountAmount > 0) {
    text += `🎟️ Voucher (<code>${voucherCode}</code>): <b>-${formatRupiah(discountAmount)}</b>\n`;
  }

  text += `━━━━━━━━━━━━━━━━━━\n`;
  text += `💵 <b>TOTAL BAYAR: ${formatRupiah(finalTotal)}</b>\n`;
  text += `💰 Saldo Anda: <b>${formatRupiah(user.balance)}</b>\n\n`;
  text += `Pilih metode pembayaran:`;

  const vParam = voucherCode ? `_${voucherCode}` : '';

  const buttons = [
    [{ text: '💰 BAYAR DENGAN SALDO', callback_data: `pay_bal_${product.id}_${qty}${vParam}` }],
    [{ text: '⚡ BAYAR DENGAN QRIS (Otomatis 24 Jam)', callback_data: `pay_qris_${product.id}_${qty}${vParam}` }]
  ];

  if (!appliedVoucher) {
    buttons.push([{ text: '🎟️ Gunakan Kode Voucher', callback_data: `voucher_checkout_${product.id}_${qty}` }]);
  }

  buttons.push([{ text: '🔙 Batal', callback_data: `prod_detail_${product.id}` }]);

  await editOrSendMessage(chatId, messageId, text, { inline_keyboard: buttons });
}

// ORDER OTP MENU
async function renderOtpServicesMenu(chatId, messageId = null, page = 1) {
  const res = await OtpService.getServices();
  if (!res.success || !res.data || res.data.length === 0) {
    return bot.sendMessage(chatId, '❌ Gagal mengambil daftar layanan OTP dari server provider.');
  }

  userStates[chatId] = userStates[chatId] || {};
  userStates[chatId].otp_services_cache = res.data;

  const totalServices = res.data.length;
  const itemsPerPage = 10;
  const totalPages = Math.ceil(totalServices / itemsPerPage) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));

  const startIndex = (currentPage - 1) * itemsPerPage;
  const pageServices = res.data.slice(startIndex, startIndex + itemsPerPage);

  let text = `📱 <b>LAYANAN VIRTUAL SMS OTP</b>\n\nHalaman ${currentPage} / ${totalPages}\nSilakan pilih aplikasi / layanan OTP:\n<i>(OTP akan otomatis masuk tanpa perlu refresh berulang)</i>`;

  const buttons = [];
  pageServices.forEach(s => {
    buttons.push([{
      text: `📱 ${s.service_name}`,
      callback_data: `os_${s.service_code}`
    }]);
  });

  const navRow = [];
  if (currentPage > 1) navRow.push({ text: '◀️ Sebelumnya', callback_data: `osp_${currentPage - 1}` });
  if (currentPage < totalPages) navRow.push({ text: 'Next ▶️', callback_data: `osp_${currentPage + 1}` });
  if (navRow.length > 0) buttons.push(navRow);

  buttons.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'cat_page_1' }]);

  await editOrSendMessage(chatId, messageId, text, { inline_keyboard: buttons });
}

// CANCEL HELPER
function getCancelInlineKeyboard() {
  return sanitizeReplyMarkup({
    inline_keyboard: [[{ text: '🔙 Batal / Kembali', callback_data: 'cancel_state' }]]
  });
}

// TELEGRAM COMMAND LISTENERS
bot.onText(/\/start/, async (msg) => {
  const user = await registerUser(msg.from);
  delete userStates[msg.chat.id];

  if (msg.text.includes('prod_')) {
    const prodId = parseInt(msg.text.split('prod_')[1]);
    if (!isNaN(prodId)) {
      const product = await dbGet('SELECT * FROM products WHERE id = ?', [prodId]);
      if (product) {
        const stock = await dbGet('SELECT COUNT(*) as count FROM product_stock WHERE product_id = ? AND status = \'available\'', [prodId]);
        let text = `🤖 <b>${product.category} - ${product.name}</b>\n\n${product.description}\n\n💰 Harga Satuan: <b>${formatRupiah(product.price)}</b>\n📦 Stok Tersedia: <b>${stock.count} Account</b>\n`;
        const buttons = [];
        if (stock.count > 0) {
          buttons.push([{ text: '🛒 BELI 1 PCS', callback_data: `buy_choose_${product.id}_1` }]);
          buttons.push([{ text: '📦 BELI BULK / GROSIR', callback_data: `buy_bulk_prompt_${product.id}` }]);
        } else {
          buttons.push([{ text: '🔴 STOCK HABIS', callback_data: 'noop' }]);
        }
        buttons.push([{ text: '🔙 Kembali ke Katalog', callback_data: 'cat_page_1' }]);
        return editOrSendMessage(msg.chat.id, null, text, { inline_keyboard: buttons });
      }
    }
  }

  const isJoined = await checkChannelMember(msg.from.id);
  if (!isJoined) {
    const joinMsg = `⚠️ <b>WAJIB JOIN CHANNEL</b>\n\nUntuk menggunakan <b>${config.STORE_NAME}</b>, silakan bergabung ke channel resmi kami terlebih dahulu:`;
    const joinButtons = [
      [{ text: '📢 Join Channel', url: config.CHANNEL_URL }],
      [{ text: '✅ Saya Sudah Join', callback_data: 'check_join_status' }]
    ];
    return bot.sendMessage(msg.chat.id, joinMsg, { parse_mode: 'HTML', reply_markup: sanitizeReplyMarkup({ inline_keyboard: joinButtons }) });
  }

  await sendStartDashboard(msg.chat.id, user);
});

bot.onText(/\/(stok|stock|katalog)/, async (msg) => {
  await registerUser(msg.from);
  delete userStates[msg.chat.id];
  await renderCatalog(msg.chat.id, 1, null);
});

bot.onText(/\/saldo/, async (msg) => {
  const user = await registerUser(msg.from);
  delete userStates[msg.chat.id];
  bot.sendMessage(msg.chat.id, `💰 <b>SALDO AKUN</b>\n\nSaldo Anda: <b>${formatRupiah(user.balance)}</b>`, {
    parse_mode: 'HTML',
    reply_markup: sanitizeReplyMarkup({ inline_keyboard: [[{ text: '➕ Isi Saldo (Deposit)', callback_data: 'deposit_prompt' }]] })
  });
});

bot.onText(/\/deposit/, async (msg) => {
  const user = await registerUser(msg.from);
  userStates[msg.chat.id] = { step: 'AWAITING_DEPOSIT_AMOUNT' };
  bot.sendMessage(msg.chat.id, `💰 <b>DEPOSIT SALDO INSTAN</b>\n\nSaldo Anda: <b>${formatRupiah(user.balance)}</b>\nMinimal deposit: <b>${formatRupiah(config.MIN_DEPOSIT)}</b>\n\nMasukkan nominal yang ingin dideposit:`, {
    parse_mode: 'HTML',
    reply_markup: getCancelInlineKeyboard()
  });
});

bot.onText(/\/riwayat/, async (msg) => {
  const user = await registerUser(msg.from);
  delete userStates[msg.chat.id];
  await showUserHistory(msg.chat.id, user, null);
});

bot.onText(/\/cari(?:\s+(.+))?/, async (msg, match) => {
  const user = await registerUser(msg.from);
  const keyword = match && match[1] ? match[1].trim() : null;
  if (!keyword) {
    userStates[msg.chat.id] = { step: 'AWAITING_SEARCH_KEYWORD' };
    return bot.sendMessage(msg.chat.id, `🔍 <b>CARI PRODUK</b>\n\nKetik nama produk atau kategori yang ingin dicari (contoh: <code>spotify</code> atau <code>canva</code>):`, {
      parse_mode: 'HTML',
      reply_markup: getCancelInlineKeyboard()
    });
  }
  delete userStates[msg.chat.id];
  await searchProducts(msg.chat.id, keyword, null);
});

bot.onText(/\/garansi/, async (msg) => {
  const user = await registerUser(msg.from);
  userStates[msg.chat.id] = { step: 'AWAITING_WARRANTY_INPUT' };
  bot.sendMessage(msg.chat.id, `🛡️ <b>KLAIM GARANSI PRODUK</b>\n\nFormat klaim garansi:\n<code>ORDER_CODE | KELUHAN</code>\n\nContoh:\n<code>ORD-1725000000 | Akun Canva tidak bisa login / password salah</code>`, {
    parse_mode: 'HTML',
    reply_markup: getCancelInlineKeyboard()
  });
});

bot.onText(/\/voucher(?:\s+(.+))?/, async (msg, match) => {
  const user = await registerUser(msg.from);
  delete userStates[msg.chat.id];
  const code = match && match[1] ? match[1].trim() : null;
  if (!code) {
    const activeVouchers = await dbAll('SELECT * FROM vouchers WHERE status = \'active\' LIMIT 5');
    let text = `🎟️ <b>VOUCHER PROMO AKTIF</b>\n\n`;
    if (activeVouchers.length === 0) {
      text += `Belum ada voucher publik saat ini. Pantau terus channel kami untuk kode promo!`;
    } else {
      activeVouchers.forEach(v => {
        text += `• Kode: <code>${v.code}</code> (Diskon: ${formatRupiah(v.discount_amount)})\n`;
      });
      text += `\nGunakan kode voucher saat checkout pembelian!`;
    }
    return bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
  }

  const vCheck = await PaymentService.validateVoucher(dbGet, code, user.id, 100000);
  if (vCheck.valid) {
    return bot.sendMessage(msg.chat.id, `✅ <b>VOUCHER VALID!</b>\n\nKode: <code>${vCheck.code}</code>\nPotongan: <b>${formatRupiah(vCheck.discountAmount)}</b>\n\nGunakan kode ini pada saat memilih variasi produk di katalog.`, { parse_mode: 'HTML' });
  } else {
    return bot.sendMessage(msg.chat.id, `❌ ${vCheck.message}`);
  }
});

bot.onText(/\/(flashsale|promo)/, async (msg) => {
  await registerUser(msg.from);
  delete userStates[msg.chat.id];
  await showFlashSale(msg.chat.id, null);
});

bot.onText(/\/backup/, async (msg) => {
  const user = await registerUser(msg.from);
  delete userStates[msg.chat.id];
  if (user.role !== 'admin' && user.role !== 'owner') return;

  try {
    if (!fs.existsSync(dbPath)) return bot.sendMessage(msg.chat.id, '❌ Database file tidak ditemukan.');
    const zip = new AdmZip();
    zip.addLocalFile(dbPath);

    const timeStamp = new Date().toISOString().replace(/[:.]/g, '-');
    const zipFileName = `backup_db_${timeStamp}.zip`;
    const zipFilePath = path.join(backupDir, zipFileName);
    zip.writeZip(zipFilePath);

    await bot.sendDocument(msg.chat.id, zipFilePath, {
      caption: `💾 <b>MANUAL BACKUP DATABASE</b>\n\n📅 Waktu: <code>${getFormattedDate()}</code>`,
      parse_mode: 'HTML'
    });
  } catch (err) {
    bot.sendMessage(msg.chat.id, `❌ Backup error: ${err.message}`);
  }
});

bot.onText(/\/export/, async (msg) => {
  const user = await registerUser(msg.from);
  delete userStates[msg.chat.id];
  if (user.role !== 'admin' && user.role !== 'owner') return;

  try {
    const orders = await dbAll(`
      SELECT o.id, o.order_code, o.amount, o.qty, o.payment_method, o.status, o.created_at, o.completed_at,
             p.name as product_name, p.category, u.username, u.telegram_id
      FROM orders o
      JOIN products p ON o.product_id = p.id
      JOIN users u ON o.user_id = u.id
      ORDER BY o.id DESC
    `);

    let csvContent = 'ID,OrderCode,Date,User,TelegramID,Category,Product,Qty,Amount,Method,Status\n';
    orders.forEach(o => {
      const dateStr = o.completed_at || o.created_at;
      csvContent += `${o.id},"${o.order_code}","${dateStr}","@${o.username || ''}",${o.telegram_id},"${o.category}","${o.product_name}",${o.qty || 1},${o.amount},"${o.payment_method}","${o.status}"\n`;
    });

    const csvPath = path.join(backupDir, `laporan_penjualan_${Date.now()}.csv`);
    fs.writeFileSync(csvPath, csvContent, 'utf8');

    await bot.sendDocument(msg.chat.id, csvPath, {
      caption: `📊 <b>LAPORAN PENJUALAN TOKO (CSV)</b>\nTotal Transaksi: <b>${orders.length} Order</b>\n📅 Waktu Export: <code>${getFormattedDate()}</code>`,
      parse_mode: 'HTML'
    });
  } catch (err) {
    bot.sendMessage(msg.chat.id, `❌ Export error: ${err.message}`);
  }
});

bot.onText(/\/resetcategories/, async (msg) => {
  const user = await registerUser(msg.from);
  delete userStates[msg.chat.id];
  if (user.role !== 'admin' && user.role !== 'owner') return;

  await dbRun("DELETE FROM products");
  await dbRun("DELETE FROM product_stock");

  const seed = [
    ['CANVA PRO', 'Canva 1 Bulan Invite', 'Full Akses Garansi Invite Member', 400],
    ['CANVA PRO', 'Canva 1 Tahun', 'Full Akses Garansi 1 Year Premium', 4000],
    ['CANVA PRO', 'Canva Lifetime', 'Full Akses Garansi Lifetime', 5000],
    ['SPOTIFY PREMIUM', 'Spotify 1 Bulan Individual', 'Full aksos fullgar login empass', 15000],
    ['SPOTIFY PREMIUM', 'Spotify 3 Bulan Individual', 'Full aksos fullgar login empass', 35000],
    ['SPOTIFY PREMIUM', 'Spotify 1 Tahun Family Plan', 'Full aksos fullgar login empass', 90000],
    ['CAPCUT PRO', 'CapCut Pro 7 Hari', 'CapCut Pro Premium 7 Days', 10000],
    ['CAPCUT PRO', 'CapCut Pro 1 Bulan', 'CapCut Pro Premium 1 Month', 35000],
    ['NETFLIX PREMIUM', 'Netflix 1 Bulan Shared', 'Netflix Premium Shared 1 Profile', 35000],
    ['NETFLIX PREMIUM', 'Netflix 1 Bulan Private', 'Netflix Private Account 1 Month', 120000],
    ['CHATGPT+', 'ChatGPT Plus Shared', 'ChatGPT Plus Shared Account', 25000],
    ['CHATGPT+', 'ChatGPT Plus Private', 'ChatGPT Plus Private Account', 50000]
  ];
  for (const s of seed) {
    await dbRun('INSERT INTO products (category, name, description, price) VALUES (?, ?, ?, ?)', s);
  }

  bot.sendMessage(msg.chat.id, '✅ Kategori & Produk telah di-reset ke struktur bersih!');
});

bot.onText(/\/admin/, async (msg) => {
  const user = await registerUser(msg.from);
  delete userStates[msg.chat.id];
  if (user.role !== 'admin' && user.role !== 'owner') {
    return bot.sendMessage(msg.chat.id, '⛔ <b>ACCESS DENIED</b>\n\nAnda tidak memiliki izin untuk mengakses Admin Panel.', { parse_mode: 'HTML' });
  }

  await sendAdminDashboard(msg.chat.id, user);
});

bot.onText(/\/addproduct/, async (msg) => {
  const user = await registerUser(msg.from);
  if (user.role !== 'admin' && user.role !== 'owner') return;

  userStates[msg.chat.id] = { step: 'ADD_PROD_CAT' };
  bot.sendMessage(msg.chat.id, `📂 <b>KATEGORI PRODUK BARU</b>\n\nMasukkan Nama Kategori / Group Produk:\nContoh: <code>SPOTIFY PREMIUM</code>`, {
    parse_mode: 'HTML',
    reply_markup: getCancelInlineKeyboard()
  });
});

bot.onText(/\/addstock/, async (msg) => {
  const user = await registerUser(msg.from);
  delete userStates[msg.chat.id];
  if (user.role !== 'admin' && user.role !== 'owner') return;

  const products = await dbAll('SELECT * FROM products WHERE status = \'active\'');
  const inline = products.map(p => [{ text: `${p.category} - ${p.name}`, callback_data: `admin_sel_stock_prod_${p.id}` }]);
  inline.push([{ text: '🔙 Batal', callback_data: 'cancel_state' }]);
  bot.sendMessage(msg.chat.id, `📦 <b>TAMBAH STOCK</b>\n\nPilih produk/variasi yang ingin diisi stock:`, {
    reply_markup: sanitizeReplyMarkup({ inline_keyboard: inline })
  });
});

// MESSAGE CONVERSATION LISTENER
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const user = await registerUser(msg.from);

  // PRIORITY 1: Check if message is a standard Reply Keyboard button
  const MENU_KEYWORDS = [
    'Katalog', 'List Produk', 'Order OTP', 'Cek Saldo', 'Saldo', 'Deposit', 'Riwayat Transaksi',
    'Cari Produk', 'Klaim Voucher', 'Klaim Garansi', 'BANTUAN', 'Bantuan', 'Populer',
    'Menu User', 'Kelola Produk', 'Laporan Stok', 'Add Product', 'Add Stock',
    'Voucher', 'Saldo RumahOTP', 'Deposit RumahOTP', 'Pesanan App', 'Pesanan OTP',
    'Statistik & Export', 'Status CodeGatra', 'Broadcast'
  ];

  const isMenuButtonClick = MENU_KEYWORDS.some(k => text.includes(k));

  if (isMenuButtonClick) {
    // Immediately clear conversational state so user is NEVER trapped when clicking menu buttons
    delete userStates[chatId];
  }

  // PRIORITY 2: Handle Active Conversational States (if NOT clicking a menu button)
  const state = userStates[chatId];
  if (state && !isMenuButtonClick) {
    if (state.step === 'AWAITING_SEARCH_KEYWORD') {
      delete userStates[chatId];
      return searchProducts(chatId, text, null);
    }

    if (state.step === 'AWAITING_DEPOSIT_AMOUNT') {
      const amount = parseInt(text.replace(/[^0-9]/g, ''));
      if (isNaN(amount) || amount < config.MIN_DEPOSIT) {
        return bot.sendMessage(chatId, `❌ Nominal minimal deposit adalah <b>${formatRupiah(config.MIN_DEPOSIT)}</b>. Coba lagi:`, {
          parse_mode: 'HTML',
          reply_markup: getCancelInlineKeyboard()
        });
      }

      delete userStates[chatId];
      const deposit = await PaymentService.createDeposit({
        dbRun,
        userId: user.id,
        amount,
        customerName: msg.from.username || msg.from.first_name || 'Member'
      });

      if (deposit.status !== 'success') {
        return bot.sendMessage(chatId, `❌ <b>Gagal membuat deposit QRIS:</b> ${deposit.message}`, { parse_mode: 'HTML' });
      }

      const expTimeFormatted = formatExpiryWib(deposit.expiredAt, deposit.expiredMinutes);
      let depMsg = `⚡ <b>DEPOSIT QRIS OTOMATIS</b>\n\n`;
      depMsg += `Kode Deposit: <code>#${deposit.depositCode}</code>\n`;
      depMsg += `Nominal: ${formatRupiah(deposit.amount)}\n`;
      depMsg += `Kode Unik: <b>+${formatRupiah(deposit.uniqueCode)}</b>\n`;
      depMsg += `━━━━━━━━━━━━━━━━━━\n`;
      depMsg += `💵 <b>TOTAL TRANSFER: ${formatRupiah(deposit.totalAmount)}</b>\n`;
      depMsg += `<i>(Wajib transfer persis nominal di atas agar saldo otomatis masuk)</i>\n\n`;
      depMsg += `⏱️ Berlaku: <b>${deposit.expiredMinutes} Menit</b> (s/d <b>${expTimeFormatted} WIB</b>)\n`;
      depMsg += `✅ Saldo akan otomatis bertambah dalam hitungan detik setelah bayar.`;

      const depButtons = {
        inline_keyboard: [
          [
            { text: '🔄 Cek Status / Refresh', callback_data: `chk_dep_${deposit.depositCode}` },
            { text: '❌ Batalkan', callback_data: `cnc_dep_${deposit.depositCode}` }
          ]
        ]
      };

      await sendQrPhotoOrMessage(chatId, deposit, depMsg, depButtons);
      return;
    }

    if (state.step === 'AWAITING_CUSTOM_BUY_QTY') {
      const qty = parseInt(text.replace(/[^0-9]/g, ''));
      const prodId = state.productId;
      if (isNaN(qty) || qty < 1) {
        return bot.sendMessage(chatId, '❌ Jumlah pembelian minimal adalah 1 Pcs. Coba lagi:', {
          reply_markup: sanitizeReplyMarkup({ inline_keyboard: [[{ text: '🔙 Batal', callback_data: `prod_detail_${prodId}` }]] })
        });
      }

      delete userStates[chatId];
      const product = await dbGet('SELECT * FROM products WHERE id = ?', [prodId]);
      return sendPaymentChoice(chatId, null, user, product, qty);
    }

    if (state.step === 'AWAITING_CHECKOUT_VOUCHER') {
      const { productId, qty } = state;
      delete userStates[chatId];

      const product = await dbGet('SELECT * FROM products WHERE id = ?', [productId]);
      const grossAmount = product.price * qty;
      const vCheck = await PaymentService.validateVoucher(dbGet, text, user.id, grossAmount);

      if (!vCheck.valid) {
        bot.sendMessage(chatId, `❌ <b>Voucher Gagal:</b> ${vCheck.message}`, { parse_mode: 'HTML' });
        return sendPaymentChoice(chatId, null, user, product, qty, null);
      }

      bot.sendMessage(chatId, `🎉 <b>VOUCHER BERHASIL DIGUNAKAN!</b>\nPotongan: <b>-${formatRupiah(vCheck.discountAmount)}</b>`, { parse_mode: 'HTML' });
      return sendPaymentChoice(chatId, null, user, product, qty, vCheck);
    }

    if (state.step === 'AWAITING_WARRANTY_INPUT') {
      const parts = text.split('|');
      if (parts.length < 2) {
        return bot.sendMessage(chatId, '❌ Format salah. Gunakan format: <code>ORDER_CODE | KELUHAN</code>\n\nContoh: <code>ORD-1725000000 | Password salah</code>', {
          parse_mode: 'HTML',
          reply_markup: getCancelInlineKeyboard()
        });
      }

      const orderCode = parts[0].trim().replace(/^#/, '');
      const description = parts.slice(1).join('|').trim();

      const order = await dbGet('SELECT * FROM orders WHERE order_code = ? AND user_id = ?', [orderCode, user.id]);
      if (!order) {
        return bot.sendMessage(chatId, '❌ Order Code tidak ditemukan dalam riwayat pesanan Anda. Pastikan kode order sesuai.', {
          parse_mode: 'HTML',
          reply_markup: getCancelInlineKeyboard()
        });
      }

      const ticketCode = 'TCK-' + Date.now().toString().slice(-6);
      await dbRun(
        'INSERT INTO support_tickets (ticket_code, user_id, order_code, issue_type, description, status) VALUES (?, ?, ?, ?, ?, \'open\')',
        [ticketCode, user.id, orderCode, 'WARRANTY_CLAIM', description]
      );

      delete userStates[chatId];
      bot.sendMessage(chatId, `✅ <b>TIKET GARANSI DIBUAT</b>\n\nKode Tiket: <code>#${ticketCode}</code>\nOrder: <code>#${orderCode}</code>\nKeluhan: <i>${description}</i>\n\nAdmin akan segera meninjau garansi Anda.`, { parse_mode: 'HTML' });

      // Notify Owner
      const alertMsg = `🛡️ <b>KLAIM GARANSI MASUK!</b>\n\nTiket: <code>#${ticketCode}</code>\nOrder: <code>#${orderCode}</code>\nUser: @${msg.from.username || 'User'} (<code>${msg.from.id}</code>)\nKeluhan:\n${description}`;
      try {
        await bot.sendMessage(config.OWNER_ID, alertMsg, { parse_mode: 'HTML' });
      } catch (e) {}
      return;
    }

    if (state.step === 'AWAITING_OWNER_OTP_DEP_AMOUNT') {
      const amount = parseInt(text.replace(/[^0-9]/g, ''));
      if (isNaN(amount) || amount < 10000) {
        return bot.sendMessage(chatId, '❌ Nominal minimal deposit RumahOTP adalah Rp 10.000.', {
          reply_markup: getCancelInlineKeyboard()
        });
      }

      delete userStates[chatId];
      const res = await OtpService.createOwnerDeposit(amount);
      if (!res.success) {
        return bot.sendMessage(chatId, `❌ Gagal membuat deposit RumahOTP: ${res.message}`);
      }

      let depText = `💳 <b>DEPOSIT RUMAHOTP CREATED</b>\n\nDeposit ID: <code>${res.data.id}</code>\nTotal Bayar: <b>${formatRupiah(res.data.amount)}</b>\n\nScan QRIS di bawah ini untuk menyelesaikan deposit.`;

      await sendQrPhotoOrMessage(chatId, res.data, depText);
      return;
    }

    if (state.step === 'ADD_PROD_CAT') {
      userStates[chatId] = { step: 'ADD_PROD_NAME', category: text.toUpperCase() };
      return bot.sendMessage(chatId, `📝 <b>NAMA VARIASI PRODUK</b>\n\nKategori: <b>${text.toUpperCase()}</b>\nMasukkan Nama Variasi Produk:\nContoh: <code>Spotify 1 Bulan Individual</code>`, {
        parse_mode: 'HTML',
        reply_markup: getCancelInlineKeyboard()
      });
    }

    if (state.step === 'ADD_PROD_NAME') {
      userStates[chatId] = { ...state, step: 'ADD_PROD_PRICE', name: text };
      return bot.sendMessage(chatId, `💰 <b>HARGA PRODUK</b>\n\nMasukkan harga jual angka saja (contoh: <code>15000</code>):`, {
        parse_mode: 'HTML',
        reply_markup: getCancelInlineKeyboard()
      });
    }

    if (state.step === 'ADD_PROD_PRICE') {
      const price = parseInt(text.replace(/[^0-9]/g, ''));
      if (isNaN(price)) {
        return bot.sendMessage(chatId, '❌ Harga harus berupa angka.', { reply_markup: getCancelInlineKeyboard() });
      }

      userStates[chatId] = { ...state, step: 'ADD_PROD_DESC', price };
      return bot.sendMessage(chatId, `📝 <b>DESKRIPSI PRODUK</b>\n\nMasukkan deskripsi singkat produk:`, {
        parse_mode: 'HTML',
        reply_markup: getCancelInlineKeyboard()
      });
    }

    if (state.step === 'ADD_PROD_DESC') {
      const { category, name, price } = state;
      await dbRun('INSERT INTO products (category, name, description, price) VALUES (?, ?, ?, ?)', [category, name, text, price]);
      delete userStates[chatId];
      return bot.sendMessage(chatId, `✅ <b>PRODUK BERHASIL DITAMBAHKAN</b>\n\nKategori: <b>${category}</b>\nVariasi: <b>${name}</b>\nHarga: <b>${formatRupiah(price)}</b>`, { parse_mode: 'HTML' });
    }

    if (state.step === 'AWAITING_EDIT_PRICE') {
      const newPrice = parseInt(text.replace(/[^0-9]/g, ''));
      if (isNaN(newPrice) || newPrice < 0) {
        return bot.sendMessage(chatId, '❌ Harga tidak valid. Masukkan angka harga yang benar:', { reply_markup: getCancelInlineKeyboard() });
      }

      const prodId = state.productId;
      const product = await dbGet('SELECT * FROM products WHERE id = ?', [prodId]);

      await dbRun('UPDATE products SET price = ? WHERE id = ?', [newPrice, prodId]);
      delete userStates[chatId];

      return bot.sendMessage(chatId, `✅ <b>HARGA PRODUK BERHASIL DIUBAH!</b>\n\nProduk: <b>${product.category} - ${product.name}</b>\nHarga Baru: <b>${formatRupiah(newPrice)}</b>`, { parse_mode: 'HTML' });
    }

    if (state.step === 'ADD_STOCK_MANUAL') {
      const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      const productId = state.productId;
      let added = 0;

      for (const line of lines) {
        const parts = line.split('|');
        if (parts.length >= 2) {
          const email = parts[0].trim();
          const password = parts[1].trim();
          const extra = parts.slice(2).join('|').trim();
          await dbRun('INSERT INTO product_stock (product_id, email, password, extra_data) VALUES (?, ?, ?, ?)', [productId, email, password, extra]);
          added++;
        }
      }

      delete userStates[chatId];
      bot.sendMessage(chatId, `✅ <b>STOCK BERHASIL DITAMBAHKAN</b>\n\nBerhasil memasukkan: <b>${added} Account</b>`, { parse_mode: 'HTML' });

      if (added > 0) {
        sendRestockNotificationCard({
          productId: productId,
          addedCount: added,
          addedBy: msg.from.username || msg.from.first_name || 'Admin'
        });
      }
      return;
    }

    if (state.step === 'AWAITING_VOUCHER_INPUT') {
      const parts = text.split('|');
      if (parts.length < 2) {
        return bot.sendMessage(chatId, '❌ Format salah. Gunakan format:\n<code>KODE | POTONGAN | MIN_BELANJA | JUMLAH_STOK</code>\n\nContoh:\n<code>BOSPROMO|4500|5000|100</code>\n<i>(Min. Belanja dan Stok opsional, isi 0 jika tanpa batas)</i>', {
          parse_mode: 'HTML',
          reply_markup: getCancelInlineKeyboard()
        });
      }

      const code = parts[0].trim().toUpperCase();
      const discount = parseInt(parts[1].trim());
      if (isNaN(discount) || discount < 1) {
        return bot.sendMessage(chatId, '❌ Nominal potongan harus berupa angka valid lebih dari 0.', {
          reply_markup: getCancelInlineKeyboard()
        });
      }

      const minSpend = parts[2] ? (parseInt(parts[2].trim()) || 0) : 0;
      const maxUsage = parts[3] ? (parseInt(parts[3].trim()) || 0) : 0;

      try {
        await dbRun(
          'INSERT INTO vouchers (code, discount_amount, min_spend, max_usage, used_count, status) VALUES (?, ?, ?, ?, 0, \'active\')',
          [code, discount, minSpend, maxUsage]
        );
        delete userStates[chatId];

        let resMsg = `✅ <b>VOUCHER BERHASIL DIBUAT</b>\n\n`;
        resMsg += `🎟️ Kode: <code>${code}</code>\n`;
        resMsg += `💰 Potongan: <b>${formatRupiah(discount)}</b>\n`;
        resMsg += `🛒 Min. Belanja: <b>${formatRupiah(minSpend)}</b>\n`;
        resMsg += `📦 Stok / Kuota: <b>${maxUsage > 0 ? `${maxUsage} Penggunaan` : 'Tanpa Batas (Unlimited)'}</b>`;

        return bot.sendMessage(chatId, resMsg, { parse_mode: 'HTML' });
      } catch (err) {
        if (err.message && err.message.includes('UNIQUE')) {
          return bot.sendMessage(chatId, `❌ Kode voucher <code>${code}</code> sudah ada! Gunakan kode lain.`, {
            parse_mode: 'HTML',
            reply_markup: getCancelInlineKeyboard()
          });
        }
        return bot.sendMessage(chatId, `❌ Gagal menyimpan voucher: ${err.message}`, {
          reply_markup: getCancelInlineKeyboard()
        });
      }
    }

    if (state.step === 'AWAITING_EDIT_USER_BAL') {
      const parts = text.split('|');
      if (parts.length < 2) {
        return bot.sendMessage(chatId, '❌ Format salah. Gunakan format <code>TELEGRAM_ID|SALDO_BARU</code>', {
          parse_mode: 'HTML',
          reply_markup: getCancelInlineKeyboard()
        });
      }

      const targetId = parseInt(parts[0].trim());
      const newBal = parseInt(parts[1].trim());

      await dbRun('UPDATE users SET balance = ? WHERE telegram_id = ?', [newBal, targetId]);
      delete userStates[chatId];

      return bot.sendMessage(chatId, `✅ <b>SALDO USER BERHASIL DIUPDATE</b>\n\nUser ID: <code>${targetId}</code>\nSaldo Baru: <b>${formatRupiah(newBal)}</b>`, { parse_mode: 'HTML' });
    }

    if (state.step === 'AWAITING_BROADCAST_MSG') {
      const allUsers = await dbAll('SELECT telegram_id FROM users');
      delete userStates[chatId];

      bot.sendMessage(chatId, `⏳ Memulai broadcast aman ke ${allUsers.length} pengguna (Rate-limited)...`);

      const count = await sendRateLimitedBroadcast(allUsers, async (u) => {
        await bot.sendMessage(u.telegram_id, `📢 <b>INFORMASI TOKO</b>\n\n${text}`, { parse_mode: 'HTML' });
      });

      return bot.sendMessage(chatId, `✅ <b>BROADCAST SELESAI</b>\n\nPesan terkirim ke <b>${count} / ${allUsers.length}</b> pengguna.`, { parse_mode: 'HTML' });
    }
  }

  // PRIORITY 2.5: ADMIN DIRECT PIPE INPUTS (Fallback when state was not pre-set)
  if (isAdmin(msg.from.id) && text.includes('|')) {
    const parts = text.split('|');
    // Pattern 1: Voucher creation -> KODE|POTONGAN|MIN_BELANJA|JUMLAH_STOK (e.g. PROMOKOK|4500|5000|5)
    if (parts.length >= 2 && isNaN(parts[0].trim())) {
      const code = parts[0].trim().toUpperCase();
      const discount = parseInt(parts[1].trim());
      if (!isNaN(discount) && discount > 0) {
        const minSpend = parts[2] ? (parseInt(parts[2].trim()) || 0) : 0;
        const maxUsage = parts[3] ? (parseInt(parts[3].trim()) || 0) : 0;

        try {
          await dbRun(
            'INSERT INTO vouchers (code, discount_amount, min_spend, max_usage, used_count, status) VALUES (?, ?, ?, ?, 0, \'active\')',
            [code, discount, minSpend, maxUsage]
          );
          delete userStates[chatId];

          let resMsg = `✅ <b>VOUCHER BERHASIL DIBUAT</b>\n\n`;
          resMsg += `🎟️ Kode: <code>${code}</code>\n`;
          resMsg += `💰 Potongan: <b>${formatRupiah(discount)}</b>\n`;
          resMsg += `🛒 Min. Belanja: <b>${formatRupiah(minSpend)}</b>\n`;
          resMsg += `📦 Stok / Kuota: <b>${maxUsage > 0 ? `${maxUsage} Penggunaan` : 'Tanpa Batas (Unlimited)'}</b>`;

          return bot.sendMessage(chatId, resMsg, { parse_mode: 'HTML' });
        } catch (err) {
          if (err.message && err.message.includes('UNIQUE')) {
            return bot.sendMessage(chatId, `❌ Kode voucher <code>${code}</code> sudah ada! Gunakan kode lain.`, { parse_mode: 'HTML' });
          }
          return bot.sendMessage(chatId, `❌ Gagal menyimpan voucher: ${err.message}`);
        }
      }
    }

    // Pattern 2: Edit user balance -> TELEGRAM_ID|SALDO_BARU (e.g. 123456789|50000)
    if (parts.length === 2 && !isNaN(parts[0].trim()) && !isNaN(parts[1].trim())) {
      const targetId = parseInt(parts[0].trim());
      const newBal = parseInt(parts[1].trim());
      await dbRun('UPDATE users SET balance = ? WHERE telegram_id = ?', [newBal, targetId]);
      delete userStates[chatId];
      return bot.sendMessage(chatId, `✅ <b>SALDO USER BERHASIL DIUPDATE</b>\n\nUser ID: <code>${targetId}</code>\nSaldo Baru: <b>${formatRupiah(newBal)}</b>`, { parse_mode: 'HTML' });
    }
  }

  // PRIORITY 3: USER REPLY KEYBOARD ACTIONS
  if (text.includes('Katalog') || text.includes('List Produk')) {
    return renderCatalog(chatId, 1, null);
  }

  if (text.includes('Order OTP')) {
    return renderOtpServicesMenu(chatId, null, 1);
  }

  if (text.includes('Cek Saldo') || text === 'Saldo' || text === '💳 Cek Saldo') {
    return bot.sendMessage(chatId, `💰 <b>SALDO AKUN</b>\n\nSaldo Anda: <b>${formatRupiah(user.balance)}</b>`, {
      parse_mode: 'HTML',
      reply_markup: sanitizeReplyMarkup({ inline_keyboard: [[{ text: '➕ Isi Saldo (Deposit)', callback_data: 'deposit_prompt' }]] })
    });
  }

  if (text.includes('Riwayat Transaksi')) {
    return showUserHistory(chatId, user, null);
  }

  if (text.includes('Cari Produk')) {
    userStates[chatId] = { step: 'AWAITING_SEARCH_KEYWORD' };
    return bot.sendMessage(chatId, `🔍 <b>CARI PRODUK</b>\n\nKetik nama produk atau variasi yang ingin dicari:`, {
      parse_mode: 'HTML',
      reply_markup: getCancelInlineKeyboard()
    });
  }

  if (text.includes('Klaim Voucher')) {
    const activeVouchers = await dbAll('SELECT * FROM vouchers WHERE status = \'active\'');
    let vMsg = `🎟️ <b>VOUCHER PROMO TOKO</b>\n\n`;
    if (activeVouchers.length === 0) {
      vMsg += `Saat ini belum ada kode promo aktif.`;
    } else {
      activeVouchers.forEach(v => {
        vMsg += `• Kode: <code>${v.code}</code> | Diskon: <b>${formatRupiah(v.discount_amount)}</b>\n`;
      });
      vMsg += `\n<i>Masukkan kode voucher saat memilih metode pembayaran di katalog!</i>`;
    }
    return bot.sendMessage(chatId, vMsg, { parse_mode: 'HTML' });
  }

  if (text.includes('Klaim Garansi')) {
    userStates[chatId] = { step: 'AWAITING_WARRANTY_INPUT' };
    return bot.sendMessage(chatId, `🛡️ <b>KLAIM GARANSI PRODUK</b>\n\nFormat:\n<code>ORDER_CODE | KELUHAN</code>\n\nContoh:\n<code>ORD-1725000000 | Akun Spotify error tidak bisa login</code>`, {
      parse_mode: 'HTML',
      reply_markup: getCancelInlineKeyboard()
    });
  }

  if (text.includes('BANTUAN') || text.includes('Bantuan')) {
    let guide = `❓ <b>PANDUAN & BANTUAN ${config.STORE_NAME || 'MOAKUN STORE'}</b>\n\n`;
    guide += `1. <b>Beli Akun Digital:</b> Klik <b>🛍️ Katalog</b> → pilih nomor → pilih jumlah → bayar via Saldo / Auto QRIS 24 Jam.\n`;
    guide += `2. <b>Order OTP Virtual:</b> Klik <b>📱 Order OTP</b> → pilih layanan → bayar saldo → nomor HP muncul dan kode OTP akan otomatis masuk tanpa perlu refresh!\n`;
    guide += `3. <b>Isi Saldo:</b> Klik <b>💰 Deposit</b> → masukkan nominal → bayar QRIS otomatis.\n`;
    guide += `4. <b>Riwayat Akun:</b> Semua akun yang dibeli tersimpan di menu <b>📜 Riwayat Transaksi</b>.\n\n`;
    guide += `Butuh Bantuan CS? Hubungi admin @${config.SUPPORT_USERNAME || 'yopratama'}`;
    return bot.sendMessage(chatId, guide, { parse_mode: 'HTML' });
  }

  if (text === '🔥 Populer') {
    return renderCatalog(chatId, 1, null);
  }

  if (text.includes('Deposit')) {
    userStates[chatId] = { step: 'AWAITING_DEPOSIT_AMOUNT' };
    return bot.sendMessage(chatId, `💰 <b>DEPOSIT SALDO INSTAN</b>\n\nSaldo Anda saat ini: <b>${formatRupiah(user.balance)}</b>\n\nMasukkan nominal deposit (min ${formatRupiah(config.MIN_DEPOSIT)}):`, {
      parse_mode: 'HTML',
      reply_markup: getCancelInlineKeyboard()
    });
  }

  if (text === '🏠 Menu User') {
    return sendStartDashboard(chatId, user);
  }

  // PRIORITY 4: ADMIN KEYBOARD ACTIONS
  if (user.role === 'admin' || user.role === 'owner') {
    if (text === '🏷️ Kelola Produk') {
      const prods = await dbAll('SELECT p.*, COUNT(s.id) as stock FROM products p LEFT JOIN product_stock s ON p.id = s.product_id AND s.status = \'available\' GROUP BY p.id');
      let pMsg = `🏷️ <b>MANAJEMEN PRODUK TOKO</b>\n\n`;
      const buttons = [];

      prods.forEach(p => {
        const statusIcon = p.status === 'active' ? '🟢' : '🔴';
        pMsg += `${statusIcon} <b>${p.category} - ${p.name}</b>\n   💰 ${formatRupiah(p.price)} | Stok: <b>${p.stock}</b>\n\n`;
        buttons.push([
          { text: `${statusIcon} ${p.category} - ${p.name}`, callback_data: `admin_manage_prod_${p.id}` }
        ]);
      });

      return bot.sendMessage(chatId, pMsg, {
        parse_mode: 'HTML',
        reply_markup: sanitizeReplyMarkup({ inline_keyboard: buttons })
      });
    }

    if (text === '📦 Laporan Stok') {
      const readyProds = await dbAll(`SELECT p.category, p.name, COUNT(s.id) as count FROM products p LEFT JOIN product_stock s ON p.id = s.product_id AND s.status = 'available' GROUP BY p.id HAVING count > 0`);
      const emptyProds = await dbAll(`SELECT p.category, p.name, COUNT(s.id) as count FROM products p LEFT JOIN product_stock s ON p.id = s.product_id AND s.status = 'available' GROUP BY p.id HAVING count = 0`);

      let report = `📊 <b>LAPORAN STOCK TOKO</b>\n\n🟢 <b>READY STOCK</b>\n`;
      let readyTotal = 0;
      readyProds.forEach(p => { report += `• ${p.category} (${p.name}): <b>${p.count}</b>\n`; readyTotal += p.count; });

      report += `\n🔴 <b>HABIS</b>\n`;
      emptyProds.forEach(p => { report += `• ${p.category} (${p.name}): <b>0</b>\n`; });

      report += `\n━━━━━━━━━━━━━━━━━━\nTotal Stock Ready: <b>${readyTotal} Account</b>`;
      return bot.sendMessage(chatId, report, { parse_mode: 'HTML' });
    }

    if (text === '➕ Add Product') {
      userStates[chatId] = { step: 'ADD_PROD_CAT' };
      return bot.sendMessage(chatId, `📂 <b>KATEGORI PRODUK BARU</b>\n\nMasukkan Nama Kategori / Group Produk:\nContoh: <code>SPOTIFY PREMIUM</code>`, {
        parse_mode: 'HTML',
        reply_markup: getCancelInlineKeyboard()
      });
    }

    if (text === '📥 Add Stock') {
      const products = await dbAll('SELECT * FROM products WHERE status = \'active\' ORDER BY CASE WHEN category = \'⚡ FLASH SALE\' THEN 0 ELSE 1 END, category ASC, id ASC');
      const inline = products.map(p => [{ text: `${p.category} - ${p.name}`, callback_data: `admin_sel_stock_prod_${p.id}` }]);
      inline.push([{ text: '🔙 Batal', callback_data: 'cancel_state' }]);
      return bot.sendMessage(chatId, `📦 <b>TAMBAH STOCK</b>\n\nPilih produk/variasi yang ingin diisi stock:`, {
        reply_markup: sanitizeReplyMarkup({ inline_keyboard: inline })
      });
    }

    if (text === '🎟️ Voucher') {
      userStates[chatId] = { step: 'AWAITING_VOUCHER_INPUT' };
      const vouchers = await dbAll('SELECT * FROM vouchers ORDER BY id DESC LIMIT 15');
      let vMsg = `🎟️ <b>KELOLA VOUCHER TOKO</b>\n\n`;
      const vButtons = [];

      if (vouchers.length === 0) {
        vMsg += `<i>Belum ada voucher aktif.</i>\n\n`;
      } else {
        vouchers.forEach(v => {
          const remainingStock = v.max_usage > 0 ? Math.max(0, v.max_usage - (v.used_count || 0)) : 'Unlimited';
          const stockText = v.max_usage > 0 ? `${remainingStock}/${v.max_usage} Kuota` : 'Unlimited';
          vMsg += `• Kode: <code>${v.code}</code>\n`;
          vMsg += `   ├ Diskon: <b>${formatRupiah(v.discount_amount)}</b> (Min. Belanja: ${formatRupiah(v.min_spend || 0)})\n`;
          vMsg += `   └ Stok: <b>${stockText}</b> (Terpakai: ${v.used_count || 0}x)\n\n`;
          vButtons.push([{ text: `🗑️ Hapus Voucher ${v.code}`, callback_data: `admin_del_voucher_${v.id}` }]);
        });
      }

      vMsg += `<b>Tambah Voucher Baru:</b> Kirim langsung format:\n<code>KODE|POTONGAN|MIN_BELANJA|JUMLAH_STOK</code>\n\nContoh: <code>PROMOKOK|4500|5000|5</code>`;
      vButtons.push([{ text: '➕ Tambah Voucher Baru', callback_data: 'admin_add_voucher_prompt' }]);

      return bot.sendMessage(chatId, vMsg, { parse_mode: 'HTML', reply_markup: sanitizeReplyMarkup({ inline_keyboard: vButtons }) });
    }

    if (text === '💳 Saldo RumahOTP') {
      const balRes = await OtpService.getBalance();
      if (!balRes.success) {
        return bot.sendMessage(chatId, `❌ Gagal mengecek saldo RumahOTP: ${balRes.message}`);
      }

      let balMsg = `💳 <b>SALDO AKUN RUMAHOTP OWNER</b>\n\n`;
      balMsg += `Email: <code>${balRes.data.email}</code>\n`;
      balMsg += `Username: <b>${balRes.data.username}</b>\n`;
      balMsg += `Saldo Provider: <b>${balRes.data.formated}</b>`;

      return bot.sendMessage(chatId, balMsg, { parse_mode: 'HTML' });
    }

    if (text === '⚙️ Status CodeGatra') {
      const profRes = await CodeGatraService.getProfile();
      let cgMsg = `⚙️ <b>STATUS CODEGATRA PAYMENT GATEWAY</b>\n\n`;
      cgMsg += `Base URL: <code>${config.CODEGATRA_BASE_URL}</code>\n`;
      cgMsg += `Project Name: <code>${config.CODEGATRA_NAMA_PROJECT || 'Belum diatur'}</code>\n`;
      cgMsg += `API Key: <code>${config.CODEGATRA_API_KEY ? '••••••••' + config.CODEGATRA_API_KEY.slice(-4) : 'Belum diatur'}</code>\n\n`;

      if (profRes.status === 'success' || profRes.data) {
        cgMsg += `✅ <b>Koneksi: TERHUBUNG</b>\n`;
        if (profRes.data) cgMsg += `Info: <pre>${JSON.stringify(profRes.data, null, 2)}</pre>`;
      } else {
        cgMsg += `⚠️ <b>Koneksi:</b> ${profRes.message || 'Gagal tersambung'}`;
      }

      return bot.sendMessage(chatId, cgMsg, { parse_mode: 'HTML' });
    }

    if (text === '➕ Deposit RumahOTP') {
      userStates[chatId] = { step: 'AWAITING_OWNER_OTP_DEP_AMOUNT' };
      return bot.sendMessage(chatId, `💳 <b>DEPOSIT RUMAHOTP PROVIDER</b>\n\nMasukkan nominal deposit yang ingin diisi ke saldo RumahOTP:`, {
        parse_mode: 'HTML',
        reply_markup: getCancelInlineKeyboard()
      });
    }

    if (text === '🛒 Pesanan App') {
      const recentOrders = await dbAll('SELECT o.*, p.name as prod_name, p.category, u.username FROM orders o JOIN products p ON o.product_id = p.id JOIN users u ON o.user_id = u.id ORDER BY o.id DESC LIMIT 10');
      let oMsg = `🛒 <b>PESANAN APP TERAKHIR</b>\n\n`;
      if (recentOrders.length === 0) oMsg += `Belum ada pesanan masuk.`;
      else {
        recentOrders.forEach(o => {
          oMsg += `#<code>${o.order_code}</code> | @${o.username || 'user'} | <b>${o.category} - ${o.prod_name}</b> | Status: <b>${o.status.toUpperCase()}</b>\n`;
        });
      }
      return bot.sendMessage(chatId, oMsg, { parse_mode: 'HTML' });
    }

    if (text === '📱 Pesanan OTP') {
      const recentOtp = await dbAll('SELECT o.*, u.username FROM otp_orders o JOIN users u ON o.user_id = u.id ORDER BY o.id DESC LIMIT 10');
      let oMsg = `📱 <b>PESANAN OTP TERAKHIR</b>\n\n`;
      if (recentOtp.length === 0) oMsg += `Belum ada pesanan OTP.`;
      else {
        recentOtp.forEach(o => {
          oMsg += `#<code>${o.order_code}</code> | @${o.username} | <b>${o.service_name}</b> | Status: <b>${o.status.toUpperCase()}</b>\n`;
        });
      }
      return bot.sendMessage(chatId, oMsg, { parse_mode: 'HTML' });
    }

    if (text === '📊 Statistik & Export') {
      const totalUsers = await dbGet('SELECT COUNT(*) as c FROM users');
      const totalOrders = await dbGet('SELECT COUNT(*) as c FROM orders WHERE status = \'completed\'');
      const totalOmzet = await dbGet('SELECT SUM(amount) as s FROM orders WHERE status = \'completed\'');
      const totalStock = await dbGet('SELECT COUNT(*) as c FROM product_stock WHERE status = \'available\'');

      // Top 3 Best Selling Products
      const topProducts = await dbAll(`
        SELECT p.category, p.name, SUM(o.qty) as sold_qty, SUM(o.amount) as total_sales
        FROM orders o
        JOIN products p ON o.product_id = p.id
        WHERE o.status = 'completed'
        GROUP BY p.id
        ORDER BY sold_qty DESC, total_sales DESC
        LIMIT 3
      `);

      // Top 3 Loyal Users / Spenders
      const topUsers = await dbAll(`
        SELECT u.username, u.first_name, u.telegram_id, COUNT(o.id) as order_count, SUM(o.amount) as total_spent
        FROM orders o
        JOIN users u ON o.user_id = u.id
        WHERE o.status = 'completed'
        GROUP BY u.id
        ORDER BY total_spent DESC, order_count DESC
        LIMIT 3
      `);

      let statText = `📊 <b>STATISTIK & LAPORAN TOKO</b>\n\n`;
      statText += `├ 👥 Total Users: <b>${totalUsers.c} User</b>\n`;
      statText += `├ 🛒 Total Order Selesai: <b>${totalOrders.c} Pesanan</b>\n`;
      statText += `├ 💰 Total Omzet: <b>${formatRupiah(totalOmzet ? totalOmzet.s : 0)}</b>\n`;
      statText += `└ 📦 Total Stok Ready: <b>${totalStock.c} Account</b>\n\n`;

      statText += `🏆 <b>TOP 3 PRODUK TERLARIS:</b>\n`;
      if (!topProducts || topProducts.length === 0) {
        statText += `<i>Belum ada data penjualan.</i>\n\n`;
      } else {
        const medals = ['🥇', '🥈', '🥉'];
        topProducts.forEach((p, idx) => {
          statText += `${medals[idx] || '•'} <b>${p.category} - ${p.name}</b>\n`;
          statText += `   └ Terjual: <b>${p.sold_qty || 1} pcs</b> | Omzet: <b>${formatRupiah(p.total_sales)}</b>\n`;
        });
        statText += `\n`;
      }

      statText += `💎 <b>TOP 3 USER PALING LOYAL (TOP SPENDER):</b>\n`;
      if (!topUsers || topUsers.length === 0) {
        statText += `<i>Belum ada data pembeli.</i>\n\n`;
      } else {
        const crowns = ['🥇', '🥈', '🥉'];
        topUsers.forEach((u, idx) => {
          const name = u.username ? `@${u.username}` : (u.first_name || `ID ${u.telegram_id}`);
          statText += `${crowns[idx] || '•'} <b>${name}</b> (<code>${u.telegram_id}</code>)\n`;
          statText += `   └ Total Belanja: <b>${formatRupiah(u.total_spent)}</b> (${u.order_count}x order)\n`;
        });
        statText += `\n`;
      }

      statText += `Pilih aksi di bawah:`;

      const statButtons = [
        [{ text: '📥 Export Laporan Penjualan (CSV)', callback_data: 'admin_export_csv' }],
        [{ text: '💾 Backup Database (ZIP)', callback_data: 'admin_backup_zip' }],
        [{ text: '✏️ Edit Saldo User', callback_data: 'admin_edit_user_bal_prompt' }]
      ];

      return bot.sendMessage(chatId, statText, { parse_mode: 'HTML', reply_markup: sanitizeReplyMarkup({ inline_keyboard: statButtons }) });
    }

    if (text === '📢 Broadcast') {
      userStates[chatId] = { step: 'AWAITING_BROADCAST_MSG' };
      return bot.sendMessage(chatId, `📢 <b>BROADCAST PESAN AMAN</b>\n\nKirimkan teks atau foto yang ingin disiarkan ke seluruh pengguna terdaftar:`, {
        parse_mode: 'HTML',
        reply_markup: getCancelInlineKeyboard()
      });
    }
  }

  // PRIORITY 5: Category Number Selector
  if (/^\d+$/.test(text)) {
    const selectedNum = parseInt(text);
    return showCategoryByIndex(chatId, selectedNum, null);
  }
});

// BULK TXT IMPORT
bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const state = userStates[chatId];

  if (state && state.step === 'AWAITING_STOCK_TXT') {
    const doc = msg.document;
    if (!doc.file_name.endsWith('.txt')) {
      return bot.sendMessage(chatId, '❌ Format file harus berupa <code>.txt</code>', { parse_mode: 'HTML', reply_markup: getCancelInlineKeyboard() });
    }

    try {
      const fileContent = await downloadTextFile(doc.file_id);
      const lines = fileContent.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

      const productId = state.productId;
      const product = await dbGet('SELECT * FROM products WHERE id = ?', [productId]);
      const existingStock = await dbAll('SELECT email, password FROM product_stock WHERE product_id = ?', [productId]);

      const existingSet = new Set(existingStock.map(s => `${s.email}|${s.password}`));

      let validList = [];
      let invalidCount = 0;
      let duplicateCount = 0;

      for (const line of lines) {
        const parts = line.split('|');
        if (parts.length < 2) {
          invalidCount++;
          continue;
        }

        const email = parts[0].trim();
        const password = parts[1].trim();
        const extra = parts.slice(2).join('|').trim();
        const key = `${email}|${password}`;

        if (existingSet.has(key)) {
          duplicateCount++;
        } else {
          existingSet.add(key);
          validList.push({ email, password, extra });
        }
      }

      userStates[chatId] = {
        step: 'CONFIRM_BULK_TXT',
        productId,
        validList
      };

      let preview = `📄 <b>HASIL ANALISA IMPORT TXT</b>\n\n`;
      preview += `Produk: <b>${product.category} - ${product.name}</b>\n`;
      preview += `File: <code>${doc.file_name}</code>\n\n`;
      preview += `📊 Total Baris: <b>${lines.length}</b>\n`;
      preview += `✅ Valid: <b>${validList.length}</b>\n`;
      preview += `⚠️ Invalid Format: <b>${invalidCount}</b>\n`;
      preview += `🔄 Duplicate: <b>${duplicateCount}</b>\n\n`;
      preview += `Akan ditambahkan: <b>${validList.length} Account</b>`;

      const confirmButtons = [
        [{ text: `✅ IMPORT ${validList.length} ACCOUNT`, callback_data: 'confirm_bulk_txt_import' }],
        [{ text: '❌ BATAL', callback_data: 'cancel_bulk_txt_import' }]
      ];

      bot.sendMessage(chatId, preview, { parse_mode: 'HTML', reply_markup: sanitizeReplyMarkup({ inline_keyboard: confirmButtons }) });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Gagal membaca file: ${err.message}`);
    }
  }
});

// PHOTO LISTENER (Broadcast Only)
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const state = userStates[chatId];
  if (!state) return;

  const photoFileId = msg.photo[msg.photo.length - 1].file_id;

  if (state.step === 'AWAITING_BROADCAST_MSG') {
    const allUsers = await dbAll('SELECT telegram_id FROM users');
    delete userStates[chatId];

    bot.sendMessage(chatId, `⏳ Memulai photo broadcast aman ke ${allUsers.length} pengguna...`);

    const count = await sendRateLimitedBroadcast(allUsers, async (u) => {
      await bot.sendPhoto(u.telegram_id, photoFileId, { caption: msg.caption || '📢 <b>INFORMASI TOKO</b>', parse_mode: 'HTML' });
    });

    return bot.sendMessage(chatId, `✅ <b>PHOTO BROADCAST SELESAI</b>\n\nFoto terkirim ke <b>${count} / ${allUsers.length}</b> pengguna.`, { parse_mode: 'HTML' });
  }
});

// CALLBACK QUERY HANDLER
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  const user = await registerUser(query.from);

  if (data === 'cancel_state') {
    delete userStates[chatId];
    bot.answerCallbackQuery(query.id, { text: 'Aksi dibatalkan' });
    return renderCatalog(chatId, 1, messageId);
  }

  if (data === 'show_flash_sale') {
    bot.answerCallbackQuery(query.id);
    return showFlashSale(chatId, messageId);
  }

  if (data.startsWith('fs_buy_')) {
    const fsIndex = parseInt(data.split('_')[2]) - 1;
    const fsItem = FLASH_SALE_ITEMS[fsIndex];
    if (fsItem) {
      bot.answerCallbackQuery(query.id, { text: `Memuat ${fsItem.name}...` });
      const product = await getOrCreateFlashSaleProduct(fsItem);
      const stock = await dbGet('SELECT COUNT(*) as count FROM product_stock WHERE product_id = ? AND status = \'available\'', [product.id]);

      let text = `🛒 <b>DETAIL VARIASI PRODUK (FLASH SALE)</b>\n`;
      text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
      text += `🏷️ <b>Kategori:</b> ${product.category}\n`;
      text += `📦 <b>Variasi:</b> ${product.name}\n`;
      text += `💰 <b>Harga Flash Sale:</b> <b>${formatRupiah(product.price)}</b> <s>${formatRupiah(fsItem.origPrice)}</s>\n`;
      text += `📊 <b>Stok Tersedia:</b> <b>${stock.count > 0 ? '🟢 ' + stock.count + ' Akun' : '🔴 Habis'}</b>\n`;
      text += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      text += `📝 <b>Keterangan:</b>\n<i>${product.description || 'Full akses garansi 100%'}</i>\n\n`;
      text += `⚡ <i>Pesanan akan langsung diproses dan dikirim otomatis 24 Jam.</i>`;

      const buttons = [];
      if (stock.count > 0) {
        buttons.push([{ text: `🛒 Beli 1 Pcs (${formatRupiah(product.price)})`, callback_data: `buy_choose_${product.id}_1` }]);
        buttons.push([{ text: '📦 Beli Grosir / Banyak', callback_data: `buy_bulk_prompt_${product.id}` }]);
      } else {
        buttons.push([{ text: '🔴 STOK HABIS (Hubungi Admin)', callback_data: 'noop' }]);
      }
      buttons.push([{ text: '🔙 Kembali ke Flash Sale', callback_data: 'show_flash_sale' }]);

      return editOrSendMessage(chatId, messageId, text, { inline_keyboard: buttons });
    }
  }

  if (data === 'deposit_prompt') {
    userStates[chatId] = { step: 'AWAITING_DEPOSIT_AMOUNT' };
    bot.sendMessage(chatId, `💰 <b>DEPOSIT SALDO INSTAN</b>\n\nSaldo Anda saat ini: <b>${formatRupiah(user.balance)}</b>\n\nMasukkan nominal deposit:\nMinimal deposit: <b>${formatRupiah(config.MIN_DEPOSIT)}</b>`, {
      parse_mode: 'HTML',
      reply_markup: getCancelInlineKeyboard()
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data === 'search_prompt') {
    userStates[chatId] = { step: 'AWAITING_SEARCH_KEYWORD' };
    bot.sendMessage(chatId, `🔍 <b>CARI PRODUK</b>\n\nKetik nama produk yang ingin Anda cari:`, {
      parse_mode: 'HTML',
      reply_markup: getCancelInlineKeyboard()
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data === 'warranty_prompt') {
    userStates[chatId] = { step: 'AWAITING_WARRANTY_INPUT' };
    bot.sendMessage(chatId, `🛡️ <b>KLAIM GARANSI PRODUK</b>\n\nFormat klaim:\n<code>ORDER_CODE | KELUHAN</code>\n\nContoh:\n<code>ORD-1725000000 | Password akun salah</code>`, {
      parse_mode: 'HTML',
      reply_markup: getCancelInlineKeyboard()
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data === 'check_join_status') {
    const isJoined = await checkChannelMember(query.from.id);
    if (isJoined) {
      bot.answerCallbackQuery(query.id, { text: '✅ Terima kasih! Kamu telah bergabung.', show_alert: true });
      try { await bot.deleteMessage(chatId, messageId); } catch(e) {}
      return sendStartDashboard(chatId, user);
    } else {
      return bot.answerCallbackQuery(query.id, { text: '❌ Kamu belum bergabung ke channel kami!', show_alert: true });
    }
  }

  if (data.startsWith('cat_page_')) {
    delete userStates[chatId];
    const page = parseInt(data.split('_')[2]);
    await renderCatalog(chatId, page, messageId);
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('sel_cat_idx_')) {
    delete userStates[chatId];
    const idx = parseInt(data.replace('sel_cat_idx_', ''));
    await showCategoryByIndex(chatId, idx, messageId);
    return bot.answerCallbackQuery(query.id);
  }

  // === PAYMENT & DEPOSIT STATUS REFRESH & CANCEL CALLBACKS ===
  if (data.startsWith('chk_pay_')) {
    const orderCode = data.replace('chk_pay_', '');
    const pay = await dbGet(`
      SELECT p.*, o.order_code, o.product_id, o.qty, o.amount as order_amount, o.voucher_code, o.discount_amount, o.status as order_status, u.telegram_id, u.username, pr.name as prod_name, pr.category
      FROM payments p
      JOIN orders o ON p.order_id = o.id
      JOIN products pr ON o.product_id = pr.id
      JOIN users u ON p.user_id = u.id
      WHERE o.order_code = ?
    `, [orderCode]);

    if (!pay) {
      return bot.answerCallbackQuery(query.id, { text: 'Transaksi tidak ditemukan.', show_alert: true });
    }

    if (pay.order_status === 'completed' || pay.status === 'paid') {
      return bot.answerCallbackQuery(query.id, { text: '✅ Pembayaran SUKSES & pesanan telah selesai dikirim!', show_alert: true });
    }

    if (pay.order_status === 'cancelled' || pay.status === 'cancelled') {
      return bot.answerCallbackQuery(query.id, { text: '❌ Pesanan ini telah dibatalkan.', show_alert: true });
    }

    if (pay.order_status === 'expired' || pay.status === 'expired') {
      return bot.answerCallbackQuery(query.id, { text: '⚠️ Waktu pembayaran telah kadaluarsa.', show_alert: true });
    }

    const result = await CodeGatraService.processSingleProductPayment(pay, { bot, dbRun, dbGet, dbAll, dbTransaction, formatRupiah });
    if (result.status === 'paid') {
      return bot.answerCallbackQuery(query.id, { text: '🎉 Pembayaran terdeteksi LUNAS! Akun Anda telah dikirim.', show_alert: true });
    } else if (result.status === 'expired') {
      return bot.answerCallbackQuery(query.id, { text: '⚠️ Pembayaran telah kadaluarsa.', show_alert: true });
    } else {
      return bot.answerCallbackQuery(query.id, { text: '⏳ Pembayaran belum terdeteksi. Silakan transfer sesuai total nominal (termasuk kode unik).', show_alert: true });
    }
  }

  if (data.startsWith('cnc_pay_')) {
    const orderCode = data.replace('cnc_pay_', '');
    const order = await dbGet('SELECT * FROM orders WHERE order_code = ? AND user_id = ?', [orderCode, user.id]);
    if (!order) {
      return bot.answerCallbackQuery(query.id, { text: 'Pesanan tidak ditemukan.', show_alert: true });
    }
    if (order.status === 'completed') {
      return bot.answerCallbackQuery(query.id, { text: 'Pesanan sudah selesai dan tidak dapat dibatalkan.', show_alert: true });
    }
    if (order.status === 'cancelled') {
      return bot.answerCallbackQuery(query.id, { text: 'Pesanan sudah dibatalkan sebelumnya.', show_alert: true });
    }

    await dbRun("UPDATE orders SET status = 'cancelled' WHERE id = ?", [order.id]);
    await dbRun("UPDATE payments SET status = 'cancelled' WHERE order_id = ?", [order.id]);

    bot.answerCallbackQuery(query.id, { text: '❌ Pesanan berhasil dibatalkan.' });
    return bot.sendMessage(chatId, `❌ <b>PESANAN DIBATALKAN</b>\n\nOrder <code>#${orderCode}</code> telah berhasil dibatalkan.\nSilakan gunakan menu /start untuk melihat produk lainnya.`, { parse_mode: 'HTML' });
  }

  if (data.startsWith('chk_dep_')) {
    const depCode = data.replace('chk_dep_', '');
    const dep = await dbGet(`
      SELECT d.*, u.telegram_id, u.username, u.balance as user_balance
      FROM deposits d
      JOIN users u ON d.user_id = u.id
      WHERE d.deposit_code = ?
    `, [depCode]);

    if (!dep) {
      return bot.answerCallbackQuery(query.id, { text: 'Deposit tidak ditemukan.', show_alert: true });
    }

    if (dep.status === 'approved') {
      return bot.answerCallbackQuery(query.id, { text: '✅ Deposit SUKSES & saldo sudah masuk ke akun Anda!', show_alert: true });
    }

    if (dep.status === 'cancelled') {
      return bot.answerCallbackQuery(query.id, { text: '❌ Deposit ini telah dibatalkan.', show_alert: true });
    }

    if (dep.status === 'expired') {
      return bot.answerCallbackQuery(query.id, { text: '⚠️ Deposit telah kadaluarsa.', show_alert: true });
    }

    const result = await CodeGatraService.processSingleDeposit(dep, { bot, dbRun, dbGet, dbAll, dbTransaction, formatRupiah });
    if (result.status === 'paid') {
      return bot.answerCallbackQuery(query.id, { text: '🎉 Deposit BERHASIL! Saldo Anda telah otomatis ditambahkan.', show_alert: true });
    } else if (result.status === 'expired') {
      return bot.answerCallbackQuery(query.id, { text: '⚠️ Deposit telah kadaluarsa.', show_alert: true });
    } else {
      return bot.answerCallbackQuery(query.id, { text: '⏳ Pembayaran deposit belum terdeteksi. Pastikan Anda mentransfer nominal persis.', show_alert: true });
    }
  }

  if (data.startsWith('cnc_dep_')) {
    const depCode = data.replace('cnc_dep_', '');
    const dep = await dbGet('SELECT * FROM deposits WHERE deposit_code = ? AND user_id = ?', [depCode, user.id]);
    if (!dep) {
      return bot.answerCallbackQuery(query.id, { text: 'Deposit tidak ditemukan.', show_alert: true });
    }
    if (dep.status === 'approved') {
      return bot.answerCallbackQuery(query.id, { text: 'Deposit sudah selesai dan tidak dapat dibatalkan.', show_alert: true });
    }
    if (dep.status === 'cancelled') {
      return bot.answerCallbackQuery(query.id, { text: 'Deposit sudah dibatalkan sebelumnya.', show_alert: true });
    }

    await dbRun("UPDATE deposits SET status = 'cancelled' WHERE id = ?", [dep.id]);

    bot.answerCallbackQuery(query.id, { text: '❌ Deposit berhasil dibatalkan.' });
    return bot.sendMessage(chatId, `❌ <b>DEPOSIT DIBATALKAN</b>\n\nKode Deposit <code>#${depCode}</code> telah dibatalkan.`, { parse_mode: 'HTML' });
  }

  // === OTP CALLBACKS ===
  if (data.startsWith('osp_')) {
    const page = parseInt(data.replace('osp_', ''));
    await renderOtpServicesMenu(chatId, messageId, page);
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('os_')) {
    const serviceCode = data.replace('os_', '');
    const cachedServices = userStates[chatId]?.otp_services_cache || [];
    const foundSvc = cachedServices.find(s => String(s.service_code) === String(serviceCode));
    const serviceName = foundSvc ? foundSvc.service_name : `Service #${serviceCode}`;

    userStates[chatId] = userStates[chatId] || {};
    userStates[chatId].selected_otp_svc = { code: serviceCode, name: serviceName };

    const res = await OtpService.getCountries(serviceCode);
    if (!res.success || !res.data || res.data.length === 0) {
      return bot.sendMessage(chatId, `❌ Layanan <b>${serviceName}</b> sedang tidak tersedia/habis stok.`, { parse_mode: 'HTML' });
    }

    userStates[chatId].otp_countries_cache = res.data;

    let text = `📱 <b>ORDER OTP (${serviceName.toUpperCase()})</b>\n\nPilih negara asal nomor HP:`;
    const buttons = [];

    res.data.slice(0, 10).forEach((c, idx) => {
      const rawPrice = Number(c.price || c.rate || c.cost || c.harga || c.amount || c.price_idr || 0);
      const margin = Number(config.OTP_PROFIT_MARGIN || 1500);
      const finalPrice = rawPrice > 0 ? (rawPrice + margin) : margin;

      buttons.push([{ text: `🏳️ ${c.name} (${formatRupiah(finalPrice)})`, callback_data: `oc_${idx}` }]);
    });

    buttons.push([{ text: '🔙 Batal', callback_data: 'cancel_state' }]);
    await editOrSendMessage(chatId, messageId, text, { inline_keyboard: buttons });
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('oc_')) {
    const idx = parseInt(data.replace('oc_', ''));
    const countryList = userStates[chatId]?.otp_countries_cache || [];
    const country = countryList[idx];

    if (!country) {
      return bot.sendMessage(chatId, '❌ Sesi pemilihan negara kadaluarsa. Silakan ulangi pemesanan!');
    }

    const svc = userStates[chatId]?.selected_otp_svc || { code: '13', name: 'OTP' };
    const rawPrice = Number(country.price || country.rate || country.cost || country.harga || country.amount || country.price_idr || 0);
    const margin = Number(config.OTP_PROFIT_MARGIN || 1500);
    const finalPrice = rawPrice > 0 ? (rawPrice + margin) : margin;

    userStates[chatId].selected_otp_country = country;
    userStates[chatId].selected_otp_price = finalPrice;

    let text = `📱 <b>KONFIRMASI ORDER OTP</b>\n\n`;
    text += `Aplikasi: <b>${svc.name}</b>\n`;
    text += `Negara: <b>${country.name}</b>\n`;
    text += `Harga OTP: <b>${formatRupiah(finalPrice)}</b>\n`;
    text += `Saldo Kamu: <b>${formatRupiah(user.balance)}</b>\n\n`;
    text += `Silakan pilih metode pembayaran:`;

    const buttons = [
      [{ text: '💰 BAYAR DENGAN SALDO', callback_data: `opay_bal` }],
      [{ text: '🔙 Batal', callback_data: 'cancel_state' }]
    ];

    await editOrSendMessage(chatId, messageId, text, { inline_keyboard: buttons });
    return bot.answerCallbackQuery(query.id);
  }

  if (data === 'opay_bal') {
    const svc = userStates[chatId]?.selected_otp_svc;
    const country = userStates[chatId]?.selected_otp_country;
    const price = userStates[chatId]?.selected_otp_price;

    if (!svc || !price) {
      return bot.sendMessage(chatId, '❌ Sesi pemesanan OTP kadaluarsa. Silakan ulangi!');
    }

    if (user.balance < price) {
      return bot.answerCallbackQuery(query.id, { text: `Saldo Anda tidak mencukupi (${formatRupiah(price)}). Silakan deposit dahulu!`, show_alert: true });
    }

    const providerId = country ? (country.provider_id || 1) : 1;
    const operatorId = country ? (country.operator_id || 1) : 1;

    const orderRes = await OtpService.orderNumber({ serviceId: svc.code, providerId, operatorId });
    if (!orderRes.success || !orderRes.data) {
      return bot.sendMessage(chatId, `❌ Gagal memesan nomor OTP dari provider: ${orderRes.message || 'Nomor sedang habis untuk negara/layanan ini.'}`);
    }

    const roData = orderRes.data;
    const localOrderCode = 'OTP-' + Date.now();
    const actualPrice = Number(roData.price || price);

    await dbTransaction(async ({ dbRun }) => {
      await dbRun('UPDATE users SET balance = balance - ? WHERE id = ?', [actualPrice, user.id]);
      await dbRun('INSERT INTO balance_history (user_id, amount, type, description) VALUES (?, ?, \'PURCHASE\', ?)', [user.id, -actualPrice, `Order OTP ${svc.name} #${localOrderCode}`]);
      await dbRun(
        'INSERT INTO otp_orders (order_code, provider_order_id, user_id, service_name, phone_number, amount, status) VALUES (?, ?, ?, ?, ?, ?, \'active\')',
        [localOrderCode, roData.order_id, user.id, svc.name, roData.phone_number, actualPrice]
      );
    });

    let activeText = `📱 <b>NOMOR OTP BERHASIL DIPESAN</b>\n\n`;
    activeText += `Order Code: <code>#${localOrderCode}</code>\n`;
    activeText += `Aplikasi: <b>${svc.name}</b>\n`;
    activeText += `Nomor HP: <code>${roData.phone_number}</code>\n\n`;
    activeText += `⚡ <i>Sistem otomatis memantau SMS OTP. Ketika kode masuk, bot akan langsung mengirimkannya ke Anda!</i>\n`;
    activeText += `Klik tombol <b>🔄 Cek OTP</b> jika ingin memicu cek manual:`;

    const activeButtons = [
      [{ text: '🔄 Cek Kode OTP (Manual)', callback_data: `ochk_${roData.order_id}_${localOrderCode}` }],
      [{ text: '❌ Batalkan & Refund', callback_data: `ocnl_${roData.order_id}_${localOrderCode}` }]
    ];

    await editOrSendMessage(chatId, messageId, activeText, { inline_keyboard: activeButtons });
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('ochk_')) {
    const parts = data.split('_');
    const roOrderId = parts[1];
    const localOrderCode = parts[2];

    const statusRes = await OtpService.getOrderStatus(roOrderId);
    if (!statusRes.success || !statusRes.data) {
      return bot.answerCallbackQuery(query.id, { text: '⚠️ Belum ada OTP masuk. Silakan tunggu sebentar!', show_alert: true });
    }

    const sData = statusRes.data;
    if (sData.otp_code) {
      await dbRun('UPDATE otp_orders SET status = \'completed\', otp_code = ?, completed_at = DATETIME(\'now\', \'localtime\') WHERE order_code = ?', [sData.otp_code, localOrderCode]);

      let doneText = `🎉 <b>KODE OTP BERHASIL DITERIMA!</b>\n\n`;
      doneText += `Aplikasi: <b>${sData.service}</b>\n`;
      doneText += `Nomor HP: <code>${sData.phone_number}</code>\n\n`;
      doneText += `🔑 <b>KODE OTP:</b> <code>${sData.otp_code}</code>\n\n`;
      if (sData.otp_msg) doneText += `Pesan SMS:\n<code>${sData.otp_msg}</code>\n\n`;
      doneText += `Terima kasih telah berbelanja di <b>${config.STORE_NAME}</b>!`;

      await editOrSendMessage(chatId, messageId, doneText, { inline_keyboard: [] });
      return bot.answerCallbackQuery(query.id, { text: '🎉 Kode OTP Berhasil Diterima!', show_alert: true });
    } else {
      return bot.answerCallbackQuery(query.id, { text: '⏳ SMS OTP belum masuk. Harap tunggu!', show_alert: true });
    }
  }

  if (data.startsWith('ocnl_')) {
    const parts = data.split('_');
    const roOrderId = parts[1];
    const localOrderCode = parts[2];

    await OtpService.setOrderStatus(roOrderId, 'cancel');
    const dbOtp = await dbGet('SELECT * FROM otp_orders WHERE order_code = ?', [localOrderCode]);

    if (dbOtp && dbOtp.status === 'active') {
      await dbTransaction(async ({ dbRun }) => {
        await dbRun('UPDATE users SET balance = balance + ? WHERE id = ?', [dbOtp.amount, user.id]);
        await dbRun('UPDATE otp_orders SET status = \'cancelled\' WHERE order_code = ?', [localOrderCode]);
        await dbRun('INSERT INTO balance_history (user_id, amount, type, description) VALUES (?, ?, \'REFUND\', ?)', [user.id, dbOtp.amount, `Refund Pembatalan OTP #${localOrderCode}`]);
      });

      bot.sendMessage(chatId, `✅ <b>ORDER OTP DIBATALKAN</b>\n\nOrder #${localOrderCode} berhasil dibatalkan. Saldo sebesar <b>${formatRupiah(dbOtp.amount)}</b> telah dikembalikan ke akun Anda!`, { parse_mode: 'HTML' });
    }
    return bot.answerCallbackQuery(query.id);
  }

  // === PRODUCT DETAIL & CHECKOUT CALLBACKS ===
  if (data.startsWith('prod_detail_')) {
    delete userStates[chatId];
    const prodId = parseInt(data.split('_')[2]);
    const product = await dbGet('SELECT * FROM products WHERE id = ?', [prodId]);
    const stock = await dbGet('SELECT COUNT(*) as count FROM product_stock WHERE product_id = ? AND status = \'available\'', [prodId]);

    let text = `🛒 <b>DETAIL VARIASI PRODUK</b>\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `🏷️ <b>Kategori:</b> ${product.category}\n`;
    text += `📦 <b>Variasi:</b> ${product.name}\n`;
    text += `💰 <b>Harga Satuan:</b> <b>${formatRupiah(product.price)}</b>\n`;
    text += `📊 <b>Stok Tersedia:</b> <b>${stock.count > 0 ? '🟢 ' + stock.count + ' Akun' : '🔴 Habis'}</b>\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    text += `📝 <b>Keterangan:</b>\n<i>${product.description || 'Full akses garansi 100%'}</i>\n\n`;
    text += `⚡ <i>Pesanan akan langsung diproses dan dikirim otomatis 24 Jam.</i>`;

    const buttons = [];
    if (stock.count > 0) {
      buttons.push([{ text: '🛒 Beli 1 Pcs', callback_data: `buy_choose_${product.id}_1` }]);
      buttons.push([{ text: '📦 Beli Grosir / Banyak', callback_data: `buy_bulk_prompt_${product.id}` }]);
    } else {
      buttons.push([{ text: '🔴 STOK HABIS', callback_data: 'noop' }]);
    }
    buttons.push([{ text: '🔙 Kembali ke Katalog', callback_data: 'cat_page_1' }]);

    await editOrSendMessage(chatId, messageId, text, { inline_keyboard: buttons });
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('buy_bulk_prompt_')) {
    delete userStates[chatId];
    const prodId = parseInt(data.replace('buy_bulk_prompt_', ''));
    const product = await dbGet('SELECT * FROM products WHERE id = ?', [prodId]);
    const stock = await dbGet('SELECT COUNT(*) as count FROM product_stock WHERE product_id = ? AND status = \'available\'', [prodId]);

    let text = `📦 <b>PEMBELIAN GROSIR / BULK</b>\n\n`;
    text += `Kategori: <b>${product.category}</b>\n`;
    text += `Variasi: <b>${product.name}</b>\n`;
    text += `Harga Satuan: <b>${formatRupiah(product.price)}</b>\n`;
    text += `Stok Tersedia: <b>${stock.count} Account</b>\n\n`;
    text += `Pilih jumlah yang ingin dibeli:`;

    const buttons = [
      [
        { text: '2 Pcs', callback_data: `buy_choose_${product.id}_2` },
        { text: '3 Pcs', callback_data: `buy_choose_${product.id}_3` },
        { text: '5 Pcs', callback_data: `buy_choose_${product.id}_5` },
        { text: '10 Pcs', callback_data: `buy_choose_${product.id}_10` }
      ],
      [{ text: '✏️ Input Jumlah Custom', callback_data: `buy_custom_qty_${product.id}` }],
      [{ text: '🔙 Batal', callback_data: `prod_detail_${product.id}` }]
    ];

    await editOrSendMessage(chatId, messageId, text, { inline_keyboard: buttons });
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('buy_custom_qty_')) {
    const prodId = parseInt(data.replace('buy_custom_qty_', ''));
    userStates[chatId] = { step: 'AWAITING_CUSTOM_BUY_QTY', productId: prodId };
    bot.sendMessage(chatId, `✏️ <b>INPUT JUMLAH GROSIR</b>\n\nKetik jumlah angka produk yang ingin dibeli:\nContoh: <code>15</code>`, {
      parse_mode: 'HTML',
      reply_markup: sanitizeReplyMarkup({ inline_keyboard: [[{ text: '🔙 Batal', callback_data: `prod_detail_${prodId}` }]] })
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('voucher_checkout_')) {
    const parts = data.split('_');
    const prodId = parseInt(parts[2]);
    const qty = parseInt(parts[3]) || 1;

    userStates[chatId] = { step: 'AWAITING_CHECKOUT_VOUCHER', productId: prodId, qty: qty };
    bot.sendMessage(chatId, `🎟️ <b>GUNAKAN VOUCHER DISKON</b>\n\nKetik kode voucher promo Anda (contoh: <code>HEMAT5K</code>):`, {
      parse_mode: 'HTML',
      reply_markup: sanitizeReplyMarkup({ inline_keyboard: [[{ text: '🔙 Batal', callback_data: `buy_choose_${prodId}_${qty}` }]] })
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('buy_choose_')) {
    delete userStates[chatId];
    const parts = data.split('_');
    const prodId = parseInt(parts[2]);
    const qty = parseInt(parts[3]) || 1;
    const voucherCode = parts[4] || null;

    const product = await dbGet('SELECT * FROM products WHERE id = ?', [prodId]);
    let appliedVoucher = null;
    if (voucherCode) {
      const vCheck = await PaymentService.validateVoucher(dbGet, voucherCode, user.id, product.price * qty);
      if (vCheck.valid) appliedVoucher = vCheck;
    }

    await sendPaymentChoice(chatId, messageId, user, product, qty, appliedVoucher);
    return bot.answerCallbackQuery(query.id);
  }

  // === PAY WITH BALANCE (ATOMIC ACID TRANSACTION) ===
  if (data.startsWith('pay_bal_')) {
    delete userStates[chatId];
    const parts = data.split('_');
    const prodId = parseInt(parts[2]);
    const qty = parseInt(parts[3]) || 1;
    const voucherCode = parts[4] || null;

    const product = await dbGet('SELECT * FROM products WHERE id = ?', [prodId]);
    const grossTotal = product.price * qty;

    let discountAmount = 0;
    let validVoucherObj = null;

    if (voucherCode) {
      const vCheck = await PaymentService.validateVoucher(dbGet, voucherCode, user.id, grossTotal);
      if (vCheck.valid) {
        discountAmount = vCheck.discountAmount;
        validVoucherObj = vCheck.voucher;
      }
    }

    const finalTotal = Math.max(0, grossTotal - discountAmount);

    if (user.balance < finalTotal) {
      return bot.answerCallbackQuery(query.id, {
        text: `Saldo Anda tidak mencukupi (${formatRupiah(finalTotal)}). Silakan deposit terlebih dahulu!`,
        show_alert: true
      });
    }

    try {
      const orderCode = 'ORD-' + Date.now();
      const stockItems = await dbAll('SELECT * FROM product_stock WHERE product_id = ? AND status = \'available\' LIMIT ?', [prodId, qty]);

      if (stockItems.length < qty) {
        return bot.sendMessage(chatId, `❌ Maaf, stok produk ini tersisa ${stockItems.length} account. Pembelian dibatalkan.`);
      }

      await dbTransaction(async ({ dbRun }) => {
        await dbRun('UPDATE users SET balance = balance - ? WHERE id = ?', [finalTotal, user.id]);
        await dbRun(
          'INSERT INTO balance_history (user_id, amount, type, description) VALUES (?, ?, \'PURCHASE\', ?)',
          [user.id, -finalTotal, `Beli ${product.category} - ${product.name} (${qty} Pcs) #${orderCode}`]
        );

        for (const item of stockItems) {
          await dbRun('UPDATE product_stock SET status = \'sold\', order_id = ?, sold_at = DATETIME(\'now\', \'localtime\') WHERE id = ?', [orderCode, item.id]);
        }

        await dbRun(
          'INSERT INTO orders (order_code, user_id, product_id, stock_id, qty, gross_amount, discount_amount, voucher_code, amount, payment_method, status, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, \'BALANCE\', \'completed\', DATETIME(\'now\', \'localtime\'))',
          [orderCode, user.id, product.id, stockItems[0].id, qty, grossTotal, discountAmount, voucherCode, finalTotal]
        );

        if (validVoucherObj) {
          await PaymentService.recordVoucherUsage(dbRun, validVoucherObj.id, user.id, orderCode, discountAmount);
        }
      });

      let successMsg = `🎉 <b>PEMBELIAN BERHASIL (${qty} Pcs)</b>\n\n`;
      successMsg += `Order Code: <code>#${orderCode}</code>\n`;
      successMsg += `Produk: <b>${product.category} - ${product.name}</b> (${qty} Pcs)\n`;
      if (discountAmount > 0) successMsg += `Diskon Voucher: <b>-${formatRupiah(discountAmount)}</b>\n`;
      successMsg += `Total Bayar: <b>${formatRupiah(finalTotal)}</b>\n\n`;
      successMsg += `━━━━━━━━━━━━━━━━━━\n`;
      successMsg += `📦 <b>DETAIL AKUN / CREDENTIAL (${qty} Pcs):</b>\n\n`;

      stockItems.forEach((item, index) => {
        successMsg += `<b>[${index + 1}]</b>\n`;
        successMsg += `📧 <b>Email:</b> <code>${item.email}</code>\n`;
        successMsg += `🔑 <b>Password:</b> <code>${item.password}</code>\n`;
        if (item.extra_data) successMsg += `ℹ️ <b>Extra:</b> <code>${item.extra_data}</code>\n`;
        successMsg += `\n`;
      });

      successMsg += `━━━━━━━━━━━━━━━━━━\n\n`;
      successMsg += `✅ Akun tersimpan otomatis di menu <b>📜 Riwayat Transaksi</b> (/riwayat).\n`;
      successMsg += `Terima kasih telah berbelanja di <b>${config.STORE_NAME}</b>!`;

      bot.sendMessage(chatId, successMsg, { parse_mode: 'HTML' });
      return bot.answerCallbackQuery(query.id);
    } catch (err) {
      bot.sendMessage(chatId, `❌ Terjadi kesalahan saat memproses transaksi: ${err.message}`);
      return bot.answerCallbackQuery(query.id);
    }
  }

  // === PAY WITH QRIS (AUTO CODEGATRA EXCLUSIVE) ===
  if (data.startsWith('pay_qris_')) {
    delete userStates[chatId];
    const parts = data.split('_');
    const prodId = parseInt(parts[2]);
    const qty = parseInt(parts[3]) || 1;
    const voucherCode = parts[4] || null;

    const product = await dbGet('SELECT * FROM products WHERE id = ?', [prodId]);
    const grossTotal = product.price * qty;

    let discountAmount = 0;
    if (voucherCode) {
      const vCheck = await PaymentService.validateVoucher(dbGet, voucherCode, user.id, grossTotal);
      if (vCheck.valid) discountAmount = vCheck.discountAmount;
    }

    const finalAmount = Math.max(100, grossTotal - discountAmount);
    const orderCode = 'ORD-' + Date.now();

    await dbRun(
      'INSERT INTO orders (order_code, user_id, product_id, qty, gross_amount, discount_amount, voucher_code, amount, payment_method, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, \'QRIS\', \'pending\')',
      [orderCode, user.id, product.id, qty, grossTotal, discountAmount, voucherCode, finalAmount]
    );

    const payment = await PaymentService.createProductPayment({
      dbRun,
      orderCode,
      userId: user.id,
      grossAmount: grossTotal,
      discountAmount,
      voucherCode,
      customerName: query.from.username || query.from.first_name || 'Buyer'
    });

    if (payment.status !== 'success') {
      return bot.sendMessage(chatId, `❌ <b>Gagal membuat pembayaran QRIS:</b> ${payment.message}`, { parse_mode: 'HTML' });
    }

    const expTimeFormatted = formatExpiryWib(payment.expiredAt, payment.expiredMinutes);
    let qrisMsg = `⚡ <b>PEMBAYARAN QRIS OTOMATIS (${qty} Pcs)</b>\n\n`;
    qrisMsg += `Order Code: <code>#${orderCode}</code>\n`;
    qrisMsg += `Produk: <b>${product.category} - ${product.name}</b> (${qty} Pcs)\n`;
    qrisMsg += `Nominal: ${formatRupiah(payment.amount)}\n`;
    qrisMsg += `Kode Unik: <b>+${formatRupiah(payment.uniqueCode)}</b>\n`;
    qrisMsg += `━━━━━━━━━━━━━━━━━━\n`;
    qrisMsg += `💵 <b>TOTAL TRANSFER: ${formatRupiah(payment.totalAmount)}</b>\n`;
    qrisMsg += `<i>(Wajib transfer persis ${formatRupiah(payment.totalAmount)} agar otomatis lunas)</i>\n\n`;
    qrisMsg += `⏱️ Berlaku: <b>${payment.expiredMinutes} Menit</b> (s/d <b>${expTimeFormatted} WIB</b>)\n`;
    qrisMsg += `⚡ Begitu pembayaran terdeteksi, akun akan langsung otomatis dikirim ke chat ini!`;

    const qrisButtons = {
      inline_keyboard: [
        [
          { text: '🔄 Cek Status / Refresh', callback_data: `chk_pay_${orderCode}` },
          { text: '❌ Batalkan', callback_data: `cnc_pay_${orderCode}` }
        ]
      ]
    };

    await sendQrPhotoOrMessage(chatId, payment, qrisMsg, qrisButtons);
    return bot.answerCallbackQuery(query.id);
  }

  // === ADMIN CALLBACK ACTIONS ===
  if (data === 'admin_export_csv') {
    const orders = await dbAll(`
      SELECT o.id, o.order_code, o.amount, o.qty, o.payment_method, o.status, o.created_at, o.completed_at,
             p.name as product_name, p.category, u.username, u.telegram_id
      FROM orders o
      JOIN products p ON o.product_id = p.id
      JOIN users u ON o.user_id = u.id
      ORDER BY o.id DESC
    `);

    let csvContent = 'ID,OrderCode,Date,User,TelegramID,Category,Product,Qty,Amount,Method,Status\n';
    orders.forEach(o => {
      const dateStr = o.completed_at || o.created_at;
      csvContent += `${o.id},"${o.order_code}","${dateStr}","@${o.username || ''}",${o.telegram_id},"${o.category}","${o.product_name}",${o.qty || 1},${o.amount},"${o.payment_method}","${o.status}"\n`;
    });

    const csvPath = path.join(backupDir, `laporan_penjualan_${Date.now()}.csv`);
    fs.writeFileSync(csvPath, csvContent, 'utf8');

    await bot.sendDocument(chatId, csvPath, {
      caption: `📊 <b>LAPORAN PENJUALAN TOKO (CSV)</b>\nTotal Transaksi: <b>${orders.length} Order</b>\n📅 Waktu Export: <code>${getFormattedDate()}</code>`,
      parse_mode: 'HTML'
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data === 'admin_backup_zip') {
    try {
      const zip = new AdmZip();
      zip.addLocalFile(dbPath);
      const timeStamp = new Date().toISOString().replace(/[:.]/g, '-');
      const zipFileName = `backup_db_${timeStamp}.zip`;
      const zipFilePath = path.join(backupDir, zipFileName);
      zip.writeZip(zipFilePath);

      await bot.sendDocument(chatId, zipFilePath, {
        caption: `💾 <b>DATABASE BACKUP (ZIP)</b>\n📅 Waktu: <code>${getFormattedDate()}</code>`,
        parse_mode: 'HTML'
      });
    } catch (e) {
      bot.sendMessage(chatId, `❌ Backup error: ${e.message}`);
    }
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('admin_sel_stock_prod_')) {
    const prodId = parseInt(data.split('_')[4]);
    const buttons = [
      [{ text: '👤 INPUT MANUAL', callback_data: `add_stock_manual_${prodId}` }],
      [{ text: '📄 IMPORT TXT', callback_data: `add_stock_txt_${prodId}` }],
      [{ text: '🔙 Batal', callback_data: 'cancel_state' }]
    ];
    bot.sendMessage(chatId, `📦 <b>PILIH METODE ADD STOCK</b>`, { reply_markup: sanitizeReplyMarkup({ inline_keyboard: buttons }) });
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('add_stock_manual_')) {
    const prodId = parseInt(data.split('_')[3]);
    userStates[chatId] = { step: 'ADD_STOCK_MANUAL', productId: prodId };
    bot.sendMessage(chatId, `👤 <b>INPUT STOCK MANUAL</b>\n\nKirim data akun dengan format per baris:\n<code>email|password</code> atau <code>email|password|extra</code>`, {
      parse_mode: 'HTML',
      reply_markup: getCancelInlineKeyboard()
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('add_stock_txt_')) {
    const prodId = parseInt(data.split('_')[3]);
    userStates[chatId] = { step: 'AWAITING_STOCK_TXT', productId: prodId };
    bot.sendMessage(chatId, `📄 <b>IMPORT STOCK VIA FILE .TXT</b>\n\nSilakan upload file <code>.txt</code> yang berisi list akun dengan format per baris:\n<code>email|password</code>`, {
      parse_mode: 'HTML',
      reply_markup: getCancelInlineKeyboard()
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data === 'confirm_bulk_txt_import') {
    const state = userStates[chatId];
    if (state && state.step === 'CONFIRM_BULK_TXT') {
      let count = 0;
      for (const item of state.validList) {
        await dbRun('INSERT INTO product_stock (product_id, email, password, extra_data) VALUES (?, ?, ?, ?)', [state.productId, item.email, item.password, item.extra]);
        count++;
      }

      const prodId = state.productId;
      delete userStates[chatId];
      bot.sendMessage(chatId, `🎉 <b>IMPORT BERHASIL</b>\n\nSebanyak <b>${count} Account</b> berhasil ditambahkan ke database!`, { parse_mode: 'HTML' });

      if (count > 0) {
        sendRestockNotificationCard({
          productId: prodId,
          addedCount: count,
          addedBy: query.from.username || query.from.first_name || 'Admin'
        });
      }
    }
    return bot.answerCallbackQuery(query.id);
  }

  if (data === 'cancel_bulk_txt_import') {
    delete userStates[chatId];
    bot.sendMessage(chatId, `❌ Process Import TXT dibatalkan.`);
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('admin_manage_prod_')) {
    const prodId = parseInt(data.replace('admin_manage_prod_', ''));
    const prod = await dbGet('SELECT * FROM products WHERE id = ?', [prodId]);

    let text = `📦 <b>KELOLA PRODUK</b>\n\nKategori: <b>${prod.category}</b>\nVariasi: <b>${prod.name}</b>\nHarga: <b>${formatRupiah(prod.price)}</b>\nStatus: <b>${prod.status.toUpperCase()}</b>`;
    const buttons = [
      [{ text: '✏️ Edit Harga', callback_data: `admin_edit_price_prompt_${prod.id}` }],
      [{ text: prod.status === 'active' ? '🔴 Nonaktifkan Produk' : '🟢 Aktifkan Produk', callback_data: `admin_toggle_prod_${prod.id}` }],
      [{ text: '🗑️ Hapus Produk', callback_data: `admin_delete_prod_${prod.id}` }],
      [{ text: '🔙 Kembali', callback_data: 'cancel_state' }]
    ];

    bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: sanitizeReplyMarkup({ inline_keyboard: buttons }) });
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('admin_edit_price_prompt_')) {
    const prodId = parseInt(data.replace('admin_edit_price_prompt_', ''));
    const prod = await dbGet('SELECT * FROM products WHERE id = ?', [prodId]);

    userStates[chatId] = { step: 'AWAITING_EDIT_PRICE', productId: prodId };
    bot.sendMessage(chatId, `✏️ <b>EDIT HARGA PRODUK</b>\n\nProduk: <b>${prod.category} - ${prod.name}</b>\nHarga Saat Ini: <b>${formatRupiah(prod.price)}</b>\n\nMasukkan harga baru:`, {
      parse_mode: 'HTML',
      reply_markup: getCancelInlineKeyboard()
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('admin_toggle_prod_')) {
    const prodId = parseInt(data.replace('admin_toggle_prod_', ''));
    const prod = await dbGet('SELECT * FROM products WHERE id = ?', [prodId]);
    const newStatus = prod.status === 'active' ? 'inactive' : 'active';

    await dbRun('UPDATE products SET status = ? WHERE id = ?', [newStatus, prodId]);
    bot.sendMessage(chatId, `✅ Status produk <b>${prod.name}</b> diubah menjadi <b>${newStatus.toUpperCase()}</b>`, { parse_mode: 'HTML' });
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('admin_delete_prod_')) {
    const prodId = parseInt(data.replace('admin_delete_prod_', ''));
    await dbRun('DELETE FROM products WHERE id = ?', [prodId]);
    bot.sendMessage(chatId, `✅ Produk berhasil dihapus dari database.`);
    return bot.answerCallbackQuery(query.id);
  }

  if (data === 'admin_add_voucher_prompt') {
    userStates[chatId] = { step: 'AWAITING_VOUCHER_INPUT' };
    bot.sendMessage(chatId, `🎟️ <b>TAMBAH VOUCHER BARU</b>\n\nFormat:\n<code>KODE | POTONGAN | MIN_BELANJA | JUMLAH_STOK</code>\n\nContoh:\n<code>BOSPROMO|4500|5000|100</code>\n\n<i>Keterangan:</i>\n• <code>KODE</code>: Kode voucher (misal: BOSPROMO)\n• <code>POTONGAN</code>: Nominal diskon Rp (misal: 4500)\n• <code>MIN_BELANJA</code>: Minimal belanja (isi 0 jika tanpa min)\n• <code>JUMLAH_STOK</code>: Kuota pemakaian (isi 0 jika unlimited)`, {
      parse_mode: 'HTML',
      reply_markup: getCancelInlineKeyboard()
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('admin_del_voucher_')) {
    const vId = parseInt(data.replace('admin_del_voucher_', ''));
    await dbRun('DELETE FROM vouchers WHERE id = ?', [vId]);
    bot.sendMessage(chatId, `✅ Voucher berhasil dihapus.`);
    return bot.answerCallbackQuery(query.id);
  }

  if (data === 'admin_edit_user_bal_prompt') {
    userStates[chatId] = { step: 'AWAITING_EDIT_USER_BAL' };
    bot.sendMessage(chatId, `✏️ <b>EDIT SALDO USER</b>\n\nFormat:\n<code>TELEGRAM_ID|SALDO_BARU</code>\n\nContoh: <code>123456789|50000</code>`, {
      parse_mode: 'HTML',
      reply_markup: getCancelInlineKeyboard()
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data === 'cat_page_1') {
    delete userStates[chatId];
    return renderCatalog(chatId, 1, messageId);
  }

  if (data === 'noop') return bot.answerCallbackQuery(query.id);
});

// START BACKGROUND WORKERS & INITIALIZE SYSTEM
async function startBot() {
  await initDatabase();
  console.log(`✅ Database initialized successfully.`);

  // Pre-seed Flash Sale items if not present
  try {
    for (const fsItem of FLASH_SALE_ITEMS) {
      await getOrCreateFlashSaleProduct(fsItem);
    }
  } catch (fsErr) {
    console.error('[FLASH SALE SEED ERROR]:', fsErr.message);
  }

  // 1. CodeGatra Auto QRIS Payment Poller (Every 5s)
  CodeGatraService.startAutoPollingPaymentWorker({
    bot,
    dbRun,
    dbGet,
    dbAll,
    dbTransaction,
    formatRupiah
  });

  // 2. RumahOTP SMS Auto-Poller (Every 5s) & Auto-Timeout Refund
  OtpService.startAutoPollingOtpWorker({
    bot,
    dbRun,
    dbGet,
    dbAll,
    dbTransaction,
    formatRupiah,
    getShortTimeString
  });

  // 3. Automated Database Backup Service
  startAutoBackupService();

  console.log(`🚀 ${config.STORE_NAME || 'Store'} Bot is fully running with Auto QRIS & OTP Polling!`);
}

startBot().catch(console.error);
