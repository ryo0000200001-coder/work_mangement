'use strict';
const config = require('./config');
const db = require('./db');
const { createApp } = require('./app');

db.get(); // マイグレーション実行
const app = createApp();
const server = app.listen(config.PORT, () => {
  console.log(`勤怠管理システム起動: http://localhost:${config.PORT}  (DB: ${config.DB_FILE})`);
});

function shutdown() {
  server.close(() => {
    db.get().close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
