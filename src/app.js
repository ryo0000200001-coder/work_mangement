'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');

const config = require('./config');
const db = require('./db');
const SqliteStore = require('./lib/session-store');
const t = require('./lib/time');
const { LEAVE_TYPES } = require('./lib/calc');
const settingsLib = require('./lib/settings');
const { csrf } = require('./middleware/security');
const { loadUser } = require('./middleware/auth');
const requestsSvc = require('./services/requests');
const usersSvc = require('./services/users');

function createApp({ sessionSecret = config.loadSessionSecret() } = {}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.ROOT, 'views'));
  app.disable('x-powered-by');
  if (config.TRUST_PROXY) app.set('trust proxy', 1);
  // 早い段階でエラー画面を描画する場合に備えた既定値
  Object.assign(app.locals, {
    appName: '勤怠管理', title: '', currentUser: null, flash: [], currentPath: '', pendingCount: 0, csrfToken: '',
  });

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        // HTTP で社内運用する場合に備え、upgrade-insecure-requests は COOKIE_SECURE 時のみ
        'upgrade-insecure-requests': config.COOKIE_SECURE ? [] : null,
      },
    },
    strictTransportSecurity: config.COOKIE_SECURE,
  }));

  app.use('/static', express.static(path.join(config.ROOT, 'public'), { maxAge: config.NODE_ENV === 'production' ? '1d' : 0 }));
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  app.use(session({
    name: 'kintai.sid',
    secret: sessionSecret,
    store: new SqliteStore(db.get()),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.COOKIE_SECURE,
      maxAge: 12 * 3600 * 1000, // 最終操作から12時間
    },
  }));

  // フラッシュメッセージ
  app.use((req, res, next) => {
    req.flash = (type, message) => {
      req.session.flash = req.session.flash || [];
      req.session.flash.push({ type, message });
    };
    res.locals.flash = req.session.flash || [];
    delete req.session.flash;
    next();
  });

  app.use(csrf);
  app.use(loadUser);

  // ビュー共通の値
  app.use((req, res, next) => {
    const settings = settingsLib.getAll();
    req.settings = settings;
    Object.assign(res.locals, {
      t,
      settings,
      LEAVE_TYPES,
      STATUS_LABELS: requestsSvc.STATUS_LABELS,
      TYPE_LABELS: requestsSvc.TYPE_LABELS,
      appName: settings.company_name ? `${settings.company_name} 勤怠管理` : '勤怠管理',
      currentPath: req.path,
      pendingCount: req.user && req.user.role === 'admin' ? requestsSvc.countPending() : 0,
      title: '',
    });
    next();
  });

  // 初期セットアップ未完了ならセットアップ画面へ
  app.use((req, res, next) => {
    if (req.path !== '/setup' && usersSvc.count() === 0) return res.redirect('/setup');
    next();
  });

  app.use(require('./routes/auth'));
  app.use(require('./routes/employee'));
  app.use('/admin', require('./routes/admin'));

  app.use((req, res) => {
    res.status(404).render('error', { title: 'ページが見つかりません', message: 'お探しのページは存在しないか、移動した可能性があります。' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', { title: 'エラー', message: 'サーバーでエラーが発生しました。時間をおいて再度お試しください。' });
  });

  return app;
}

module.exports = { createApp };
