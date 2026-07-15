-- 20260715130000_ssdlc_plan_compilation_lifecycle.sql
-- LFC-004: idempotent plan activation, provenance, and retryable compilation readiness.
-- runPgMigrations supplies the transaction boundary for this file.

ALTER TABLE ssdlc_compiled_plans
  ADD COLUMN IF NOT EXISTS provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ssdlc_compiled_plans_provenance_check') THEN
    ALTER TABLE ssdlc_compiled_plans
      ADD CONSTRAINT ssdlc_compiled_plans_provenance_check
      CHECK (jsonb_typeof(provenance_json) = 'object');
  END IF;
END $$;

-- This complements the one-current-plan-per-spec index with the normalized
-- input identity required for replay/concurrency deduplication.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ssdlc_compiled_plans_current_input
  ON ssdlc_compiled_plans (workspace_id, spec_slug, normalized_input_hash)
  WHERE is_current = TRUE;

CREATE TABLE IF NOT EXISTS ssdlc_plan_readiness_reasons (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  spec_slug TEXT NOT NULL CHECK (btrim(spec_slug) <> ''),
  save_generation BIGINT,
  input_hash TEXT,
  reason_code TEXT NOT NULL CHECK (btrim(reason_code) <> ''),
  message TEXT NOT NULL CHECK (btrim(message) <> ''),
  retryable BOOLEAN NOT NULL DEFAULT TRUE,
  details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT ssdlc_plan_readiness_reason_identity UNIQUE (
    workspace_id,
    spec_slug,
    save_generation,
    reason_code,
    input_hash
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ssdlc_plan_readiness_reason_replay
  ON ssdlc_plan_readiness_reasons (
    workspace_id,
    spec_slug,
    COALESCE(save_generation, -1),
    reason_code,
    COALESCE(input_hash, '')
  );

CREATE INDEX IF NOT EXISTS idx_ssdlc_plan_readiness_open
  ON ssdlc_plan_readiness_reasons (workspace_id, spec_slug, created_at DESC)
  WHERE resolved_at IS NULL;

-- Plan bodies remain immutable. The only content-state transition is the
-- service-owned draft -> validated activation performed in the same transaction
-- that selects the row as current. Existing current-selection updates remain valid.
CREATE OR REPLACE FUNCTION guard_ssdlc_compiled_plan_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'compiled plans are audit-retained and cannot be deleted';
  END IF;

  IF (to_jsonb(OLD) - ARRAY['is_current', 'updated_at']::text[])
       IS NOT DISTINCT FROM
     (to_jsonb(NEW) - ARRAY['is_current', 'updated_at']::text[]) THEN
    RETURN NEW;
  END IF;

  IF OLD.validation_status = 'draft'
     AND NEW.validation_status = 'validated'
     AND OLD.validated_at IS NULL
     AND NEW.validated_at IS NOT NULL
     AND NEW.is_current = TRUE
     AND (to_jsonb(OLD) - ARRAY['validation_status', 'validated_at', 'is_current', 'updated_at']::text[])
          IS NOT DISTINCT FROM
         (to_jsonb(NEW) - ARRAY['validation_status', 'validated_at', 'is_current', 'updated_at']::text[]) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'compiled plan content and validation outcome are immutable';
END;
$$ LANGUAGE plpgsql;
