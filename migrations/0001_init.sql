-- 聯絡人：加了 LINE 官方帳號好友的人或群組
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'user',       -- user | group
  line_name TEXT,                          -- LINE 上顯示的名字
  nickname TEXT,                           -- kai 取的小名，例如「小明」
  is_self INTEGER NOT NULL DEFAULT 0,      -- 是不是 kai 本人
  created_at INTEGER NOT NULL
);

-- 提醒事項
CREATE TABLE reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  send_at INTEGER NOT NULL,                -- 預定送出時間（毫秒）
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed | cancelled
  sent_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX reminders_due ON reminders (status, send_at);

-- 登入失敗次數（防止別人猜密碼）
CREATE TABLE login_attempts (
  ip TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);
