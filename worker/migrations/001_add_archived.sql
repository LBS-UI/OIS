-- Migration: add reversible archive support to records
-- Run with: npx wrangler d1 execute nextgen-smart-classroom --remote --file=worker/migrations/001_add_archived.sql
-- Safe to re-run on already-migrated DBs (columns are added only if missing via try/catch pattern in docs).

-- SQLite / D1 does not support IF NOT EXISTS for columns in older versions; run once per database.
-- If a column already exists the statement will fail; that is expected and harmless.

ALTER TABLE records ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE records ADD COLUMN archived_at TEXT;
ALTER TABLE records ADD COLUMN archived_by TEXT;

CREATE INDEX IF NOT EXISTS idx_records_archived ON records(archived);

-- Optional: extend audit_logs with a free-form details column for archive batch info
-- (ignore error if column already present)
ALTER TABLE audit_logs ADD COLUMN details TEXT;
