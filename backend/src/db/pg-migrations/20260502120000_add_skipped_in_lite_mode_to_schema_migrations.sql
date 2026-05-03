-- Track migrations that were intentionally skipped in Lite Mode so they can be replayed
-- after upgrading from native Postgres to Docker + Apache AGE.
ALTER TABLE public.schema_migrations
  ADD COLUMN IF NOT EXISTS skipped_in_lite_mode BOOLEAN NOT NULL DEFAULT FALSE;
