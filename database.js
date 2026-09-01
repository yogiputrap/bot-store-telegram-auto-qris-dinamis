const path = require('path');
const fs = require('fs');

const dbDir = path.join(__dirname, 'database');
const backupDir = path.join(__dirname, 'backups');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

const dbPath = path.join(dbDir, 'database.sqlite');

let dbRun, dbGet, dbAll, dbTransaction, dbInstance;

// Check if native node:sqlite is available (Node 22+)
let useNativeSqlite = false;
try {
  const { DatabaseSync } = require('node:sqlite');
  const nativeDb = new DatabaseSync(dbPath);
  nativeDb.exec('PRAGMA journal_mode = WAL;');
  nativeDb.exec('PRAGMA synchronous = NORMAL;');
  nativeDb.exec('PRAGMA foreign_keys = ON;');
  dbInstance = nativeDb;
  useNativeSqlite = true;

  dbRun = (sql, params = []) => {
    return new Promise((resolve, reject) => {
      try {
        const stmt = nativeDb.prepare(sql);
        const result = stmt.run(...params);
        resolve({ lastID: Number(result.lastInsertRowid), changes: Number(result.changes) });
      } catch (err) {
        reject(err);
      }
    });
  };

  dbGet = (sql, params = []) => {
    return new Promise((resolve, reject) => {
      try {
        const stmt = nativeDb.prepare(sql);
        const row = stmt.get(...params);
        resolve(row || null);
      } catch (err) {
        reject(err);
      }
    });
  };

  dbAll = (sql, params = []) => {
    return new Promise((resolve, reject) => {
      try {
        const stmt = nativeDb.prepare(sql);
        const rows = stmt.all(...params);
        resolve(rows || []);
      } catch (err) {
        reject(err);
      }
    });
  };

  dbTransaction = async (callback) => {
    nativeDb.exec('BEGIN TRANSACTION;');
    try {
      const result = await callback({ dbRun, dbGet, dbAll });
      nativeDb.exec('COMMIT;');
      return result;
    } catch (err) {
      nativeDb.exec('ROLLBACK;');
      throw err;
    }
  };
} catch (e) {
  // Fallback to sqlite3 callback library
  const sqlite3 = require('sqlite3').verbose();
  const legacyDb = new sqlite3.Database(dbPath);
  legacyDb.run('PRAGMA journal_mode = WAL;');
  legacyDb.run('PRAGMA foreign_keys = ON;');
  dbInstance = legacyDb;

  dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    legacyDb.run(sql, params, function (err) {
      if (err) reject(err); else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });

  dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    legacyDb.get(sql, params, (err, row) => {
      if (err) reject(err); else resolve(row || null);
    });
  });

  dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    legacyDb.all(sql, params, (err, rows) => {
      if (err) reject(err); else resolve(rows || []);
    });
  });

  dbTransaction = async (callback) => {
    await dbRun('BEGIN TRANSACTION');
    try {
      const res = await callback({ dbRun, dbGet, dbAll });
      await dbRun('COMMIT');
      return res;
    } catch (err) {
      await dbRun('ROLLBACK');
      throw err;
    }
  };
}

async function ensureColumn(tableName, columnName, columnDefinition) {
  try {
    const tableInfo = await dbAll(`PRAGMA table_info(${tableName})`);
    const exists = tableInfo.some(col => col.name.toLowerCase() === columnName.toLowerCase());
    if (!exists) {
      await dbRun(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
    }
  } catch (err) {
    // Ignore if table doesn't exist yet
  }
}

async function initDatabase() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER UNIQUE,
      username TEXT,
      first_name TEXT,
      balance INTEGER DEFAULT 0,
      role TEXT DEFAULT 'user',
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT DEFAULT 'GENERAL',
      name TEXT NOT NULL,
      description TEXT,
      price INTEGER NOT NULL,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS product_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER,
      email TEXT NOT NULL,
      password TEXT NOT NULL,
      extra_data TEXT,
      status TEXT DEFAULT 'available',
      order_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      sold_at DATETIME
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_code TEXT UNIQUE,
      user_id INTEGER,
      product_id INTEGER,
      stock_id INTEGER,
      qty INTEGER DEFAULT 1,
      gross_amount INTEGER,
      discount_amount INTEGER DEFAULT 0,
      voucher_code TEXT,
      amount INTEGER,
      payment_method TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS otp_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_code TEXT UNIQUE,
      provider_order_id TEXT,
      user_id INTEGER,
      service_name TEXT,
      phone_number TEXT,
      amount INTEGER,
      status TEXT DEFAULT 'active',
      otp_code TEXT,
      otp_msg TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_code TEXT UNIQUE,
      order_id INTEGER,
      user_id INTEGER,
      ref_id TEXT UNIQUE,
      amount INTEGER,
      total_amount INTEGER,
      unique_code INTEGER DEFAULT 0,
      qr_image TEXT,
      method TEXT,
      proof_file_id TEXT,
      status TEXT DEFAULT 'pending',
      rejection_reason TEXT,
      expired_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      confirmed_at DATETIME
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deposit_code TEXT UNIQUE,
      user_id INTEGER,
      ref_id TEXT UNIQUE,
      amount INTEGER,
      total_amount INTEGER,
      unique_code INTEGER DEFAULT 0,
      qr_image TEXT,
      method TEXT DEFAULT 'AUTO_QRIS',
      proof_file_id TEXT,
      status TEXT DEFAULT 'pending',
      rejection_reason TEXT,
      expired_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      confirmed_at DATETIME
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS balance_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      amount INTEGER,
      type TEXT,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS vouchers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE,
      discount_amount INTEGER,
      min_spend INTEGER DEFAULT 0,
      max_usage INTEGER DEFAULT 0,
      used_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS voucher_usages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER,
      user_id INTEGER,
      order_code TEXT,
      discount_amount INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_code TEXT UNIQUE,
      user_id INTEGER,
      order_code TEXT,
      issue_type TEXT,
      description TEXT,
      status TEXT DEFAULT 'open',
      admin_reply TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME
    )
  `);

  // Ensure safe column migrations if existing tables were created previously
  await ensureColumn('orders', 'qty', 'INTEGER DEFAULT 1');
  await ensureColumn('orders', 'gross_amount', 'INTEGER');
  await ensureColumn('orders', 'discount_amount', 'INTEGER DEFAULT 0');
  await ensureColumn('orders', 'voucher_code', 'TEXT');
  await ensureColumn('otp_orders', 'otp_msg', 'TEXT');
  await ensureColumn('otp_orders', 'completed_at', 'DATETIME');
  await ensureColumn('payments', 'ref_id', 'TEXT');
  await ensureColumn('payments', 'total_amount', 'INTEGER');
  await ensureColumn('payments', 'unique_code', 'INTEGER DEFAULT 0');
  await ensureColumn('payments', 'qr_image', 'TEXT');
  await ensureColumn('payments', 'expired_at', 'DATETIME');
  await ensureColumn('deposits', 'ref_id', 'TEXT');
  await ensureColumn('deposits', 'total_amount', 'INTEGER');
  await ensureColumn('deposits', 'unique_code', 'INTEGER DEFAULT 0');
  await ensureColumn('deposits', 'qr_image', 'TEXT');
  await ensureColumn('deposits', 'method', 'TEXT DEFAULT "AUTO_QRIS"');
  await ensureColumn('deposits', 'expired_at', 'DATETIME');
  await ensureColumn('vouchers', 'min_spend', 'INTEGER DEFAULT 0');
  await ensureColumn('vouchers', 'max_usage', 'INTEGER DEFAULT 0');
  await ensureColumn('vouchers', 'used_count', 'INTEGER DEFAULT 0');

  // Seed Default Product categories if database is completely empty
  const prodCheck = await dbGet('SELECT COUNT(*) as count FROM products');
  if (prodCheck && prodCheck.count === 0) {
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
  }
}

module.exports = {
  dbDir,
  backupDir,
  dbPath,
  dbRun,
  dbGet,
  dbAll,
  dbTransaction,
  initDatabase,
  dbInstance
};
