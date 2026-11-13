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

  // v2: 飲食店向け（店舗・時給・シフト・店長ロール・ヘルプ勤務・売上）
  {
    foreignKeysOff: true,
    sql: `
  CREATE TABLE stores (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL,
    required_weekday  INTEGER NOT NULL DEFAULT 0,   -- 平日の必要人数（シフト表の目安）
    required_weekend  INTEGER NOT NULL DEFAULT 0,   -- 土日祝の必要人数
    active            INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  -- role に 'manager'（店長）を追加するためテーブルを再作成
  CREATE TABLE users_new (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    login_id             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name                 TEXT NOT NULL,
    email                TEXT,
    department           TEXT,
    role                 TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('admin','manager','employee')),
    password_hash        TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    active               INTEGER NOT NULL DEFAULT 1,
    work_start           TEXT NOT NULL DEFAULT '09:00',
    work_end             TEXT NOT NULL DEFAULT '18:00',
    standard_minutes     INTEGER,
    hire_date            TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    employment_type      TEXT NOT NULL DEFAULT 'full' CHECK (employment_type IN ('full','part')),
    store_id             INTEGER REFERENCES stores(id),
    hourly_wage          INTEGER,        -- 時給（円）
    commute_per_day      INTEGER,        -- 交通費（円/出勤日）
    annual_income_limit  INTEGER         -- 年収の目安上限（円）扶養内勤務の管理用
  );
  INSERT INTO users_new (id, login_id, name, email, department, role, password_hash, must_change_password, active,
    work_start, work_end, standard_minutes, hire_date, created_at, updated_at)
  SELECT id, login_id, name, email, department, role, password_hash, must_change_password, active,
    work_start, work_end, standard_minutes, hire_date, created_at, updated_at FROM users;
  DROP TABLE users;
  ALTER TABLE users_new RENAME TO users;

  ALTER TABLE attendance ADD COLUMN store_id INTEGER REFERENCES stores(id);

  -- 勤務中の店舗移動（ヘルプ）。at 以降は store_id の店舗での勤務として按分する
  CREATE TABLE store_moves (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    attendance_id INTEGER NOT NULL REFERENCES attendance(id) ON DELETE CASCADE,
    store_id      INTEGER NOT NULL REFERENCES stores(id),
    at            TEXT NOT NULL
  );
  CREATE INDEX idx_store_moves_att ON store_moves(attendance_id);

  -- 確定シフト（1人1日1件）。end_time <= start_time は翌日終了
  CREATE TABLE shifts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    store_id      INTEGER REFERENCES stores(id),
    work_date     TEXT NOT NULL,
    start_time    TEXT NOT NULL,
    end_time      TEXT NOT NULL,
    break_minutes INTEGER NOT NULL DEFAULT 0,
    note          TEXT,
    published     INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE (user_id, work_date)
  );
  CREATE INDEX idx_shifts_store_date ON shifts(store_id, work_date);

  -- スタッフの希望シフト（kind: available=出勤可 / unavailable=出勤不可）
  CREATE TABLE shift_requests (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    work_date  TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('available','unavailable')),
    start_time TEXT,
    end_time   TEXT,
    note       TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE (user_id, work_date)
  );

  -- 店舗の日別売上（人件費率の算出用）
  CREATE TABLE store_sales (
    store_id INTEGER NOT NULL REFERENCES stores(id),
    date     TEXT NOT NULL,
    amount   INTEGER NOT NULL,
    PRIMARY KEY (store_id, date)
  );
  `,
  },
];

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    const m = typeof MIGRATIONS[v] === 'string' ? { sql: MIGRATIONS[v] } : MIGRATIONS[v];
    // テーブル再作成を伴う場合は外部キー制約を一時的に無効化（トランザクション外でのみ変更可能）
    if (m.foreignKeysOff) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(m.sql);
        if (m.foreignKeysOff) {
          const bad = db.pragma('foreign_key_check');
          if (bad.length) throw new Error(`foreign key check failed: ${JSON.stringify(bad)}`);
        }
        db.pragma(`user_version = ${v + 1}`);
      })();
    } finally {
      if (m.foreignKeysOff) db.pragma('foreign_keys = ON');
    }
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
