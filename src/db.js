// 資料表：第一次使用時自動建立，不需要另外設定
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      line_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'user',
      line_name TEXT,
      nickname TEXT,
      is_self INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      contact_id INTEGER NOT NULL REFERENCES contacts(id),
      send_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      sent_at INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL
    )`,
  `CREATE INDEX IF NOT EXISTS reminders_due ON reminders (status, send_at)`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
      ip TEXT PRIMARY KEY,
      fails INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0
    )`,
];

let ready;

export function ensureSchema(env) {
  ready ??= env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql))).catch((err) => {
    ready = undefined;
    throw err;
  });
  return ready;
}
