'use strict';
const express = require('express');
const t = require('../lib/time');
const audit = require('../lib/audit');
const { LEAVE_TYPES } = require('../lib/calc');
const { parseAttendanceForm, recordToForm, str } = require('../lib/forms');
const att = require('../services/attendance');
const reqs = require('../services/requests');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();
router.use(requireLogin);

// ---- ダッシュボード（打刻） ----
router.get('/', (req, res) => {
  const now = new Date();
  const user = req.user;
  const status = att.getStatus(user.id, now);
  const month = t.monthOf(t.today(now), req.settings.closing_day);
  const sheet = att.buildMonth(user, month, now, req.settings);
  const workDate = status.record ? status.record.work_date : t.today(now);
  const todayRow = att.buildPeriod(user, workDate, workDate, now, req.settings).days[0];
  const alerts = sheet.days.filter((d) => (d.noRecord || d.missingClockOut) && !d.hasPending);
  res.render('dashboard', {
    title: '打刻',
    status,
    todayRow,
    sheet,
    alerts,
    balance: att.paidLeaveBalance(user.id),
    myPending: reqs.list({ userId: user.id, status: 'pending', limit: 5 }),
    now,
  });
});

const PUNCH_LABELS = { clock_in: '出勤', break_start: '休憩開始', break_end: '休憩終了', clock_out: '退勤' };

router.post('/punch', (req, res, next) => {
  const action = req.body.action;
  try {
    const now = new Date();
    const id = att.punch(req.user.id, action, now);
    audit.log(req, `punch.${action}`, 'attendance', id, { at: t.toLocalISO(now) });
    req.flash('success', `${PUNCH_LABELS[action]}を記録しました（${t.toLocalISO(now).slice(11, 16)}）。`);
  } catch (e) {
    if (!(e instanceof att.PunchError)) return next(e);
    req.flash('error', e.message);
  }
  res.redirect('/');
});

// ---- 勤務表 ----
router.get('/timesheet', (req, res) => {
  const month = t.isValidMonth(req.query.month) ? req.query.month : t.monthOf(t.today(), req.settings.closing_day);
  const sheet = att.buildMonth(req.user, month, new Date(), req.settings);
  res.render('timesheet', { title: '勤務表', sheet, target: req.user, isAdminView: false });
});

// ---- 申請 ----
router.get('/requests', (req, res) => {
  res.render('requests/index', { title: '申請一覧', requests: reqs.list({ userId: req.user.id }), balance: att.paidLeaveBalance(req.user.id) });
});

function renderCorrection(res, req, date, form, errors = [], reason = '', status = 200) {
  const current = att.getRecord(req.user.id, date);
  res.status(status).render('requests/correction', { title: '打刻修正申請', date, form, current, errors, reason });
}

router.get('/requests/correction/new', (req, res) => {
  const date = t.isValidDate(req.query.date) && req.query.date <= t.today() ? req.query.date : t.today();
  renderCorrection(res, req, date, recordToForm(att.getRecord(req.user.id, date), date));
});

router.post('/requests/correction', (req, res) => {
  const date = str(req.body.date);
  const reason = str(req.body.reason).slice(0, 500);
  if (!t.isValidDate(date) || date > t.today()) {
    req.flash('error', '日付が不正です（未来の日付は申請できません）。');
    return res.redirect('/requests/correction/new');
  }
  const { errors, data } = parseAttendanceForm(req.body, date, { requireClockOut: date < t.today() });
  if (!reason) errors.push('申請理由を入力してください。');
  const formBack = { ...req.body, breaks: [].concat(req.body.break_start || []).map((s, i) => ({ start: s, end: [].concat(req.body.break_end || [])[i] || '' })), clock_out_next_day: req.body.clock_out_next_day === '1' };
  if (errors.length) return renderCorrection(res, req, date, formBack, errors, reason, 400);
  try {
    const id = reqs.createCorrection(req.user.id, date, data, reason);
    audit.log(req, 'request.create', 'request', id, { type: 'correction', date });
    req.flash('success', `${date} の打刻修正を申請しました。管理者の承認後に反映されます。`);
    res.redirect('/requests');
  } catch (e) {
    if (!(e instanceof reqs.RequestError)) throw e;
    renderCorrection(res, req, date, formBack, [e.message], reason, 400);
  }
});

router.get('/requests/leave/new', (req, res) => {
  const date = t.isValidDate(req.query.date) ? req.query.date : t.today();
  res.render('requests/leave', {
    title: '休暇申請', values: { start_date: date, end_date: date, leave_type: 'paid_full', reason: '' },
    errors: [], balance: att.paidLeaveBalance(req.user.id),
  });
});

router.post('/requests/leave', (req, res) => {
  const values = {
    start_date: str(req.body.start_date), end_date: str(req.body.end_date) || str(req.body.start_date),
    leave_type: str(req.body.leave_type), reason: str(req.body.reason).slice(0, 500),
  };
  const errors = [];
  if (!t.isValidDate(values.start_date) || !t.isValidDate(values.end_date)) errors.push('日付を正しく入力してください。');
  if (!LEAVE_TYPES[values.leave_type]) errors.push('休暇種別を選択してください。');
  const renderErr = (errs) => res.status(400).render('requests/leave', { title: '休暇申請', values, errors: errs, balance: att.paidLeaveBalance(req.user.id) });
  if (errors.length) return renderErr(errors);
  try {
    const id = reqs.createLeave(req.user.id, values.start_date, values.end_date, values.leave_type, values.reason);
    audit.log(req, 'request.create', 'request', id, { type: 'leave', ...values });
    req.flash('success', '休暇を申請しました。');
    res.redirect('/requests');
  } catch (e) {
    if (!(e instanceof reqs.RequestError)) throw e;
    renderErr([e.message]);
  }
});

router.post('/requests/:id/cancel', (req, res) => {
  try {
    reqs.cancelOwn(req.user.id, Number(req.params.id));
    audit.log(req, 'request.cancel', 'request', Number(req.params.id));
    req.flash('success', '申請を取り消しました。');
  } catch (e) {
    if (!(e instanceof reqs.RequestError)) throw e;
    req.flash('error', e.message);
  }
  res.redirect('/requests');
});

module.exports = router;
