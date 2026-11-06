-- Dataset generation for offline wipe reconciliation
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO app_meta (key, value, updated_at)
VALUES ('data_generation', '1', datetime('now'));
