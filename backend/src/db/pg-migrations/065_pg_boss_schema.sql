-- 062_pg_boss_schema.sql — pg-boss job queue schema reservation
--
-- pg-boss manages its own schema (pgboss.*) via boss.start().
-- This migration is intentionally a no-op: it exists only to:
--   1. Reserve slot 062 in the sequential migration log.
--   2. Document that the pgboss schema is NOT hand-managed.
--
-- Tables created automatically by pg-boss:
--   pgboss.job            — active + scheduled jobs
--   pgboss.archive        — completed / expired jobs
--   pgboss.subscription   — queue subscriptions
--   pgboss.version        — schema version for pg-boss self-upgrades
--
-- To inspect the schema after startup:
--   \dt pgboss.*
--
-- DO NOT create, alter, or drop pgboss.* tables manually.
-- pg-boss handles all schema creation and upgrades via boss.start().

SELECT 1; -- no-op sentinel so the migration runner sees a valid SQL statement
