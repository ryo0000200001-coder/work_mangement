'use strict';
const db = require('../db');

/** 操作ログを記録する */
function log(req, action, targetType = null, targetId = null, detail = null) {
  const userId = req && req.user ? req.user.id : null;
  const ip = req ? req.ip : null;
  db.get()
    .prepare('INSERT INTO audit_logs(user_id, action, target_type, target_id, detail, ip) VALUES (?,?,?,?,?,?)')
    .run(userId, action, targetType, targetId, detail == null ? null : JSON.stringify(detail), ip);
}

const ACTION_LABELS = {
  'auth.login': 'ログイン',
  'auth.login_failed': 'ログイン失敗',
  'auth.logout': 'ログアウト',
  'auth.password_changed': 'パスワード変更',
  'setup.completed': '初期設定',
  'punch.clock_in': '出勤打刻',
  'punch.clock_out': '退勤打刻',
  'punch.break_start': '休憩開始',
  'punch.break_end': '休憩終了',
  'attendance.edit': '勤怠修正（管理者）',
  'request.create': '申請作成',
  'request.cancel': '申請取消',
  'request.approve': '申請承認',
  'request.reject': '申請却下',
  'request.revoke': '承認済み休暇の取消',
  'user.create': 'ユーザー作成',
  'user.update': 'ユーザー更新',
  'user.reset_password': 'パスワードリセット',
  'leave.grant': '有給付与・調整',
  'holiday.add': '会社休日追加',
  'holiday.delete': '会社休日削除',
  'settings.update': '設定変更',
  'punch.move': '店舗移動（ヘルプ）',
  'shift.request': '希望シフト提出',
  'shift.save': 'シフト保存',
  'shift.delete': 'シフト削除',
  'shift.autofill': 'シフト一括作成（希望から）',
  'shift.copy': 'シフトコピー',
  'shift.publish': 'シフト公開',
  'sales.save': '売上入力',
  'store.create': '店舗登録',
  'store.update': '店舗更新',
};

module.exports = { log, ACTION_LABELS };
