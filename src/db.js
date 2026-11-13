'use strict';
const Database = require('better-sqlite3');
const config = require('./config');

/**
 * スキーマ定義。追加変更は MIGRATIONS の末尾に追記していく（既存の要素は書き換えない）。
 * PRAGMA user_version で適用済みのバージョンを管理する。
 */
const MIGRATIONS = [
  // v1: 初期スキーマ
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE users (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    login_id             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name                 TEXT NOT NULL,
    email                TEXT,
    department           TEXT,
    role                 TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('admin','employee')),
    password_hash        TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    active               INTEGER NOT NULL DEFAULT 1,
    work_start           TEXT NOT NULL DEFAULT '09:00',
    work_end             TEXT NOT NULL DEFAULT '18:00',
    standard_minutes     INTEGER,           -- NULL の場合は会社設定の所定労働時間
    hire_date            TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  -- 1日1レコード。work_date は出勤した日（日跨ぎ勤務でも出勤日に帰属）
  CREATE TABLE attendance (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    work_date  TEXT NOT NULL,               -- YYYY-MM-DD
    clock_in   TEXT,                        -- YYYY-MM-DDTHH:MM:SS (JST)
    clock_out  TEXT,
    note       TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE (user_id, work_date)
  );
  CREATE INDEX idx_attendance_open ON attendance(user_id, clock_out);

  CREATE TABLE breaks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    attendance_id INTEGER NOT NULL REFERENCES attendance(id) ON DELETE CASCADE,
    start_at      TEXT NOT NULL,
    end_at        TEXT
  );
  CREATE INDEX idx_breaks_att ON breaks(attendance_id);

  -- 申請（打刻修正 / 休暇）
  CREATE TABLE requests (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL REFERENCES users(id),
    type           TEXT NOT NULL CHECK (type IN ('correction','leave')),
    status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
    start_date     TEXT NOT NULL,
    end_date       TEXT NOT NULL,
    payload        TEXT NOT NULL DEFAULT '{}',  -- JSON
    reason         TEXT,
    reviewer_id    INTEGER REFERENCES users(id),
    review_comment TEXT,
    reviewed_at    TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX idx_requests_status ON requests(status, created_at);
  CREATE INDEX idx_requests_user ON requests(user_id, created_at);

  -- 承認済みの休暇（日単位）
  CREATE TABLE leaves (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    leave_date TEXT NOT NULL,
    leave_type TEXT NOT NULL,
    request_id INTEGER REFERENCES requests(id),
    UNIQUE (user_id, leave_date)
  );

  -- 有給休暇の付与・取得台帳（残日数 = days の合計）
  CREATE TABLE leave_ledger (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    entry_date  TEXT NOT NULL,
    days        REAL NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('grant','use','adjust','restore')),
    note        TEXT,
    request_id  INTEGER REFERENCES requests(id),
    created_by  INTEGER REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX idx_ledger_user ON leave_ledger(user_id);

  CREATE TABLE company_holidays (
    date TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );

  CREATE TABLE sessions (
    sid     TEXT PRIMARY KEY,
    sess    TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_expires ON sessions(expires);

  CREATE TABLE audit_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id),
    action      TEXT NOT NULL,
    target_type TEXT,
    target_id   INTEGER,
    detail      TEXT,
    ip          TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX idx_audit_created ON audit_logs(created_at);
  `,
];

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

function open(file = config.DB_FILE) {
  if (file !== ':memory:') config.ensureDataDir();
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

let instance = null;
function get() {
  if (!instance) instance = open();
  return instance;
}
function set(db) {
  instance = db;
}

module.exports = { open, get, set, migrate, MIGRATIONS };
