PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  qr_token TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('student','employee','visitor')),
  pc_number TEXT,
  full_name TEXT NOT NULL,
  grade TEXT,
  section TEXT,
  school TEXT,
  office TEXT,
  position TEXT,
  pre_test REAL,
  post_test REAL,
  feedback TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  UNIQUE(category, pc_number)
);

CREATE INDEX IF NOT EXISTS idx_records_full_name ON records(full_name);
CREATE INDEX IF NOT EXISTS idx_records_category ON records(category);
CREATE INDEX IF NOT EXISTS idx_records_section ON records(section);
CREATE INDEX IF NOT EXISTS idx_records_created_at ON records(created_at);
CREATE INDEX IF NOT EXISTS idx_records_qr_token ON records(qr_token);

CREATE TABLE IF NOT EXISTS scan_events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  scanned_by TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'staff_lookup',
  FOREIGN KEY(record_id) REFERENCES records(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_scan_events_record_id ON scan_events(record_id);
CREATE INDEX IF NOT EXISTS idx_scan_events_scanned_at ON scan_events(scanned_at);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
