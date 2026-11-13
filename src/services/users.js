'use strict';
const bcrypt = require('bcryptjs');
const db = require('../db');
const t = require('../lib/time');
const { str } = require('../lib/forms');

const BCRYPT_ROUNDS = 10;
const LOGIN_ID_RE = /^[A-Za-z0-9._@-]{2,64}$/;

function hashPassword(pw) {
  return bcrypt.hashSync(pw, BCRYPT_ROUNDS);
}

function verifyPassword(user, pw) {
  return !!user && bcrypt.compareSync(pw, user.password_hash);
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'パスワードは8文字以上で入力してください。';
  if (pw.length > 128) return 'パスワードは128文字以内で入力してください。';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'パスワードには英字と数字を両方含めてください。';
  return null;
}

function findById(id) {
  return db.get().prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

function findByLoginId(loginId) {
  return db.get().prepare('SELECT * FROM users WHERE login_id = ?').get(loginId) || null;
}

function count() {
  return db.get().prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

function list({ includeInactive = true } = {}) {
  return db.get().prepare(`SELECT * FROM users ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY active DESC, department, login_id`).all();
}

/** フォーム入力を検証。errors と値を返す */
function parseUserForm(body, { isNew }) {
  const errors = [];
  const v = {
    login_id: str(body.login_id),
    name: str(body.name),
    email: str(body.email) || null,
    department: str(body.department) || null,
    role: body.role === 'admin' ? 'admin' : 'employee',
    active: body.active === '1' || body.active === 'on' ? 1 : 0,
    work_start: str(body.work_start),
    work_end: str(body.work_end),
    standard_minutes: null,
    hire_date: str(body.hire_date) || null,
    password: typeof body.password === 'string' ? body.password : '',
  };
  if (isNew) v.active = 1;
  if (!LOGIN_ID_RE.test(v.login_id)) errors.push('ログインIDは2〜64文字の半角英数字と . _ @ - で入力してください。');
  if (!v.name || v.name.length > 100) errors.push('氏名を入力してください（100文字以内）。');
  if (v.email && !/^[^\s@]+@[^\s@]+$/.test(v.email)) errors.push('メールアドレスの形式が正しくありません。');
  if (!t.isValidTime(v.work_start) || !t.isValidTime(v.work_end)) errors.push('始業・終業時刻を HH:MM 形式で入力してください。');
  if (v.hire_date && !t.isValidDate(v.hire_date)) errors.push('入社日の形式が正しくありません。');
  const std = str(body.standard_hours);
  if (std) {
    const n = Number(std);
    if (!Number.isFinite(n) || n <= 0 || n > 24) errors.push('所定労働時間は 0〜24 の数値（時間）で入力してください。');
    else v.standard_minutes = Math.round(n * 60);
  }
  if (isNew || v.password) {
    const pe = validatePassword(v.password);
    if (pe) errors.push(pe);
  }
  return { errors, values: v };
}

function create(v, { mustChangePassword = true } = {}) {
  return db.get().prepare(`
    INSERT INTO users(login_id, name, email, department, role, password_hash, must_change_password, work_start, work_end, standard_minutes, hire_date)
    VALUES (@login_id, @name, @email, @department, @role, @password_hash, @must_change, @work_start, @work_end, @standard_minutes, @hire_date)`)
    .run({ ...v, password_hash: hashPassword(v.password), must_change: mustChangePassword ? 1 : 0 }).lastInsertRowid;
}

function update(id, v) {
  db.get().prepare(`
    UPDATE users SET login_id=@login_id, name=@name, email=@email, department=@department, role=@role, active=@active,
      work_start=@work_start, work_end=@work_end, standard_minutes=@standard_minutes, hire_date=@hire_date,
      updated_at=datetime('now','localtime')
    WHERE id=@id`).run({ ...v, id });
}

function setPassword(id, pw, { mustChange = false } = {}) {
  db.get().prepare("UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = datetime('now','localtime') WHERE id = ?")
    .run(hashPassword(pw), mustChange ? 1 : 0, id);
}

function activeAdminCount(excludeId = null) {
  return db.get().prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1 AND id != ?").get(excludeId || 0).c;
}

module.exports = {
  hashPassword, verifyPassword, validatePassword, findById, findByLoginId, count, list,
  parseUserForm, create, update, setPassword, activeAdminCount,
};
