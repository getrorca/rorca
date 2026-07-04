-- 20260628120000_spec_generation_logs_updated_at.sql — Add updated_at to spec_generation_logs (Context Intelligence Platform US-042).
--
-- The generate/persist path patches an existing spec_generation_logs row after the
-- initial insert (model/provider/tokens/status/context_summary_json), and that UPDATE
-- sets `updated_at = NOW()` (see patchSpecGenerationLog in routes/specs.ts). The base
-- table (046_spec_generation_logs.sql) only defined `created_at`, so every generate and
-- context-capture persist failed with `column "updated_at" ... does not exist` (HTTP 500).
--
-- Add the column with a NOW() default so existing rows backfill and the patch UPDATE
-- (and any future mutation tracking) succeeds. Idempotent via IF NOT EXISTS.
--
-- pgboss.* tables are NOT touched by this migration (and must never be — see AGENTS.md).

ALTER TABLE spec_generation_logs
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
