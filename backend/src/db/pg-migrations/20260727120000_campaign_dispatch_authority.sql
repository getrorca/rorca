-- Canonical campaign dispatch authority and pause fencing.
-- Application tables are authoritative; pg-boss remains transport-only and is
-- intentionally not referenced or modified by this migration.

CREATE TABLE IF NOT EXISTS campaign_dispatch_controls (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  campaign_id TEXT NOT NULL CHECK (campaign_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,159}$'),
  generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'paused')),
  reason TEXT NOT NULL CHECK (btrim(reason) <> '' AND length(reason) <= 500),
  updated_by TEXT NOT NULL CHECK (btrim(updated_by) <> '' AND length(updated_by) <= 255),
  idempotency_key TEXT NOT NULL CHECK (btrim(idempotency_key) <> '' AND length(idempotency_key) <= 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, campaign_id)
);

CREATE TABLE IF NOT EXISTS campaign_dispatch_control_events (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  campaign_id TEXT NOT NULL,
  generation BIGINT NOT NULL CHECK (generation > 0),
  requested_state TEXT NOT NULL CHECK (requested_state IN ('active', 'paused')),
  state TEXT NOT NULL CHECK (state IN ('active', 'paused')),
  reason TEXT NOT NULL CHECK (btrim(reason) <> '' AND length(reason) <= 500),
  actor TEXT NOT NULL CHECK (btrim(actor) <> '' AND length(actor) <= 255),
  idempotency_key TEXT NOT NULL CHECK (btrim(idempotency_key) <> '' AND length(idempotency_key) <= 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT campaign_dispatch_control_events_control_fk
    FOREIGN KEY (workspace_id, campaign_id)
    REFERENCES campaign_dispatch_controls(workspace_id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT campaign_dispatch_control_events_generation_unique
    UNIQUE (workspace_id, campaign_id, generation),
  CONSTRAINT campaign_dispatch_control_events_idempotency_unique
    UNIQUE (workspace_id, campaign_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS campaign_dispatch_authorizations (
  authorization_hash TEXT PRIMARY KEY CHECK (authorization_hash ~ '^[0-9a-f]{64}$'),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  campaign_id TEXT NOT NULL,
  wave_id TEXT NOT NULL CHECK (wave_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,159}$'),
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (btrim(idempotency_key) <> '' AND length(idempotency_key) <= 160),
  run_id BIGINT NOT NULL UNIQUE REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  spec_id TEXT NOT NULL CHECK (btrim(spec_id) <> '' AND length(spec_id) <= 160),
  spec_revision TEXT NOT NULL CHECK (btrim(spec_revision) <> '' AND length(spec_revision) <= 160),
  story_id TEXT NOT NULL CHECK (story_id ~ '^[A-Z][A-Z0-9]+-[0-9]+$'),
  attempt_fence UUID NOT NULL,
  repository_host TEXT NOT NULL CHECK (repository_host = 'github.com'),
  repository TEXT NOT NULL CHECK (repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  repository_binding_id UUID NOT NULL REFERENCES github_app_workspace_bindings(id) ON DELETE RESTRICT,
  repository_id BIGINT NOT NULL CHECK (repository_id > 0),
  base_sha TEXT NOT NULL CHECK (base_sha ~ '^[0-9a-f]{40}$'),
  arm_decision_id BIGINT NOT NULL REFERENCES ssdlc_decisions(id) ON DELETE RESTRICT,
  gate_decision_id BIGINT NOT NULL REFERENCES ssdlc_decisions(id) ON DELETE RESTRICT,
  control_generation BIGINT NOT NULL CHECK (control_generation >= 0),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload_snapshot JSONB NOT NULL CHECK (jsonb_typeof(payload_snapshot) = 'object'),
  CONSTRAINT campaign_dispatch_authorization_expiry_check
    CHECK (expires_at > issued_at AND consumed_at <= expires_at),
  CONSTRAINT campaign_dispatch_authorization_control_fk
    FOREIGN KEY (workspace_id, campaign_id)
    REFERENCES campaign_dispatch_controls(workspace_id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT campaign_dispatch_authorization_idempotency_unique
    UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT campaign_dispatch_authorization_attempt_unique
    UNIQUE (workspace_id, campaign_id, wave_id, attempt_fence)
);

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS campaign_dispatch_authorization_hash TEXT;

ALTER TABLE pipeline_runs DROP CONSTRAINT IF EXISTS pipeline_runs_campaign_dispatch_authorization_hash_check;
ALTER TABLE pipeline_runs ADD CONSTRAINT pipeline_runs_campaign_dispatch_authorization_hash_check
  CHECK (campaign_dispatch_authorization_hash IS NULL
    OR campaign_dispatch_authorization_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE pipeline_runs DROP CONSTRAINT IF EXISTS pipeline_runs_campaign_dispatch_authorization_fk;
ALTER TABLE pipeline_runs ADD CONSTRAINT pipeline_runs_campaign_dispatch_authorization_fk
  FOREIGN KEY (campaign_dispatch_authorization_hash)
  REFERENCES campaign_dispatch_authorizations(authorization_hash) ON DELETE RESTRICT
  DEFERRABLE INITIALLY IMMEDIATE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_runs_campaign_dispatch_authorization
  ON pipeline_runs(campaign_dispatch_authorization_hash)
  WHERE campaign_dispatch_authorization_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_campaign_dispatch_authorizations_scope
  ON campaign_dispatch_authorizations(workspace_id, campaign_id, wave_id, consumed_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_dispatch_control_events_scope
  ON campaign_dispatch_control_events(workspace_id, campaign_id, generation DESC);

CREATE OR REPLACE FUNCTION guard_campaign_dispatch_authorization_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'campaign dispatch authorizations are immutable and single-consumption';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS campaign_dispatch_authorizations_immutable ON campaign_dispatch_authorizations;
CREATE TRIGGER campaign_dispatch_authorizations_immutable
  BEFORE UPDATE OR DELETE ON campaign_dispatch_authorizations
  FOR EACH ROW EXECUTE FUNCTION guard_campaign_dispatch_authorization_mutation();

CREATE OR REPLACE FUNCTION guard_campaign_dispatch_control_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'campaign dispatch control events are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS campaign_dispatch_control_events_append_only ON campaign_dispatch_control_events;
CREATE TRIGGER campaign_dispatch_control_events_append_only
  BEFORE UPDATE OR DELETE ON campaign_dispatch_control_events
  FOR EACH ROW EXECUTE FUNCTION guard_campaign_dispatch_control_event_mutation();
