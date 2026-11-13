'use strict';
// 動作確認用のデモデータを投入する（空のDBに対してのみ実行可能）
// 使い方: npm run seed:demo
require('../src/config');
const db = require('../src/db');
const t = require('../src/lib/time');
const users = require('../src/services/users');
const att = require('../src/services/attendance');
const reqs = require('../src/services/requests');
const settingsLib = require('../src/lib/settings');

db.get();
if (users.count() > 0) {
  console.error('すでにユーザーが存在するため、デモデータは投入しません（data/ を削除してから実行してください）。');
  process.exit(1);
}

settingsLib.update({ company_name: 'デモ株式会社' });
const mk = (login_id, name, department, role, work_start = '09:00', work_end = '18:00') => {
  const id = users.create({ login_id, name, department, role, email: null, work_start, work_end, standard_minutes: null, hire_date: '2024-04-01', password: 'demo1234' }, { mustChangePassword: false });
  db.get().prepare("INSERT INTO leave_ledger(user_id, entry_date, days, kind, note) VALUES (?,?,?,'grant','2026年度 定期付与')").run(id, '2026-04-01', 11);
  return id;
};

const adminId = mk('admin', '管理 太郎', '総務部', 'admin');
const staff = [
  mk('e001', '山田 花子', '営業部', 'employee'),
  mk('e002', '佐藤 健', '開発部', 'employee', '10:00', '19:00'),
  mk('e003', '鈴木 一郎', '開発部', 'employee'),
  mk('e004', '高橋 美咲', 'サポート部', 'employee', '13:00', '22:00'),
];

// 乱数（再現性のため固定シード）
let seed = 42;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const hm = (min) => `${t.pad(Math.floor(min / 60) % 24)}:${t.pad(min % 60)}`;

const settings = settingsLib.getAll();
const today = t.today();
const start = t.addDays(today, -45);
const companyMap = att.companyHolidays(start, today);

for (const uid of [adminId, ...staff]) {
  const u = users.findById(uid);
  const sStart = t.hmToMinutes(u.work_start);
  const sEnd = t.hmToMinutes(u.work_end);
  for (const date of t.eachDate(start, t.addDays(today, -1))) {
    if (att.dayType(date, settings, companyMap).isOffDay) continue;
    if (rand() < 0.04) continue; // たまに打刻漏れ
    const inMin = sStart - 15 + Math.floor(rand() * 20);
    const outMin = sEnd + Math.floor(rand() * 150) - 5;
    const lunch = sStart + 180;
    const nextDay = (m) => m >= 24 * 60;
    att.saveRecord(uid, date, {
      clockIn: t.combine(date, hm(inMin)),
      clockOut: t.combine(date, hm(outMin), nextDay(outMin)),
      breaks: [{ start: t.combine(date, hm(lunch)), end: t.combine(date, hm(lunch + 60)) }],
      note: '',
    });
  }
}

// 退勤漏れ1件
const missDate = t.eachDate(t.addDays(today, -6), t.addDays(today, -1)).find((d) => !att.dayType(d, settings, companyMap).isOffDay);
if (missDate) db.get().prepare('UPDATE attendance SET clock_out = NULL WHERE user_id = ? AND work_date = ?').run(staff[2], missDate);

// 申請
if (missDate) {
  reqs.createCorrection(staff[2], missDate, {
    clockIn: t.combine(missDate, '08:55'), clockOut: t.combine(missDate, '18:20'),
    breaks: [{ start: t.combine(missDate, '12:00'), end: t.combine(missDate, '13:00') }], note: '',
  }, '退勤打刻を忘れました');
}
const future = t.eachDate(t.addDays(today, 3), t.addDays(today, 20)).filter((d) => !att.dayType(d, settings, companyMap).isOffDay);
reqs.createLeave(staff[0], future[0], future[1], 'paid_full', '私用のため');
reqs.createLeave(staff[1], future[3], future[3], 'paid_am', '通院');

console.log('デモデータを投入しました。');
console.log('  管理者: admin / demo1234');
console.log('  従業員: e001〜e004 / demo1234');
