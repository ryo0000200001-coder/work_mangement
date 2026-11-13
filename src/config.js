'use strict';
// 日本時間で日付計算を行う（日本は夏時間がないため Asia/Tokyo 固定で安全）
process.env.TZ = process.env.TZ || 'Asia/Tokyo';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// SESSION_SECRET が未指定の場合はデータディレクトリに生成・永続化する
function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  ensureDataDir();
  const file = path.join(DATA_DIR, '.session_secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

module.exports = {
  ROOT,
  DATA_DIR,
  ensureDataDir,
  loadSessionSecret,
  PORT: Number(process.env.PORT || 3000),
  NODE_ENV: process.env.NODE_ENV || 'development',
  // リバースプロキシ(HTTPS終端)配下で動かす場合は TRUST_PROXY=1
  TRUST_PROXY: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
  // HTTPS で配信する場合は COOKIE_SECURE=1（TRUST_PROXY と併用）
  COOKIE_SECURE: process.env.COOKIE_SECURE === '1' || process.env.COOKIE_SECURE === 'true',
  DB_FILE: process.env.DB_FILE || path.join(DATA_DIR, 'kintai.sqlite3'),
};
