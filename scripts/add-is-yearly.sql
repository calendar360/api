-- Run once on the live database to add the is_yearly column.
-- Safe to re-run (IF NOT EXISTS).
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS is_yearly BOOLEAN NOT NULL DEFAULT FALSE;
