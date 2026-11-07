-- Migration 079: Widen schema_migrations.version from INTEGER to BIGINT
--
-- Required before timestamp-format migration filenames (14-digit numeric prefixes
-- like 20260314150000) can be stored. INTEGER max is ~2.1x10^9; 14-digit timestamps
-- are ~2x10^13, which overflows INTEGER. BIGINT holds up to ~9.2x10^18.
--
-- This migration itself uses sequential format (079) so it runs before any
-- timestamp-format migration file is introduced.
-- The migration runner's canonical ledger is always public.schema_migrations;
-- qualify it because the migration session searches rorca before public.

ALTER TABLE public.schema_migrations
  ALTER COLUMN version TYPE BIGINT;
