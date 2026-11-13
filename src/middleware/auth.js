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

/** 管理者または店長 */
function requireManager(req, res, next) {
  if (!req.user || !['admin', 'manager'].includes(req.user.role)) {
    res.status(403);
    return res.render('error', { title: '権限がありません', message: 'このページは管理者・店長のみ利用できます。' });
  }
  next();
}

/** 店長は自店舗所属のスタッフのみ扱える。管理者は全員 */
function canManage(actor, target) {
  if (!actor || !target) return false;
  if (actor.role === 'admin') return true;
  return actor.role === 'manager' && !!actor.store_id && target.store_id === actor.store_id;
}

/** 店長の場合は担当店舗ID、管理者は null（全店舗） */
function scopeStoreId(actor) {
  return actor && actor.role === 'manager' ? actor.store_id : null;
}

module.exports = { loadUser, requireLogin, requireAdmin, requireManager, canManage, scopeStoreId };
