'use strict';
// 日付・時刻ユーティリティ。すべてローカル時刻（TZ=Asia/Tokyo）で扱う。
// 日時は 'YYYY-MM-DDTHH:MM:SS' 形式の文字列で DB に保存する。

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

const pad = (n, w = 2) => String(n).padStart(w, '0');

function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toLocalISO(d) {
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

function isValidDate(s) {
  const m = DATE_RE.exec(s || '');
  if (!m) return false;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3];
}

function isValidTime(s) {
  return TIME_RE.test(s || '');
}

function isValidMonth(s) {
  return MONTH_RE.test(s || '');
}

/** 'YYYY-MM-DD' -> Date(ローカル0時) */
function parseDate(s) {
  const m = DATE_RE.exec(s);
  if (!m) throw new Error(`invalid date: ${s}`);
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

/** 'YYYY-MM-DDTHH:MM[:SS]' -> Date */
function parseDateTime(s) {
  if (s == null) return null;
  const m = DATETIME_RE.exec(s);
  if (!m) throw new Error(`invalid datetime: ${s}`);
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
}

function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

function weekday(dateStr) {
  return parseDate(dateStr).getDay();
}

function weekdayLabel(dateStr) {
  return WEEKDAYS[weekday(dateStr)];
}

/** 日付 + 'HH:MM' (+翌日フラグ) -> 'YYYY-MM-DDTHH:MM:00' */
function combine(dateStr, hm, nextDay = false) {
  const d = nextDay ? addDays(dateStr, 1) : dateStr;
  return `${d}T${hm}:00`;
}

/** 分 -> 'H:MM'（0 は空文字 or '0:00'） */
function fmtMinutes(min, { blankZero = false } = {}) {
  if (min == null) return '';
  if (blankZero && min === 0) return '';
  const sign = min < 0 ? '-' : '';
  const a = Math.abs(Math.round(min));
  return `${sign}${Math.floor(a / 60)}:${pad(a % 60)}`;
}

/** 日時文字列 -> 'HH:MM'。基準日より後の日付なら '翌' などを付ける */
function fmtClock(dt, baseDate) {
  if (!dt) return '';
  const date = dt.slice(0, 10);
  const hm = dt.slice(11, 16);
  if (baseDate && date !== baseDate) {
    const diff = Math.round((parseDate(date) - parseDate(baseDate)) / 86400000);
    if (diff === 1) return `翌${hm}`;
    if (diff > 1) return `${diff}日後${hm}`;
    if (diff < 0) return `${date.slice(5)} ${hm}`;
  }
  return hm;
}

/** 'HH:MM' -> 分 */
function hmToMinutes(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

function diffMinutes(a, b) {
  return (b.getTime() - a.getTime()) / 60000;
}

function today(now = new Date()) {
  return ymd(now);
}

function currentMonth(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
}

function shiftMonth(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/**
 * 締め日を考慮した月度の期間を返す。
 * closingDay = 0 なら月末締め（1日〜末日）。
 * closingDay = 20 なら「2026-11 月度」= 2026-10-21 〜 2026-11-20。
 */
function monthPeriod(month, closingDay = 0) {
  const [y, m] = month.split('-').map(Number);
  if (!closingDay) {
    const start = new Date(y, m - 1, 1);
    const end = new Date(y, m, 0);
    return { start: ymd(start), end: ymd(end) };
  }
  const lastOf = (yy, mm) => new Date(yy, mm, 0).getDate(); // mm: 1-12
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const prevClose = Math.min(closingDay, lastOf(prevY, prevM));
  const close = Math.min(closingDay, lastOf(y, m));
  const start = new Date(prevY, prevM - 1, prevClose + 1);
  const end = new Date(y, m - 1, close);
  return { start: ymd(start), end: ymd(end) };
}

/** ある日付が属する月度を返す */
function monthOf(dateStr, closingDay = 0) {
  const d = parseDate(dateStr);
  let y = d.getFullYear();
  let m = d.getMonth() + 1;
  if (closingDay) {
    const last = new Date(y, m, 0).getDate();
    if (d.getDate() > Math.min(closingDay, last)) {
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
  }
  return `${y}-${pad(m)}`;
}

function eachDate(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

module.exports = {
  WEEKDAYS, pad, ymd, toLocalISO, isValidDate, isValidTime, isValidMonth,
  parseDate, parseDateTime, addDays, weekday, weekdayLabel, combine,
  fmtMinutes, fmtClock, hmToMinutes, diffMinutes, today, currentMonth,
  shiftMonth, monthPeriod, monthOf, eachDate,
};
