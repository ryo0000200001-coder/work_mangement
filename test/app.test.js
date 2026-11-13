'use strict';
require('../src/config');
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');

db.set(db.open(':memory:'));
const { createApp } = require('../src/app');
const t = require('../src/lib/time');

let server;
let base;

test.before(async () => {
  const app = createApp({ sessionSecret: 'test-secret' });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

/** Cookie と CSRF トークンを保持する簡易クライアント */
function client() {
  let cookie = '';
  let csrf = '';
  const remember = (res) => {
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of sc) if (c.startsWith('kintai.sid=')) cookie = c.split(';')[0];
  };
  const grabCsrf = (html) => {
    const m = /name="_csrf" value="([^"]+)"/.exec(html);
    if (m) csrf = m[1];
  };
  return {
    async get(path) {
      const res = await fetch(base + path, { headers: { cookie }, redirect: 'manual' });
      remember(res);
      const body = await res.text();
      grabCsrf(body);
      return { status: res.status, body, location: res.headers.get('location'), headers: res.headers };
    },
    async post(path, data = {}) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries({ _csrf: csrf, ...data })) {
        for (const x of [].concat(v)) params.append(k, x);
      }
      const res = await fetch(base + path, {
        method: 'POST', body: params, redirect: 'manual',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      });
      remember(res);
      const body = await res.text();
      grabCsrf(body);
      return { status: res.status, body, location: res.headers.get('location') };
    },
    setCsrf(v) { csrf = v; },
  };
}

const admin = client();
const emp = client();

test('初期セットアップ → 管理者作成', async () => {
  let r = await admin.get('/');
  assert.equal(r.status, 302);
  assert.equal(r.location, '/setup');
  r = await admin.get('/setup');
  assert.equal(r.status, 200);
  r = await admin.post('/setup', { company_name: 'テスト社', name: '管理者', login_id: 'admin', password: 'admin1234', password_confirm: 'admin1234' });
  assert.equal(r.status, 302);
  assert.equal(r.location, '/admin');
  r = await admin.get('/admin');
  assert.equal(r.status, 200);
  assert.match(r.body, /テスト社 勤怠管理/);
  // セットアップは2回目以降不可
  r = await admin.get('/setup');
  assert.equal(r.location, '/login');
});

test('CSRF トークンなしの POST は拒否', async () => {
  const c = client();
  await c.get('/login');
  c.setCsrf('invalid');
  const r = await c.post('/login', { login_id: 'admin', password: 'admin1234' });
  assert.equal(r.status, 403);
});

test('従業員登録 → 初回ログインでパスワード変更を強制', async () => {
  await admin.get('/admin/users/new');
  let r = await admin.post('/admin/users', { login_id: 'e001', name: '山田 花子', department: '営業', role: 'employee', work_start: '09:00', work_end: '18:00', password: 'temp1234' });
  assert.equal(r.status, 302);
  // 重複ID
  await admin.get('/admin/users/new');
  r = await admin.post('/admin/users', { login_id: 'E001', name: 'x', work_start: '09:00', work_end: '18:00', password: 'temp1234' });
  assert.equal(r.status, 400);

  await emp.get('/login');
  r = await emp.post('/login', { login_id: 'e001', password: 'wrong' });
  assert.equal(r.status, 401);
  r = await emp.post('/login', { login_id: 'e001', password: 'temp1234' });
  assert.equal(r.location, '/account/password');
  r = await emp.get('/');
  assert.equal(r.location, '/account/password');
  await emp.get('/account/password');
  r = await emp.post('/account/password', { current_password: 'temp1234', new_password: 'newpass123', new_password_confirm: 'newpass123' });
  assert.equal(r.status, 302);
  r = await emp.get('/');
  assert.equal(r.status, 200);
  assert.match(r.body, /未出勤/);
});

test('一般ユーザーは管理画面にアクセスできない', async () => {
  const r = await emp.get('/admin');
  assert.equal(r.status, 403);
});

test('打刻: 出勤 → 休憩 → 退勤', async () => {
  await emp.get('/');
  let r = await emp.post('/punch', { action: 'clock_out' });
  r = await emp.get('/');
  assert.match(r.body, /出勤していないため退勤できません/);
  await emp.post('/punch', { action: 'clock_in' });
  r = await emp.get('/');
  assert.match(r.body, /勤務中/);
  await emp.post('/punch', { action: 'break_start' });
  r = await emp.get('/');
  assert.match(r.body, /休憩中/);
  await emp.post('/punch', { action: 'break_end' });
  await emp.get('/');
  await emp.post('/punch', { action: 'clock_out' });
  r = await emp.get('/');
  assert.match(r.body, /退勤済み/);
  // 二重出勤は不可
  await emp.post('/punch', { action: 'clock_in' });
  r = await emp.get('/');
  assert.match(r.body, /すでに退勤済み/);
});

test('打刻修正申請 → 承認で勤務表に反映', async () => {
  const date = t.addDays(t.today(), -7);
  await emp.get(`/requests/correction/new?date=${date}`);
  let r = await emp.post('/requests/correction', { date, clock_in: '09:00', clock_out: '18:30', break_start: ['12:00'], break_end: ['13:00'], reason: '打刻忘れ' });
  assert.equal(r.status, 302);
  // 同日の重複申請は不可
  await emp.get(`/requests/correction/new?date=${date}`);
  r = await emp.post('/requests/correction', { date, clock_in: '09:00', clock_out: '18:30', reason: '重複' });
  assert.equal(r.status, 400);

  r = await admin.get('/admin/requests');
  assert.match(r.body, /打刻忘れ/);
  const id = /\/admin\/requests\/(\d+)\/approve/.exec(r.body)[1];
  r = await admin.post(`/admin/requests/${id}/approve`, { comment: 'OK' });
  assert.equal(r.status, 302);

  r = await emp.get(`/timesheet?month=${t.monthOf(date)}`);
  assert.match(r.body, /18:30/);
  assert.match(r.body, /8:30/);
});

test('休暇申請 → 承認で有給残が減る / 残不足はエラー', async () => {
  // 有給付与
  await admin.get('/admin/leave?user=2');
  let r = await admin.post('/admin/leave/grant', { user_id: '2', days: '10', note: '付与' });
  assert.equal(r.status, 302);

  // 次の平日を探す
  let d = t.addDays(t.today(), 1);
  const { holidayName } = require('../src/lib/holidays');
  while ([0, 6].includes(t.weekday(d)) || holidayName(d)) d = t.addDays(d, 1);

  await emp.get('/requests/leave/new');
  r = await emp.post('/requests/leave', { leave_type: 'paid_full', start_date: d, end_date: d, reason: '私用' });
  assert.equal(r.status, 302);
  await emp.get('/requests/leave/new');
  r = await emp.post('/requests/leave', { leave_type: 'paid_full', start_date: t.addDays(d, 7), end_date: t.addDays(d, 30), reason: '長期' });
  assert.equal(r.status, 400);
  assert.match(r.body, /残日数が不足/);

  r = await admin.get('/admin/requests');
  const id = /\/admin\/requests\/(\d+)\/approve/.exec(r.body)[1];
  await admin.post(`/admin/requests/${id}/approve`, {});
  r = await emp.get('/requests');
  assert.match(r.body, /残日数: <strong>9日/);

  // 承認後の取消で残日数が戻る
  await admin.get('/admin/requests?status=approved');
  r = await admin.post(`/admin/requests/${id}/revoke`, {});
  r = await emp.get('/requests');
  assert.match(r.body, /残日数: <strong>10日/);
});

test('管理者による勤怠修正と CSV 出力', async () => {
  const date = t.addDays(t.today(), -3);
  await admin.get(`/admin/attendance/2/${date}`);
  let r = await admin.post(`/admin/attendance/2/${date}`, { clock_in: '22:00', clock_out: '06:00', clock_out_next_day: '1', break_start: ['02:00'], break_end: ['03:00'], note: '夜間対応' });
  assert.equal(r.status, 302);
  r = await admin.get(`/admin/export/detail.csv?user=2&month=${t.monthOf(date)}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.body, /^社員ID,氏名,日付/);
  assert.match(r.body, new RegExp(`${date},.*,22:00,翌06:00,1:00,7:00,,6:00,`));
  r = await admin.get(`/admin/export/summary.csv?month=${t.monthOf(date)}`);
  assert.match(r.body, /山田 花子/);
  r = await admin.get('/admin/audit');
  assert.match(r.body, /勤怠修正/);
});

test('CSV: BOM付き・数式インジェクション対策', () => {
  const csv = require('../src/lib/csv');
  const out = csv.toCsv([['a', '=SUM(A1)', 'x,y', '-1:30', '-5']]);
  assert.ok(out.startsWith('\uFEFF'));
  assert.equal(out, "\uFEFFa,'=SUM(A1),\"x,y\",-1:30,-5\r\n");
});

test('不正な入力値の検証', async () => {
  const date = t.addDays(t.today(), -2);
  await admin.get(`/admin/attendance/2/${date}`);
  const r = await admin.post(`/admin/attendance/2/${date}`, { clock_in: '18:00', clock_out: '09:00' });
  assert.equal(r.status, 400);
  assert.match(r.body, /退勤時刻は出勤時刻より後/);
});

test('ログアウト', async () => {
  await emp.get('/');
  await emp.post('/logout');
  const r = await emp.get('/');
  assert.equal(r.location, '/login');
});

// ---- 飲食店向け: 店舗・シフト・店長権限・ヘルプ・人件費 ----
const dbh = () => db.get();

async function newUserClient(loginId, tempPw) {
  const c = client();
  await c.get('/login');
  await c.post('/login', { login_id: loginId, password: tempPw });
  await c.get('/account/password');
  await c.post('/account/password', { current_password: tempPw, new_password: 'pass1234x', new_password_confirm: 'pass1234x' });
  return c;
}

const ctx = {};

test('店舗とスタッフ（店長・アルバイト）の登録', async () => {
  await admin.get('/admin/stores');
  let r = await admin.post('/admin/stores', { name: 'A店', required_weekday: '2', required_weekend: '3' });
  assert.equal(r.status, 302);
  await admin.get('/admin/stores');
  await admin.post('/admin/stores', { name: 'B店', required_weekday: '1', required_weekend: '1' });
  const stores = dbh().prepare('SELECT id, name FROM stores ORDER BY id').all();
  ctx.A = stores[0].id; ctx.B = stores[1].id;

  const base = { work_start: '10:00', work_end: '15:00', password: 'temp1234' };
  await admin.get('/admin/users/new');
  // 店長は店舗必須
  r = await admin.post('/admin/users', { ...base, login_id: 'mgr', name: '店長', role: 'manager', employment_type: 'full' });
  assert.equal(r.status, 400);
  r = await admin.post('/admin/users', { ...base, login_id: 'mgr', name: '店長', role: 'manager', employment_type: 'full', store_id: String(ctx.A) });
  assert.equal(r.status, 302);
  await admin.get('/admin/users/new');
  r = await admin.post('/admin/users', { ...base, login_id: 'pa', name: 'バイトA', employment_type: 'part', store_id: String(ctx.A), hourly_wage: '1,200', commute_per_day: '300', annual_income_limit: '1230000' });
  assert.equal(r.status, 302);
  await admin.get('/admin/users/new');
  await admin.post('/admin/users', { ...base, login_id: 'pb', name: 'バイトB', employment_type: 'part', store_id: String(ctx.B), hourly_wage: '1100' });
  const u = dbh().prepare("SELECT * FROM users WHERE login_id = 'pa'").get();
  assert.equal(u.hourly_wage, 1200);
  assert.equal(u.employment_type, 'part');
  ctx.pa = u.id;
  ctx.pb = dbh().prepare("SELECT id FROM users WHERE login_id = 'pb'").get().id;
  ctx.mgr = await newUserClient('mgr', 'temp1234');
  ctx.paC = await newUserClient('pa', 'temp1234');
  ctx.pbC = await newUserClient('pb', 'temp1234');
});

test('希望シフト提出 → 店長が下書き作成 → 公開でスタッフに表示', async () => {
  const d1 = t.addDays(t.today(), 3);
  const d2 = t.addDays(t.today(), 4);
  await ctx.paC.get('/shifts');
  let r = await ctx.paC.post('/shifts/requests', {
    start: t.today(), date: [d1, d2], kind: ['available', 'unavailable'], start_time: ['17:00', ''], end_time: ['22:00', ''], note: ['', '学校'],
  });
  assert.equal(r.status, 302);
  // 不正な時間帯
  await ctx.paC.get('/shifts');
  await ctx.paC.post('/shifts/requests', { start: t.today(), date: [d1], kind: ['available'], start_time: ['17:00'], end_time: [''], note: [''] });
  r = await ctx.paC.get('/shifts');
  assert.match(r.body, /時間帯を正しく入力/);

  r = await ctx.mgr.get(`/admin/shifts?start=${d1}`);
  assert.equal(r.status, 200);
  assert.match(r.body, /バイトA/);
  assert.doesNotMatch(r.body, /<th class="sg-name" scope="row">\s*バイトB/); // 他店舗スタッフは行に出ない
  await ctx.mgr.post('/admin/shifts/autofill', { start: d1, days: '7' });
  let sh = dbh().prepare('SELECT * FROM shifts WHERE user_id = ? AND work_date = ?').get(ctx.pa, d1);
  assert.equal(sh.start_time, '17:00');
  assert.equal(sh.published, 0);
  assert.equal(sh.store_id, ctx.A);
  assert.equal(dbh().prepare('SELECT COUNT(*) c FROM shifts WHERE user_id = ? AND work_date = ?').get(ctx.pa, d2).c, 0);

  r = await ctx.paC.get('/');
  assert.doesNotMatch(r.body, /17:00〜22:00/); // 下書きは見えない
  await ctx.mgr.get(`/admin/shifts?start=${d1}`);
  await ctx.mgr.post('/admin/shifts/publish', { start: d1, days: '7' });
  r = await ctx.paC.get('/');
  assert.match(r.body, /17:00〜22:00/);

  // 公開済みの日の希望は変更できない
  await ctx.paC.get('/shifts');
  await ctx.paC.post('/shifts/requests', { start: t.today(), date: [d1], kind: ['unavailable'], start_time: [''], end_time: [''], note: [''] });
  assert.equal(dbh().prepare('SELECT kind FROM shift_requests WHERE user_id = ? AND work_date = ?').get(ctx.pa, d1).kind, 'available');

  // セル編集（休憩は空欄で自動）・削除
  await ctx.mgr.get(`/admin/shifts?start=${d1}`);
  await ctx.mgr.post('/admin/shifts/save', { start: d1, days: '7', user_id: String(ctx.pa), date: d2, start_time: '10:00', end_time: '19:00', break_minutes: '' });
  sh = dbh().prepare('SELECT * FROM shifts WHERE user_id = ? AND work_date = ?').get(ctx.pa, d2);
  assert.equal(sh.break_minutes, 60);
  await ctx.mgr.post('/admin/shifts/save', { start: d1, days: '7', user_id: String(ctx.pa), date: d2, delete: '1' });
  assert.equal(shiftsCount(ctx.pa, d2), 0);
});

function shiftsCount(uid, date) {
  return dbh().prepare('SELECT COUNT(*) c FROM shifts WHERE user_id = ? AND work_date = ?').get(uid, date).c;
}

test('店長は担当店舗のスタッフのみ管理できる', async () => {
  let r = await ctx.mgr.get('/admin/users');
  assert.equal(r.status, 403);
  r = await ctx.mgr.get('/admin/settings');
  assert.equal(r.status, 403);
  r = await ctx.mgr.get(`/admin/timesheets?user=${ctx.pb}`);
  assert.doesNotMatch(r.body, /バイトB/);
  r = await ctx.mgr.get(`/admin/attendance/${ctx.pb}/${t.today()}`);
  assert.equal(r.status, 404);
  r = await ctx.mgr.get(`/admin/timesheets?user=${ctx.pa}`);
  assert.match(r.body, /バイトA/);

  // 他店舗スタッフの申請は承認できない
  const date = t.addDays(t.today(), -1);
  await ctx.pbC.get(`/requests/correction/new?date=${date}`);
  await ctx.pbC.post('/requests/correction', { date, clock_in: '10:00', clock_out: '15:00', reason: 'test' });
  const reqId = dbh().prepare('SELECT id FROM requests WHERE user_id = ? ORDER BY id DESC').get(ctx.pb).id;
  r = await ctx.mgr.get('/admin/requests');
  assert.doesNotMatch(r.body, /バイトB/);
  await ctx.mgr.post(`/admin/requests/${reqId}/approve`, {});
  assert.equal(dbh().prepare('SELECT status FROM requests WHERE id = ?').get(reqId).status, 'pending');
});

test('ヘルプ勤務: 出勤店舗の選択と店舗移動、人件費への按分', async () => {
  let r = await ctx.paC.get('/');
  assert.match(r.body, /出勤する店舗/);
  await ctx.paC.post('/punch', { action: 'clock_in', store_id: String(ctx.A) });
  await ctx.paC.get('/');
  await ctx.paC.post('/punch', { action: 'move', store_id: String(ctx.A) });
  r = await ctx.paC.get('/');
  assert.match(r.body, /すでにその店舗で勤務中/);
  await ctx.paC.post('/punch', { action: 'move', store_id: String(ctx.B) });
  r = await ctx.paC.get('/');
  assert.match(r.body, /<span class="tag tag-store">B店<\/span>/);
  const rec = dbh().prepare('SELECT * FROM attendance WHERE user_id = ? ORDER BY id DESC').get(ctx.pa);
  assert.equal(rec.store_id, ctx.A);
  assert.equal(dbh().prepare('SELECT store_id FROM store_moves WHERE attendance_id = ?').get(rec.id).store_id, ctx.B);
  await ctx.paC.post('/punch', { action: 'clock_out' });

  // 過去日の実績（A店 2h → B店 3h）で人件費を検証
  const date = t.addDays(t.today(), -2);
  const id = dbh().prepare('INSERT INTO attendance(user_id, work_date, clock_in, clock_out, store_id) VALUES (?,?,?,?,?)')
    .run(ctx.pa, date, `${date}T10:00:00`, `${date}T15:00:00`, ctx.A).lastInsertRowid;
  dbh().prepare('INSERT INTO store_moves(attendance_id, store_id, at) VALUES (?,?,?)').run(id, ctx.B, `${date}T12:00:00`);
  const labor = require('../src/services/labor');
  const settings = require('../src/lib/settings').getAll();
  const a = labor.storeDaily(ctx.A, date, date, settings).rows[0];
  const b = labor.storeDaily(ctx.B, date, date, settings).rows[0];
  assert.equal(a.actualMinutes, 120);
  assert.equal(b.actualMinutes, 180);
  assert.equal(a.actual + b.actual, 1200 * 5 + 300); // 時給×5h + 交通費
  // 売上入力 → 人件費率
  r = await ctx.mgr.get('/admin/labor');
  assert.equal(r.status, 200);
  await ctx.mgr.post('/admin/labor/sales', { date: [date], amount: ['24,000'] });
  const a2 = labor.storeDaily(ctx.A, date, date, settings).rows[0];
  assert.equal(a2.sales, 24000);
  assert.ok(Math.abs(a2.ratio - (a2.actual / 24000) * 100) < 1e-9);
});

test('アルバイトのダッシュボードに概算給与と年収目安が表示される', async () => {
  const r = await ctx.paC.get('/');
  assert.match(r.body, /今月の概算給与/);
  assert.match(r.body, /目安 1,230,000円/);
});
