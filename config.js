const path = require('path');
const fs = require('fs');

// Load environment variables from .env file
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    if (typeof process.loadEnvFile === 'function') {
      try {
        process.loadEnvFile(envPath);
      } catch (e) {
        // Fallback parser if loadEnvFile fails
        parseEnvFile(envPath);
      }
    } else {
      parseEnvFile(envPath);
    }
  }
}

function parseEnvFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (key && !(key in process.env)) {
          process.env[key] = value.replace(/^["']|["']$/g, '');
        }
      }
    }
  } catch (e) {
    console.error('[CONFIG] Failed to parse .env file:', e.message);
  }
}

loadEnv();

function parseAdminIds(adminStr, ownerId) {
  const ids = [];
  if (adminStr) {
    adminStr.split(',').forEach(id => {
      const parsed = parseInt(id.trim());
      if (!isNaN(parsed) && !ids.includes(parsed)) ids.push(parsed);
    });
  }
  const parsedOwner = parseInt(ownerId);
  if (!isNaN(parsedOwner) && !ids.includes(parsedOwner)) {
    ids.push(parsedOwner);
  }
  return ids;
}

const OWNER_ID = parseInt(process.env.OWNER_ID) || 8915677989;
const ADMIN_IDS = parseAdminIds(process.env.ADMIN_IDS, OWNER_ID);

module.exports = {
  // Telegram Bot Credentials
  BOT_TOKEN: process.env.BOT_TOKEN || '8611384867:AAE-IYs-BCKoObwswnjz39lXSRUZ0QfQLfg',
  OWNER_ID: OWNER_ID,
  ADMIN_IDS: ADMIN_IDS,

  // Store Identity
  STORE_NAME: process.env.STORE_NAME || 'Moakun Store',
  STORE_USERNAME: process.env.STORE_USERNAME || 'moakun_bot',
  CHANNEL_ID: process.env.CHANNEL_ID || '',
  CHANNEL_URL: process.env.CHANNEL_URL || '',
  GROUP_URL: process.env.GROUP_URL || '',
  SUPPORT_USERNAME: process.env.SUPPORT_USERNAME || 'yopratama',
  BANNER_URL: process.env.BANNER_URL || path.join(__dirname, 'assets', 'moakun_banner.jpg'),

  // CodeGatra Auto QRIS Payment Gateway
  CODEGATRA_BASE_URL: process.env.CODEGATRA_BASE_URL || 'https://pay.codegatra.com/api',
  CODEGATRA_API_KEY: process.env.CODEGATRA_API_KEY || '',
  CODEGATRA_NAMA_PROJECT: process.env.CODEGATRA_NAMA_PROJECT || '',
  CODEGATRA_EXPIRED_MINUTES: parseInt(process.env.CODEGATRA_EXPIRED_MINUTES) || 10,
  QRIS_STRING: process.env.QRIS_STRING || process.env.STATIC_QRIS || '',
  QRIS_URL: process.env.QRIS_URL || '',

  // RumahOTP Virtual SMS Service
  RUMAHOTP_API_KEY: process.env.RUMAHOTP_API_KEY || 'rk-dev-4t0UxAzXvQQRXr4VIixWXUQ1AL0qU4P6',
  RUMAHOTP_BASE_URL: process.env.RUMAHOTP_BASE_URL || 'https://www.rumahotp.io',
  OTP_PROFIT_MARGIN: parseInt(process.env.OTP_PROFIT_MARGIN) || 1500,

  // General Settings
  CURRENCY: process.env.CURRENCY || 'Rp',
  MIN_DEPOSIT: parseInt(process.env.MIN_DEPOSIT) || 10000,
  ITEMS_PER_PAGE: parseInt(process.env.ITEMS_PER_PAGE) || 5,
  AUTO_BACKUP_HOURS: parseInt(process.env.AUTO_BACKUP_HOURS) || 24
};
