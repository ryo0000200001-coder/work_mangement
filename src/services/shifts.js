'use strict';
const db = require('../db');
const t = require('../lib/time');
const { requiredBreak } = require('../lib/calc');
const { shiftMinutes } = require('../lib/pay');

class ShiftError extends Error {}

/** シフト一覧（条件: storeId / userId / 期間 / 公開済みのみ） */
function list({ storeId = null, userId = null, start, end, publishedOnly = false }) {
  const where = ['s.work_date BETWEEN ? AND ?'];
  const args = [start, end];
  if (storeId) { where.push('s.store_id = ?'); args.push(storeId); }
  if (userId) { where.push('s.user_id = ?'); args.push(userId); }
  if (publishedOnly) where.push('s.published = 1');
  return db.get().prepare(`
    SELECT s.*, st.name AS store_name FROM shifts s LEFT JOIN stores st ON st.id = s.store_id
    WHERE ${where.join(' AND ')} ORDER BY s.work_date, s.start_time`).all(...args);
}

function get(userId, date) {
  return db.get().prepare('SELECT * FROM shifts WHERE user_id = ? AND work_date = ?').get(userId, date) || null;
}

/** 入力値の検証。end <= start は翌日終了として扱う */
function validate({ start, end, breakMinutes }) {
  if (!t.isValidTime(start) || !t.isValidTime(end)) throw new ShiftError('開始・終了時刻を HH:MM 形式で入力してください。');
  if (start === end) throw new ShiftError('開始と終了が同じ時刻です。');
  const mins = shiftMinutes({ start_time: start, end_time: end, break_minutes: 0 });
  if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes >= mins) throw new ShiftError('休憩時間が不正です。');
}

/** シフトの登録・更新（公開状態は維持。新規は下書き） */
function upsert({ userId, storeId, date, start, end, breakMinutes = 0, note = null }) {
  if (!t.isValidDate(date)) throw new ShiftError('日付が不正です。');
  validate({ start, end, breakMinutes });
  db.get().prepare(`
    INSERT INTO shifts(user_id, store_id, work_date, start_time, end_time, break_minutes, note)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(user_id, work_date) DO UPDATE SET store_id = excluded.store_id, start_time = excluded.start_time,
      end_time = excluded.end_time, break_minutes = excluded.break_minutes, note = excluded.note,
      updated_at = datetime('now','localtime')`)
    .run(userId, storeId || null, date, start, end, breakMinutes, note || null);
}

function remove(userId, date) {
  db.get().prepare('DELETE FROM shifts WHERE user_id = ? AND work_date = ?').run(userId, date);
}

/** 期間内の店舗のシフトを公開。公開した件数を返す */
function publish(storeId, start, end) {
  return db.get().prepare('UPDATE shifts SET published = 1 WHERE store_id = ? AND work_date BETWEEN ? AND ? AND published = 0')
    .run(storeId, start, end).changes;
}

/** 勤務時間に応じた標準休憩（法定） */
function defaultBreak(start, end) {
  const mins = shiftMinutes({ start_time: start, end_time: end, break_minutes: 0 });
  // 休憩を引いた後の労働時間に対して法定休憩を満たす最小値
  for (const b of [0, 45, 60]) if (b >= requiredBreak(mins - b)) return b;
  return 60;
}

// ---- 希望シフト ----

function listRequests({ userIds, start, end }) {
  if (!userIds.length) return [];
  return db.get().prepare(`SELECT * FROM shift_requests WHERE work_date BETWEEN ? AND ? AND user_id IN (${userIds.map(() => '?').join(',')})`)
    .all(start, end, ...userIds);
}

/**
 * 希望シフトの保存。entries: [{date, kind: ''|'available'|'unavailable', start, end, note}]
 * kind が空ならその日の希望を削除する。公開済みシフトがある日は変更不可。
 */
function saveRequests(userId, entries) {
  const conn = db.get();
  const errors = [];
  const today = t.today();
  const ups = conn.prepare(`
    INSERT INTO shift_requests(user_id, work_date, kind, start_time, end_time, note) VALUES (?,?,?,?,?,?)
    ON CONFLICT(user_id, work_date) DO UPDATE SET kind = excluded.kind, start_time = excluded.start_time,
      end_time = excluded.end_time, note = excluded.note, updated_at = datetime('now','localtime')`);
  const del = conn.prepare('DELETE FROM shift_requests WHERE user_id = ? AND work_date = ?');
  const ops = [];
  for (const e of entries) {
    if (!t.isValidDate(e.date) || e.date < today) continue;
    const published = conn.prepare('SELECT 1 FROM shifts WHERE user_id = ? AND work_date = ? AND published = 1').get(userId, e.date);
    if (!e.kind) { if (!published) ops.push(() => del.run(userId, e.date)); continue; }
    if (!['available', 'unavailable'].includes(e.kind)) continue;
    let start = null;
    let end = null;
    if (e.kind === 'available' && (e.start || e.end)) {
      if (!t.isValidTime(e.start) || !t.isValidTime(e.end) || e.start === e.end) {
        errors.push(`${e.date}: 時間帯を正しく入力してください（終日可の場合は空欄）。`);
        continue;
      }
      start = e.start; end = e.end;
    }
    if (published) continue; // 確定済みの日は変更しない
    ops.push(() => ups.run(userId, e.date, e.kind, start, end, (e.note || '').slice(0, 100) || null));
  }
  if (errors.length) throw new ShiftError(errors.join('\n'));
  conn.transaction(() => ops.forEach((f) => f()))();
  return ops.length;
}

/**
 * 希望シフトから下書きシフトを一括作成（シフト未作成の日のみ）。
 * 時間指定のない「終日可」は各スタッフの基本勤務時間を使う。作成件数を返す。
 */
function autoFill(storeId, staff, start, end) {
  const reqs = listRequests({ userIds: staff.map((u) => u.id), start, end }).filter((r) => r.kind === 'available');
  const byId = new Map(staff.map((u) => [u.id, u]));
  let n = 0;
  db.get().transaction(() => {
    for (const r of reqs) {
      if (get(r.user_id, r.work_date)) continue;
      const u = byId.get(r.user_id);
      const s = r.start_time || u.work_start;
      const e = r.end_time || u.work_end;
      upsert({ userId: r.user_id, storeId, date: r.work_date, start: s, end: e, breakMinutes: defaultBreak(s, e) });
      n += 1;
    }
  })();
  return n;
}

module.exports = { ShiftError, list, get, upsert, remove, publish, defaultBreak, listRequests, saveRequests, autoFill };
