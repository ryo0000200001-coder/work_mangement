'use strict';
const users = require('../services/users');

/** セッションからユーザーを読み込む */
function loadUser(req, res, next) {
  req.user = null;
  if (req.session && req.session.userId) {
    const u = users.findById(req.session.userId);
    if (u && u.active) req.user = u;
    else delete req.session.userId;
  }
  res.locals.currentUser = req.user;
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) {
    if (req.method === 'GET') req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  // 初回ログイン時などパスワード変更が必須の場合
  if (req.user.must_change_password && !['/account/password', '/logout'].includes(req.path)) {
    return res.redirect('/account/password');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403);
    return res.render('error', { title: '権限がありません', message: 'このページは管理者のみ利用できます。' });
  }
  next();
}

module.exports = { loadUser, requireLogin, requireAdmin };
