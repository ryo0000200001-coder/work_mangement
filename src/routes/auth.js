'use strict';
const express = require('express');
const users = require('../services/users');
const settingsLib = require('../lib/settings');
const audit = require('../lib/audit');
const { str } = require('../lib/forms');
const { requireLogin } = require('../middleware/auth');
const { createLoginLimiter } = require('../middleware/security');

const router = express.Router();
const limiter = createLoginLimiter();

function regenerate(req) {
  return new Promise((resolve, reject) => {
    const csrfToken = req.session.csrfToken;
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.csrfToken = csrfToken;
      resolve();
    });
  });
}

// ---- 初期セットアップ（ユーザーが1人もいない場合のみ） ----
router.get('/setup', (req, res) => {
  if (users.count() > 0) return res.redirect('/login');
  res.render('setup', { title: '初期セットアップ', values: {}, errors: [] });
});

router.post('/setup', async (req, res, next) => {
  try {
    if (users.count() > 0) return res.redirect('/login');
    const companyName = str(req.body.company_name).slice(0, 100);
    const { errors, values } = users.parseUserForm(
      { ...req.body, role: 'admin', work_start: '09:00', work_end: '18:00' },
      { isNew: true }
    );
    if (req.body.password !== req.body.password_confirm) errors.push('確認用パスワードが一致しません。');
    if (errors.length) return res.status(400).render('setup', { title: '初期セットアップ', values: req.body, errors });
    values.role = 'admin';
    const id = users.create(values, { mustChangePassword: false });
    if (companyName) settingsLib.update({ company_name: companyName });
    await regenerate(req);
    req.session.userId = id;
    req.user = users.findById(id);
    audit.log(req, 'setup.completed', 'user', id);
    req.flash('success', '初期セットアップが完了しました。「管理 > 従業員」から従業員を登録してください。');
    res.redirect('/admin');
  } catch (e) { next(e); }
});

// ---- ログイン ----
router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: 'ログイン', loginId: '', error: null });
});

router.post('/login', async (req, res, next) => {
  try {
    const loginId = str(req.body.login_id);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const key = limiter.key(req, loginId);
    if (limiter.isBlocked(key)) {
      return res.status(429).render('login', { title: 'ログイン', loginId, error: 'ログイン試行回数が上限に達しました。15分ほど待ってから再度お試しください。' });
    }
    const user = users.findByLoginId(loginId);
    if (!user || !user.active || !users.verifyPassword(user, password)) {
      limiter.fail(key);
      audit.log(req, 'auth.login_failed', 'user', user ? user.id : null, { login_id: loginId });
      return res.status(401).render('login', { title: 'ログイン', loginId, error: 'ログインIDまたはパスワードが正しくありません。' });
    }
    limiter.reset(key);
    const returnTo = req.session.returnTo;
    await regenerate(req);
    req.session.userId = user.id;
    req.user = user;
    audit.log(req, 'auth.login', 'user', user.id);
    const safeReturn = typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
    res.redirect(user.must_change_password ? '/account/password' : safeReturn);
  } catch (e) { next(e); }
});

router.post('/logout', (req, res, next) => {
  if (req.user) audit.log(req, 'auth.logout', 'user', req.user.id);
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('kintai.sid');
    res.redirect('/login');
  });
});

// ---- パスワード変更 ----
router.get('/account/password', requireLogin, (req, res) => {
  res.render('password', { title: 'パスワード変更', errors: [] });
});

router.post('/account/password', requireLogin, (req, res) => {
  const { current_password: cur, new_password: pw, new_password_confirm: pw2 } = req.body;
  const errors = [];
  if (!users.verifyPassword(req.user, typeof cur === 'string' ? cur : '')) errors.push('現在のパスワードが正しくありません。');
  const pe = users.validatePassword(pw);
  if (pe) errors.push(pe);
  if (pw !== pw2) errors.push('確認用パスワードが一致しません。');
  if (!pe && cur === pw) errors.push('現在と異なるパスワードを設定してください。');
  if (errors.length) return res.status(400).render('password', { title: 'パスワード変更', errors });
  users.setPassword(req.user.id, pw);
  audit.log(req, 'auth.password_changed', 'user', req.user.id);
  req.flash('success', 'パスワードを変更しました。');
  res.redirect('/');
});

module.exports = router;
