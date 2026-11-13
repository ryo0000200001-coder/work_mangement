'use strict';
// 概算給与・人件費の計算（時給制スタッフ向け。税・社会保険料の控除前）

/**
 * 1日分の概算支給額（円, 小数を含む）
 * - 基本: 労働時間 × 時給
 * - 時間外割増: 残業時間 × 時給 × overtime_premium%
 * - 深夜割増:   深夜時間 × 時給 × night_premium%
 * - 休日割増:   休日労働 × 時給 × holiday_premium%
 * - 交通費:     出勤日ごとに commute_per_day
 */
function dayPay(day, user, settings) {
  const wage = user.hourly_wage || 0;
  const r = { base: 0, overtime: 0, night: 0, holiday: 0, commute: 0, total: 0 };
  if (!day.hasRecord || day.missingClockOut) return r;
  const perMin = wage / 60;
  r.base = day.workMinutes * perMin;
  r.overtime = day.overtimeMinutes * perMin * (settings.overtime_premium / 100);
  r.night = day.nightMinutes * perMin * (settings.night_premium / 100);
  r.holiday = day.holidayWorkMinutes * perMin * (settings.holiday_premium / 100);
  r.commute = day.workMinutes > 0 ? user.commute_per_day || 0 : 0;
  r.total = r.base + r.overtime + r.night + r.holiday + r.commute;
  return r;
}

/** 期間の概算給与（円・切り捨て） */
function periodPay(days, user, settings) {
  const sum = { base: 0, overtime: 0, night: 0, holiday: 0, commute: 0, total: 0 };
  for (const d of days) {
    const p = dayPay(d, user, settings);
    for (const k of Object.keys(sum)) sum[k] += p[k];
  }
  for (const k of Object.keys(sum)) sum[k] = Math.floor(sum[k]);
  sum.total = sum.base + sum.overtime + sum.night + sum.holiday + sum.commute;
  return sum;
}

/** シフトの予定人件費（休憩を除いた時間 × 時給 + 交通費。割増は深夜のみ概算） */
function shiftCost(shift, user, settings, nightMinutes = 0) {
  const wage = user.hourly_wage || 0;
  const mins = shiftMinutes(shift);
  return Math.floor(mins * wage / 60 + nightMinutes * wage / 60 * (settings.night_premium / 100) + (user.commute_per_day || 0));
}

function toMin(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

/** シフトの拘束時間から休憩を除いた分数 */
function shiftMinutes(shift) {
  let s = toMin(shift.start_time);
  let e = toMin(shift.end_time);
  if (e <= s) e += 24 * 60;
  return Math.max(0, e - s - (shift.break_minutes || 0));
}

/** シフトの深夜時間（22:00〜翌5:00）※休憩は考慮しない概算 */
function shiftNightMinutes(shift) {
  let s = toMin(shift.start_time);
  let e = toMin(shift.end_time);
  if (e <= s) e += 24 * 60;
  let n = 0;
  for (const [a, b] of [[-120, 300], [1320, 1740], [2760, 3180]]) {
    n += Math.max(0, Math.min(e, b) - Math.max(s, a));
  }
  return n;
}

const yen = (n) => `${Math.round(n).toLocaleString('ja-JP')}円`;

module.exports = { dayPay, periodPay, shiftCost, shiftMinutes, shiftNightMinutes, yen };
