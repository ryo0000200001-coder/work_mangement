'use strict';
// 勤怠計算ロジック（純粋関数。DB に依存しない）
const t = require('./time');

const LEAVE_TYPES = {
  paid_full: { label: '有給休暇', short: '有給', days: 1, paid: true, fullDay: true },
  paid_am: { label: '午前半休（有給）', short: '午前半休', days: 0.5, paid: true, half: 'am' },
  paid_pm: { label: '午後半休（有給）', short: '午後半休', days: 0.5, paid: true, half: 'pm' },
  special: { label: '特別休暇（慶弔等）', short: '特休', days: 0, paid: false, fullDay: true },
  absence: { label: '欠勤', short: '欠勤', days: 0, paid: false, fullDay: true },
};

const NIGHT_START = 22 * 60; // 深夜時間帯 22:00〜翌5:00（労基法）
const NIGHT_END = 5 * 60;

/** 法定休憩: 6時間超→45分, 8時間超→60分 */
function requiredBreak(workMinutes) {
  if (workMinutes > 480) return 60;
  if (workMinutes > 360) return 45;
  return 0;
}

/**
 * 記録された休憩が法定に満たない場合の追加控除（分）。
 * 控除後の労働時間に対して法定休憩を満たす最小の値を求める。
 */
function autoBreakDeduction(workBeforeAuto, recordedBreak) {
  for (let d = 0; d <= 60; d++) {
    const w = workBeforeAuto - d;
    if (w <= 0) return Math.max(0, workBeforeAuto);
    if (recordedBreak + d >= requiredBreak(w)) return d;
  }
  return 60;
}

function truncSeconds(d) {
  const x = new Date(d); x.setSeconds(0, 0); return x;
}

function roundUp(d, unit) {
  const x = truncSeconds(d);
  if (unit <= 1) return x;
  const ms = unit * 60000;
  return new Date(Math.ceil(x.getTime() / ms) * ms);
}

function roundDown(d, unit) {
  const x = truncSeconds(d);
  if (unit <= 1) return x;
  const ms = unit * 60000;
  return new Date(Math.floor(x.getTime() / ms) * ms);
}

/** 区間リストを結合 */
function mergeIntervals(list) {
  const s = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of s) {
    if (out.length && a <= out[out.length - 1][1]) {
      out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    } else out.push([a, b]);
  }
  return out;
}

/** [from, to] から除外区間を差し引いた区間リスト（ms） */
function subtract(from, to, excludes) {
  const out = [];
  let cur = from;
  for (const [a, b] of mergeIntervals(excludes)) {
    if (b <= cur) continue;
    if (a >= to) break;
    if (a > cur) out.push([cur, Math.min(a, to)]);
    cur = Math.max(cur, b);
  }
  if (cur < to) out.push([cur, to]);
  return out;
}

/** 区間と深夜帯の重なり（分） */
function nightOverlap(a, b) {
  let total = 0;
  const start = new Date(a); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 1);
  for (let d = new Date(start); d.getTime() < b; d.setDate(d.getDate() + 1)) {
    const ns = new Date(d); ns.setHours(0, NIGHT_START, 0, 0);
    const ne = new Date(d); ne.setDate(ne.getDate() + 1); ne.setHours(0, NIGHT_END, 0, 0);
    const lo = Math.max(a, ns.getTime());
    const hi = Math.min(b, ne.getTime());
    if (hi > lo) total += (hi - lo) / 60000;
  }
  return total;
}

/**
 * 1日分の勤怠を計算する。
 * @param {object} p
 * @param {string} p.date 'YYYY-MM-DD'
 * @param {object|null} p.record {clock_in, clock_out, breaks:[{start_at,end_at}], note}
 * @param {Date} p.now 現在時刻
 * @param {boolean} p.isOffDay 休日か
 * @param {string|null} p.offReason 休日名（祝日名・会社休日名・'週休'）
 * @param {string|null} p.leaveType LEAVE_TYPES のキー
 * @param {object} p.schedule {start:'HH:MM', end:'HH:MM', standardMinutes}
 * @param {object} p.settings {rounding_in, rounding_out, auto_break}
 * @param {boolean} [p.scheduled] 出勤予定日か（省略時は !isOffDay）。シフト制ではシフトがある日のみ true
 */
function computeDay(p) {
  const { date, record, now, isOffDay, offReason, leaveType, schedule, settings } = p;
  const scheduled = p.scheduled == null ? !isOffDay : !!p.scheduled;
  const leave = leaveType ? LEAVE_TYPES[leaveType] || null : null;
  const today = t.ymd(now);
  const r = {
    date,
    weekday: t.weekday(date),
    weekdayLabel: t.weekdayLabel(date),
    isOffDay: !!isOffDay,
    offReason: offReason || null,
    leaveType: leaveType || null,
    leaveLabel: leave ? leave.short : null,
    clockIn: record ? record.clock_in : null,
    clockOut: record ? record.clock_out : null,
    note: record ? record.note || '' : '',
    hasRecord: !!(record && record.clock_in),
    inProgress: false,
    onBreak: false,
    missingClockOut: false,
    noRecord: false,
    breakMinutes: 0,
    autoBreakMinutes: 0,
    workMinutes: 0,
    overtimeMinutes: 0,
    nightMinutes: 0,
    holidayWorkMinutes: 0,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    isWorkday: scheduled,
    storeMinutes: {},
  };

  if (!r.hasRecord) {
    // 過去の出勤日で記録も休暇もない → 未打刻
    if (scheduled && !leave && date < today) r.noRecord = true;
    return r;
  }

  const inAt = t.parseDateTime(record.clock_in);
  let outAt = record.clock_out ? t.parseDateTime(record.clock_out) : null;
  if (!outAt) {
    // 当日〜24時間以内なら勤務中、それ以前は退勤打刻漏れ
    if (now - inAt < 24 * 3600 * 1000 && now >= inAt) {
      r.inProgress = true;
      outAt = now;
    } else {
      r.missingClockOut = true;
      return r;
    }
  }

  const inR = roundUp(inAt, settings.rounding_in || 1);
  let outR = r.inProgress ? truncSeconds(outAt) : roundDown(outAt, settings.rounding_out || 1);
  if (outR < inR) outR = inR;
  const a = inR.getTime();
  const b = outR.getTime();

  const breakIntervals = [];
  for (const br of record.breaks || []) {
    const bs = t.parseDateTime(br.start_at).getTime();
    let be;
    if (br.end_at) be = t.parseDateTime(br.end_at).getTime();
    else {
      be = r.inProgress ? now.getTime() : b;
      if (r.inProgress) r.onBreak = true;
    }
    const lo = Math.max(bs, a);
    const hi = Math.min(be, b);
    if (hi > lo) breakIntervals.push([lo, hi]);
  }
  const mergedBreaks = mergeIntervals(breakIntervals);
  const recordedBreak = Math.round(mergedBreaks.reduce((s, [x, y]) => s + (y - x), 0) / 60000);
  const segments = subtract(a, b, mergedBreaks);
  const workBeforeAuto = Math.round(segments.reduce((s, [x, y]) => s + (y - x), 0) / 60000);

  let auto = 0;
  if (settings.auto_break && !r.inProgress) auto = autoBreakDeduction(workBeforeAuto, recordedBreak);

  r.breakMinutes = recordedBreak + auto;
  r.autoBreakMinutes = auto;
  r.workMinutes = Math.max(0, workBeforeAuto - auto);
  r.nightMinutes = Math.min(
    r.workMinutes,
    Math.round(segments.reduce((s, [x, y]) => s + nightOverlap(x, y), 0))
  );

  r.storeMinutes = allocateStores(record, segments, r.workMinutes);

  if (isOffDay) {
    r.holidayWorkMinutes = r.workMinutes;
  } else {
    const leaveDays = leave ? leave.days : 0;
    const standard = Math.round((schedule.standardMinutes || 480) * (1 - Math.min(leaveDays, 1)));
    r.overtimeMinutes = Math.max(0, r.workMinutes - standard);

    if (schedule.start && schedule.end && !(leave && leave.fullDay)) {
      const sStart = t.parseDateTime(t.combine(date, schedule.start));
      const nextDay = t.hmToMinutes(schedule.end) <= t.hmToMinutes(schedule.start);
      const sEnd = t.parseDateTime(t.combine(date, schedule.end, nextDay));
      if (!(leave && leave.half === 'am') && inR > sStart) {
        r.lateMinutes = Math.round(t.diffMinutes(sStart, inR));
      }
      if (!r.inProgress && !(leave && leave.half === 'pm') && outR < sEnd) {
        r.earlyLeaveMinutes = Math.round(t.diffMinutes(outR, sEnd));
      }
    }
  }
  return r;
}

/**
 * 店舗別の勤務時間（分）。出勤店舗と店舗移動の時刻で区切り、労働区間との重なりで按分する。
 * 自動控除した休憩分は比率で差し引き、合計が workMinutes と一致するよう調整する。
 */
function allocateStores(record, segments, workMinutes) {
  const out = {};
  if (!workMinutes) return out;
  const startStore = record.store_id || 0;
  const moves = (record.moves || [])
    .map((m) => ({ store: m.store_id || 0, at: t.parseDateTime(m.at).getTime() }))
    .sort((x, y) => x.at - y.at);
  const bounds = [{ store: startStore, from: -Infinity }];
  for (const m of moves) bounds.push({ store: m.store, from: m.at });
  const raw = {};
  let total = 0;
  bounds.forEach((bnd, i) => {
    const to = i + 1 < bounds.length ? bounds[i + 1].from : Infinity;
    for (const [x, y] of segments) {
      const lo = Math.max(x, bnd.from);
      const hi = Math.min(y, to);
      if (hi > lo) {
        raw[bnd.store] = (raw[bnd.store] || 0) + (hi - lo) / 60000;
        total += (hi - lo) / 60000;
      }
    }
  });
  if (!total) return out;
  let assigned = 0;
  const keys = Object.keys(raw);
  keys.forEach((k, i) => {
    const v = i === keys.length - 1 ? workMinutes - assigned : Math.round((raw[k] / total) * workMinutes);
    out[k] = v;
    assigned += v;
  });
  return out;
}

/** 月次集計 */
function summarize(days) {
  const s = {
    workDays: 0, offDayWorkDays: 0, scheduledDays: 0,
    workMinutes: 0, overtimeMinutes: 0, nightMinutes: 0, holidayWorkMinutes: 0,
    lateCount: 0, lateMinutes: 0, earlyLeaveCount: 0, earlyLeaveMinutes: 0,
    paidLeaveDays: 0, specialLeaveDays: 0, absenceDays: 0,
    noRecordDays: 0, missingClockOutDays: 0,
  };
  for (const d of days) {
    if (d.isWorkday) s.scheduledDays += 1;
    if (d.hasRecord) {
      if (d.isOffDay) s.offDayWorkDays += 1; else s.workDays += 1;
    }
    s.workMinutes += d.workMinutes;
    s.overtimeMinutes += d.overtimeMinutes;
    s.nightMinutes += d.nightMinutes;
    s.holidayWorkMinutes += d.holidayWorkMinutes;
    if (d.lateMinutes > 0) { s.lateCount += 1; s.lateMinutes += d.lateMinutes; }
    if (d.earlyLeaveMinutes > 0) { s.earlyLeaveCount += 1; s.earlyLeaveMinutes += d.earlyLeaveMinutes; }
    if (d.leaveType) {
      const lt = LEAVE_TYPES[d.leaveType];
      if (lt && lt.paid) s.paidLeaveDays += lt.days;
      if (d.leaveType === 'special') s.specialLeaveDays += 1;
      if (d.leaveType === 'absence') s.absenceDays += 1;
    }
    if (d.noRecord) s.noRecordDays += 1;
    if (d.missingClockOut) s.missingClockOutDays += 1;
  }
  return s;
}

module.exports = {
  LEAVE_TYPES, requiredBreak, autoBreakDeduction, computeDay, summarize,
  roundUp, roundDown, mergeIntervals, subtract, nightOverlap, allocateStores,
};
