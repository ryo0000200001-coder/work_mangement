'use strict';
const db = require('../db');
const t = require('../lib/time');
const pay = require('../lib/pay');
const att = require('./attendance');
const shiftsSvc = require('./shifts');

/**
 * 店舗の日別人件費（実績・予定）と売上。
 * 実績: 打刻にもとづく概算支給額を、店舗別の勤務時間で按分（ヘルプ勤務は勤務先店舗に計上）
 * 予定: 公開/下書きを問わずシフトにもとづく見込み
 * 時給が未設定のスタッフ（月給制など）は人件費に含めない。
 */
function storeDaily(storeId, start, end, settings) {
  const conn = db.get();
  const dates = t.eachDate(start, end);
  const rows = new Map(dates.map((d) => [d, { date: d, actual: 0, actualMinutes: 0, planned: 0, plannedMinutes: 0, staff: new Set(), plannedStaff: 0, sales: null }]));
  const key = String(storeId);

  // 実績: 期間内にこの店舗で勤務した可能性のあるユーザー
  const userIds = conn.prepare(`
    SELECT DISTINCT a.user_id FROM attendance a LEFT JOIN store_moves m ON m.attendance_id = a.id
    WHERE a.work_date BETWEEN ? AND ? AND (a.store_id = ? OR m.store_id = ?)`).all(start, end, storeId, storeId).map((r) => r.user_id);
  const now = new Date();
  let unpricedMinutes = 0;
  for (const uid of userIds) {
    const u = conn.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    const { days } = att.buildPeriod(u, start, end, now, settings);
    for (const d of days) {
      const mins = d.storeMinutes[key] || 0;
      if (!mins || !rows.has(d.date)) continue;
      const row = rows.get(d.date);
      row.actualMinutes += mins;
      row.staff.add(uid);
      if (!u.hourly_wage) { unpricedMinutes += mins; continue; }
      row.actual += pay.dayPay(d, u, settings).total * (mins / d.workMinutes);
    }
  }

  // 予定（シフト）
  const users = new Map();
  for (const s of shiftsSvc.list({ storeId, start, end })) {
    if (!users.has(s.user_id)) users.set(s.user_id, conn.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id));
    const u = users.get(s.user_id);
    const row = rows.get(s.work_date);
    row.plannedMinutes += pay.shiftMinutes(s);
    row.plannedStaff += 1;
    if (u.hourly_wage) row.planned += pay.shiftCost(s, u, settings, pay.shiftNightMinutes(s));
  }

  for (const r of conn.prepare('SELECT date, amount FROM store_sales WHERE store_id = ? AND date BETWEEN ? AND ?').all(storeId, start, end)) {
    rows.get(r.date).sales = r.amount;
  }

  const list = [...rows.values()].map((r) => ({
    ...r,
    actual: Math.floor(r.actual),
    staff: r.staff.size,
    ratio: r.sales ? (r.actual / r.sales) * 100 : null,
  }));
  const total = list.reduce((s, r) => ({
    actual: s.actual + r.actual, planned: s.planned + r.planned, sales: s.sales + (r.sales || 0),
    actualMinutes: s.actualMinutes + r.actualMinutes, plannedMinutes: s.plannedMinutes + r.plannedMinutes,
    salesActualCost: s.salesActualCost + (r.sales ? r.actual : 0),
  }), { actual: 0, planned: 0, sales: 0, actualMinutes: 0, plannedMinutes: 0, salesActualCost: 0 });
  // 売上が入力されている日のみで人件費率を算出
  total.ratio = total.sales ? (total.salesActualCost / total.sales) * 100 : null;
  return { rows: list, total, unpricedMinutes };
}

function saveSales(storeId, entries) {
  const ups = db.get().prepare('INSERT INTO store_sales(store_id, date, amount) VALUES (?,?,?) ON CONFLICT(store_id, date) DO UPDATE SET amount = excluded.amount');
  const del = db.get().prepare('DELETE FROM store_sales WHERE store_id = ? AND date = ?');
  db.get().transaction(() => {
    for (const e of entries) {
      if (!t.isValidDate(e.date)) continue;
      if (e.amount == null) del.run(storeId, e.date);
      else ups.run(storeId, e.date, e.amount);
    }
  })();
}

/** 年初からの概算収入（扶養内勤務の目安） */
function yearToDate(user, settings, now = new Date()) {
  const start = `${now.getFullYear()}-01-01`;
  const { days } = att.buildPeriod(user, start, t.today(now), now, settings);
  return pay.periodPay(days, user, settings);
}

module.exports = { storeDaily, saveSales, yearToDate };
