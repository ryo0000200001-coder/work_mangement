'use strict';
// 店舗・シフト作成・人件費（管理者・店長）
const express = require('express');
const db = require('../db');
const t = require('../lib/time');
const audit = require('../lib/audit');
const pay = require('../lib/pay');
const { str, toArray } = require('../lib/forms');
const att = require('../services/attendance');
const users = require('../services/users');
const storesSvc = require('../services/stores');
const shiftsSvc = require('../services/shifts');
const labor = require('../services/labor');
const { requireLogin, requireAdmin, requireManager, scopeStoreId } = require('../middleware/auth');

const router = express.Router();
router.use(requireLogin, requireManager);

/** 対象店舗: 店長は担当店舗固定、管理者は指定 or 先頭の店舗 */
function resolveStore(req) {
  const fixed = scopeStoreId(req.user);
  if (fixed) return storesSvc.get(fixed);
  const id = Number(req.query.store || req.body.store_id);
  return (id && storesSvc.get(id)) || storesSvc.list()[0] || null;
}

function noStore(res) {
  return res.render('error', { title: '店舗が未登録です', message: '先に「管理 > 店舗」から店舗を登録してください。' });
}

function mondayOf(date) {
  const w = t.weekday(date);
  return t.addDays(date, w === 0 ? -6 : 1 - w);
}

function rangeParams(req) {
  const start = t.isValidDate(req.query.start || req.body.start) ? (req.query.start || req.body.start) : mondayOf(t.today());
  const days = [7, 14].includes(Number(req.query.days || req.body.days)) ? Number(req.query.days || req.body.days) : 7;
  return { start, days, end: t.addDays(start, days - 1) };
}

function shiftsUrl(storeId, start, days) {
  return `/admin/shifts?store=${storeId}&start=${start}&days=${days}`;
}

// ---- シフト表 ----
router.get('/shifts', (req, res) => {
  const store = resolveStore(req);
  if (!store) return noStore(res);
  const { start, days, end } = rangeParams(req);
  const dates = t.eachDate(start, end);
  const conn = db.get();

  // 所属スタッフ + この店舗にシフトが入っているヘルプスタッフ
  const own = users.list({ includeInactive: false, storeId: store.id });
  const storeShifts = shiftsSvc.list({ storeId: store.id, start, end });
  const helpIds = [...new Set(storeShifts.map((s) => s.user_id))].filter((id) => !own.some((u) => u.id === id));
  const help = helpIds.map((id) => users.findById(id)).filter(Boolean);
  const staff = [...own, ...help];
  const ids = staff.map((u) => u.id);

  const allShifts = ids.length
    ? conn.prepare(`SELECT s.*, st.name AS store_name FROM shifts s LEFT JOIN stores st ON st.id = s.store_id WHERE s.work_date BETWEEN ? AND ? AND s.user_id IN (${ids.map(() => '?').join(',')})`).all(start, end, ...ids)
    : [];
  const shiftMap = new Map(allShifts.map((s) => [`${s.user_id}|${s.work_date}`, s]));
  const reqMap = new Map(shiftsSvc.listRequests({ userIds: ids, start, end }).map((r) => [`${r.user_id}|${r.work_date}`, r]));
  const leaveMap = new Map(ids.length
    ? conn.prepare(`SELECT user_id, leave_date, leave_type FROM leaves WHERE leave_date BETWEEN ? AND ? AND user_id IN (${ids.map(() => '?').join(',')})`).all(start, end, ...ids).map((l) => [`${l.user_id}|${l.leave_date}`, l.leave_type])
    : []);

  const companyMap = att.companyHolidays(start, end);
  const footer = dates.map((date) => {
    const dt = att.dayType(date, { ...req.settings, weekly_holidays: [0, 6] }, companyMap);
    const required = dt.isOffDay ? store.required_weekend : store.required_weekday;
    const list = storeShifts.filter((s) => s.work_date === date);
    const cost = list.reduce((sum, s) => {
      const u = staff.find((x) => x.id === s.user_id);
      return sum + (u && u.hourly_wage ? pay.shiftCost(s, u, req.settings, pay.shiftNightMinutes(s)) : 0);
    }, 0);
    const minutes = list.reduce((sum, s) => sum + pay.shiftMinutes(s), 0);
    return { date, count: list.length, required, cost, minutes, holiday: dt.offReason };
  });
  const unpublished = storeShifts.filter((s) => !s.published).length;
  const others = users.list({ includeInactive: false }).filter((u) => !staff.some((s) => s.id === u.id));

  res.render('admin/shifts', {
    title: 'シフト表', store, stores: scopeStoreId(req.user) ? [store] : storesSvc.list(), start, end, days, dates,
    staff, ownIds: new Set(own.map((u) => u.id)), shiftMap, reqMap, leaveMap, footer, unpublished, others,
    totalCost: footer.reduce((s, f) => s + f.cost, 0), pay,
  });
});

router.post('/shifts/save', (req, res) => {
  const store = resolveStore(req);
  if (!store) return noStore(res);
  const { start, days } = rangeParams(req);
  const back = shiftsUrl(store.id, start, days);
  const u = users.findById(Number(req.body.user_id));
  const date = str(req.body.date);
  if (!u || !u.active) { req.flash('error', 'スタッフが見つかりません。'); return res.redirect(back); }
  const existing = shiftsSvc.get(u.id, date);
  if (existing && existing.store_id && existing.store_id !== store.id && scopeStoreId(req.user)) {
    req.flash('error', '他店舗のシフトは変更できません。');
    return res.redirect(back);
  }
  try {
    if (req.body.delete === '1') {
      shiftsSvc.remove(u.id, date);
      audit.log(req, 'shift.delete', 'user', u.id, { date });
      req.flash('success', `${u.name} さんの ${date} のシフトを削除しました。`);
    } else {
      const s = str(req.body.start_time);
      const e = str(req.body.end_time);
      const brk = req.body.break_minutes === '' || req.body.break_minutes == null ? shiftsSvc.defaultBreak(s, e) : Number(req.body.break_minutes);
      shiftsSvc.upsert({ userId: u.id, storeId: store.id, date, start: s, end: e, breakMinutes: brk, note: str(req.body.note).slice(0, 100) });
      audit.log(req, 'shift.save', 'user', u.id, { date, start: s, end: e, break: brk, store: store.id });
      req.flash('success', `${u.name} さんの ${date} のシフトを保存しました。`);
    }
  } catch (err) {
    if (!(err instanceof shiftsSvc.ShiftError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect(back);
});

router.post('/shifts/autofill', (req, res) => {
  const store = resolveStore(req);
  if (!store) return noStore(res);
  const { start, days, end } = rangeParams(req);
  const n = shiftsSvc.autoFill(store.id, users.list({ includeInactive: false, storeId: store.id }), t.today() > start ? t.today() : start, end);
  audit.log(req, 'shift.autofill', null, null, { store: store.id, start, end, created: n });
  req.flash('success', n ? `希望シフトから ${n} 件の下書きを作成しました。内容を確認して「公開」してください。` : '作成できる希望シフトはありませんでした（未提出、または作成済み）。');
  res.redirect(shiftsUrl(store.id, start, days));
});

router.post('/shifts/copy', (req, res) => {
  const store = resolveStore(req);
  if (!store) return noStore(res);
  const { start, days, end } = rangeParams(req);
  const src = shiftsSvc.list({ storeId: store.id, start: t.addDays(start, -days), end: t.addDays(start, -1) });
  let n = 0;
  db.get().transaction(() => {
    for (const s of src) {
      const date = t.addDays(s.work_date, days);
      if (date < t.today() || date > end || shiftsSvc.get(s.user_id, date)) continue;
      const u = users.findById(s.user_id);
      if (!u || !u.active) continue;
      shiftsSvc.upsert({ userId: s.user_id, storeId: store.id, date, start: s.start_time, end: s.end_time, breakMinutes: s.break_minutes, note: s.note });
      n += 1;
    }
  })();
  audit.log(req, 'shift.copy', null, null, { store: store.id, start, end, created: n });
  req.flash('success', n ? `前の期間のシフトを ${n} 件コピーしました（下書き）。` : 'コピーできるシフトはありませんでした。');
  res.redirect(shiftsUrl(store.id, start, days));
});

router.post('/shifts/publish', (req, res) => {
  const store = resolveStore(req);
  if (!store) return noStore(res);
  const { start, days, end } = rangeParams(req);
  const n = shiftsSvc.publish(store.id, start, end);
  audit.log(req, 'shift.publish', null, null, { store: store.id, start, end, count: n });
  req.flash('success', `${n} 件のシフトを公開しました。スタッフの画面に表示されます。`);
  res.redirect(shiftsUrl(store.id, start, days));
});

// ---- 人件費・売上 ----
router.get('/labor', (req, res) => {
  const store = resolveStore(req);
  if (!store) return noStore(res);
  const month = t.isValidMonth(req.query.month) ? req.query.month : t.monthOf(t.today(), req.settings.closing_day);
  const period = t.monthPeriod(month, req.settings.closing_day);
  const data = labor.storeDaily(store.id, period.start, period.end, req.settings);
  res.render('admin/labor', {
    title: '人件費', store, stores: scopeStoreId(req.user) ? [store] : storesSvc.list(), month, period, ...data, yen: pay.yen,
  });
});

router.post('/labor/sales', (req, res) => {
  const store = resolveStore(req);
  if (!store) return noStore(res);
  const dates = toArray(req.body.date);
  const amounts = toArray(req.body.amount);
  const entries = [];
  for (let i = 0; i < dates.length; i++) {
    const raw = String(amounts[i] || '').replace(/[,，円\s]/g, '');
    if (raw === '') { entries.push({ date: dates[i], amount: null }); continue; }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 1e10) { req.flash('error', `${dates[i]} の売上は 0 以上の整数で入力してください。`); continue; }
    entries.push({ date: dates[i], amount: n });
  }
  labor.saveSales(store.id, entries);
  audit.log(req, 'sales.save', null, null, { store: store.id, count: entries.length });
  req.flash('success', '売上を保存しました。');
  const month = t.isValidMonth(req.body.month) ? req.body.month : '';
  res.redirect(`/admin/labor?store=${store.id}${month ? '&month=' + month : ''}`);
});

// ---- 店舗管理（管理者のみ） ----
router.get('/stores', requireAdmin, (req, res) => {
  const list = storesSvc.list({ includeInactive: true }).map((s) => ({
    ...s, staffCount: db.get().prepare('SELECT COUNT(*) AS c FROM users WHERE store_id = ? AND active = 1').get(s.id).c,
  }));
  res.render('admin/stores', { title: '店舗', stores: list, errors: [], values: { name: '', required_weekday: 0, required_weekend: 0 } });
});

router.post('/stores', requireAdmin, (req, res) => {
  const { errors, values } = storesSvc.parseForm({ ...req.body, active: '1' });
  if (errors.length) {
    req.flash('error', errors.join(' '));
    return res.redirect('/admin/stores');
  }
  const id = storesSvc.create(values);
  audit.log(req, 'store.create', 'store', id, values);
  req.flash('success', `店舗「${values.name}」を登録しました。`);
  res.redirect('/admin/stores');
});

router.post('/stores/:id', requireAdmin, (req, res) => {
  const store = storesSvc.get(req.params.id);
  if (!store) return res.redirect('/admin/stores');
  const { errors, values } = storesSvc.parseForm(req.body);
  if (errors.length) {
    req.flash('error', errors.join(' '));
  } else {
    storesSvc.update(store.id, values);
    audit.log(req, 'store.update', 'store', store.id, values);
    req.flash('success', `店舗「${values.name}」を更新しました。`);
  }
  res.redirect('/admin/stores');
});

module.exports = router;
