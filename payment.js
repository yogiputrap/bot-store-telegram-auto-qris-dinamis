const config = require('./config.js');
const CodeGatraService = require('./codegatra.js');

class PaymentService {
  // === VOUCHER VALIDATION & APPLICATION ===
  static async validateVoucher(dbGet, code, userId, amount) {
    if (!code) return { valid: false, message: 'Kode voucher kosong' };
    const cleanCode = code.trim().toUpperCase();

    const voucher = await dbGet(`SELECT * FROM vouchers WHERE code = ? AND status = 'active'`, [cleanCode]);
    if (!voucher) {
      return { valid: false, message: 'Voucher tidak ditemukan atau sudah tidak aktif' };
    }

    if (voucher.min_spend && amount < voucher.min_spend) {
      return {
        valid: false,
        message: `Minimal transaksi untuk voucher ini adalah ${config.CURRENCY} ${new Intl.NumberFormat('id-ID').format(voucher.min_spend)}`
      };
    }

    if (voucher.max_usage && voucher.used_count >= voucher.max_usage) {
      return { valid: false, message: 'Kuota penggunaan voucher ini sudah habis' };
    }

    // Check if user already used this voucher
    const userUsage = await dbGet('SELECT COUNT(*) as count FROM voucher_usages WHERE voucher_id = ? AND user_id = ?', [voucher.id, userId]);
    if (userUsage && userUsage.count > 0) {
      return { valid: false, message: 'Anda sudah pernah menggunakan voucher ini sebelumnya' };
    }

    const discountAmount = Math.min(amount, voucher.discount_amount);
    const finalAmount = Math.max(0, amount - discountAmount);

    return {
      valid: true,
      voucher,
      discountAmount,
      finalAmount,
      code: cleanCode
    };
  }

  // Record voucher usage
  static async recordVoucherUsage(dbRun, voucherId, userId, orderCode, discountAmount) {
    await dbRun(
      'INSERT INTO voucher_usages (voucher_id, user_id, order_code, discount_amount) VALUES (?, ?, ?, ?)',
      [voucherId, userId, orderCode, discountAmount]
    );
    await dbRun(
      'UPDATE vouchers SET used_count = used_count + 1 WHERE id = ?',
      [voucherId]
    );
  }

  // === PAYMENT PRODUK (AUTO QRIS CODEGATRA / DYNAMIC QRIS) ===
  static async createProductPayment({ dbRun, orderCode, userId, grossAmount, discountAmount = 0, voucherCode = null, customerName = 'Customer' }) {
    const finalAmount = Math.max(100, grossAmount - discountAmount);
    const paymentCode = 'PAY-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const refId = 'ORD-' + Date.now() + '-' + Math.floor(Math.random() * 1000);

    const cgRes = await CodeGatraService.createOrder({
      refId,
      amount: finalAmount,
      customerName,
      expiredMinutes: config.CODEGATRA_EXPIRED_MINUTES || 10
    });

    if (!cgRes || cgRes.status !== 'success') {
      return {
        status: 'error',
        message: cgRes?.message || 'Gagal membuat QRIS otomatis dari payment gateway.'
      };
    }

    const sql = `
      INSERT INTO payments (payment_code, order_id, user_id, ref_id, amount, total_amount, unique_code, qr_image, method, status, expired_at, created_at)
      VALUES (?, (SELECT id FROM orders WHERE order_code = ?), ?, ?, ?, ?, ?, ?, 'AUTO_QRIS', 'pending', ?, DATETIME('now', 'localtime'))
    `;
    await dbRun(sql, [
      paymentCode,
      orderCode,
      userId,
      refId,
      finalAmount,
      cgRes.total_amount,
      cgRes.unique_code,
      cgRes.qr_image || cgRes.qr_string || '',
      cgRes.expired_at.toISOString()
    ]);

    return {
      status: 'success',
      paymentCode,
      orderCode,
      refId,
      amount: finalAmount,
      totalAmount: cgRes.total_amount,
      uniqueCode: cgRes.unique_code,
      qrImage: cgRes.qr_image,
      qrBuffer: cgRes.qr_buffer,
      qrString: cgRes.qr_string,
      expiredMinutes: config.CODEGATRA_EXPIRED_MINUTES || 10
    };
  }

  // === DEPOSIT SALDO (AUTO QRIS CODEGATRA / DYNAMIC QRIS) ===
  static async createDeposit({ dbRun, userId, amount, customerName = 'Member' }) {
    const depositCode = 'DEP-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const refId = 'DEP-' + Date.now() + '-' + Math.floor(Math.random() * 1000);

    const cgRes = await CodeGatraService.createOrder({
      refId,
      amount,
      customerName,
      expiredMinutes: config.CODEGATRA_EXPIRED_MINUTES || 10
    });

    if (!cgRes || cgRes.status !== 'success') {
      return {
        status: 'error',
        message: cgRes?.message || 'Gagal membuat transaksi deposit QRIS otomatis.'
      };
    }

    const sql = `
      INSERT INTO deposits (deposit_code, user_id, ref_id, amount, total_amount, unique_code, qr_image, method, status, expired_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'AUTO_QRIS', 'pending', ?, DATETIME('now', 'localtime'))
    `;
    await dbRun(sql, [
      depositCode,
      userId,
      refId,
      amount,
      cgRes.total_amount,
      cgRes.unique_code,
      cgRes.qr_image || cgRes.qr_string || '',
      cgRes.expired_at.toISOString()
    ]);

    return {
      status: 'success',
      depositCode,
      refId,
      amount,
      totalAmount: cgRes.total_amount,
      uniqueCode: cgRes.unique_code,
      qrImage: cgRes.qr_image,
      qrBuffer: cgRes.qr_buffer,
      qrString: cgRes.qr_string,
      expiredMinutes: config.CODEGATRA_EXPIRED_MINUTES || 10
    };
  }
}

module.exports = PaymentService;
