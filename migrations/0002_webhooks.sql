CREATE TABLE IF NOT EXISTS webhook (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id INTEGER NOT NULL,
  created_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  url TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (creator_id) REFERENCES user(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_webhook_creator_id ON webhook(creator_id);
