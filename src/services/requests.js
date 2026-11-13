'use strict';
const db = require('../db');
const t = require('../lib/time');
const { LEAVE_TYPES } = require('../lib/calc');
const settingsLib = require('../lib/settings');
const att = require('./attendance');

class RequestError extends Error {}

const STATUS_LABELS = { pending: '承認待ち', approved: '承認済み', rejected: '却下', cancelled: '取消' };
const TYPE_LABELS = { correction: '打刻修正', leave: '休暇' };

function parse(row) {
  if (!row) return null;
  return { ...row, payload: JSON.parse(row.payload || '{}') };
}

function get(id) {
  return parse(db.get().prepare(`
    SELECT r.*, u.name AS user_name, u.login_id, u.department, rv.name AS reviewer_name
    FROM requests r JOIN users u ON u.id = r.user_id LEFT JOIN users rv ON rv.id = r.reviewer_id
    WHERE r.id = ?`).get(id));
}

function list({ userId = null, status = null, storeId = null, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (storeId) { where.push('u.store_id = ?'); args.push(storeId); }
  if (userId) { where.push('r.user_id = ?'); args.push(userId); }
  if (status) { where.push('r.status = ?'); args.push(status); }
  const sql = `
    SELECT r.*, u.name AS user_name, u.login_id, u.department, rv.name AS reviewer_name
    FROM requests r JOIN users u ON u.id = r.user_id LEFT JOIN users rv ON rv.id = r.reviewer_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.created_at DESC, r.id DESC
    LIMIT ${Number(limit)}`;
  return db.get().prepare(sql).all(...args).map(parse);
}

function countPending(storeId = null) {
  if (storeId) {
    return db.get().prepare("SELECT COUNT(*) AS c FROM requests r JOIN users u ON u.id = r.user_id WHERE r.status = 'pending' AND u.store_id = ?").get(storeId).c;
  }
  return db.get().prepare("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'").get().c;
}

function hasPendingOverlap(userId, type, start, end) {
  return !!db.get().prepare(
    "SELECT 1 FROM requests WHERE user_id = ? AND type = ? AND status = 'pending' AND end_date >= ? AND start_date <= ?"
  ).get(userId, type, start, end);
}

function createCorrection(userId, date, data, reason) {
  if (hasPendingOverlap(userId, 'correction', date, date)) {
    throw new RequestError('この日付には承認待ちの打刻修正申請がすでにあります。');
  }
  const before = att.getRecord(userId, date);
  const payload = {
    clock_in: data.clockIn,
    clock_out: data.clockOut,
    breaks: data.breaks,
    note: data.note,
    before: before ? { clock_in: before.clock_in, clock_out: before.clock_out, breaks: before.breaks.map((b) => ({ start: b.start_at, end: b.end_at })) } : null,
  };
  return db.get().prepare('INSERT INTO requests(user_id, type, start_date, end_date, payload, reason) VALUES (?,?,?,?,?,?)')
    .run(userId, 'correction', date, date, JSON.stringify(payload), reason).lastInsertRowid;
}

/** 休暇対象日（休日を除く出勤日）を返す */
function leaveTargetDates(start, end) {
  const settings = settingsLib.getAll();
  const companyMap = att.companyHolidays(start, end);
  return t.eachDate(start, end).filter((d) => !att.dayType(d, settings, companyMap).isOffDay);
}

function createLeave(userId, start, end, leaveType, reason) {
  const lt = LEAVE_TYPES[leaveType];
  if (!lt) throw new RequestError('休暇種別が不正です。');
  if (end < start) throw new RequestError('終了日は開始日以降にしてください。');
  if (lt.half && start !== end) throw new RequestError('半休は1日単位で申請してください。');
  if (t.eachDate(start, end).length > 62) throw new RequestError('一度に申請できる期間は62日までです。');
  const dates = leaveTargetDates(start, end);
  if (!dates.length) throw new RequestError('指定期間に出勤日がありません（休日は休暇の対象外です）。');
  if (hasPendingOverlap(userId, 'leave', start, end)) throw new RequestError('期間が重複する承認待ちの休暇申請があります。');
  const taken = db.get().prepare(`SELECT leave_date FROM leaves WHERE user_id = ? AND leave_date BETWEEN ? AND ?`).all(userId, start, end);
  if (taken.length) throw new RequestError(`${taken.map((x) => x.leave_date).join(', ')} はすでに休暇が登録されています。`);
  const days = dates.length * lt.days;
  if (lt.paid && days > att.paidLeaveBalance(userId)) {
    throw new RequestError(`有給休暇の残日数が不足しています（申請: ${days}日 / 残: ${att.paidLeaveBalance(userId)}日）。`);
  }
  const payload = { leave_type: leaveType, dates, days };
  return db.get().prepare('INSERT INTO requests(user_id, type, start_date, end_date, payload, reason) VALUES (?,?,?,?,?,?)')
    .run(userId, 'leave', start, end, JSON.stringify(payload), reason).lastInsertRowid;
}

function cancelOwn(userId, id) {
  const r = db.get().prepare("UPDATE requests SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'").run(id, userId);
  if (!r.changes) throw new RequestError('取り消せる申請が見つかりません。');
}

function approve(reviewerId, id, comment) {
  const conn = db.get();
  conn.transaction(() => {
    const r = get(id);
    if (!r || r.status !== 'pending') throw new RequestError('承認待ちの申請が見つかりません。');
    if (r.type === 'correction') {
      const p = r.payload;
      att.saveRecord(r.user_id, r.start_date, { clockIn: p.clock_in, clockOut: p.clock_out, breaks: p.breaks, note: p.note });
    } else {
      const lt = LEAVE_TYPES[r.payload.leave_type];
      const dates = leaveTargetDates(r.start_date, r.end_date);
      const ins = conn.prepare('INSERT INTO leaves(user_id, leave_date, leave_type, request_id) VALUES (?,?,?,?)');
      for (const d of dates) {
        const exists = conn.prepare('SELECT 1 FROM leaves WHERE user_id = ? AND leave_date = ?').get(r.user_id, d);
        if (exists) throw new RequestError(`${d} にはすでに休暇が登録されています。`);
        ins.run(r.user_id, d, r.payload.leave_type, r.id);
      }
      const days = dates.length * lt.days;
      if (lt.paid && days > 0) {
        conn.prepare("INSERT INTO leave_ledger(user_id, entry_date, days, kind, note, request_id, created_by) VALUES (?,?,?,'use',?,?,?)")
          .run(r.user_id, r.start_date, -days, `${lt.short} ${r.start_date}${r.end_date !== r.start_date ? '〜' + r.end_date : ''}`, r.id, reviewerId);
      }
    }
    conn.prepare("UPDATE requests SET status = 'approved', reviewer_id = ?, review_comment = ?, reviewed_at = datetime('now','localtime') WHERE id = ?")
      .run(reviewerId, comment || null, id);
  })();
}

function reject(reviewerId, id, comment) {
  const r = db.get().prepare("UPDATE requests SET status = 'rejected', reviewer_id = ?, review_comment = ?, reviewed_at = datetime('now','localtime') WHERE id = ? AND status = 'pending'")
    .run(reviewerId, comment || null, id);
  if (!r.changes) throw new RequestError('承認待ちの申請が見つかりません。');
}

/** 承認済み休暇の取り消し（管理者）。有給は残日数に戻す */
function revokeLeave(reviewerId, id, comment) {
  const conn = db.get();
  conn.transaction(() => {
    const r = get(id);
    if (!r || r.type !== 'leave' || r.status !== 'approved') throw new RequestError('取り消せる休暇申請が見つかりません。');
    conn.prepare('DELETE FROM leaves WHERE request_id = ?').run(id);
    const used = conn.prepare("SELECT COALESCE(SUM(days),0) AS d FROM leave_ledger WHERE request_id = ? AND kind = 'use'").get(id).d;
    if (used < 0) {
      conn.prepare("INSERT INTO leave_ledger(user_id, entry_date, days, kind, note, request_id, created_by) VALUES (?,?,?,'restore',?,?,?)")
        .run(r.user_id, t.today(), -used, `休暇取消 (申請#${id})`, id, reviewerId);
    }
    conn.prepare("UPDATE requests SET status = 'cancelled', reviewer_id = ?, review_comment = ?, reviewed_at = datetime('now','localtime') WHERE id = ?")
      .run(reviewerId, comment || '承認後に取消', id);
  })();
}

module.exports = {
  RequestError, STATUS_LABELS, TYPE_LABELS, get, list, countPending,
  createCorrection, createLeave, cancelOwn, approve, reject, revokeLeave,
};
