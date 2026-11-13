'use strict';
const crypto = require('crypto');

/** セッション同期トークン方式の CSRF 対策 */
function csrf(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = (req.body && req.body._csrf) || req.get('x-csrf-token');
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(req.session.csrfToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(403);
    return res.render('error', { title: 'エラー', message: 'セッションの有効期限が切れたか、不正なリクエストです。ページを再読み込みしてからもう一度お試しください。' });
  }
  next();
}

/** ログイン試行の簡易レート制限（メモリ内、IP+ID 単位） */
function createLoginLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, 60 * 1000);
  timer.unref();
  return {
    key: (req, loginId) => `${req.ip}|${String(loginId || '').toLowerCase()}`,
    isBlocked(key) {
      const h = hits.get(key);
      return !!h && h.reset > Date.now() && h.count >= max;
    },
    fail(key) {
      const now = Date.now();
      const h = hits.get(key);
      if (!h || h.reset < now) hits.set(key, { count: 1, reset: now + windowMs });
      else h.count += 1;
    },
    reset(key) { hits.delete(key); },
  };
}

module.exports = { csrf, createLoginLimiter };
