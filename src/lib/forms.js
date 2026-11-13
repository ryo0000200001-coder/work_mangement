'use strict';
const t = require('./time');

const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * 勤怠編集フォーム（出勤・退勤・休憩）を検証して保存用データに変換する。
 * body: { clock_in, clock_out, clock_out_next_day, break_start[], break_end[], note }
 * 時刻が出勤時刻より前の場合（休憩）は翌日として扱う。
 */
function parseAttendanceForm(body, date, { requireClockOut = true } = {}) {
  const errors = [];
  const inHm = str(body.clock_in);
  const outHm = str(body.clock_out);
  const note = str(body.note).slice(0, 500);

  if (!t.isValidTime(inHm)) {
    errors.push('出勤時刻を HH:MM 形式で入力してください。');
    return { errors };
  }
  const clockIn = t.combine(date, inHm);
  let clockOut = null;
  if (outHm) {
    if (!t.isValidTime(outHm)) errors.push('退勤時刻を HH:MM 形式で入力してください。');
    else {
      const next = body.clock_out_next_day === '1' || body.clock_out_next_day === 'on';
      clockOut = t.combine(date, outHm, next);
      if (clockOut <= clockIn) errors.push('退勤時刻は出勤時刻より後にしてください（日を跨ぐ場合は「翌日」にチェック）。');
      else if (t.diffMinutes(t.parseDateTime(clockIn), t.parseDateTime(clockOut)) > 24 * 60) {
        errors.push('勤務時間が24時間を超えています。');
      }
    }
  } else if (requireClockOut) {
    errors.push('退勤時刻を入力してください。');
  }

  const starts = toArray(body.break_start).map(str);
  const ends = toArray(body.break_end).map(str);
  const breaks = [];
  const toDt = (hm) => {
    const same = t.combine(date, hm);
    return same < clockIn ? t.combine(date, hm, true) : same;
  };
  for (let i = 0; i < Math.max(starts.length, ends.length); i++) {
    const s = starts[i] || '';
    const e = ends[i] || '';
    if (!s && !e) continue;
    if (!t.isValidTime(s) || !t.isValidTime(e)) {
      errors.push(`休憩${i + 1}の開始・終了時刻を HH:MM 形式で入力してください。`);
      continue;
    }
    const bs = toDt(s);
    let be = toDt(e);
    if (be <= bs) be = t.combine(bs.slice(0, 10), e, true); // 日跨ぎの休憩
    if (be <= bs) { errors.push(`休憩${i + 1}の終了は開始より後にしてください。`); continue; }
    if (clockOut && (bs < clockIn || be > clockOut)) {
      errors.push(`休憩${i + 1}が勤務時間の範囲外です。`);
      continue;
    }
    breaks.push({ start: bs, end: be });
  }
  breaks.sort((a, b) => (a.start < b.start ? -1 : 1));
  for (let i = 1; i < breaks.length; i++) {
    if (breaks[i].start < breaks[i - 1].end) errors.push('休憩時間が重複しています。');
  }
  return { errors, data: { clockIn, clockOut, breaks, note } };
}

/** 保存済みレコード -> フォーム初期値 */
function recordToForm(rec, date) {
  if (!rec || !rec.clock_in) return { clock_in: '', clock_out: '', clock_out_next_day: false, breaks: [], note: rec ? rec.note || '' : '' };
  return {
    clock_in: rec.clock_in.slice(11, 16),
    clock_out: rec.clock_out ? rec.clock_out.slice(11, 16) : '',
    clock_out_next_day: !!(rec.clock_out && rec.clock_out.slice(0, 10) > date),
    breaks: (rec.breaks || []).map((b) => ({ start: (b.start_at || b.start || '').slice(11, 16), end: (b.end_at || b.end || '').slice(11, 16) })),
    note: rec.note || '',
  };
}

module.exports = { parseAttendanceForm, recordToForm, toArray, str };
