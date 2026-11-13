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
