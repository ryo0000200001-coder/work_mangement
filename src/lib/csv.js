'use strict';

function cell(v) {
  if (v == null) return '';
  let s = String(v);
  // CSV インジェクション対策（Excel で数式として解釈されないように）
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) && !/^-?\d+:\d{2}$/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Excel で文字化けしないよう BOM 付き UTF-8 の CSV を返す */
function toCsv(rows) {
  return '\uFEFF' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

function send(res, filename, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="export.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(toCsv(rows));
}

module.exports = { toCsv, send, cell };
