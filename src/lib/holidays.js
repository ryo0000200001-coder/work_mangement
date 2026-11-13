'use strict';
// 日本の祝日計算（「国民の祝日に関する法律」2020年以降の規定に基づく。対象: 2000〜2099年）
// 振替休日・国民の休日にも対応。会社独自の休日は company_holidays テーブルで管理する。
const { ymd, pad } = require('./time');

const cache = new Map();

function nthMonday(year, month, n) {
  const first = new Date(year, month - 1, 1).getDay();
  const offset = (8 - first) % 7; // 最初の月曜までの日数
  return 1 + offset + (n - 1) * 7;
}

function vernalEquinox(y) {
  return Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
}

function autumnalEquinox(y) {
  return Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
}

function baseHolidays(y) {
  const list = [
    [1, 1, '元日'],
    [1, nthMonday(y, 1, 2), '成人の日'],
    [2, 11, '建国記念の日'],
    [3, vernalEquinox(y), '春分の日'],
    [4, 29, '昭和の日'],
    [5, 3, '憲法記念日'],
    [5, 4, 'みどりの日'],
    [5, 5, 'こどもの日'],
    [9, nthMonday(y, 9, 3), '敬老の日'],
    [9, autumnalEquinox(y), '秋分の日'],
    [11, 3, '文化の日'],
    [11, 23, '勤労感謝の日'],
  ];
  if (y >= 2020) list.push([2, 23, '天皇誕生日']);
  else if (y <= 2018) list.push([12, 23, '天皇誕生日']);

  // 東京オリンピック特例（2020・2021年）
  if (y === 2020) {
    list.push([7, 23, '海の日'], [7, 24, 'スポーツの日'], [8, 10, '山の日']);
  } else if (y === 2021) {
    list.push([7, 22, '海の日'], [7, 23, 'スポーツの日'], [8, 8, '山の日']);
  } else {
    list.push([7, nthMonday(y, 7, 3), '海の日']);
    list.push([10, nthMonday(y, 10, 2), y >= 2020 ? 'スポーツの日' : '体育の日']);
    if (y >= 2016) list.push([8, 11, '山の日']);
  }
  if (y === 2019) {
    list.push([4, 30, '国民の休日'], [5, 1, '天皇の即位の日'], [5, 2, '国民の休日'], [10, 22, '即位礼正殿の儀の行われる日']);
  }
  return list;
}

/** 指定年の祝日 Map<'YYYY-MM-DD', name> */
function holidaysOfYear(y) {
  if (cache.has(y)) return cache.get(y);
  const map = new Map();
  for (const [m, d, name] of baseHolidays(y)) map.set(`${y}-${pad(m)}-${pad(d)}`, name);

  // 国民の休日: 前日と翌日が祝日で、その日自体は祝日でない日
  for (const key of [...map.keys()]) {
    const d = new Date(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10));
    const next = new Date(d); next.setDate(d.getDate() + 1);
    const next2 = new Date(d); next2.setDate(d.getDate() + 2);
    if (!map.has(ymd(next)) && map.has(ymd(next2)) && next.getDay() !== 0) {
      map.set(ymd(next), '国民の休日');
    }
  }

  // 振替休日: 祝日が日曜の場合、その後の最初の「祝日でない日」
  const sorted = [...map.keys()].sort();
  for (const key of sorted) {
    const d = new Date(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10));
    if (d.getDay() !== 0) continue;
    const s = new Date(d);
    do { s.setDate(s.getDate() + 1); } while (map.has(ymd(s)));
    if (s.getFullYear() === y) map.set(ymd(s), '振替休日');
  }

  cache.set(y, map);
  return map;
}

/** 祝日名（祝日でなければ null） */
function holidayName(dateStr) {
  const y = Number(dateStr.slice(0, 4));
  return holidaysOfYear(y).get(dateStr) || null;
}

module.exports = { holidayName, holidaysOfYear };
