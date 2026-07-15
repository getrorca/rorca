-- 20260714160000_ssdlc_lifecycle.sql
-- Minimal durable storage for compiled SSDLC plans, normalized evidence, and governed decisions.
-- Phase state is intentionally derived from evidence and active decisions rather than persisted.
-- runPgMigrations supplies the transaction boundary for this file.

CREATE TABLE IF NOT EXISTS ssdlc_compiled_plans (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  spec_slug TEXT NOT NULL CHECK (btrim(spec_slug) <> ''),
  spec_version TEXT NOT NULL CHECK (btrim(spec_version) <> ''),
  compiler_version TEXT NOT NULL CHECK (btrim(compiler_version) <> ''),
  normalized_input_hash TEXT NOT NULL CHECK (btrim(normalized_input_hash) <> ''),
  schema_version TEXT NOT NULL CHECK (btrim(schema_version) <> ''),
  plan_json JSONB NOT NULL CHECK (jsonb_typeof(plan_json) = 'object'),
  validation_status TEXT NOT NULL
    CHECK (validation_status IN ('draft', 'validated', 'failed')),
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  validated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ssdlc_compiled_plans_identity_unique UNIQUE (
    workspace_id,
    spec_slug,
    spec_version,
    compiler_version,
    normalized_input_hash
  ),
  CONSTRAINT ssdlc_compiled_plans_current_validated_check
    CHECK (NOT is_current OR validation_status = 'validated'),
  CONSTRAINT ssdlc_compiled_plans_validated_timestamp_check
    CHECK (validation_status <> 'validated' OR validated_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS ssdlc_lifecycle_evidence (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  spec_slug TEXT NOT NULL CHECK (btrim(spec_slug) <> ''),
  spec_version TEXT,
  revision TEXT,
  run_id INTEGER REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  story_id TEXT,
  phase_id TEXT,
  gate_id TEXT,
  evidence_type TEXT NOT NULL CHECK (btrim(evidence_type) <> ''),
  subject_type TEXT NOT NULL
    CHECK (subject_type IN ('spec_hash', 'commit_sha', 'artifact_digest', 'deployment_id')),
  subject_value TEXT NOT NULL CHECK (btrim(subject_value) <> ''),
  source_system TEXT NOT NULL CHECK (btrim(source_system) <> ''),
  source_idempotency_key TEXT NOT NULL CHECK (btrim(source_idempotency_key) <> ''),
  payload_hash TEXT NOT NULL CHECK (btrim(payload_hash) <> ''),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provenance) = 'object'),
  source_ref TEXT,
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ssdlc_lifecycle_evidence_source_unique
    UNIQUE (workspace_id, source_system, source_idempotency_key)
);

CREATE TABLE IF NOT EXISTS ssdlc_lifecycle_decisions (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  spec_slug TEXT NOT NULL CHECK (btrim(spec_slug) <> ''),
  spec_version TEXT,
  revision TEXT,
  run_id INTEGER REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  story_id TEXT,
  phase_id TEXT,
  gate_id TEXT,
  decision_type TEXT NOT NULL CHECK (decision_type IN (
    'defer',
    'not_applicable_confirmation',
    'gate_override',
    'qa_approval',
    'merge_approval',
    'production_approval'
  )),
  actor TEXT NOT NULL CHECK (btrim(actor) <> ''),
  rationale TEXT NOT NULL CHECK (btrim(rationale) <> ''),
  scope JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(scope) = 'object'),
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provenance) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT,
  revocation_rationale TEXT,
  CONSTRAINT ssdlc_lifecycle_decisions_expiry_check
    CHECK (expires_at IS NULL OR expires_at > created_at),
  CONSTRAINT ssdlc_lifecycle_decisions_revocation_check CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revocation_rationale IS NULL)
    OR
    (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND btrim(revoked_by) <> ''
      AND revocation_rationale IS NOT NULL AND btrim(revocation_rationale) <> ''
      AND revoked_at >= created_at)
  )
);

-- At most one validated plan can be selected for a workspace/spec. Selection is
-- performed atomically by the repository; failed or draft plans cannot satisfy this index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ssdlc_compiled_plans_one_current
  ON ssdlc_compiled_plans (workspace_id, spec_slug)
  WHERE is_current = TRUE;

CREATE INDEX IF NOT EXISTS idx_ssdlc_compiled_plans_portfolio
  ON ssdlc_compiled_plans (workspace_id, validation_status, is_current, spec_slug);

CREATE INDEX IF NOT EXISTS idx_ssdlc_compiled_plans_spec_versions
  ON ssdlc_compiled_plans (workspace_id, spec_slug, spec_version, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ssdlc_evidence_phase_detail
  ON ssdlc_lifecycle_evidence (workspace_id, spec_slug, phase_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ssdlc_evidence_gate
  ON ssdlc_lifecycle_evidence (workspace_id, gate_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ssdlc_evidence_story
  ON ssdlc_lifecycle_evidence (workspace_id, story_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ssdlc_evidence_run
  ON ssdlc_lifecycle_evidence (workspace_id, run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ssdlc_evidence_revision
  ON ssdlc_lifecycle_evidence (workspace_id, revision, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ssdlc_decisions_phase_detail
  ON ssdlc_lifecycle_decisions (workspace_id, spec_slug, phase_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ssdlc_decisions_active
  ON ssdlc_lifecycle_decisions (
    workspace_id,
    spec_slug,
    decision_type,
    gate_id,
    story_id,
    created_at DESC
  )
  WHERE revoked_at IS NULL;

-- Plan bodies and compilation outcomes are immutable. Only current-plan selection
-- metadata may change, preserving prior validated and failed compiler output.
CREATE OR REPLACE FUNCTION guard_ssdlc_compiled_plan_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'compiled plans are audit-retained and cannot be deleted';
  END IF;

  IF (to_jsonb(OLD) - ARRAY['is_current', 'updated_at']::text[])
       IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY['is_current', 'updated_at']::text[]) THEN
    RAISE EXCEPTION 'compiled plan content and validation outcome are immutable';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ssdlc_compiled_plans_immutable ON ssdlc_compiled_plans;
CREATE TRIGGER ssdlc_compiled_plans_immutable
  BEFORE UPDATE OR DELETE ON ssdlc_compiled_plans
  FOR EACH ROW EXECUTE FUNCTION guard_ssdlc_compiled_plan_mutation();

CREATE OR REPLACE FUNCTION guard_ssdlc_evidence_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'lifecycle evidence is append-only and cannot be changed or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ssdlc_lifecycle_evidence_append_only ON ssdlc_lifecycle_evidence;
CREATE TRIGGER ssdlc_lifecycle_evidence_append_only
  BEFORE UPDATE OR DELETE ON ssdlc_lifecycle_evidence
  FOR EACH ROW EXECUTE FUNCTION guard_ssdlc_evidence_append_only();

-- Decisions are append-only except for a single complete, one-way revocation.
CREATE OR REPLACE FUNCTION guard_ssdlc_decision_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'lifecycle decisions are audit-retained and cannot be deleted';
  END IF;

  IF OLD.revoked_at IS NOT NULL
     OR NEW.revoked_at IS NULL
     OR NEW.revoked_by IS NULL
     OR btrim(NEW.revoked_by) = ''
     OR NEW.revocation_rationale IS NULL
     OR btrim(NEW.revocation_rationale) = ''
     OR (to_jsonb(OLD) - ARRAY['revoked_at', 'revoked_by', 'revocation_rationale']::text[])
          IS DISTINCT FROM
        (to_jsonb(NEW) - ARRAY['revoked_at', 'revoked_by', 'revocation_rationale']::text[]) THEN
    RAISE EXCEPTION 'lifecycle decisions are append-only; only one-way revocation is allowed';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ssdlc_lifecycle_decisions_append_only ON ssdlc_lifecycle_decisions;
CREATE TRIGGER ssdlc_lifecycle_decisions_append_only
  BEFORE UPDATE OR DELETE ON ssdlc_lifecycle_decisions
  FOR EACH ROW EXECUTE FUNCTION guard_ssdlc_decision_mutation();
