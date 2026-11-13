'use strict';
// 動作確認用のデモデータ（飲食店 2店舗）を投入する。空のDBに対してのみ実行可能
// 使い方: npm run seed:demo
require('../src/config');
const db = require('../src/db');
const t = require('../src/lib/time');
const users = require('../src/services/users');
const att = require('../src/services/attendance');
const reqs = require('../src/services/requests');
const shiftsSvc = require('../src/services/shifts');
const storesSvc = require('../src/services/stores');
const labor = require('../src/services/labor');
const settingsLib = require('../src/lib/settings');

db.get();
if (users.count() > 0) {
  console.error('すでにユーザーが存在するため、デモデータは投入しません（data/ を削除してから実行してください）。');
  process.exit(1);
}

settingsLib.update({ company_name: 'デモ食堂' });
const shibuya = storesSvc.create({ name: '渋谷店', required_weekday: 3, required_weekend: 4 });
const ebisu = storesSvc.create({ name: '恵比寿店', required_weekday: 2, required_weekend: 3 });

const mk = (o) => {
  const id = users.create({
    email: null, department: null, standard_minutes: null, hire_date: '2025-04-01', password: 'demo1234',
    employment_type: 'part', hourly_wage: null, commute_per_day: null, annual_income_limit: null, work_start: '10:00', work_end: '15:00',
    role: 'employee', ...o,
  }, { mustChangePassword: false });
  db.get().prepare("INSERT INTO leave_ledger(user_id, entry_date, days, kind, note) VALUES (?,?,?,'grant','2026年度 定期付与')").run(id, '2026-04-01', o.employment_type === 'full' ? 11 : 5);
  return id;
};

const admin = mk({ login_id: 'admin', name: '本部 太郎', role: 'admin', employment_type: 'full', store_id: null, work_start: '09:00', work_end: '18:00' });
const staff = [
  { id: mk({ login_id: 'm001', name: '店長 花子', role: 'manager', employment_type: 'full', store_id: shibuya, work_start: '10:00', work_end: '19:00' }), store: shibuya, pattern: [[600, 1140]] },
  { id: mk({ login_id: 'p001', name: '山田 美咲', store_id: shibuya, hourly_wage: 1250, commute_per_day: 400, annual_income_limit: 1230000 }), store: shibuya, pattern: [[600, 900], [660, 960]] },
  { id: mk({ login_id: 'p002', name: '佐藤 健太', store_id: shibuya, hourly_wage: 1200, commute_per_day: 300, work_start: '17:00', work_end: '23:00' }), store: shibuya, pattern: [[1020, 1380], [1080, 1380]] },
  { id: mk({ login_id: 'p003', name: 'グエン ミン', store_id: shibuya, hourly_wage: 1300, work_start: '18:00', work_end: '24:00' }), store: shibuya, pattern: [[1080, 1440]] },
  { id: mk({ login_id: 'p004', name: '鈴木 陽菜', store_id: ebisu, hourly_wage: 1250, commute_per_day: 500, annual_income_limit: 1060000 }), store: ebisu, pattern: [[660, 1020]] },
  { id: mk({ login_id: 'p005', name: '高橋 大輔', store_id: ebisu, hourly_wage: 1200, work_start: '17:00', work_end: '22:00' }), store: ebisu, pattern: [[1020, 1320]] },
];

let seed = 7;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const hm = (min) => `${t.pad(Math.floor(min / 60) % 24)}:${t.pad(min % 60)}`;
const nextIf = (min) => min >= 24 * 60;

const today = t.today();
const start = t.addDays(today, -40);
const monday = t.addDays(today, t.weekday(today) === 0 ? -6 : 1 - t.weekday(today));
const nextMondayEnd = t.addDays(monday, 13);

// シフト（過去〜今週は公開、来週は下書き）と実績
for (const s of staff) {
  for (const date of t.eachDate(start, nextMondayEnd)) {
    const w = t.weekday(date);
    const isFull = s.pattern.length === 1 && s.pattern[0][1] - s.pattern[0][0] >= 480;
    if (isFull ? (w === 2 || w === 3) : rand() < 0.45) continue; // 社員は火水休み、パートは週3〜4日
    const [a, b] = s.pattern[Math.floor(rand() * s.pattern.length)];
    shiftsSvc.upsert({ userId: s.id, storeId: s.store, date, start: hm(a), end: hm(b), breakMinutes: shiftsSvc.defaultBreak(hm(a), hm(b)) });
    if (date >= today) continue;
    if (rand() < 0.03) continue; // まれに打刻漏れ
    const inMin = a - 8 + Math.floor(rand() * 12);
    const outMin = b + Math.floor(rand() * 25) - 3;
    const brk = shiftsSvc.defaultBreak(hm(a), hm(b));
    const mid = a + Math.floor((b - a) / 2) - 30;
    att.saveRecord(s.id, date, {
      clockIn: t.combine(date, hm(inMin)),
      clockOut: t.combine(date, hm(outMin), nextIf(outMin)),
      breaks: brk ? [{ start: t.combine(date, hm(mid)), end: t.combine(date, hm(mid + brk)) }] : [],
      note: '', storeId: s.store,
    });
  }
  shiftsSvc.publish(s.store, start, t.addDays(monday, 6));
}

// ヘルプ勤務: 山田さんが渋谷→恵比寿へ移動した日
const helpDate = t.eachDate(t.addDays(today, -10), t.addDays(today, -1)).find((d) => att.getRecord(staff[1].id, d));
if (helpDate) {
  const rec = att.getRecord(staff[1].id, helpDate);
  const mid = new Date((t.parseDateTime(rec.clock_in).getTime() + t.parseDateTime(rec.clock_out).getTime()) / 2);
  db.get().prepare('INSERT INTO store_moves(attendance_id, store_id, at) VALUES (?,?,?)').run(rec.id, ebisu, t.toLocalISO(mid).slice(0, 16) + ':00');
}

// 売上（過去分）
for (const [storeId, base] of [[shibuya, 85000], [ebisu, 52000]]) {
  const entries = t.eachDate(start, t.addDays(today, -1)).map((date) => {
    const w = t.weekday(date);
    return { date, amount: Math.round((base * (w === 5 || w === 6 ? 1.4 : 1) * (0.85 + rand() * 0.3)) / 100) * 100 };
  });
  labor.saveSales(storeId, entries);
}

// 希望シフト（再来週分）
const reqStart = t.addDays(monday, 14);
for (const s of staff.slice(1)) {
  shiftsSvc.saveRequests(s.id, t.eachDate(reqStart, t.addDays(reqStart, 13)).map((date) => {
    const r = rand();
    if (r < 0.25) return { date, kind: 'unavailable' };
    if (r < 0.75) return { date, kind: 'available', start: hm(s.pattern[0][0]), end: hm(s.pattern[0][1] % 1440) };
    return { date, kind: '' };
  }));
}

// 退勤漏れと申請
const missDate = t.eachDate(t.addDays(today, -6), t.addDays(today, -1)).find((d) => att.getRecord(staff[2].id, d));
if (missDate) {
  const rec = att.getRecord(staff[2].id, missDate);
  db.get().prepare('UPDATE attendance SET clock_out = NULL WHERE id = ?').run(rec.id);
  reqs.createCorrection(staff[2].id, missDate, {
    clockIn: rec.clock_in, clockOut: t.combine(missDate, '23:05'),
    breaks: rec.breaks.map((b) => ({ start: b.start_at, end: b.end_at })), note: '',
  }, '退勤の打刻を忘れました');
}
const leaveDate = t.eachDate(t.addDays(today, 3), t.addDays(today, 20)).find((d) => ![0, 6].includes(t.weekday(d)));
reqs.createLeave(staff[4].id, leaveDate, leaveDate, 'paid_full', '私用のため');

console.log('デモデータを投入しました（デモ食堂: 渋谷店・恵比寿店）。パスワードはすべて demo1234');
console.log('  本部(管理者): admin   店長(渋谷店): m001');
console.log('  アルバイト: p001〜p003(渋谷店) p004〜p005(恵比寿店)');
