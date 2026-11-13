'use strict';
require('../src/config');
const test = require('node:test');
const assert = require('node:assert/strict');
const calc = require('../src/lib/calc');
const pay = require('../src/lib/pay');
const t = require('../src/lib/time');

const settings = { rounding_in: 1, rounding_out: 1, auto_break: true, overtime_premium: 25, night_premium: 25, holiday_premium: 35 };
const NOW = new Date(2026, 10, 20, 12, 0, 0);

function day(rec, opts = {}) {
  return calc.computeDay({
    date: '2026-11-10', now: NOW, isOffDay: false, leaveType: null,
    schedule: { start: null, end: null, standardMinutes: 480 }, settings, ...opts,
    record: { clock_in: rec[0], clock_out: rec[1], breaks: (rec[2] || []).map(([s, e]) => ({ start_at: s, end_at: e })), store_id: rec[3] || 1, moves: rec[4] || [] },
  });
}

test('店舗按分: 途中で店舗移動（ヘルプ）', () => {
  const d = day(['2026-11-10T10:00:00', '2026-11-10T17:00:00', [['2026-11-10T13:00:00', '2026-11-10T14:00:00']], 1,
    [{ store_id: 2, at: '2026-11-10T15:00:00' }]]);
  assert.equal(d.workMinutes, 360);
  assert.deepEqual(d.storeMinutes, { 1: 240, 2: 120 });
});

test('店舗按分: 自動控除後も合計が労働時間と一致', () => {
  const d = day(['2026-11-10T10:00:00', '2026-11-10T19:00:00', [], 1, [{ store_id: 2, at: '2026-11-10T14:00:00' }]]);
  assert.equal(d.autoBreakMinutes, 60);
  assert.equal(d.storeMinutes[1] + d.storeMinutes[2], d.workMinutes);
});

test('シフト制: シフトのない日は未打刻扱いにしない / シフト基準で遅刻判定', () => {
  const noShift = calc.computeDay({ date: '2026-11-10', now: NOW, isOffDay: false, scheduled: false, record: null, schedule: { standardMinutes: 480 }, settings });
  assert.equal(noShift.noRecord, false);
  const withShift = calc.computeDay({ date: '2026-11-10', now: NOW, isOffDay: false, scheduled: true, record: null, schedule: { standardMinutes: 480 }, settings });
  assert.equal(withShift.noRecord, true);
  const late = day(['2026-11-10T17:10:00', '2026-11-10T22:00:00'], { schedule: { start: '17:00', end: '22:00', standardMinutes: 480 } });
  assert.equal(late.lateMinutes, 10);
  assert.equal(late.earlyLeaveMinutes, 0);
});

test('概算給与: 基本・残業・深夜・交通費', () => {
  // 15:00〜翌0:00 休憩1h → 労働8h、深夜 22-24 = 2h、残業なし
  const d = day(['2026-11-10T15:00:00', '2026-11-11T00:00:00', [['2026-11-10T19:00:00', '2026-11-10T20:00:00']]]);
  assert.equal(d.workMinutes, 480);
  assert.equal(d.nightMinutes, 120);
  const p = pay.dayPay(d, { hourly_wage: 1200, commute_per_day: 500 }, settings);
  assert.equal(p.base, 9600);
  assert.equal(p.night, 600);
  assert.equal(p.overtime, 0);
  assert.equal(p.total, 10700);
  // 10時間勤務 → 2h 残業
  const d2 = day(['2026-11-10T09:00:00', '2026-11-10T20:00:00', [['2026-11-10T12:00:00', '2026-11-10T13:00:00']]]);
  assert.equal(pay.dayPay(d2, { hourly_wage: 1200 }, settings).overtime, 600);
});

test('シフトの時間計算・標準休憩', () => {
  const shifts = require('../src/services/shifts');
  assert.equal(pay.shiftMinutes({ start_time: '18:00', end_time: '00:00', break_minutes: 0 }), 360);
  assert.equal(pay.shiftNightMinutes({ start_time: '18:00', end_time: '02:00' }), 240);
  assert.equal(pay.shiftNightMinutes({ start_time: '04:00', end_time: '09:00' }), 60);
  assert.equal(shifts.defaultBreak('10:00', '15:00'), 0);
  assert.equal(shifts.defaultBreak('10:00', '18:00'), 45);
  assert.equal(shifts.defaultBreak('10:00', '19:00'), 60);
});
