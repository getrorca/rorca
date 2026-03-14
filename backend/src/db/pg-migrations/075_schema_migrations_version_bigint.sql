-- Migration 075: Widen schema_migrations.version from INTEGER to BIGINT
--
-- Required before timestamp-format migration filenames (14-digit numeric prefixes
-- like 20260313120000) can be stored. INTEGER max is ~2.1×10^9; 14-digit timestamps
-- are ~2×10^13, which overflows INTEGER silently. BIGINT holds up to ~9.2×10^18.
--
-- This migration itself uses sequential format (075) so it runs before any
-- timestamp-format migration file is introduced.

ALTER TABLE schema_migrations
  ALTER COLUMN version TYPE BIGINT;
