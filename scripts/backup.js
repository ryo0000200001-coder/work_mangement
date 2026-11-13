'use strict';
// DB のオンラインバックアップ（稼働中でも安全に取得できる）
// 使い方: npm run backup [-- 出力ディレクトリ]
const path = require('path');
const fs = require('fs');
const config = require('../src/config');
const db = require('../src/db');
const t = require('../src/lib/time');

const dir = path.resolve(process.argv[2] || path.join(config.ROOT, 'backups'));
fs.mkdirSync(dir, { recursive: true });
const stamp = t.toLocalISO(new Date()).replace(/[-:]/g, '').replace('T', '-');
const file = path.join(dir, `kintai-${stamp}.sqlite3`);
db.get().backup(file)
  .then(() => console.log(`バックアップを作成しました: ${file}`))
  .catch((e) => { console.error(e); process.exit(1); });
