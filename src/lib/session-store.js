'use strict';
const session = require('express-session');

/** express-session 用の SQLite セッションストア */
class SqliteStore extends session.Store {
  constructor(db, { ttlMs = 12 * 3600 * 1000, cleanupIntervalMs = 15 * 60 * 1000 } = {}) {
    super();
    this.db = db;
    this.ttlMs = ttlMs;
    this.stmts = {
      get: db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?'),
      set: db.prepare('INSERT INTO sessions(sid, sess, expires) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires'),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
      cleanup: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
    };
    this.timer = setInterval(() => this.stmts.cleanup.run(Date.now()), cleanupIntervalMs);
    this.timer.unref();
  }

  expiresOf(sess) {
    const exp = sess && sess.cookie && sess.cookie.expires;
    return exp ? new Date(exp).getTime() : Date.now() + this.ttlMs;
  }

  get(sid, cb) {
    try {
      const row = this.stmts.get.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb) {
    try { this.stmts.set.run(sid, JSON.stringify(sess), this.expiresOf(sess)); cb && cb(null); } catch (e) { cb && cb(e); }
  }

  destroy(sid, cb) {
    try { this.stmts.destroy.run(sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }

  touch(sid, sess, cb) {
    try { this.stmts.touch.run(this.expiresOf(sess), sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
}

module.exports = SqliteStore;
