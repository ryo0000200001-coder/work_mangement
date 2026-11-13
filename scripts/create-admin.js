'use strict';
// 管理者アカウントをコマンドラインから作成・パスワード再設定する
// 使い方: npm run create-admin -- <ログインID> <氏名> <パスワード>
require('../src/config');
const db = require('../src/db');
const users = require('../src/services/users');

const [loginId, name, password] = process.argv.slice(2);
if (!loginId || !name || !password) {
  console.error('使い方: npm run create-admin -- <ログインID> <氏名> <パスワード>');
  process.exit(1);
}
db.get();
const pe = users.validatePassword(password);
if (pe) { console.error(pe); process.exit(1); }
const existing = users.findByLoginId(loginId);
if (existing) {
  users.setPassword(existing.id, password);
  db.get().prepare("UPDATE users SET role = 'admin', active = 1 WHERE id = ?").run(existing.id);
  console.log(`既存ユーザー ${loginId} を管理者にし、パスワードを再設定しました。`);
} else {
  const { errors, values } = users.parseUserForm({ login_id: loginId, name, password, role: 'admin', work_start: '09:00', work_end: '18:00' }, { isNew: true });
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  values.role = 'admin';
  users.create(values, { mustChangePassword: false });
  console.log(`管理者 ${loginId} を作成しました。`);
}
