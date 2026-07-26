-- Durable generation-level authority for expected raw PTY archives and failures.
ALTER TABLE pty_generations
  ADD COLUMN IF NOT EXISTS raw_archive_expected BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS raw_archive_storage_scope TEXT,
  ADD COLUMN IF NOT EXISTS raw_archive_failure_code TEXT,
  ADD COLUMN IF NOT EXISTS raw_archive_failure_at TIMESTAMPTZ;

ALTER TABLE pty_generations
  ADD CONSTRAINT pty_generation_raw_archive_scope_ck CHECK (
    (raw_archive_expected = FALSE AND raw_archive_storage_scope IS NULL)
    OR
    (raw_archive_expected = TRUE AND raw_archive_storage_scope = 'service-owned')
  ) NOT VALID;

ALTER TABLE pty_generations
  ADD CONSTRAINT pty_generation_raw_archive_failure_ck CHECK (
    (raw_archive_failure_code IS NULL AND raw_archive_failure_at IS NULL)
    OR
    (raw_archive_expected = TRUE AND raw_archive_failure_code IS NOT NULL AND raw_archive_failure_at IS NOT NULL)
  ) NOT VALID;
