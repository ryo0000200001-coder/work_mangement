'use strict';
require('../src/config');
const test = require('node:test');
const assert = require('node:assert/strict');
const calc = require('../src/lib/calc');
const t = require('../src/lib/time');
const { holidayName, holidaysOfYear } = require('../src/lib/holidays');

const settings = { rounding_in: 1, rounding_out: 1, auto_break: true };
const schedule = { start: '09:00', end: '18:00', standardMinutes: 480 };
const NOW = new Date(2026, 10, 20, 12, 0, 0);

function day(date, rec, opts = {}) {
  return calc.computeDay({
    date, now: NOW, isOffDay: false, offReason: null, leaveType: null, schedule, settings,
    ...opts,
    record: rec ? { clock_in: rec[0], clock_out: rec[1], breaks: (rec[2] || []).map(([s, e]) => ({ start_at: s, end_at: e })) } : null,
  });
}

test('通常勤務: 9-18 休憩1h → 8h, 残業なし', () => {
  const d = day('2026-11-10', ['2026-11-10T09:00:00', '2026-11-10T18:00:00', [['2026-11-10T12:00:00', '2026-11-10T13:00:00']]]);
  assert.equal(d.workMinutes, 480);
  assert.equal(d.breakMinutes, 60);
  assert.equal(d.overtimeMinutes, 0);
  assert.equal(d.lateMinutes, 0);
  assert.equal(d.earlyLeaveMinutes, 0);
});

test('残業・遅刻', () => {
  const d = day('2026-11-10', ['2026-11-10T09:10:00', '2026-11-10T20:30:00', [['2026-11-10T12:00:00', '2026-11-10T13:00:00']]]);
  assert.equal(d.workMinutes, 620);
  assert.equal(d.overtimeMinutes, 140);
  assert.equal(d.lateMinutes, 10);
});

test('休憩未打刻 → 法定休憩を自動控除', () => {
  const d = day('2026-11-10', ['2026-11-10T09:00:00', '2026-11-10T18:00:00']);
  assert.equal(d.autoBreakMinutes, 60);
  assert.equal(d.workMinutes, 480);
  // 6時間20分勤務 → 6時間を下回らないよう20分のみ控除
  const d2 = day('2026-11-10', ['2026-11-10T09:00:00', '2026-11-10T15:20:00']);
  assert.equal(d2.workMinutes, 360);
  // 8時間30分（休憩なし）→ 45分控除で 7:45（8時間以下なので45分で足りる）
  const d3 = day('2026-11-10', ['2026-11-10T09:00:00', '2026-11-10T17:30:00']);
  assert.equal(d3.autoBreakMinutes, 45);
  assert.equal(d3.workMinutes, 465);
});

test('自動控除なし設定', () => {
  const d = calc.computeDay({
    date: '2026-11-10', now: NOW, isOffDay: false, leaveType: null, schedule,
    settings: { ...settings, auto_break: false },
    record: { clock_in: '2026-11-10T09:00:00', clock_out: '2026-11-10T18:00:00', breaks: [] },
  });
  assert.equal(d.workMinutes, 540);
  assert.equal(d.overtimeMinutes, 60);
});

test('深夜・日跨ぎ', () => {
  const d = day('2026-11-10', ['2026-11-10T18:00:00', '2026-11-11T03:00:00', [['2026-11-10T23:00:00', '2026-11-11T00:00:00']]],
    { schedule: { start: '18:00', end: '03:00', standardMinutes: 480 } });
  assert.equal(d.workMinutes, 480);
  assert.equal(d.nightMinutes, 240); // 22-23, 0-3
  assert.equal(d.earlyLeaveMinutes, 0);
});

test('休日労働', () => {
  const d = day('2026-11-08', ['2026-11-08T10:00:00', '2026-11-08T15:00:00'], { isOffDay: true });
  assert.equal(d.holidayWorkMinutes, 300);
  assert.equal(d.overtimeMinutes, 0);
  assert.equal(d.lateMinutes, 0);
});

test('丸め: 出勤15分切り上げ・退勤15分切り捨て', () => {
  const d = calc.computeDay({
    date: '2026-11-10', now: NOW, isOffDay: false, leaveType: null,
    schedule: { start: '09:00', end: '18:00', standardMinutes: 480 },
    settings: { rounding_in: 15, rounding_out: 15, auto_break: false },
    record: { clock_in: '2026-11-10T08:52:00', clock_out: '2026-11-10T18:14:00', breaks: [{ start_at: '2026-11-10T12:00:00', end_at: '2026-11-10T13:00:00' }] },
  });
  assert.equal(d.workMinutes, 480); // 09:00-18:00
});

test('未打刻・退勤漏れ・勤務中', () => {
  assert.equal(day('2026-11-10', null).noRecord, true);
  assert.equal(day('2026-11-08', null, { isOffDay: true }).noRecord, false);
  assert.equal(day('2026-11-10', null, { leaveType: 'paid_full' }).noRecord, false);
  assert.equal(day('2026-11-18', ['2026-11-18T09:00:00', null]).missingClockOut, true);
  const w = day('2026-11-20', ['2026-11-20T09:00:00', null, [['2026-11-20T11:30:00', null]]]);
  assert.equal(w.inProgress, true);
  assert.equal(w.onBreak, true);
  assert.equal(w.workMinutes, 150);
});

test('午前半休: 遅刻扱いにせず所定を半分にする', () => {
  const d = day('2026-11-10', ['2026-11-10T14:00:00', '2026-11-10T19:00:00'], { leaveType: 'paid_am' });
  assert.equal(d.lateMinutes, 0);
  assert.equal(d.workMinutes, 300);
  assert.equal(d.overtimeMinutes, 60);
});

test('月次集計', () => {
  const days = [
    day('2026-11-09', ['2026-11-09T09:00:00', '2026-11-09T19:00:00', [['2026-11-09T12:00:00', '2026-11-09T13:00:00']]]),
    day('2026-11-10', null, { leaveType: 'paid_full' }),
    day('2026-11-11', null),
  ];
  const s = calc.summarize(days);
  assert.equal(s.workDays, 1);
  assert.equal(s.overtimeMinutes, 60);
  assert.equal(s.paidLeaveDays, 1);
  assert.equal(s.noRecordDays, 1);
});

test('祝日: 振替休日・国民の休日', () => {
  assert.equal(holidayName('2026-05-06'), '振替休日');
  assert.equal(holidayName('2026-09-22'), '国民の休日');
  assert.equal(holidayName('2026-01-12'), '成人の日');
  assert.equal(holidayName('2026-11-10'), null);
  assert.equal(holidayName('2025-03-20'), '春分の日');
  assert.equal(holidayName('2027-03-21'), '春分の日');
  assert.equal(holidayName('2027-03-22'), '振替休日');
  assert.equal(holidaysOfYear(2026).size, 18);
});

test('締め日の期間計算', () => {
  assert.deepEqual(t.monthPeriod('2026-11', 0), { start: '2026-11-01', end: '2026-11-30' });
  assert.deepEqual(t.monthPeriod('2026-03', 20), { start: '2026-02-21', end: '2026-03-20' });
  assert.deepEqual(t.monthPeriod('2026-01', 25), { start: '2025-12-26', end: '2026-01-25' });
  assert.equal(t.monthOf('2026-11-21', 20), '2026-12');
  assert.equal(t.monthOf('2026-11-20', 20), '2026-11');
});
