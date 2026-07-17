-- 20260715210000_autonomous_delivery_governance.sql
-- LFC-032 foundation: standing operator-owned delivery policy and exact-SHA
-- GitHub pull-request evidence. No scheduler, queue, deployment authority, or
-- pg-boss object is introduced by this migration.

CREATE TABLE IF NOT EXISTS autonomous_delivery_policies (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  repo_owner TEXT NOT NULL CHECK (btrim(repo_owner) <> ''),
  repo_name TEXT NOT NULL CHECK (btrim(repo_name) <> ''),
  base_branch TEXT NOT NULL CHECK (base_branch ~ '^[A-Za-z0-9._/-]{1,255}$'),
  allowed_risk_levels JSONB NOT NULL CHECK (
    jsonb_typeof(allowed_risk_levels) = 'array'
    AND jsonb_array_length(allowed_risk_levels) BETWEEN 1 AND 2
    AND allowed_risk_levels <@ '["low", "medium"]'::jsonb
  ),
  required_checks JSONB NOT NULL CHECK (
    jsonb_typeof(required_checks) = 'array'
    AND jsonb_array_length(required_checks) BETWEEN 1 AND 50
  ),
  review_rules JSONB NOT NULL CHECK (jsonb_typeof(review_rules) = 'object'),
  merge_method TEXT NOT NULL CHECK (merge_method IN ('merge', 'squash', 'rebase')),
  retry_budget JSONB NOT NULL CHECK (jsonb_typeof(retry_budget) = 'object'),
  deployment_allowed BOOLEAN NOT NULL DEFAULT FALSE CHECK (deployment_allowed = FALSE),
  policy_digest TEXT NOT NULL CHECK (policy_digest ~ '^sha256:[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled', 'active', 'revoked')),
  source_request_id TEXT NOT NULL CHECK (char_length(source_request_id) BETWEEN 8 AND 200),
  created_by_principal_id TEXT NOT NULL CHECK (btrim(created_by_principal_id) <> ''),
  created_by_display_label TEXT NOT NULL CHECK (btrim(created_by_display_label) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > created_at),
  activated_at TIMESTAMPTZ,
  activated_by_principal_id TEXT,
  activated_by_display_label TEXT,
  activation_source_request_id TEXT,
  revoked_at TIMESTAMPTZ,
  revoked_by_principal_id TEXT,
  revoked_by_display_label TEXT,
  revocation_reason TEXT,
  revocation_source_request_id TEXT,
  CONSTRAINT autonomous_delivery_policy_revision_unique
    UNIQUE (workspace_id, repo_owner, repo_name, base_branch, revision),
  CONSTRAINT autonomous_delivery_policy_create_request_unique
    UNIQUE (workspace_id, source_request_id),
  CONSTRAINT autonomous_delivery_policy_digest_unique
    UNIQUE (workspace_id, policy_digest),
  CONSTRAINT autonomous_delivery_policy_state_check CHECK (
    (status = 'disabled'
      AND activated_at IS NULL AND activated_by_principal_id IS NULL
      AND activated_by_display_label IS NULL AND activation_source_request_id IS NULL
      AND revoked_at IS NULL AND revoked_by_principal_id IS NULL
      AND revoked_by_display_label IS NULL AND revocation_reason IS NULL
      AND revocation_source_request_id IS NULL)
    OR
    (status = 'active'
      AND activated_at IS NOT NULL AND activated_by_principal_id IS NOT NULL
      AND activated_by_display_label IS NOT NULL AND activation_source_request_id IS NOT NULL
      AND revoked_at IS NULL AND revoked_by_principal_id IS NULL
      AND revoked_by_display_label IS NULL AND revocation_reason IS NULL
      AND revocation_source_request_id IS NULL)
    OR
    (status = 'revoked'
      AND revoked_at IS NOT NULL AND revoked_by_principal_id IS NOT NULL
      AND revoked_by_display_label IS NOT NULL
      AND revocation_reason IS NOT NULL AND length(btrim(revocation_reason)) >= 10
      AND revocation_source_request_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_autonomous_delivery_policy_active_workspace
  ON autonomous_delivery_policies (workspace_id)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS uq_autonomous_delivery_policy_activation_request
  ON autonomous_delivery_policies (workspace_id, activation_source_request_id)
  WHERE activation_source_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_autonomous_delivery_policy_revocation_request
  ON autonomous_delivery_policies (workspace_id, revocation_source_request_id)
  WHERE revocation_source_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_autonomous_delivery_policy_history
  ON autonomous_delivery_policies (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS autonomous_delivery_policy_events (
  id BIGSERIAL PRIMARY KEY,
  policy_id UUID NOT NULL REFERENCES autonomous_delivery_policies(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'activated', 'revoked', 'expired_observed')),
  principal_id TEXT NOT NULL CHECK (btrim(principal_id) <> ''),
  principal_display_label TEXT NOT NULL CHECK (btrim(principal_display_label) <> ''),
  source_request_id TEXT NOT NULL CHECK (char_length(source_request_id) BETWEEN 8 AND 200),
  policy_digest TEXT NOT NULL CHECK (policy_digest ~ '^sha256:[0-9a-f]{64}$'),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT autonomous_delivery_policy_event_request_unique
    UNIQUE (workspace_id, source_request_id)
);

CREATE INDEX IF NOT EXISTS idx_autonomous_delivery_policy_events_policy
  ON autonomous_delivery_policy_events (policy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS github_pr_delivery_evidence (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  policy_id UUID REFERENCES autonomous_delivery_policies(id) ON DELETE RESTRICT,
  policy_digest TEXT CHECK (policy_digest IS NULL OR policy_digest ~ '^sha256:[0-9a-f]{64}$'),
  repo_owner TEXT NOT NULL CHECK (btrim(repo_owner) <> ''),
  repo_name TEXT NOT NULL CHECK (btrim(repo_name) <> ''),
  pr_number INTEGER NOT NULL CHECK (pr_number > 0),
  pr_url TEXT NOT NULL CHECK (pr_url ~ '^https://github\.com/'),
  pr_state TEXT NOT NULL CHECK (pr_state IN ('open', 'closed')),
  draft BOOLEAN NOT NULL,
  merged BOOLEAN NOT NULL,
  head_ref TEXT NOT NULL CHECK (btrim(head_ref) <> ''),
  base_ref TEXT NOT NULL CHECK (btrim(base_ref) <> ''),
  head_sha TEXT NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40,64}$'),
  base_sha TEXT NOT NULL CHECK (base_sha ~ '^[0-9a-f]{40,64}$'),
  merge_commit_sha TEXT CHECK (merge_commit_sha IS NULL OR merge_commit_sha ~ '^[0-9a-f]{40,64}$'),
  mergeable BOOLEAN,
  mergeable_state TEXT NOT NULL CHECK (btrim(mergeable_state) <> ''),
  comparison_status TEXT NOT NULL CHECK (comparison_status IN ('ahead', 'behind', 'diverged', 'identical', 'unknown')),
  ahead_by INTEGER NOT NULL CHECK (ahead_by >= 0),
  behind_by INTEGER NOT NULL CHECK (behind_by >= 0),
  branch_fresh BOOLEAN NOT NULL,
  checks JSONB NOT NULL CHECK (jsonb_typeof(checks) = 'array' AND jsonb_array_length(checks) <= 500),
  checks_truncated BOOLEAN NOT NULL DEFAULT FALSE,
  reviews JSONB NOT NULL CHECK (jsonb_typeof(reviews) = 'array' AND jsonb_array_length(reviews) <= 500),
  reviews_truncated BOOLEAN NOT NULL DEFAULT FALSE,
  check_summary JSONB NOT NULL CHECK (jsonb_typeof(check_summary) = 'object'),
  review_summary JSONB NOT NULL CHECK (jsonb_typeof(review_summary) = 'object'),
  provider_observed_at TIMESTAMPTZ NOT NULL,
  observed_by_principal_id TEXT NOT NULL CHECK (btrim(observed_by_principal_id) <> ''),
  observed_by_display_label TEXT NOT NULL CHECK (btrim(observed_by_display_label) <> ''),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT github_pr_delivery_evidence_identity_unique
    UNIQUE (workspace_id, repo_owner, repo_name, pr_number, head_sha, payload_hash)
);

CREATE INDEX IF NOT EXISTS idx_github_pr_delivery_evidence_run
  ON github_pr_delivery_evidence (workspace_id, run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_github_pr_delivery_evidence_pr
  ON github_pr_delivery_evidence (workspace_id, repo_owner, repo_name, pr_number, created_at DESC);

CREATE OR REPLACE FUNCTION guard_autonomous_delivery_policy_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'autonomous delivery policies are audit-retained and cannot be deleted';
  END IF;

  IF (to_jsonb(OLD) - ARRAY[
        'status', 'activated_at', 'activated_by_principal_id', 'activated_by_display_label',
        'activation_source_request_id', 'revoked_at', 'revoked_by_principal_id',
        'revoked_by_display_label', 'revocation_reason', 'revocation_source_request_id'
      ]::text[])
      IS DISTINCT FROM
      (to_jsonb(NEW) - ARRAY[
        'status', 'activated_at', 'activated_by_principal_id', 'activated_by_display_label',
        'activation_source_request_id', 'revoked_at', 'revoked_by_principal_id',
        'revoked_by_display_label', 'revocation_reason', 'revocation_source_request_id'
      ]::text[]) THEN
    RAISE EXCEPTION 'autonomous delivery policy scope and authority are immutable';
  END IF;

  IF OLD.status = 'disabled' AND NEW.status = 'active'
     AND NEW.activated_at IS NOT NULL
     AND NEW.activated_by_principal_id IS NOT NULL
     AND NEW.activated_by_display_label IS NOT NULL
     AND NEW.activation_source_request_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF OLD.status IN ('disabled', 'active') AND NEW.status = 'revoked'
     AND NEW.revoked_at IS NOT NULL
     AND NEW.revoked_by_principal_id IS NOT NULL
     AND NEW.revoked_by_display_label IS NOT NULL
     AND NEW.revocation_reason IS NOT NULL
     AND NEW.revocation_source_request_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'autonomous delivery policy state transitions are one-way';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_autonomous_delivery_policy_guard ON autonomous_delivery_policies;
CREATE TRIGGER trg_autonomous_delivery_policy_guard
  BEFORE UPDATE OR DELETE ON autonomous_delivery_policies
  FOR EACH ROW EXECUTE FUNCTION guard_autonomous_delivery_policy_mutation();

CREATE OR REPLACE FUNCTION reject_autonomous_delivery_append_only_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_autonomous_delivery_policy_events_append_only ON autonomous_delivery_policy_events;
CREATE TRIGGER trg_autonomous_delivery_policy_events_append_only
  BEFORE UPDATE OR DELETE ON autonomous_delivery_policy_events
  FOR EACH ROW EXECUTE FUNCTION reject_autonomous_delivery_append_only_mutation();

DROP TRIGGER IF EXISTS trg_github_pr_delivery_evidence_append_only ON github_pr_delivery_evidence;
CREATE TRIGGER trg_github_pr_delivery_evidence_append_only
  BEFORE UPDATE OR DELETE ON github_pr_delivery_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_autonomous_delivery_append_only_mutation();
