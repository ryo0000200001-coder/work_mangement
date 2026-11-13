'use strict';
const db = require('../db');

const DEFAULTS = {
  company_name: '',
  standard_minutes: 480,       // 所定労働時間（分/日）
  default_work_start: '09:00', // 新規ユーザーの始業時刻
  default_work_end: '18:00',   // 新規ユーザーの終業時刻
  rounding_in: 1,              // 出勤打刻の丸め単位（分, 切り上げ）
  rounding_out: 1,             // 退勤打刻の丸め単位（分, 切り捨て）
  closing_day: 0,              // 締め日（0 = 月末）
  weekly_holidays: [0, 6],     // 週休日（0=日 ... 6=土）
  auto_break: true,            // 休憩不足時に法定休憩を自動控除
};

function serialize(key, value) {
  if (Array.isArray(DEFAULTS[key])) return value.join(',');
  if (typeof DEFAULTS[key] === 'boolean') return value ? '1' : '0';
  return String(value);
}

function deserialize(key, raw) {
  const def = DEFAULTS[key];
  if (Array.isArray(def)) return raw === '' ? [] : raw.split(',').map(Number);
  if (typeof def === 'boolean') return raw === '1';
  if (typeof def === 'number') return Number(raw);
  return raw;
}

function getAll() {
  const rows = db.get().prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULTS, weekly_holidays: [...DEFAULTS.weekly_holidays] };
  for (const r of rows) if (r.key in DEFAULTS) out[r.key] = deserialize(r.key, r.value);
  return out;
}

function update(values) {
  const stmt = db.get().prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  db.get().transaction(() => {
    for (const [k, v] of Object.entries(values)) {
      if (!(k in DEFAULTS)) continue;
      stmt.run(k, serialize(k, v));
    }
  })();
}

module.exports = { DEFAULTS, getAll, update };
