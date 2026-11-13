'use strict';
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const t = require('../lib/time');
const audit = require('../lib/audit');
const csv = require('../lib/csv');
const settingsLib = require('../lib/settings');
const { holidaysOfYear } = require('../lib/holidays');
const { LEAVE_TYPES } = require('../lib/calc');
const { parseAttendanceForm, recordToForm, str } = require('../lib/forms');
const att = require('../services/attendance');
const reqs = require('../services/requests');
const users = require('../services/users');
const storesSvc = require('../services/stores');
const { requireLogin, requireAdmin, requireManager, canManage, scopeStoreId } = require('../middleware/auth');

const router = express.Router();
// 管理画面は管理者・店長が利用可能。店長は担当店舗のスタッフのみ。管理者専用の画面は requireAdmin を付ける
router.use(requireLogin, requireManager);

const STATE_LABELS = { off: '未出勤', working: '勤務中', break: '休憩中', done: '退勤済' };

function monthParam(req) {
  return t.isValidMonth(req.query.month) ? req.query.month : t.monthOf(t.today(), req.settings.closing_day);
}

function userOr404(req, res, id) {
  const u = users.findById(Number(id));
  if (!u || !canManage(req.user, u)) {
    res.status(404).render('error', { title: '見つかりません', message: '指定された従業員は存在しません。' });
    return null;
  }
  return u;
}

// ---- 本日の状況 ----
router.get('/', (req, res) => {
  const now = new Date();
  const today = t.today(now);
  const rows = users.list({ includeInactive: false, storeId: scopeStoreId(req.user) }).map((u) => {
    const status = att.getStatus(u.id, now);
    const date = status.record ? status.record.work_date : today;
    const day = att.buildPeriod(u, date, date, now, req.settings).days[0];
    return { user: u, status, day };
  });
  const counts = { off: 0, working: 0, break: 0, done: 0, leave: 0 };
  for (const r of rows) {
    if (r.status.state === 'off' && r.day.leaveType) counts.leave += 1;
    else counts[r.status.state] += 1;
  }
  const dt = att.dayType(today, req.settings, att.companyHolidays(today, today));
  res.render('admin/index', { title: '本日の勤務状況', rows, counts, STATE_LABELS, today, dayInfo: dt, pending: reqs.list({ status: 'pending', storeId: scopeStoreId(req.user), limit: 10 }) });
});

// ---- 申請の承認 ----
router.get('/requests', (req, res) => {
  const status = ['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status) ? req.query.status : (req.query.status === 'all' ? null : 'pending');
  res.render('admin/requests', { title: '申請の承認', requests: reqs.list({ status, storeId: scopeStoreId(req.user), limit: 300 }), filter: req.query.status === 'all' ? 'all' : status });
});

function reviewAction(fn, action, okMsg) {
  return (req, res) => {
    const id = Number(req.params.id);
    const comment = str(req.body.comment).slice(0, 500);
    const target = reqs.get(id);
    if (!target || !canManage(req.user, users.findById(target.user_id))) {
      req.flash('error', '申請が見つかりません。');
      return res.redirect('/admin/requests');
    }
    try {
      fn(req.user.id, id, comment);
      audit.log(req, action, 'request', id, comment ? { comment } : null);
      req.flash('success', okMsg);
    } catch (e) {
      if (!(e instanceof reqs.RequestError)) throw e;
      req.flash('error', e.message);
    }
    const back = str(req.body.back);
    res.redirect(back.startsWith('/admin') ? back : '/admin/requests');
  };
}
router.post('/requests/:id/approve', reviewAction(reqs.approve, 'request.approve', '申請を承認しました。'));
router.post('/requests/:id/reject', reviewAction(reqs.reject, 'request.reject', '申請を却下しました。'));
router.post('/requests/:id/revoke', reviewAction(reqs.revokeLeave, 'request.revoke', '承認済みの休暇を取り消しました。'));

// ---- 従業員管理 ----
router.get('/users', requireAdmin, (req, res) => {
  const list = users.list().map((u) => ({ ...u, balance: att.paidLeaveBalance(u.id) }));
  res.render('admin/users', { title: '従業員', users: list });
});

function blankUser(settings) {
  return {
    login_id: '', name: '', email: '', department: '', role: 'employee', active: 1, work_start: settings.default_work_start,
    work_end: settings.default_work_end, standard_hours: '', hire_date: '', employment_type: 'part', store_id: '',
    hourly_wage: '', commute_per_day: '', annual_income_limit: '',
  };
}

router.get('/users/new', requireAdmin, (req, res) => {
  res.render('admin/user-form', { stores: storesSvc.list({ includeInactive: true }), title: '従業員の登録', values: blankUser(req.settings), errors: [], isNew: true, target: null });
});

router.post('/users', requireAdmin, (req, res) => {
  const { errors, values } = users.parseUserForm(req.body, { isNew: true });
  if (!errors.length && users.findByLoginId(values.login_id)) errors.push('このログインIDはすでに使われています。');
  if (errors.length) return res.status(400).render('admin/user-form', { stores: storesSvc.list({ includeInactive: true }), title: '従業員の登録', values: req.body, errors, isNew: true, target: null });
  const id = users.create(values, { mustChangePassword: true });
  audit.log(req, 'user.create', 'user', id, { login_id: values.login_id, name: values.name, role: values.role });
  req.flash('success', `${values.name} さんを登録しました。初期パスワードを本人に伝えてください（初回ログイン時に変更が求められます）。`);
  res.redirect('/admin/users');
});

function userToForm(u) {
  const blank = (v) => (v == null ? '' : String(v));
  return {
    ...u, standard_hours: u.standard_minutes ? String(u.standard_minutes / 60) : '',
    hourly_wage: blank(u.hourly_wage), commute_per_day: blank(u.commute_per_day), annual_income_limit: blank(u.annual_income_limit),
  };
}

router.get('/users/:id/edit', requireAdmin, (req, res) => {
  const u = userOr404(req, res, req.params.id);
  if (!u) return;
  res.render('admin/user-form', { stores: storesSvc.list({ includeInactive: true }), title: '従業員の編集', values: userToForm(u), errors: [], isNew: false, target: u });
});

router.post('/users/:id', requireAdmin, (req, res) => {
  const u = userOr404(req, res, req.params.id);
  if (!u) return;
  const { errors, values } = users.parseUserForm({ ...req.body, password: '' }, { isNew: false });
  const other = users.findByLoginId(values.login_id);
  if (other && other.id !== u.id) errors.push('このログインIDはすでに使われています。');
  if (u.role === 'admin' && (values.role !== 'admin' || !values.active) && users.activeAdminCount(u.id) === 0) {
    errors.push('有効な管理者が1人もいなくなるため、変更できません。');
  }
  if (errors.length) return res.status(400).render('admin/user-form', { stores: storesSvc.list({ includeInactive: true }), title: '従業員の編集', values: { ...req.body, id: u.id }, errors, isNew: false, target: u });
  users.update(u.id, values);
  audit.log(req, 'user.update', 'user', u.id, { login_id: values.login_id, role: values.role, active: values.active });
  req.flash('success', `${values.name} さんの情報を更新しました。`);
  res.redirect('/admin/users');
});

function tempPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  let pw = '';
  for (let i = 0; i < 8; i++) pw += chars[crypto.randomInt(chars.length)];
  for (let i = 0; i < 3; i++) pw += digits[crypto.randomInt(digits.length)];
  return pw;
}

router.post('/users/:id/reset-password', requireAdmin, (req, res) => {
  const u = userOr404(req, res, req.params.id);
  if (!u) return;
  const pw = tempPassword();
  users.setPassword(u.id, pw, { mustChange: true });
  db.get().prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?").run(u.id);
  audit.log(req, 'user.reset_password', 'user', u.id);
  req.flash('success', `${u.name} さんの仮パスワード: ${pw}　（この画面を離れると再表示できません。本人にお伝えください）`);
  res.redirect(`/admin/users/${u.id}/edit`);
});

// ---- 勤務表（従業員別） ----
router.get('/timesheets', (req, res) => {
  const month = monthParam(req);
  const all = users.list({ storeId: scopeStoreId(req.user) });
  let target = req.query.user ? users.findById(Number(req.query.user)) : null;
  if (target && !canManage(req.user, target)) target = null;
  if (!target) {
    const rows = all.filter((u) => u.active).map((u) => ({ user: u, summary: att.buildMonth(u, month, new Date(), req.settings).summary }));
    const period = t.monthPeriod(month, req.settings.closing_day);
    return res.render('admin/monthly', { title: '月次集計', month, period, rows, users: all });
  }
  const sheet = att.buildMonth(target, month, new Date(), req.settings);
  res.render('timesheet', { title: `勤務表 - ${target.name}`, sheet, target, isAdminView: true, users: all, balance: att.paidLeaveBalance(target.id) });
});

// ---- 勤怠の直接修正 ----
router.get('/attendance/:userId/:date', (req, res) => {
  const u = userOr404(req, res, req.params.userId);
  if (!u) return;
  const date = req.params.date;
  if (!t.isValidDate(date)) return res.redirect('/admin/timesheets');
  const rec = att.getRecord(u.id, date);
  const form = { ...recordToForm(rec, date), store_id: rec ? rec.store_id : att.defaultStoreId(u.id, date) };
  res.render('admin/attendance-edit', { title: '勤怠の修正', target: u, date, form, rec, errors: [], stores: storesSvc.list({ includeInactive: true }) });
});

router.post('/attendance/:userId/:date', (req, res) => {
  const u = userOr404(req, res, req.params.userId);
  if (!u) return;
  const date = req.params.date;
  if (!t.isValidDate(date)) return res.redirect('/admin/timesheets');
  const before = att.getRecord(u.id, date);
  const back = `/admin/timesheets?user=${u.id}&month=${t.monthOf(date, req.settings.closing_day)}`;
  if (req.body.delete === '1') {
    att.saveRecord(u.id, date, { clockIn: null });
    audit.log(req, 'attendance.edit', 'user', u.id, { date, deleted: true, before });
    req.flash('success', `${u.name} さんの ${date} の勤怠を削除しました。`);
    return res.redirect(back);
  }
  const { errors, data } = parseAttendanceForm(req.body, date, { requireClockOut: false });
  if (errors.length) {
    const form = { ...req.body, clock_out_next_day: req.body.clock_out_next_day === '1', breaks: [].concat(req.body.break_start || []).map((s, i) => ({ start: s, end: [].concat(req.body.break_end || [])[i] || '' })) };
    return res.status(400).render('admin/attendance-edit', { title: '勤怠の修正', target: u, date, form: { ...form, store_id: Number(req.body.store_id) || null }, rec: before, errors, stores: storesSvc.list({ includeInactive: true }) });
  }
  data.storeId = Number(req.body.store_id) || null;
  att.saveRecord(u.id, date, data);
  audit.log(req, 'attendance.edit', 'user', u.id, { date, before, after: data });
  req.flash('success', `${u.name} さんの ${date} の勤怠を保存しました。`);
  res.redirect(back);
});

// ---- 有給休暇 ----
router.get('/leave', requireAdmin, (req, res) => {
  const list = users.list({ includeInactive: false }).map((u) => ({ ...u, balance: att.paidLeaveBalance(u.id) }));
  const target = req.query.user ? users.findById(Number(req.query.user)) : null;
  const ledger = target ? db.get().prepare(`SELECT l.*, c.name AS created_by_name FROM leave_ledger l LEFT JOIN users c ON c.id = l.created_by WHERE l.user_id = ? ORDER BY l.entry_date DESC, l.id DESC`).all(target.id) : [];
  res.render('admin/leave', { title: '有給休暇の管理', users: list, target, ledger, balance: target ? att.paidLeaveBalance(target.id) : 0, today: t.today() });
});

router.post('/leave/grant', requireAdmin, (req, res) => {
  const u = userOr404(req, res, req.body.user_id);
  if (!u) return;
  const days = Number(req.body.days);
  const date = str(req.body.entry_date) || t.today();
  const note = str(req.body.note).slice(0, 200);
  if (!Number.isFinite(days) || days === 0 || Math.abs(days) > 40 || Math.round(days * 2) !== days * 2) {
    req.flash('error', '日数は 0.5 日単位、±40日以内で入力してください（マイナスは減算）。');
  } else if (!t.isValidDate(date)) {
    req.flash('error', '日付が不正です。');
  } else {
    db.get().prepare('INSERT INTO leave_ledger(user_id, entry_date, days, kind, note, created_by) VALUES (?,?,?,?,?,?)')
      .run(u.id, date, days, days > 0 ? 'grant' : 'adjust', note || (days > 0 ? '有給付与' : '調整'), req.user.id);
    audit.log(req, 'leave.grant', 'user', u.id, { days, date, note });
    req.flash('success', `${u.name} さんの有給休暇を ${days > 0 ? '+' : ''}${days}日 登録しました。`);
  }
  res.redirect(`/admin/leave?user=${u.id}`);
});

// ---- 休日カレンダー ----
router.get('/holidays', requireAdmin, (req, res) => {
  const year = /^\d{4}$/.test(req.query.year || '') ? Number(req.query.year) : new Date().getFullYear();
  const national = [...holidaysOfYear(year).entries()].sort();
  const company = db.get().prepare('SELECT date, name FROM company_holidays WHERE date LIKE ? ORDER BY date').all(`${year}-%`);
  res.render('admin/holidays', { title: '休日カレンダー', year, national, company });
});

router.post('/holidays', requireAdmin, (req, res) => {
  const start = str(req.body.date);
  const end = str(req.body.end_date) || start;
  const name = str(req.body.name).slice(0, 50) || '会社休日';
  if (!t.isValidDate(start) || !t.isValidDate(end) || end < start || t.eachDate(start, end).length > 31) {
    req.flash('error', '日付を正しく入力してください（最大31日間）。');
  } else {
    const stmt = db.get().prepare('INSERT INTO company_holidays(date, name) VALUES (?,?) ON CONFLICT(date) DO UPDATE SET name = excluded.name');
    db.get().transaction(() => { for (const d of t.eachDate(start, end)) stmt.run(d, name); })();
    audit.log(req, 'holiday.add', null, null, { start, end, name });
    req.flash('success', `会社休日「${name}」を登録しました。`);
  }
  res.redirect(`/admin/holidays?year=${(t.isValidDate(start) ? start : t.today()).slice(0, 4)}`);
});

router.post('/holidays/:date/delete', requireAdmin, (req, res) => {
  const date = req.params.date;
  db.get().prepare('DELETE FROM company_holidays WHERE date = ?').run(date);
  audit.log(req, 'holiday.delete', null, null, { date });
  req.flash('success', `${date} の会社休日を削除しました。`);
  res.redirect(`/admin/holidays?year=${date.slice(0, 4)}`);
});

// ---- 設定 ----
router.get('/settings', requireAdmin, (req, res) => {
  res.render('admin/settings', { title: '設定', values: req.settings, errors: [] });
});

router.post('/settings', requireAdmin, (req, res) => {
  const b = req.body;
  const errors = [];
  const hours = Number(b.standard_hours);
  const roundingUnits = [1, 5, 10, 15, 30];
  const v = {
    company_name: str(b.company_name).slice(0, 100),
    standard_minutes: Math.round(hours * 60),
    default_work_start: str(b.default_work_start),
    default_work_end: str(b.default_work_end),
    rounding_in: Number(b.rounding_in),
    rounding_out: Number(b.rounding_out),
    closing_day: Number(b.closing_day),
    weekly_holidays: [].concat(b.weekly_holidays || []).map(Number).filter((n) => n >= 0 && n <= 6),
    auto_break: b.auto_break === '1',
    overtime_premium: Number(b.overtime_premium),
    night_premium: Number(b.night_premium),
    holiday_premium: Number(b.holiday_premium),
  };
  for (const k of ['overtime_premium', 'night_premium', 'holiday_premium']) {
    if (!Number.isInteger(v[k]) || v[k] < 0 || v[k] > 200) errors.push('割増率は 0〜200 の整数（%）で入力してください。');
  }
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) errors.push('所定労働時間は 0〜24 時間で入力してください。');
  if (!t.isValidTime(v.default_work_start) || !t.isValidTime(v.default_work_end)) errors.push('始業・終業時刻を HH:MM 形式で入力してください。');
  if (!roundingUnits.includes(v.rounding_in) || !roundingUnits.includes(v.rounding_out)) errors.push('丸め単位が不正です。');
  if (!Number.isInteger(v.closing_day) || v.closing_day < 0 || v.closing_day > 28) errors.push('締め日は 0（月末）または 1〜28 で指定してください。');
  if (errors.length) return res.status(400).render('admin/settings', { title: '設定', values: { ...req.settings, ...v }, errors });
  settingsLib.update(v);
  audit.log(req, 'settings.update', null, null, v);
  req.flash('success', '設定を保存しました。');
  res.redirect('/admin/settings');
});

// ---- CSV 出力 ----
const fm = (m) => t.fmtMinutes(m);

router.get('/export/summary.csv', requireAdmin, (req, res) => {
  const month = monthParam(req);
  const header = ['社員ID', '氏名', '部署', '所定労働日数', '出勤日数', '休日出勤日数', '総労働時間', '残業時間', '深夜時間', '休日労働時間',
    '遅刻回数', '遅刻時間', '早退回数', '早退時間', '有給取得日数', '特別休暇日数', '欠勤日数', '未打刻日数', '退勤漏れ日数', '有給残日数'];
  const rows = [header];
  for (const u of users.list({ includeInactive: false })) {
    const s = att.buildMonth(u, month, new Date(), req.settings).summary;
    rows.push([u.login_id, u.name, u.department || '', s.scheduledDays, s.workDays, s.offDayWorkDays, fm(s.workMinutes), fm(s.overtimeMinutes),
      fm(s.nightMinutes), fm(s.holidayWorkMinutes), s.lateCount, fm(s.lateMinutes), s.earlyLeaveCount, fm(s.earlyLeaveMinutes),
      s.paidLeaveDays, s.specialLeaveDays, s.absenceDays, s.noRecordDays, s.missingClockOutDays, att.paidLeaveBalance(u.id)]);
  }
  csv.send(res, `勤怠集計_${month}.csv`, rows);
});

router.get('/export/detail.csv', requireAdmin, (req, res) => {
  const month = monthParam(req);
  const target = req.query.user ? users.findById(Number(req.query.user)) : null;
  const list = target ? [target] : users.list({ includeInactive: false });
  const rows = [['社員ID', '氏名', '日付', '曜日', '区分', '出勤', '退勤', '休憩', '労働時間', '残業', '深夜', '休日労働', '遅刻', '早退', '休暇', '備考']];
  for (const u of list) {
    for (const d of att.buildMonth(u, month, new Date(), req.settings).days) {
      const kind = d.isOffDay ? (d.offReason || '休日') : '出勤日';
      rows.push([u.login_id, u.name, d.date, d.weekdayLabel, kind,
        t.fmtClock(d.clockIn, d.date), d.missingClockOut ? '未打刻' : t.fmtClock(d.clockOut, d.date),
        d.hasRecord ? fm(d.breakMinutes) : '', d.hasRecord ? fm(d.workMinutes) : '',
        t.fmtMinutes(d.overtimeMinutes, { blankZero: true }), t.fmtMinutes(d.nightMinutes, { blankZero: true }),
        t.fmtMinutes(d.holidayWorkMinutes, { blankZero: true }), t.fmtMinutes(d.lateMinutes, { blankZero: true }),
        t.fmtMinutes(d.earlyLeaveMinutes, { blankZero: true }), d.leaveType ? LEAVE_TYPES[d.leaveType].short : '', d.note]);
    }
  }
  csv.send(res, `勤怠明細_${month}${target ? '_' + target.login_id : ''}.csv`, rows);
});

// ---- 操作ログ ----
router.get('/audit', requireAdmin, (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const per = 100;
  const logs = db.get().prepare(`SELECT a.*, u.name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(per + 1, (page - 1) * per);
  res.render('admin/audit', { title: '操作ログ', logs: logs.slice(0, per), page, hasNext: logs.length > per, ACTION_LABELS: audit.ACTION_LABELS });
});

module.exports = router;
