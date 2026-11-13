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

/** storeId を指定するとその店舗所属のユーザーのみ */
function list({ includeInactive = true, storeId = null } = {}) {
  const where = [];
  const args = [];
  if (!includeInactive) where.push('active = 1');
  if (storeId) { where.push('store_id = ?'); args.push(storeId); }
  return db.get().prepare(`SELECT * FROM users ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY active DESC, store_id, department, login_id`).all(...args);
}

/** フォーム入力を検証。errors と値を返す */
function parseUserForm(body, { isNew }) {
  const errors = [];
  const v = {
    login_id: str(body.login_id),
    name: str(body.name),
    email: str(body.email) || null,
    department: str(body.department) || null,
    role: ['admin', 'manager'].includes(body.role) ? body.role : 'employee',
    employment_type: body.employment_type === 'part' ? 'part' : 'full',
    store_id: Number(body.store_id) || null,
    hourly_wage: null,
    commute_per_day: null,
    annual_income_limit: null,
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
  const yenField = (key, label, max) => {
    const raw = str(body[key]).replace(/[,，円]/g, '');
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > max) { errors.push(`${label}は 0〜${max.toLocaleString()} の整数（円）で入力してください。`); return null; }
    return n;
  };
  v.hourly_wage = yenField('hourly_wage', '時給', 100000);
  v.commute_per_day = yenField('commute_per_day', '交通費', 100000);
  v.annual_income_limit = yenField('annual_income_limit', '年収の目安上限', 100000000);
  if (v.role === 'manager' && !v.store_id) errors.push('店長には担当店舗を設定してください。');
  if (isNew || v.password) {
    const pe = validatePassword(v.password);
    if (pe) errors.push(pe);
  }
  return { errors, values: v };
}

function create(v, { mustChangePassword = true } = {}) {
  return db.get().prepare(`
    INSERT INTO users(login_id, name, email, department, role, password_hash, must_change_password, work_start, work_end, standard_minutes, hire_date,
      employment_type, store_id, hourly_wage, commute_per_day, annual_income_limit)
    VALUES (@login_id, @name, @email, @department, @role, @password_hash, @must_change, @work_start, @work_end, @standard_minutes, @hire_date,
      @employment_type, @store_id, @hourly_wage, @commute_per_day, @annual_income_limit)`)
    .run({
      employment_type: 'full', store_id: null, hourly_wage: null, commute_per_day: null, annual_income_limit: null,
      ...v, password_hash: hashPassword(v.password), must_change: mustChangePassword ? 1 : 0,
    }).lastInsertRowid;
}

function update(id, v) {
  db.get().prepare(`
    UPDATE users SET login_id=@login_id, name=@name, email=@email, department=@department, role=@role, active=@active,
      work_start=@work_start, work_end=@work_end, standard_minutes=@standard_minutes, hire_date=@hire_date,
      employment_type=@employment_type, store_id=@store_id, hourly_wage=@hourly_wage, commute_per_day=@commute_per_day,
      annual_income_limit=@annual_income_limit, updated_at=datetime('now','localtime')
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
