const axios = require('axios');
const QRCode = require('qrcode');
const config = require('./config.js');

const activePaymentLocks = new Set();
const activeDepositLocks = new Set();

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
      return null;
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

  // POST /api/order (Official CodeGatra Auto QRIS or Configured QRIS String)
  static async createOrder({ refId, amount, customerName = 'Customer', expiredMinutes = 10 }) {
    const roundedAmount = Math.round(Number(amount));
    const expMinutes = expiredMinutes || config.CODEGATRA_EXPIRED_MINUTES || 10;
    const expiredAt = new Date(Date.now() + (expMinutes * 60 * 1000));

    // Path 1: Official CodeGatra Payment Gateway API (100% Real Bank Scannable + Auto Polling)
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
        console.log('[CODEGATRA ORDER RESPONSE FULL]:', JSON.stringify(resData, null, 2));

        // Flatten: support both { data: {...} } and flat response
        const dataObj = resData.data || resData;
        console.log('[CODEGATRA DATA KEYS]:', Object.keys(dataObj));
        console.log('[CODEGATRA DATA VALUES]:', JSON.stringify(dataObj, null, 2));

        // Parse payment_detail (CodeGatra menyimpan QR di sini — bisa objek atau JSON string)
        let payDetail = dataObj.payment_detail || {};
        if (typeof payDetail === 'string') {
          try { payDetail = JSON.parse(payDetail); } catch (e) { payDetail = {}; }
        }
        console.log('[CODEGATRA] payment_detail:', JSON.stringify(payDetail));

        // Extract QR string (EMVCo payload / QRIS string) — cek payment_detail terlebih dahulu
        let qrString = payDetail.qr_string
          || payDetail.qrString
          || payDetail.raw_qr
          || payDetail.qr_code
          || payDetail.qr
          || payDetail.qris
          || payDetail.payload
          || payDetail.emv
          || dataObj.qr_string
          || dataObj.qrString
          || dataObj.raw_qr
          || dataObj.qr_code
          || dataObj.qr
          || dataObj.qris_data
          || dataObj.qris
          || dataObj.payload
          || dataObj.emv
          || '';

        // Extract QR image (URL, base64, atau EMVCo string) — cek payment_detail terlebih dahulu
        let qrImage = payDetail.qr_image
          || payDetail.qr_url
          || payDetail.qrImage
          || payDetail.qr_link
          || payDetail.image_url
          || payDetail.image
          || payDetail.qris_image
          || payDetail.qr_img
          || dataObj.qr_image
          || dataObj.qr_url
          || dataObj.qrImage
          || dataObj.qr_link
          || dataObj.image_url
          || dataObj.image
          || dataObj.qris_image
          || dataObj.qr_img
          || '';

        const totalAmount = Number(dataObj.total_amount || dataObj.totalAmount || dataObj.amount || amount);
        const uniqueCode = Number(dataObj.unique_code || dataObj.uniqueCode || (totalAmount - roundedAmount) || 0);

        console.log('[CODEGATRA] qrString:', qrString ? qrString.substring(0, 80) + '...' : '(kosong)');
        console.log('[CODEGATRA] qrImage:', qrImage ? qrImage.substring(0, 120) : '(kosong)');
        console.log('[CODEGATRA] totalAmount:', totalAmount, '| uniqueCode:', uniqueCode);

        let qrBuffer = null;

        // 1. If CodeGatra returned a raw QR string (EMVCo), render it into PNG Buffer
        if (qrString && typeof qrString === 'string' && qrString.length > 10 && !qrString.startsWith('http')) {
          try {
            qrBuffer = await QRCode.toBuffer(qrString, {
              type: 'png',
              width: 600,
              margin: 2,
              color: { dark: '#000000', light: '#ffffff' }
            });
            console.log('[CODEGATRA] QR buffer dibuat dari qr_string, panjang:', qrBuffer.length);
          } catch (e) {
            console.error('[CODEGATRA QR STRING RENDER ERROR]:', e.message);
          }
        }

        // 2. If CodeGatra returned a base64 Data URL or raw base64 string in qr_image
        if (!qrBuffer && typeof qrImage === 'string' && qrImage.length > 0) {
          if (qrImage.startsWith('data:image')) {
            try {
              const base64Data = qrImage.replace(/^data:image\/\w+;base64,/, '');
              qrBuffer = Buffer.from(base64Data, 'base64');
              console.log('[CODEGATRA] QR buffer dibuat dari base64 data URL');
            } catch (e) {
              console.error('[CODEGATRA QR BASE64 ERROR]:', e.message);
            }
          } else if (/^[A-Za-z0-9+/=]{100,}$/.test(qrImage.trim())) {
            try {
              qrBuffer = Buffer.from(qrImage.trim(), 'base64');
              console.log('[CODEGATRA] QR buffer dibuat dari raw base64 string');
            } catch (e) {
              console.error('[CODEGATRA QR RAW BASE64 ERROR]:', e.message);
            }
          }
        }

        // 3. If CodeGatra returned an HTTP/HTTPS image URL, download image directly into Buffer
        if (!qrBuffer && typeof qrImage === 'string' && (qrImage.startsWith('http://') || qrImage.startsWith('https://'))) {
          try {
            console.log('[CODEGATRA] Mencoba download QR image dari URL:', qrImage);
            const dlRes = await axios.get(qrImage, {
              responseType: 'arraybuffer',
              timeout: 15000,
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/*,*/*'
              }
            });
            if (dlRes.data && dlRes.data.byteLength > 0) {
              qrBuffer = Buffer.from(dlRes.data);
              console.log('[CODEGATRA] QR buffer berhasil didownload dari URL, size:', qrBuffer.length);
            } else {
              console.error('[CODEGATRA] Download berhasil tapi response kosong');
            }
          } catch (e) {
            console.error('[CODEGATRA QR IMAGE DOWNLOAD ERROR]:', e.response?.status, e.message);
          }
        }

        // 4. If qr_image field is actually an EMVCo string (not a URL)
        if (!qrBuffer && typeof qrImage === 'string' && qrImage.length > 20 && !qrImage.startsWith('http')) {
          try {
            qrBuffer = await QRCode.toBuffer(qrImage, {
              type: 'png',
              width: 600,
              margin: 2,
              color: { dark: '#000000', light: '#ffffff' }
            });
            // Treat qrImage field as the actual qrString too
            if (!qrString) qrString = qrImage;
            console.log('[CODEGATRA] QR buffer dibuat dari qr_image (diperlakukan sebagai EMVCo string)');
          } catch (e) {
            console.error('[CODEGATRA QR IMAGE AS STRING ERROR]:', e.message);
          }
        }

        // 5. Last resort: if we have qr_image URL but download failed, pass URL directly to Telegram
        //    Telegram bot.sendPhoto() accepts a URL directly
        if (!qrBuffer && typeof qrImage === 'string' && (qrImage.startsWith('http://') || qrImage.startsWith('https://'))) {
          console.log('[CODEGATRA] Fallback: menggunakan qr_image URL langsung (tanpa download)');
          // Return URL as qr_buffer placeholder — caller harus cek qr_image_url
          return {
            status: 'success',
            raw: resData,
            qr_string: qrString,
            qr_image: qrImage,
            qr_image_url: qrImage,  // URL langsung untuk Telegram sendPhoto
            qr_buffer: null,
            total_amount: totalAmount,
            unique_code: uniqueCode,
            amount: roundedAmount,
            ref_id: refId,
            expired_at: expiredAt
          };
        }

        if (qrBuffer) {
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
        }

        // Log all available data fields to help debug
        console.error('[CODEGATRA] SEMUA FIELD DALAM RESPONSE:');
        Object.entries(dataObj).forEach(([k, v]) => {
          const val = typeof v === 'string' ? v.substring(0, 100) : v;
          console.error(`  ${k}: ${JSON.stringify(val)}`);
        });
        console.error('[CODEGATRA] PAYMENT_DETAIL KEYS:', Object.keys(payDetail));

        return {
          status: 'error',
          message: `CodeGatra merespon tetapi data gambar/string QRIS tidak ditemukan. payment_detail keys: [${Object.keys(payDetail).join(', ') || 'kosong'}], Fields: [${Object.keys(dataObj).join(', ')}]`
        };
      } catch (err) {
        console.error('[CODEGATRA CREATE ORDER ERROR]:', err.response?.data || err.message);
        return {
          status: 'error',
          message: `Gagal membuat order di CodeGatra (${err.response?.data?.message || err.message})`
        };
      }
    }

    // Path 2: Configured Static QRIS String in .env
    if (config.QRIS_STRING && config.QRIS_STRING.trim().length > 20) {
      const uniqueCode = Math.floor(Math.random() * 899) + 100;
      const totalAmount = roundedAmount + uniqueCode;
      const dynamicQrString = this.generateDynamicQris(config.QRIS_STRING, totalAmount);
      if (dynamicQrString) {
        try {
          const qrBuffer = await QRCode.toBuffer(dynamicQrString, {
            type: 'png',
            width: 600,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' }
          });
          return {
            status: 'success',
            is_static_converted: true,
            qr_string: dynamicQrString,
            qr_image: '',
            qr_buffer: qrBuffer,
            total_amount: totalAmount,
            unique_code: uniqueCode,
            amount: roundedAmount,
            ref_id: refId,
            expired_at: expiredAt
          };
        } catch (e) {
          console.error('[STATIC QRIS CONVERT ERROR]:', e.message);
        }
      }
    }

    // Path 3: Unconfigured Gateway
    return {
      status: 'error',
      message: 'Payment Gateway QRIS belum dikonfigurasi. Harap isi CODEGATRA_API_KEY & CODEGATRA_NAMA_PROJECT (dari https://pay.codegatra.com) atau QRIS_STRING toko di file .env agar QRIS resmi dari bank dapat di-generate dan discan oleh aplikasi bank/e-wallet manapun.'
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

  // Process a single deposit payment (shared between background polling and manual refresh)
  static async processSingleDeposit(dep, { bot, dbRun, dbGet, dbAll, dbTransaction, formatRupiah }) {
    if (activeDepositLocks.has(dep.id)) {
      return { status: 'processing', message: 'Deposit sedang diproses...' };
    }
    activeDepositLocks.add(dep.id);

    try {
      // Re-check deposit status in DB before processing
      const currentDep = await dbGet('SELECT status FROM deposits WHERE id = ?', [dep.id]);
      if (!currentDep || currentDep.status === 'approved') {
        return { status: 'paid', message: 'Deposit sudah berhasil diproses.' };
      }
      if (currentDep.status === 'expired' || currentDep.status === 'cancelled') {
        return { status: currentDep.status, message: 'Deposit sudah tidak aktif.' };
      }

      const statusRes = await this.checkStatus(dep.ref_id);
      if (statusRes.status === 'success') {
        if (statusRes.payment_status === 'paid') {
          let depositConfirmed = false;

          // Confirm deposit atomically
          await dbTransaction(async ({ dbRun, dbGet }) => {
            const checkD = await dbGet('SELECT status FROM deposits WHERE id = ?', [dep.id]);
            if (checkD.status === 'approved') return;

            await dbRun(`UPDATE deposits SET status = 'approved', confirmed_at = DATETIME('now', 'localtime') WHERE id = ?`, [dep.id]);
            await dbRun(`UPDATE users SET balance = balance + ? WHERE id = ?`, [dep.amount, dep.user_id]);
            await dbRun(
              `INSERT INTO balance_history (user_id, amount, type, description) VALUES (?, ?, 'DEPOSIT', ?)`,
              [dep.user_id, dep.amount, `Auto Deposit QRIS #${dep.deposit_code}`]
            );
            depositConfirmed = true;
          });

          if (depositConfirmed) {
            // Notify User
            const userRow = await dbGet('SELECT balance FROM users WHERE id = ?', [dep.user_id]);
            const newBalance = userRow ? userRow.balance : ((dep.user_balance || 0) + dep.amount);
            let successMsg = `🎉 <b>DEPOSIT QRIS BERHASIL OTOMATIS!</b>\n\n`;
            successMsg += `Deposit Code: <code>#${dep.deposit_code}</code>\n`;
            successMsg += `Nominal Masuk: <b>${formatRupiah(dep.amount)}</b>\n`;
            successMsg += `Saldo Saat Ini: <b>${formatRupiah(newBalance)}</b>\n\n`;
            successMsg += `Terima kasih! Saldo Anda telah otomatis ditambahkan dan siap digunakan.`;

            try {
              await bot.sendMessage(dep.telegram_id, successMsg, { parse_mode: 'HTML' });
            } catch (e) {}

            // Notify Channel if configured
            if (config.CHANNEL_ID && String(config.CHANNEL_ID).startsWith('-100')) {
              try {
                const chMsg = `⚡ <b>AUTO DEPOSIT MASUK!</b>\n\nNominal: <b>${formatRupiah(dep.amount)}</b>\nUser: @${dep.username || 'User'}\nMetode: <b>QRIS Otomatis</b>\nStatus: <b>SUCCESS</b>`;
                await bot.sendMessage(config.CHANNEL_ID, chMsg, { parse_mode: 'HTML' });
              } catch (e) {}
            }
          }
          return { status: 'paid', message: 'Deposit berhasil diverifikasi dan saldo telah masuk!' };
        } else if (statusRes.payment_status === 'expired' || statusRes.payment_status === 'cancelled') {
          await dbRun(`UPDATE deposits SET status = 'expired' WHERE id = ?`, [dep.id]);
          try {
            await bot.sendMessage(dep.telegram_id, `⚠️ <b>DEPOSIT EXPIRED / KADALUARSA</b>\n\nKode Deposit <code>#${dep.deposit_code}</code> telah kadaluarsa. Silakan lakukan deposit ulang jika ingin mengisi saldo.`, { parse_mode: 'HTML' });
          } catch (e) {}
          return { status: 'expired', message: 'Deposit telah kadaluarsa atau dibatalkan.' };
        } else {
          return { status: 'pending', message: 'Pembayaran belum terdeteksi. Silakan transfer sesuai nominal yang tertera.' };
        }
      }
      return { status: 'pending', message: 'Sedang mengecek ke gateway pembayaran...' };
    } catch (err) {
      console.error(`[PROCESS DEPOSIT ERR #${dep.deposit_code}]:`, err.message);
      return { status: 'error', message: err.message };
    } finally {
      activeDepositLocks.delete(dep.id);
    }
  }

  // Process a single product order payment (shared between background polling and manual refresh)
  static async processSingleProductPayment(pay, { bot, dbRun, dbGet, dbAll, dbTransaction, formatRupiah }) {
    if (activePaymentLocks.has(pay.id)) {
      return { status: 'processing', message: 'Pembayaran sedang diproses...' };
    }
    activePaymentLocks.add(pay.id);

    try {
      // Re-check payment and order status in DB before processing
      const currentPay = await dbGet('SELECT status FROM payments WHERE id = ?', [pay.id]);
      const currentOrder = await dbGet('SELECT status FROM orders WHERE id = ?', [pay.order_id]);
      if (!currentPay || currentPay.status === 'paid' || (currentOrder && currentOrder.status === 'completed')) {
        return { status: 'paid', message: 'Pesanan sudah selesai diproses.' };
      }
      if (currentPay.status === 'expired' || currentPay.status === 'cancelled') {
        return { status: currentPay.status, message: 'Pesanan sudah tidak aktif.' };
      }

      const statusRes = await this.checkStatus(pay.ref_id);
      if (statusRes.status === 'success') {
        if (statusRes.payment_status === 'paid') {
          const reqQty = pay.qty || 1;
          let fulfilledItems = null;
          let needStockAlert = false;

          // Fulfill order atomically inside transaction
          await dbTransaction(async ({ dbRun, dbGet, dbAll }) => {
            const checkOrder = await dbGet('SELECT status FROM orders WHERE id = ?', [pay.order_id]);
            if (checkOrder.status === 'completed' || checkOrder.status === 'paid_stock_pending') {
              return;
            }

            const stockItems = await dbAll(`
              SELECT * FROM product_stock 
              WHERE product_id = ? AND status = 'available' 
              ORDER BY id ASC LIMIT ?
            `, [pay.product_id, reqQty]);

            if (stockItems.length < reqQty) {
              await dbRun(`UPDATE payments SET status = 'paid', confirmed_at = DATETIME('now', 'localtime') WHERE id = ?`, [pay.id]);
              await dbRun(`UPDATE orders SET status = 'paid_stock_pending' WHERE id = ?`, [pay.order_id]);
              needStockAlert = true;
              return;
            }

            for (const item of stockItems) {
              await dbRun(
                `UPDATE product_stock SET status = 'sold', order_id = ?, sold_at = DATETIME('now', 'localtime') WHERE id = ?`,
                [pay.order_code, item.id]
              );
            }
            await dbRun(`UPDATE payments SET status = 'paid', confirmed_at = DATETIME('now', 'localtime') WHERE id = ?`, [pay.id]);
            await dbRun(`UPDATE orders SET status = 'completed', stock_id = ?, completed_at = DATETIME('now', 'localtime') WHERE id = ?`, [stockItems[0].id, pay.order_id]);

            if (pay.voucher_code) {
              const v = await dbGet('SELECT * FROM vouchers WHERE code = ?', [pay.voucher_code]);
              if (v) {
                await dbRun(
                  'INSERT INTO voucher_usages (voucher_id, user_id, order_code, discount_amount) VALUES (?, ?, ?, ?)',
                  [v.id, pay.user_id, pay.order_code, pay.discount_amount || 0]
                );
                await dbRun('UPDATE vouchers SET used_count = used_count + 1 WHERE id = ?', [v.id]);
              }
            }

            fulfilledItems = stockItems;
          });

          if (needStockAlert) {
            const alertOwner = `⚠️ <b>PEMBAYARAN QRIS SUKSES, TAPI STOK KURANG!</b>\n\nOrder Code: <code>#${pay.order_code}</code>\nProduk: <b>${pay.category} - ${pay.prod_name}</b>\nJumlah diminta: ${reqQty}\nUser: @${pay.username || 'User'} (<code>${pay.telegram_id}</code>)\n\nHarap kirim akun manual ke pembeli!`;
            try {
              await bot.sendMessage(config.OWNER_ID, alertOwner, { parse_mode: 'HTML' });
              await bot.sendMessage(pay.telegram_id, `🎉 <b>PEMBAYARAN QRIS TERKONFIRMASI!</b>\n\nOrder <code>#${pay.order_code}</code> telah lunas. Stok sedang disiapkan oleh admin dan akan segera dikirimkan.`, { parse_mode: 'HTML' });
            } catch (e) {}
            return { status: 'paid', message: 'Pembayaran sukses, stok sedang disiapkan admin!' };
          }

          if (fulfilledItems && fulfilledItems.length > 0) {
            // Send credentials to buyer
            let successMsg = `🎉 <b>PEMBAYARAN QRIS BERHASIL (${reqQty} Pcs)</b>\n\n`;
            successMsg += `Order Code: <code>#${pay.order_code}</code>\n`;
            successMsg += `Produk: <b>${pay.category} - ${pay.prod_name}</b> (${reqQty} Pcs)\n`;
            successMsg += `Total: <b>${formatRupiah(pay.total_amount || pay.amount)}</b>\n\n`;
            successMsg += `━━━━━━━━━━━━━━━━━━\n`;
            successMsg += `📦 <b>DETAIL AKUN / CREDENTIAL (${reqQty} Pcs):</b>\n\n`;

            fulfilledItems.forEach((item, index) => {
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
            if (config.CHANNEL_ID && String(config.CHANNEL_ID).startsWith('-100')) {
              try {
                const chMsg = `🛍️ <b>TRANSAKSI QRIS OTOMATIS SUKSES!</b>\n\n📦 <b>Produk:</b> ${pay.category} - ${pay.prod_name} (${reqQty} Pcs)\n💰 <b>Total:</b> ${formatRupiah(pay.amount)}\n👤 <b>Pembeli:</b> @${pay.username || 'Buyer'}\n⚡ <b>Proses:</b> Instan 24 Jam Otomatis`;
                await bot.sendMessage(config.CHANNEL_ID, chMsg, { parse_mode: 'HTML' });
              } catch (e) {}
            }
            return { status: 'paid', message: 'Pembayaran sukses & produk berhasil dikirim!' };
          }

          return { status: 'paid', message: 'Pesanan telah selesai diproses.' };
        } else if (statusRes.payment_status === 'expired' || statusRes.payment_status === 'cancelled') {
          await dbRun(`UPDATE payments SET status = 'expired' WHERE id = ?`, [pay.id]);
          await dbRun(`UPDATE orders SET status = 'expired' WHERE id = ?`, [pay.order_id]);
          try {
            await bot.sendMessage(pay.telegram_id, `⚠️ <b>PEMBAYARAN QRIS EXPIRED</b>\n\nPembayaran untuk order <code>#${pay.order_code}</code> telah kadaluarsa. Silakan lakukan order baru jika ingin membeli.`, { parse_mode: 'HTML' });
          } catch (e) {}
          return { status: 'expired', message: 'Pembayaran telah kadaluarsa atau dibatalkan.' };
        } else {
          return { status: 'pending', message: 'Pembayaran belum terdeteksi. Silakan transfer sesuai nominal persis.' };
        }
      }
      return { status: 'pending', message: 'Sedang mengecek status ke server gateway...' };
    } catch (err) {
      console.error(`[PROCESS PAYMENT ERR #${pay.order_code}]:`, err.message);
      return { status: 'error', message: err.message };
    } finally {
      activePaymentLocks.delete(pay.id);
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
          await this.processSingleDeposit(dep, { bot, dbRun, dbGet, dbAll, dbTransaction, formatRupiah });
        }

        // 2. Check Pending Auto-QRIS Product Orders
        const pendingPayments = await dbAll(`
          SELECT p.*, o.order_code, o.product_id, o.qty, o.amount as order_amount, o.voucher_code, o.discount_amount, u.telegram_id, u.username, pr.name as prod_name, pr.category
          FROM payments p
          JOIN orders o ON p.order_id = o.id
          JOIN products pr ON o.product_id = pr.id
          JOIN users u ON p.user_id = u.id
          WHERE p.status = 'pending' AND p.ref_id IS NOT NULL AND p.method = 'AUTO_QRIS'
          ORDER BY p.id ASC
          LIMIT 10
        `);

        for (const pay of pendingPayments) {
          await this.processSingleProductPayment(pay, { bot, dbRun, dbGet, dbAll, dbTransaction, formatRupiah });
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
