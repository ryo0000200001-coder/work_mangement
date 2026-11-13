'use strict';
const db = require('../db');
const t = require('../lib/time');
const calc = require('../lib/calc');
const settingsLib = require('../lib/settings');
const { holidayName } = require('../lib/holidays');

const OPEN_WINDOW_MS = 24 * 3600 * 1000;

function loadBreaks(attendanceId) {
  return db.get()
    .prepare('SELECT id, start_at, end_at FROM breaks WHERE attendance_id = ? ORDER BY start_at')
    .all(attendanceId);
}

function loadMoves(attendanceId) {
  return db.get()
    .prepare('SELECT id, store_id, at FROM store_moves WHERE attendance_id = ? ORDER BY at')
    .all(attendanceId);
}

function hydrate(rec) {
  if (!rec) return null;
  rec.breaks = loadBreaks(rec.id);
  rec.moves = loadMoves(rec.id);
  return rec;
}

function getRecord(userId, date) {
  return hydrate(db.get().prepare('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?').get(userId, date));
}

/** 現在（最後に）勤務している店舗ID */
function currentStoreId(rec) {
  if (!rec) return null;
  const moves = rec.moves || [];
  return moves.length ? moves[moves.length - 1].store_id : rec.store_id;
}

/** 現在勤務中のレコード（退勤未打刻で、出勤から24時間以内） */
function getOpenRecord(userId, now = new Date()) {
  const rec = db.get()
    .prepare('SELECT * FROM attendance WHERE user_id = ? AND clock_out IS NULL AND clock_in IS NOT NULL ORDER BY clock_in DESC LIMIT 1')
    .get(userId);
  if (!rec) return null;
  if (now - t.parseDateTime(rec.clock_in) >= OPEN_WINDOW_MS) return null;
  return hydrate(rec);
}

/**
 * 打刻状態: off(未出勤) / working(勤務中) / break(休憩中) / done(本日退勤済)
 */
function getStatus(userId, now = new Date()) {
  const open = getOpenRecord(userId, now);
  if (open) {
    const onBreak = open.breaks.some((b) => !b.end_at);
    return { state: onBreak ? 'break' : 'working', record: open };
  }
  const todayRec = getRecord(userId, t.today(now));
  if (todayRec && todayRec.clock_out) return { state: 'done', record: todayRec };
  return { state: 'off', record: todayRec };
}

class PunchError extends Error {}

/**
 * 打刻処理。action: clock_in / break_start / break_end / clock_out / move（店舗移動）
 * opts.storeId: 出勤・店舗移動先の店舗
 */
function punch(userId, action, now = new Date(), opts = {}) {
  const conn = db.get();
  const nowStr = t.toLocalISO(now);
  return conn.transaction(() => {
    const status = getStatus(userId, now);
    switch (action) {
      case 'clock_in': {
        if (status.state === 'working' || status.state === 'break') throw new PunchError('すでに出勤中です。');
        if (status.state === 'done') throw new PunchError('本日はすでに退勤済みです。修正が必要な場合は打刻修正申請を行ってください。');
        const date = t.today(now);
        const existing = conn.prepare('SELECT id, clock_in FROM attendance WHERE user_id = ? AND work_date = ?').get(userId, date);
        if (existing && existing.clock_in) throw new PunchError('本日の出勤記録がすでにあります。');
        const chosen = opts.storeId && conn.prepare('SELECT id FROM stores WHERE id = ? AND active = 1').get(Number(opts.storeId));
        const storeId = chosen ? chosen.id : defaultStoreId(userId, date);
        if (existing) {
          conn.prepare("UPDATE attendance SET clock_in = ?, store_id = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(nowStr, storeId, existing.id);
          return existing.id;
        }
        return conn.prepare('INSERT INTO attendance(user_id, work_date, clock_in, store_id) VALUES (?,?,?,?)').run(userId, date, nowStr, storeId).lastInsertRowid;
      }
      case 'move': {
        if (status.state !== 'working') throw new PunchError('勤務中のみ店舗を移動できます（休憩中は休憩を終了してください）。');
        const to = Number(opts.storeId);
        const store = to && conn.prepare('SELECT id FROM stores WHERE id = ? AND active = 1').get(to);
        if (!store) throw new PunchError('移動先の店舗を選択してください。');
        if (currentStoreId(status.record) === to) throw new PunchError('すでにその店舗で勤務中です。');
        conn.prepare('INSERT INTO store_moves(attendance_id, store_id, at) VALUES (?,?,?)').run(status.record.id, to, nowStr);
        return status.record.id;
      }
      case 'break_start': {
        if (status.state !== 'working') throw new PunchError('勤務中ではないため休憩を開始できません。');
        conn.prepare('INSERT INTO breaks(attendance_id, start_at) VALUES (?,?)').run(status.record.id, nowStr);
        return status.record.id;
      }
      case 'break_end': {
        if (status.state !== 'break') throw new PunchError('休憩中ではありません。');
        conn.prepare('UPDATE breaks SET end_at = ? WHERE attendance_id = ? AND end_at IS NULL').run(nowStr, status.record.id);
        return status.record.id;
      }
      case 'clock_out': {
        if (status.state !== 'working' && status.state !== 'break') throw new PunchError('出勤していないため退勤できません。');
        conn.prepare('UPDATE breaks SET end_at = ? WHERE attendance_id = ? AND end_at IS NULL').run(nowStr, status.record.id);
        conn.prepare("UPDATE attendance SET clock_out = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(nowStr, status.record.id);
        return status.record.id;
      }
      default:
        throw new PunchError('不正な操作です。');
    }
  })();
}

/**
 * 勤怠レコードを丸ごと置き換える（管理者修正・申請承認時）。
 * data: {clockIn, clockOut, breaks:[{start,end}], note}  clockIn が null ならレコード削除
 */
function saveRecord(userId, date, data) {
  const conn = db.get();
  conn.transaction(() => {
    const existing = conn.prepare('SELECT id FROM attendance WHERE user_id = ? AND work_date = ?').get(userId, date);
    if (!data.clockIn) {
      if (existing) conn.prepare('DELETE FROM attendance WHERE id = ?').run(existing.id);
      return;
    }
    let id;
    if (existing) {
      id = existing.id;
      conn.prepare("UPDATE attendance SET clock_in = ?, clock_out = ?, note = ?, updated_at = datetime('now','localtime') WHERE id = ?")
        .run(data.clockIn, data.clockOut || null, data.note || null, id);
      if (data.storeId !== undefined) conn.prepare('UPDATE attendance SET store_id = ? WHERE id = ?').run(data.storeId || null, id);
      conn.prepare('DELETE FROM breaks WHERE attendance_id = ?').run(id);
    } else {
      const storeId = data.storeId !== undefined ? data.storeId || null : defaultStoreId(userId, date);
      id = conn.prepare('INSERT INTO attendance(user_id, work_date, clock_in, clock_out, note, store_id) VALUES (?,?,?,?,?,?)')
        .run(userId, date, data.clockIn, data.clockOut || null, data.note || null, storeId).lastInsertRowid;
    }
    const ins = conn.prepare('INSERT INTO breaks(attendance_id, start_at, end_at) VALUES (?,?,?)');
    for (const b of data.breaks || []) ins.run(id, b.start, b.end || null);
  })();
}

/** 既定の勤務店舗: その日のシフトの店舗 → 所属店舗 */
function defaultStoreId(userId, date) {
  const conn = db.get();
  const sh = conn.prepare('SELECT store_id FROM shifts WHERE user_id = ? AND work_date = ?').get(userId, date);
  if (sh && sh.store_id) return sh.store_id;
  const u = conn.prepare('SELECT store_id FROM users WHERE id = ?').get(userId);
  return u ? u.store_id : null;
}

/** 期間内の会社休日 Map */
function companyHolidays(start, end) {
  const rows = db.get().prepare('SELECT date, name FROM company_holidays WHERE date BETWEEN ? AND ?').all(start, end);
  return new Map(rows.map((r) => [r.date, r.name]));
}

function dayType(date, settings, companyMap) {
  const ch = companyMap.get(date);
  if (ch) return { isOffDay: true, offReason: ch };
  const hn = holidayName(date);
  if (hn) return { isOffDay: true, offReason: hn };
  if (settings.weekly_holidays.includes(t.weekday(date))) return { isOffDay: true, offReason: null };
  return { isOffDay: false, offReason: null };
}

function scheduleOf(user, settings) {
  return {
    start: user.work_start,
    end: user.work_end,
    standardMinutes: user.standard_minutes || settings.standard_minutes,
  };
}

/** 期間の日別計算 + 集計 */
function buildPeriod(user, start, end, now = new Date(), settings = settingsLib.getAll()) {
  const conn = db.get();
  const recs = conn.prepare('SELECT * FROM attendance WHERE user_id = ? AND work_date BETWEEN ? AND ?').all(user.id, start, end);
  const recMap = new Map();
  if (recs.length) {
    const ids = recs.map((r) => r.id);
    const ph = ids.map(() => '?').join(',');
    const brs = conn.prepare(`SELECT attendance_id, start_at, end_at FROM breaks WHERE attendance_id IN (${ph}) ORDER BY start_at`).all(...ids);
    const mvs = conn.prepare(`SELECT attendance_id, store_id, at FROM store_moves WHERE attendance_id IN (${ph}) ORDER BY at`).all(...ids);
    for (const r of recs) { r.breaks = []; r.moves = []; recMap.set(r.work_date, r); }
    const byId = new Map(recs.map((r) => [r.id, r]));
    for (const b of brs) byId.get(b.attendance_id).breaks.push(b);
    for (const m of mvs) byId.get(m.attendance_id).moves.push(m);
  }
  const shiftMap = new Map(
    conn.prepare('SELECT * FROM shifts WHERE user_id = ? AND work_date BETWEEN ? AND ? AND published = 1').all(user.id, start, end)
      .map((s) => [s.work_date, s])
  );
  const isPart = user.employment_type === 'part';
  const leaves = conn.prepare('SELECT leave_date, leave_type FROM leaves WHERE user_id = ? AND leave_date BETWEEN ? AND ?').all(user.id, start, end);
  const leaveMap = new Map(leaves.map((l) => [l.leave_date, l.leave_type]));
  const pending = conn.prepare("SELECT start_date, end_date, type FROM requests WHERE user_id = ? AND status = 'pending' AND end_date >= ? AND start_date <= ?").all(user.id, start, end);
  const companyMap = companyHolidays(start, end);
  const schedule = scheduleOf(user, settings);
  const hireDate = user.hire_date || null;

  const days = t.eachDate(start, end).map((date) => {
    const dt = dayType(date, settings, companyMap);
    const shift = shiftMap.get(date) || null;
    // シフト制（パート・アルバイト）: 休日の概念はなく、シフトがある日が出勤予定日。法定労働時間(8h)超を残業とする
    const daySchedule = shift
      ? { start: shift.start_time, end: shift.end_time, standardMinutes: isPart ? 480 : schedule.standardMinutes }
      : isPart ? { start: null, end: null, standardMinutes: 480 } : schedule;
    const d = calc.computeDay({
      date, record: recMap.get(date) || null, now,
      isOffDay: isPart ? false : dt.isOffDay, offReason: isPart ? null : dt.offReason,
      scheduled: isPart ? !!shift : (!dt.isOffDay || !!shift),
      leaveType: leaveMap.get(date) || null, schedule: daySchedule, settings,
    });
    d.shift = shift;
    d.holidayName = dt.offReason;
    d.storeId = (recMap.get(date) || {}).store_id || null;
    d.moves = (recMap.get(date) || {}).moves || [];
    if (hireDate && date < hireDate) d.noRecord = false; // 入社前
    d.hasPending = pending.some((p) => p.start_date <= date && date <= p.end_date);
    d.breaks = (recMap.get(date) || {}).breaks || [];
    return d;
  });
  return { days, summary: calc.summarize(days) };
}

function buildMonth(user, month, now = new Date(), settings = settingsLib.getAll()) {
  const period = t.monthPeriod(month, settings.closing_day);
  return { month, period, ...buildPeriod(user, period.start, period.end, now, settings) };
}

/** 有給残日数 */
function paidLeaveBalance(userId) {
  const r = db.get().prepare('SELECT COALESCE(SUM(days), 0) AS bal FROM leave_ledger WHERE user_id = ?').get(userId);
  return Math.round(r.bal * 10) / 10;
}

module.exports = {
  PunchError, getRecord, currentStoreId, defaultStoreId, getOpenRecord, getStatus, punch, saveRecord,
  buildMonth, buildPeriod, dayType, companyHolidays, scheduleOf, paidLeaveBalance,
};
