'use strict';
const db = require('../db');
const { str } = require('../lib/forms');

function list({ includeInactive = false } = {}) {
  return db.get().prepare(`SELECT * FROM stores ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY active DESC, id`).all();
}

function get(id) {
  return db.get().prepare('SELECT * FROM stores WHERE id = ?').get(Number(id)) || null;
}

function parseForm(body) {
  const errors = [];
  const v = {
    name: str(body.name).slice(0, 50),
    required_weekday: Number(body.required_weekday || 0),
    required_weekend: Number(body.required_weekend || 0),
    active: body.active === '1' ? 1 : 0,
  };
  if (!v.name) errors.push('店舗名を入力してください。');
  for (const k of ['required_weekday', 'required_weekend']) {
    if (!Number.isInteger(v[k]) || v[k] < 0 || v[k] > 200) errors.push('必要人数は 0〜200 の整数で入力してください。');
  }
  return { errors, values: v };
}

function create(v) {
  return db.get().prepare('INSERT INTO stores(name, required_weekday, required_weekend) VALUES (?,?,?)')
    .run(v.name, v.required_weekday, v.required_weekend).lastInsertRowid;
}

function update(id, v) {
  db.get().prepare('UPDATE stores SET name = ?, required_weekday = ?, required_weekend = ?, active = ? WHERE id = ?')
    .run(v.name, v.required_weekday, v.required_weekend, v.active, id);
}

/** id -> 店舗名 の Map（無効店舗も含む） */
function nameMap() {
  return new Map(list({ includeInactive: true }).map((s) => [s.id, s.name]));
}

module.exports = { list, get, parseForm, create, update, nameMap };
