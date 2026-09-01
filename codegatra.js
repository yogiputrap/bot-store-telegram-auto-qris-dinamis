const axios = require('axios');
const QRCode = require('qrcode');
const config = require('./config.js');

class CodeGatraService {
  static getClient() {
    return axios.create({
      baseURL: config.CODEGATRA_BASE_URL || 'https://pay.codegatra.com/api',
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.CODEGATRA_API_KEY || ''}`,
        'X-Api-Key': config.CODEGATRA_API_KEY || ''
      }
    });
  }

  static isConfigured() {
    return Boolean(config.CODEGATRA_API_KEY && config.CODEGATRA_NAMA_PROJECT);
  }

  // POST /api/profile
  static async getProfile() {
    try {
      if (!this.isConfigured()) {
        return { status: 'error', message: 'CODEGATRA_API_KEY atau CODEGATRA_NAMA_PROJECT belum disetting di .env' };
      }
      const client = this.getClient();
      const res = await client.post('/profile', {});
      return res.data;
    } catch (err) {
      console.error('[CODEGATRA PROFILE ERROR]:', err.response?.data || err.message);
      return {
        status: 'error',
        message: err.response?.data?.message || err.message
      };
    }
  }

  // Helper: Calculate CRC16 CCITT (0xFFFF, Poly 0x1021) for EMVCo QRIS
  static crc16(str) {
    let crc = 0xFFFF;
    for (let i = 0; i < str.length; i++) {
      crc ^= str.charCodeAt(i) << 8;
      for (let j = 0; j < 8; j++) {
        if ((crc & 0x8000) !== 0) {
          crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
        } else {
          crc = (crc << 1) & 0xFFFF;
        }
      }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }

  // Helper: Generate or Convert to Dynamic QRIS with exact amount
  static generateDynamicQris(rawQr, amount) {
    let qr = (rawQr || '').trim();
    if (!qr || qr.length < 20) {
      const storeName = config.STORE_NAME || 'Moakun Store';
      const storeLen = String(storeName.length).padStart(2, '0');
      qr = `00020101021226580014ID.LINKAJA.WWW01189360089801234567895204581253033605802ID59${storeLen}${storeName}6007JAKARTA6304`;
    }

    // Remove existing Tag 63 if present
    if (qr.includes('6304')) {
      qr = qr.substring(0, qr.indexOf('6304'));
    }

    // Change Tag 01 from 11 (Static) to 12 (Dynamic)
    qr = qr.replace('010211', '010212');

    // Remove existing Tag 54 if present
    const tag54Match = qr.match(/54[0-9]{2}[0-9]+/);
    if (tag54Match) {
      const tagLen = parseInt(qr.substr(qr.indexOf('54') + 2, 2));
      const fullTag = qr.substr(qr.indexOf('54'), 4 + tagLen);
      qr = qr.replace(fullTag, '');
    }

    // Inject Tag 54 with amount before Tag 58 (Country code) or at end
    const amtStr = String(Math.round(amount));
    const amtLen = String(amtStr.length).padStart(2, '0');
    const tag54 = '54' + amtLen + amtStr;

    if (qr.includes('5802ID')) {
      qr = qr.replace('5802ID', tag54 + '5802ID');
    } else {
      qr = qr + tag54;
    }

    qr += '6304';
    const checksum = this.crc16(qr);
    return qr + checksum;
  }

  // POST /api/order (with automatic fallback to Dynamic QRIS engine)
  static async createOrder({ refId, amount, customerName = 'Customer', expiredMinutes = 10 }) {
    const roundedAmount = Math.round(Number(amount));
    const expMinutes = expiredMinutes || config.CODEGATRA_EXPIRED_MINUTES || 10;
    const expiredAt = new Date(Date.now() + (expMinutes * 60 * 1000));

    // Path 1: CodeGatra API if configured
    if (this.isConfigured()) {
      try {
        const client = this.getClient();
        const payload = {
          nama_project: config.CODEGATRA_NAMA_PROJECT,
          ref_id: refId,
          amount: roundedAmount,
          customer_name: customerName,
          expired: expMinutes
        };

        const res = await client.post('/order', payload);
        const resData = res.data;
        console.log('[CODEGATRA ORDER RESPONSE]:', JSON.stringify(resData));

        const dataObj = resData.data || resData;
        let qrString = dataObj.qr_string || dataObj.qrString || dataObj.raw_qr || dataObj.qr_code || dataObj.qr || dataObj.qris_data || dataObj.qris || dataObj.payload || '';
        let qrImage = dataObj.qr_image || dataObj.qr_url || dataObj.qrImage || dataObj.qr_link || dataObj.image_url || dataObj.image || '';
        const totalAmount = Number(dataObj.total_amount || dataObj.totalAmount || dataObj.amount || amount);
        const uniqueCode = Number(dataObj.unique_code || dataObj.uniqueCode || (totalAmount - amount) || 0);

        let qrBuffer = null;

        // 1. If qr_string is available, render QR buffer
        if (qrString && typeof qrString === 'string' && qrString.length > 5 && !qrString.startsWith('http')) {
          try {
            qrBuffer = await QRCode.toBuffer(qrString, {
              type: 'png',
              width: 600,
              margin: 2,
              color: { dark: '#000000', light: '#ffffff' }
            });
          } catch (e) {
            console.error('[QRCODE GENERATE ERROR]:', e.message);
          }
        }

        // 2. If qr_image is base64 Data URL or raw base64
        if (!qrBuffer && typeof qrImage === 'string') {
          if (qrImage.startsWith('data:image')) {
            try {
              const base64Data = qrImage.replace(/^data:image\/\w+;base64,/, '');
              qrBuffer = Buffer.from(base64Data, 'base64');
            } catch (e) {}
          } else if (/^[A-Za-z0-9+/=]{100,}$/.test(qrImage.trim())) {
            try {
              qrBuffer = Buffer.from(qrImage.trim(), 'base64');
            } catch (e) {}
          }
        }

        // 3. If qr_image is an HTTP/HTTPS URL, download into Buffer directly
        if (!qrBuffer && typeof qrImage === 'string' && (qrImage.startsWith('http://') || qrImage.startsWith('https://'))) {
          try {
            const dlRes = await axios.get(qrImage, {
              responseType: 'arraybuffer',
              timeout: 10000,
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
              }
            });
            if (dlRes.data && dlRes.data.length > 0) {
              qrBuffer = Buffer.from(dlRes.data);
            }
          } catch (e) {
            console.error('[CODEGATRA QR IMAGE DOWNLOAD ERROR]:', e.message);
          }
        }

        // 4. If qr_image looks like EMVCo string
        if (!qrBuffer && typeof qrImage === 'string' && qrImage.length > 20 && !qrImage.startsWith('http')) {
          try {
            qrBuffer = await QRCode.toBuffer(qrImage, {
              type: 'png',
              width: 600,
              margin: 2,
              color: { dark: '#000000', light: '#ffffff' }
            });
          } catch (e) {}
        }

        // 5. Fallback: generate dynamic QRIS buffer if no buffer could be generated yet
        if (!qrBuffer) {
          try {
            const dynamicQr = this.generateDynamicQris(config.QRIS_STRING, totalAmount);
            qrString = qrString || dynamicQr;
            qrBuffer = await QRCode.toBuffer(dynamicQr, {
              type: 'png',
              width: 600,
              margin: 2,
              color: { dark: '#000000', light: '#ffffff' }
            });
          } catch (e) {}
        }

        return {
          status: 'success',
          raw: resData,
          qr_string: qrString,
          qr_image: qrImage,
          qr_buffer: qrBuffer,
          total_amount: totalAmount,
          unique_code: uniqueCode,
          amount: roundedAmount,
          ref_id: refId,
          expired_at: expiredAt
        };
      } catch (err) {
        console.warn('[CODEGATRA API FALLBACK]:', err.response?.data?.message || err.message);
        // Fall through to Built-in Dynamic QRIS engine below
      }
    }

    // Path 2: Built-in Dynamic QRIS Engine (Fallback / Standalone Mode)
    const uniqueCode = Math.floor(Math.random() * 899) + 100;
    const totalAmount = roundedAmount + uniqueCode;
    const dynamicQrString = this.generateDynamicQris(config.QRIS_STRING, totalAmount);
    let qrBuffer = null;
    try {
      qrBuffer = await QRCode.toBuffer(dynamicQrString, {
        type: 'png',
        width: 600,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' }
      });
    } catch (e) {
      console.error('[DYNAMIC QRIS GENERATE ERROR]:', e.message);
    }

    return {
      status: 'success',
      is_fallback: true,
      raw: { message: 'Generated via built-in Dynamic QRIS engine' },
      qr_string: dynamicQrString,
      qr_image: '',
      qr_buffer: qrBuffer,
      total_amount: totalAmount,
      unique_code: uniqueCode,
      amount: roundedAmount,
      ref_id: refId,
      expired_at: expiredAt
    };
  }

  // POST /api/status
  static async checkStatus(refId) {
    try {
      if (!this.isConfigured()) {
        return { status: 'error', message: 'CodeGatra API key belum dikonfigurasi' };
      }
      const client = this.getClient();
      const res = await client.post('/status', { ref_id: refId });
      const resData = res.data;
      const dataObj = resData.data || resData;

      const rawStatus = (dataObj.payment_status || dataObj.status || '').toLowerCase();
      let normalizedStatus = 'pending';
      if (['paid', 'success', 'berhasil', 'completed'].includes(rawStatus)) {
        normalizedStatus = 'paid';
      } else if (['expired', 'kadaluarsa', 'timeout'].includes(rawStatus)) {
        normalizedStatus = 'expired';
      } else if (['cancelled', 'canceled', 'batal', 'rejected'].includes(rawStatus)) {
        normalizedStatus = 'cancelled';
      }

      return {
        status: 'success',
        payment_status: normalizedStatus,
        total_amount: Number(dataObj.total_amount || dataObj.amount || 0),
        raw: resData
      };
    } catch (err) {
      // 404 or other errors
      return {
        status: 'error',
        payment_status: 'pending',
        message: err.response?.data?.message || err.message
      };
    }
  }

  // Background Auto-Polling Worker (Runs every 5 seconds)
  static startAutoPollingPaymentWorker({ bot, dbRun, dbGet, dbAll, dbTransaction, formatRupiah }) {
    if (!this.isConfigured()) {
      console.log('ℹ️ CodeGatra API Key tidak disetting. Auto-polling pembayaran QRIS dinonaktifkan.');
      return;
    }

    console.log('🚀 CodeGatra Auto-Polling Payment Worker started (every 5 seconds)...');

    let isPolling = false;

    setInterval(async () => {
      if (isPolling) return;
      isPolling = true;

      try {
        // 1. Check Pending Auto-QRIS Deposits
        const pendingDeposits = await dbAll(`
          SELECT d.*, u.telegram_id, u.username, u.balance as user_balance
          FROM deposits d
          JOIN users u ON d.user_id = u.id
          WHERE d.status = 'pending' AND d.ref_id IS NOT NULL AND d.method = 'AUTO_QRIS'
          ORDER BY d.id ASC
          LIMIT 10
        `);

        for (const dep of pendingDeposits) {
          try {
            const statusRes = await this.checkStatus(dep.ref_id);
            if (statusRes.status === 'success') {
              if (statusRes.payment_status === 'paid') {
                // Confirm deposit atomically
                await dbTransaction(async ({ dbRun }) => {
                  await dbRun(`UPDATE deposits SET status = 'approved', confirmed_at = DATETIME('now', 'localtime') WHERE id = ?`, [dep.id]);
                  await dbRun(`UPDATE users SET balance = balance + ? WHERE id = ?`, [dep.amount, dep.user_id]);
                  await dbRun(
                    `INSERT INTO balance_history (user_id, amount, type, description) VALUES (?, ?, 'DEPOSIT', ?)`,
                    [dep.user_id, dep.amount, `Auto Deposit QRIS #${dep.deposit_code}`]
                  );
                });

                // Notify User
                const newBalance = (dep.user_balance || 0) + dep.amount;
                let successMsg = `🎉 <b>DEPOSIT QRIS BERHASIL OTOMATIS!</b>\n\n`;
                successMsg += `Deposit Code: <code>#${dep.deposit_code}</code>\n`;
                successMsg += `Nominal Masuk: <b>${formatRupiah(dep.amount)}</b>\n`;
                successMsg += `Saldo Saat Ini: <b>${formatRupiah(newBalance)}</b>\n\n`;
                successMsg += `Terima kasih! Saldo Anda telah otomatis ditambahkan dan siap digunakan.`;

                try {
                  await bot.sendMessage(dep.telegram_id, successMsg, { parse_mode: 'HTML' });
                } catch (e) {}

                // Notify Channel if configured
                if (config.CHANNEL_ID && config.CHANNEL_ID.startsWith('-100')) {
                  try {
                    const chMsg = `⚡ <b>AUTO DEPOSIT MASUK!</b>\n\nNominal: <b>${formatRupiah(dep.amount)}</b>\nUser: @${dep.username || 'User'}\nMetode: <b>QRIS Otomatis</b>\nStatus: <b>SUCCESS</b>`;
                    await bot.sendMessage(config.CHANNEL_ID, chMsg, { parse_mode: 'HTML' });
                  } catch (e) {}
                }
              } else if (statusRes.payment_status === 'expired' || statusRes.payment_status === 'cancelled') {
                await dbRun(`UPDATE deposits SET status = 'expired' WHERE id = ?`, [dep.id]);
                try {
                  await bot.sendMessage(dep.telegram_id, `⚠️ <b>DEPOSIT EXPIRED / KADALUARSA</b>\n\nKode Deposit <code>#${dep.deposit_code}</code> telah kadaluarsa. Silakan lakukan deposit ulang jika ingin mengisi saldo.`, { parse_mode: 'HTML' });
                } catch (e) {}
              }
            }
          } catch (itemErr) {
            console.error(`[POLLING DEPOSIT ERR #${dep.deposit_code}]:`, itemErr.message);
          }
        }

        // 2. Check Pending Auto-QRIS Product Orders
        const pendingPayments = await dbAll(`
          SELECT p.*, o.order_code, o.product_id, o.qty, o.amount as order_amount, u.telegram_id, u.username, pr.name as prod_name, pr.category
          FROM payments p
          JOIN orders o ON p.order_id = o.id
          JOIN products pr ON o.product_id = pr.id
          JOIN users u ON p.user_id = u.id
          WHERE p.status = 'pending' AND p.ref_id IS NOT NULL AND p.method = 'AUTO_QRIS'
          ORDER BY p.id ASC
          LIMIT 10
        `);

        for (const pay of pendingPayments) {
          try {
            const statusRes = await this.checkStatus(pay.ref_id);
            if (statusRes.status === 'success') {
              if (statusRes.payment_status === 'paid') {
                const reqQty = pay.qty || 1;

                // Fulfill order atomically
                const stockItems = await dbAll(`
                  SELECT * FROM product_stock 
                  WHERE product_id = ? AND status = 'available' 
                  ORDER BY id ASC LIMIT ?
                `, [pay.product_id, reqQty]);

                if (stockItems.length < reqQty) {
                  // Mark as paid but stock issue -> alert owner
                  await dbRun(`UPDATE payments SET status = 'paid', confirmed_at = DATETIME('now', 'localtime') WHERE id = ?`, [pay.id]);
                  await dbRun(`UPDATE orders SET status = 'paid_stock_pending' WHERE id = ?`, [pay.order_id]);

                  const alertOwner = `⚠️ <b>PEMBAYARAN QRIS SUKSES, TAPI STOK KURANG!</b>\n\nOrder Code: <code>#${pay.order_code}</code>\nProduk: <b>${pay.category} - ${pay.prod_name}</b>\nJumlah diminta: ${reqQty}, Tersedia: ${stockItems.length}\nUser: @${pay.username || 'User'} (<code>${pay.telegram_id}</code>)\n\nHarap kirim akun manual ke pembeli!`;
                  try {
                    await bot.sendMessage(config.OWNER_ID, alertOwner, { parse_mode: 'HTML' });
                    await bot.sendMessage(pay.telegram_id, `🎉 <b>PEMBAYARAN QRIS TERKONFIRMASI!</b>\n\nOrder <code>#${pay.order_code}</code> telah lunas. Stok sedang disiapkan oleh admin dan akan segera dikirimkan.`, { parse_mode: 'HTML' });
                  } catch (e) {}
                } else {
                  // Stock is available -> fulfill immediately
                  await dbTransaction(async ({ dbRun }) => {
                    for (const item of stockItems) {
                      await dbRun(
                        `UPDATE product_stock SET status = 'sold', order_id = ?, sold_at = DATETIME('now', 'localtime') WHERE id = ?`,
                        [pay.order_code, item.id]
                      );
                    }
                    await dbRun(`UPDATE payments SET status = 'paid', confirmed_at = DATETIME('now', 'localtime') WHERE id = ?`, [pay.id]);
                    await dbRun(`UPDATE orders SET status = 'completed', stock_id = ?, completed_at = DATETIME('now', 'localtime') WHERE id = ?`, [stockItems[0].id, pay.order_id]);
                  });

                  // Send credentials to buyer
                  let successMsg = `🎉 <b>PEMBAYARAN QRIS BERHASIL (${reqQty} Pcs)</b>\n\n`;
                  successMsg += `Order Code: <code>#${pay.order_code}</code>\n`;
                  successMsg += `Produk: <b>${pay.category} - ${pay.prod_name}</b> (${reqQty} Pcs)\n`;
                  successMsg += `Total: <b>${formatRupiah(pay.total_amount || pay.amount)}</b>\n\n`;
                  successMsg += `━━━━━━━━━━━━━━━━━━\n`;
                  successMsg += `📦 <b>DETAIL AKUN / CREDENTIAL (${reqQty} Pcs):</b>\n\n`;

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

                  try {
                    await bot.sendMessage(pay.telegram_id, successMsg, { parse_mode: 'HTML' });
                  } catch (e) {}

                  // Send Testimonial to channel
                  if (config.CHANNEL_ID && config.CHANNEL_ID.startsWith('-100')) {
                    try {
                      const chMsg = `🛍️ <b>TRANSAKSI QRIS OTOMATIS SUKSES!</b>\n\n📦 <b>Produk:</b> ${pay.category} - ${pay.prod_name} (${reqQty} Pcs)\n💰 <b>Total:</b> ${formatRupiah(pay.amount)}\n👤 <b>Pembeli:</b> @${pay.username || 'Buyer'}\n⚡ <b>Proses:</b> Instan 24 Jam Otomatis`;
                      await bot.sendMessage(config.CHANNEL_ID, chMsg, { parse_mode: 'HTML' });
                    } catch (e) {}
                  }
                }
              } else if (statusRes.payment_status === 'expired' || statusRes.payment_status === 'cancelled') {
                await dbRun(`UPDATE payments SET status = 'expired' WHERE id = ?`, [pay.id]);
                await dbRun(`UPDATE orders SET status = 'expired' WHERE id = ?`, [pay.order_id]);
                try {
                  await bot.sendMessage(pay.telegram_id, `⚠️ <b>PEMBAYARAN QRIS EXPIRED</b>\n\nPembayaran untuk order <code>#${pay.order_code}</code> telah kadaluarsa. Silakan lakukan order baru jika ingin membeli.`, { parse_mode: 'HTML' });
                } catch (e) {}
              }
            }
          } catch (itemErr) {
            console.error(`[POLLING PAYMENT ERR #${pay.order_code}]:`, itemErr.message);
          }
        }
      } catch (loopErr) {
        console.error('[POLLING WORKER LOOP ERR]:', loopErr.message);
      } finally {
        isPolling = false;
      }
    }, 5000);
  }
}

module.exports = CodeGatraService;
