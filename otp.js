const axios = require('axios');
const config = require('./config.js');

let createCanvas = null;
try {
  const canvasPkg = require('canvas');
  createCanvas = canvasPkg.createCanvas;
} catch (e) {
  console.log('ℹ️ Canvas library tidak tersedia atau belum terkompilasi, menggunakan mode teks / fallback image.');
}

const rumahOtpApi = axios.create({
  baseURL: config.RUMAHOTP_BASE_URL || 'https://www.rumahotp.io',
  timeout: 15000,
  headers: {
    'x-apikey': config.RUMAHOTP_API_KEY,
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  }
});

class OtpService {
  // === RUMAHOTP API WRAPPERS ===

  static async getBalance() {
    try {
      const res = await rumahOtpApi.get('/api/v1/user/balance');
      return res.data;
    } catch (err) {
      console.error('[RUMAHOTP BALANCE ERR]:', err.response?.data || err.message);
      return { success: false, message: err.message };
    }
  }

  static async getServices() {
    try {
      const res = await rumahOtpApi.get('/api/v2/services');
      return res.data;
    } catch (err) {
      console.error('[RUMAHOTP SERVICES ERR]:', err.response?.data || err.message);
      return { success: false, data: [] };
    }
  }

  static async getCountries(serviceId) {
    try {
      const res = await rumahOtpApi.get(`/api/v2/countries?service_id=${serviceId}`);
      return res.data;
    } catch (err) {
      console.error('[RUMAHOTP COUNTRIES ERR]:', err.response?.data || err.message);
      return { success: false, data: [] };
    }
  }

  static async getOperators(countryName, providerId = 1) {
    try {
      const res = await rumahOtpApi.get(`/api/v2/operators?country=${countryName}&provider_id=${providerId}`);
      return res.data;
    } catch (err) {
      console.error('[RUMAHOTP OPERATORS ERR]:', err.response?.data || err.message);
      return { success: false, data: [] };
    }
  }

  static async orderNumber({ serviceId, providerId = 1, operatorId = 1 }) {
    try {
      let url = `/api/v2/orders?number_id=${serviceId}`;
      if (providerId) url += `&provider_id=${providerId}`;
      if (operatorId) url += `&operator_id=${operatorId}`;

      const res = await rumahOtpApi.get(url);
      return res.data;
    } catch (err) {
      console.error('[RUMAHOTP ORDER ERR]:', err.response?.data || err.message);
      return { success: false, message: err.response?.data?.message || err.message };
    }
  }

  static async getOrderStatus(orderId) {
    try {
      const res = await rumahOtpApi.get(`/api/v1/orders/get_status?order_id=${orderId}`);
      return res.data;
    } catch (err) {
      console.error('[RUMAHOTP GET STATUS ERR]:', err.response?.data || err.message);
      return { success: false, message: err.message };
    }
  }

  static async setOrderStatus(orderId, statusName) {
    try {
      const res = await rumahOtpApi.get(`/api/v1/orders/set_status?order_id=${orderId}&status=${statusName}`);
      return res.data;
    } catch (err) {
      console.error('[RUMAHOTP SET STATUS ERR]:', err.response?.data || err.message);
      return { success: false, message: err.message };
    }
  }

  static async createOwnerDeposit(amount) {
    try {
      const res = await rumahOtpApi.get(`/api/v1/deposit/create?amount=${amount}&payment_id=qris`);
      return res.data;
    } catch (err) {
      console.error('[RUMAHOTP OWNER DEP ERR]:', err.response?.data || err.message);
      return { success: false, message: err.message };
    }
  }

  // === HELPER SENSOR NOMOR & OTP ===
  static maskPhoneNumber(phone) {
    if (!phone) return '08**********';
    const str = String(phone).replace(/\s+/g, '');
    if (str.length <= 6) return str;
    return `${str.slice(0, 6)}****${str.slice(-3)}`;
  }

  static maskOtpCode(otp) {
    if (!otp) return '***';
    const str = String(otp).trim();
    if (str.length <= 2) return '**';
    return `${str.slice(0, 2)}****`;
  }

  // === DYNAMIC TESTIMONIAL CARD GENERATOR (CANVAS) ===
  static drawRoundRect(ctx, x, y, w, h, r, fill = false, stroke = true) {
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

  static drawInfoBox(ctx, x, y, w, h, label, val, valColor) {
    ctx.fillStyle = 'rgba(13, 38, 33, 0.65)';
    ctx.strokeStyle = 'rgba(0, 242, 173, 0.25)';
    ctx.lineWidth = 1.5;
    this.drawRoundRect(ctx, x, y, w, h, 16, true, true);

    ctx.fillStyle = '#7a9e96';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, x + 25, y + 30);

    ctx.fillStyle = valColor;
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText(val, x + 25, y + 58);
  }

  static async generateOtpTestimonialCard({ serviceName, phoneNumber, otpCode, dateStr, userUsername }) {
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
      this.drawRoundRect(ctx, width - 260, 30, 220, 38, 19, true, true);

      ctx.fillStyle = '#8ea8a2';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`🕒 ${dateStr}`, width - 150, 54);

      ctx.fillStyle = 'rgba(0, 242, 173, 0.08)';
      ctx.strokeStyle = '#00f2ad';
      ctx.lineWidth = 2;
      this.drawRoundRect(ctx, width / 2 - 45, 75, 90, 90, 22, true, true);

      ctx.fillStyle = '#00f2ad';
      ctx.font = '40px sans-serif';
      ctx.fillText('📱', width / 2, 133);

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 32px sans-serif';
      ctx.fillText(`ORDER OTP ${serviceName.toUpperCase()}`, width / 2, 218);

      ctx.fillStyle = '#00f2ad';
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText('❖  SUCCESS SUKSES MASUK  ❖', width / 2, 248);

      const maskedPhone = this.maskPhoneNumber(phoneNumber);
      const maskedOtp = this.maskOtpCode(otpCode);

      this.drawInfoBox(ctx, 80, 280, 410, 85, 'APLIKASI / LAYANAN', serviceName, '#00f2ad');
      this.drawInfoBox(ctx, 510, 280, 410, 85, 'NOMOR (DISENSOR)', maskedPhone, '#ffcc00');
      this.drawInfoBox(ctx, 80, 385, 410, 85, 'KODE OTP (DISENSOR)', maskedOtp, '#4ba3ff');
      this.drawInfoBox(ctx, 510, 385, 410, 85, 'PEMBELI', `@${userUsername.replace('@', '')}`, '#ffffff');

      const btnGrad = ctx.createLinearGradient(300, 510, 700, 510);
      btnGrad.addColorStop(0, '#00f2ad');
      btnGrad.addColorStop(1, '#00aaff');
      ctx.fillStyle = btnGrad;
      this.drawRoundRect(ctx, 300, 500, 400, 68, 34, true, false);

      ctx.fillStyle = '#05110e';
      ctx.font = 'bold 22px sans-serif';
      ctx.fillText('✅ TRANSAKSI BERHASIL!', width / 2, 542);

      ctx.fillStyle = '#5c7873';
      ctx.font = '14px sans-serif';
      ctx.fillText(`✦  ${config.STORE_NAME || 'JEPZ STORE'}  •  Order Virtual OTP 24 Jam  ✦`, width / 2, 640);

      return canvas.toBuffer('image/png');
    } catch (err) {
      console.error('[GENERATE OTP CARD ERR]:', err.message);
      return null;
    }
  }

  // === BACKGROUND AUTO-POLLING WORKER FOR ACTIVE OTP ORDERS ===
  static startAutoPollingOtpWorker({ bot, dbRun, dbGet, dbAll, dbTransaction, formatRupiah, getShortTimeString }) {
    console.log('🚀 RumahOTP Auto-Polling Worker started (every 5 seconds)...');

    let isPolling = false;

    setInterval(async () => {
      if (isPolling) return;
      isPolling = true;

      try {
        const activeOrders = await dbAll(`
          SELECT o.*, u.telegram_id, u.username
          FROM otp_orders o
          JOIN users u ON o.user_id = u.id
          WHERE o.status = 'active' AND o.provider_order_id IS NOT NULL
          ORDER BY o.id ASC
          LIMIT 10
        `);

        for (const order of activeOrders) {
          try {
            // Check timeout (default 15 minutes = 15 * 60 * 1000 ms)
            const orderCreatedAt = new Date(order.created_at).getTime();
            const now = Date.now();
            const ageMinutes = (now - orderCreatedAt) / (1000 * 60);

            if (ageMinutes >= 15) {
              // Order timed out -> Auto cancel & refund
              try {
                await this.setOrderStatus(order.provider_order_id, 'cancel');
              } catch (e) {}

              await dbTransaction(async ({ dbRun }) => {
                await dbRun(`UPDATE otp_orders SET status = 'cancelled' WHERE id = ?`, [order.id]);
                await dbRun(`UPDATE users SET balance = balance + ? WHERE id = ?`, [order.amount, order.user_id]);
                await dbRun(
                  `INSERT INTO balance_history (user_id, amount, type, description) VALUES (?, ?, 'REFUND', ?)`,
                  [order.user_id, order.amount, `Auto Refund Timeout OTP #${order.order_code}`]
                );
              });

              let timeoutMsg = `⏰ <b>ORDER OTP TIMEOUT & OTOMATIS DI-REFUND</b>\n\n`;
              timeoutMsg += `Order Code: <code>#${order.order_code}</code>\n`;
              timeoutMsg += `Layanan: <b>${order.service_name}</b>\n`;
              timeoutMsg += `Nomor HP: <code>${order.phone_number}</code>\n\n`;
              timeoutMsg += `Karena SMS tidak masuk dalam 15 menit, saldo sebesar <b>${formatRupiah(order.amount)}</b> telah otomatis dikembalikan ke akun Anda! 💰`;

              try {
                await bot.sendMessage(order.telegram_id, timeoutMsg, { parse_mode: 'HTML' });
              } catch (e) {}
              continue;
            }

            // Query provider status
            const statusRes = await this.getOrderStatus(order.provider_order_id);
            if (statusRes && statusRes.success && statusRes.data) {
              const sData = statusRes.data;

              if (sData.otp_code) {
                // OTP Arrived! Complete order atomically
                await dbTransaction(async ({ dbRun }) => {
                  await dbRun(
                    `UPDATE otp_orders SET status = 'completed', otp_code = ?, otp_msg = ?, completed_at = DATETIME('now', 'localtime') WHERE id = ?`,
                    [sData.otp_code, sData.otp_msg || '', order.id]
                  );
                });

                let doneText = `🎉 <b>KODE OTP BERHASIL MASUK OTOMATIS!</b>\n\n`;
                doneText += `Aplikasi: <b>${sData.service || order.service_name}</b>\n`;
                doneText += `Nomor HP: <code>${sData.phone_number || order.phone_number}</code>\n\n`;
                doneText += `🔑 <b>KODE OTP ANDA:</b>\n`;
                doneText += `👉 <code>${sData.otp_code}</code> 👈 <i>(klik untuk salin)</i>\n\n`;
                if (sData.otp_msg) {
                  doneText += `📩 <b>Isi Pesan SMS:</b>\n<code>${sData.otp_msg}</code>\n\n`;
                }
                doneText += `✅ Riwayat OTP tersimpan di menu <b>📜 Riwayat Transaksi</b> (/riwayat).\n`;
                doneText += `Terima kasih telah mempercayai <b>${config.STORE_NAME}</b>!`;

                try {
                  await bot.sendMessage(order.telegram_id, doneText, { parse_mode: 'HTML' });
                } catch (e) {}

                const cleanBuyer = (order.username || 'Buyer').replace(/^@/, '');
                const maskedUser = cleanBuyer.length <= 2 ? `@${cleanBuyer}xxx` : `@${cleanBuyer.slice(0, 2)}xxx`;

                // Send Receipt / Testimonial to Channel
                const dateStr = getShortTimeString ? getShortTimeString() : new Date().toLocaleString();
                const cardBuffer = await this.generateOtpTestimonialCard({
                  serviceName: sData.service || order.service_name || 'OTP',
                  phoneNumber: sData.phone_number || order.phone_number,
                  otpCode: sData.otp_code,
                  dateStr: dateStr,
                  userUsername: maskedUser
                });

                const cardCaption = `🚀 <b>TESTIMONI / RECEIPT OTP SUKSES!</b>\n\n🧾 <b>Order ID:</b> <code>#${order.order_code}</code>\n📱 <b>Layanan:</b> ${sData.service || order.service_name}\n💳 <b>Metode:</b> <b>Saldo Akun (Balance)</b>\n👤 <b>Pembeli:</b> ${maskedUser}\n🌐 <b>Status:</b> Success Completed\n\nTerima kasih telah mempercayai <b>${config.STORE_NAME}</b>!`;

                if (config.CHANNEL_ID && config.CHANNEL_ID.startsWith('-100')) {
                  try {
                    if (cardBuffer) {
                      await bot.sendPhoto(config.CHANNEL_ID, cardBuffer, { caption: cardCaption, parse_mode: 'HTML' });
                    } else {
                      await bot.sendMessage(config.CHANNEL_ID, cardCaption, { parse_mode: 'HTML' });
                    }
                  } catch (e) {}
                }
              }
            }
          } catch (itemErr) {
            console.error(`[POLLING OTP ORDER #${order.order_code} ERR]:`, itemErr.message);
          }
        }
      } catch (loopErr) {
        console.error('[POLLING OTP LOOP ERR]:', loopErr.message);
      } finally {
        isPolling = false;
      }
    }, 5000);
  }
}

module.exports = OtpService;
