-- 20260715220000_autonomous_reviewed_delivery.sql
-- LFC-032 completion: existing Lifecycle gate consumption, bounded PR-delivery
-- state, recovery attempts, and exact merged-SHA evidence. pg-boss remains
-- application-managed and is intentionally not touched by this migration.

-- Pipeline run IDs are BIGINT. Older lifecycle ledgers used INTEGER and can no
-- longer bind modern sequence values safely.
ALTER TABLE ssdlc_lifecycle_evidence ALTER COLUMN run_id TYPE BIGINT USING run_id::bigint;
ALTER TABLE ssdlc_decisions ALTER COLUMN run_id TYPE BIGINT USING run_id::bigint;

-- Exact PR review/check evidence is normalized into the existing Lifecycle
-- evidence ledger as the compiler's `approval` classification.
ALTER TABLE ssdlc_lifecycle_evidence
  DROP CONSTRAINT IF EXISTS ssdlc_evidence_classification_check;
ALTER TABLE ssdlc_lifecycle_evidence
  ADD CONSTRAINT ssdlc_evidence_classification_check CHECK (classification IN (
    'validation', 'revision', 'completion', 'risk_judgment', 'qa', 'staging',
    'deployment', 'memory_closeout', 'approval'
  ));
ALTER TABLE ssdlc_lifecycle_evidence
  ADD COLUMN IF NOT EXISTS github_pr_delivery_evidence_id UUID REFERENCES github_pr_delivery_evidence(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS compiled_plan_id BIGINT REFERENCES ssdlc_compiled_plans(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS delivery_projection_kind TEXT CHECK (delivery_projection_kind IN ('validation', 'merge'));
ALTER TABLE ssdlc_lifecycle_evidence
  DROP CONSTRAINT IF EXISTS ssdlc_evidence_delivery_projection_check;
ALTER TABLE ssdlc_lifecycle_evidence
  ADD CONSTRAINT ssdlc_evidence_delivery_projection_check CHECK (
    (github_pr_delivery_evidence_id IS NULL AND compiled_plan_id IS NULL AND delivery_projection_kind IS NULL)
    OR
    (github_pr_delivery_evidence_id IS NOT NULL AND compiled_plan_id IS NOT NULL AND delivery_projection_kind IS NOT NULL)
  );
CREATE UNIQUE INDEX IF NOT EXISTS uq_ssdlc_evidence_delivery_projection
  ON ssdlc_lifecycle_evidence (github_pr_delivery_evidence_id, compiled_plan_id, delivery_projection_kind)
  WHERE github_pr_delivery_evidence_id IS NOT NULL;

-- A standing policy may authorize only a policy-configured merge gate. This is
-- distinct from merge_approval and never claims a human approved a revision.
ALTER TABLE ssdlc_decisions
  DROP CONSTRAINT IF EXISTS ssdlc_decisions_decision_type_check;
ALTER TABLE ssdlc_decisions
  ADD CONSTRAINT ssdlc_decisions_decision_type_check CHECK (decision_type IN (
    'defer', 'not_applicable_confirmation', 'gate_override', 'qa_approval',
    'merge_approval', 'production_approval', 'policy_approval'
  ));
ALTER TABLE ssdlc_decisions
  DROP CONSTRAINT IF EXISTS ssdlc_decisions_subject_binding_check;
ALTER TABLE ssdlc_decisions
  ADD CONSTRAINT ssdlc_decisions_subject_binding_check CHECK (
    (decision_type IN ('qa_approval', 'merge_approval', 'production_approval', 'policy_approval')
      AND subject_type IS NOT NULL AND subject_value IS NOT NULL AND btrim(subject_value) <> '')
    OR
    (decision_type NOT IN ('qa_approval', 'merge_approval', 'production_approval', 'policy_approval')
      AND subject_type IS NULL AND subject_value IS NULL)
  );

CREATE TABLE IF NOT EXISTS autonomous_pr_deliveries (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  spec_slug TEXT NOT NULL CHECK (btrim(spec_slug) <> ''),
  policy_id UUID NOT NULL REFERENCES autonomous_delivery_policies(id) ON DELETE RESTRICT,
  policy_digest TEXT NOT NULL CHECK (policy_digest ~ '^sha256:[0-9a-f]{64}$'),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  repo_owner TEXT NOT NULL CHECK (btrim(repo_owner) <> ''),
  repo_name TEXT NOT NULL CHECK (btrim(repo_name) <> ''),
  pr_number INTEGER NOT NULL CHECK (pr_number > 0),
  base_branch TEXT NOT NULL CHECK (btrim(base_branch) <> ''),
  branch_name TEXT NOT NULL CHECK (btrim(branch_name) <> ''),
  initial_head_sha TEXT NOT NULL CHECK (initial_head_sha ~ '^[0-9a-f]{40,64}$'),
  current_head_sha TEXT NOT NULL CHECK (current_head_sha ~ '^[0-9a-f]{40,64}$'),
  merge_method TEXT NOT NULL CHECK (merge_method IN ('merge', 'squash', 'rebase')),
  retry_budget JSONB NOT NULL CHECK (jsonb_typeof(retry_budget) = 'object'),
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'observing', 'awaiting_checks', 'awaiting_review',
    'awaiting_human_approval', 'recovering_ci', 'recovering_conflict',
    'authorized', 'merging', 'merged', 'blocked', 'budget_exhausted'
  )),
  recovery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (recovery_attempts >= 0),
  last_evidence_id UUID REFERENCES github_pr_delivery_evidence(id) ON DELETE RESTRICT,
  merge_decision_id BIGINT REFERENCES ssdlc_decisions(id) ON DELETE RESTRICT,
  authorization_snapshot_id TEXT,
  authorization_evidence_hwm TEXT,
  authorization_decision_hwm TEXT,
  authorized_at TIMESTAMPTZ,
  merged_sha TEXT CHECK (merged_sha IS NULL OR merged_sha ~ '^[0-9a-f]{40,64}$'),
  terminal_reason TEXT,
  source_request_id TEXT NOT NULL CHECK (char_length(source_request_id) BETWEEN 8 AND 200),
  deadline_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT autonomous_pr_delivery_run_unique UNIQUE (workspace_id, run_id),
  CONSTRAINT autonomous_pr_delivery_request_unique UNIQUE (workspace_id, source_request_id),
  CONSTRAINT autonomous_pr_delivery_terminal_check CHECK (
    (status = 'merged' AND merged_sha IS NOT NULL AND completed_at IS NOT NULL)
    OR
    (status IN ('blocked', 'budget_exhausted') AND terminal_reason IS NOT NULL AND completed_at IS NOT NULL)
    OR
    (status NOT IN ('merged', 'blocked', 'budget_exhausted')
      AND merged_sha IS NULL AND terminal_reason IS NULL AND completed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_autonomous_pr_deliveries_state
  ON autonomous_pr_deliveries (workspace_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_autonomous_pr_deliveries_pr
  ON autonomous_pr_deliveries (workspace_id, repo_owner, repo_name, pr_number);

CREATE TABLE IF NOT EXISTS autonomous_pr_delivery_events (
  id BIGSERIAL PRIMARY KEY,
  delivery_id UUID NOT NULL REFERENCES autonomous_pr_deliveries(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'queued', 'observed', 'gate_evidence_recorded', 'policy_authorized',
    'awaiting_checks', 'awaiting_review', 'awaiting_human_approval',
    'recovery_started', 'recovery_completed', 'recovery_failed',
    'merge_authorized', 'merge_started', 'merged', 'blocked', 'budget_exhausted'
  )),
  head_sha TEXT NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40,64}$'),
  evidence_id UUID REFERENCES github_pr_delivery_evidence(id) ON DELETE RESTRICT,
  lifecycle_evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(lifecycle_evidence_ids) = 'array' AND jsonb_array_length(lifecycle_evidence_ids) <= 4
  ),
  decision_id BIGINT REFERENCES ssdlc_decisions(id) ON DELETE RESTRICT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_autonomous_pr_delivery_events_delivery
  ON autonomous_pr_delivery_events (delivery_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS autonomous_pr_delivery_recovery_attempts (
  id UUID PRIMARY KEY,
  delivery_id UUID NOT NULL REFERENCES autonomous_pr_deliveries(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  recovery_kind TEXT NOT NULL CHECK (recovery_kind IN ('ci', 'conflict')),
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  head_sha_before TEXT NOT NULL CHECK (head_sha_before ~ '^[0-9a-f]{40,64}$'),
  head_sha_after TEXT CHECK (head_sha_after IS NULL OR head_sha_after ~ '^[0-9a-f]{40,64}$'),
  child_run_id BIGINT REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  classification TEXT NOT NULL CHECK (btrim(classification) <> ''),
  failure_reason TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT autonomous_pr_delivery_recovery_attempt_unique UNIQUE (delivery_id, attempt_number),
  CONSTRAINT autonomous_pr_delivery_recovery_terminal_check CHECK (
    (status = 'started' AND finished_at IS NULL AND head_sha_after IS NULL AND failure_reason IS NULL)
    OR
    (status = 'completed' AND finished_at IS NOT NULL AND head_sha_after IS NOT NULL AND failure_reason IS NULL)
    OR
    (status = 'failed' AND finished_at IS NOT NULL AND failure_reason IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_autonomous_pr_delivery_recovery_child
  ON autonomous_pr_delivery_recovery_attempts (child_run_id)
  WHERE child_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS autonomous_pr_delivery_merge_evidence (
  id UUID PRIMARY KEY,
  delivery_id UUID NOT NULL UNIQUE REFERENCES autonomous_pr_deliveries(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  policy_id UUID NOT NULL REFERENCES autonomous_delivery_policies(id) ON DELETE RESTRICT,
  policy_digest TEXT NOT NULL CHECK (policy_digest ~ '^sha256:[0-9a-f]{64}$'),
  github_evidence_id UUID NOT NULL REFERENCES github_pr_delivery_evidence(id) ON DELETE RESTRICT,
  lifecycle_merge_evidence_id BIGINT NOT NULL REFERENCES ssdlc_lifecycle_evidence(id) ON DELETE RESTRICT,
  merge_decision_id BIGINT NOT NULL REFERENCES ssdlc_decisions(id) ON DELETE RESTRICT,
  lifecycle_snapshot_id TEXT NOT NULL CHECK (btrim(lifecycle_snapshot_id) <> ''),
  evidence_high_water_mark TEXT NOT NULL CHECK (btrim(evidence_high_water_mark) <> ''),
  decision_high_water_mark TEXT NOT NULL CHECK (btrim(decision_high_water_mark) <> ''),
  repo_owner TEXT NOT NULL CHECK (btrim(repo_owner) <> ''),
  repo_name TEXT NOT NULL CHECK (btrim(repo_name) <> ''),
  pr_number INTEGER NOT NULL CHECK (pr_number > 0),
  expected_head_sha TEXT NOT NULL CHECK (expected_head_sha ~ '^[0-9a-f]{40,64}$'),
  merged_sha TEXT NOT NULL CHECK (merged_sha ~ '^[0-9a-f]{40,64}$'),
  merge_method TEXT NOT NULL CHECK (merge_method IN ('merge', 'squash', 'rebase')),
  provider_response_hash TEXT NOT NULL CHECK (provider_response_hash ~ '^sha256:[0-9a-f]{64}$'),
  merged_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT autonomous_pr_delivery_merge_identity_unique
    UNIQUE (workspace_id, repo_owner, repo_name, pr_number, expected_head_sha)
);

CREATE OR REPLACE FUNCTION guard_autonomous_pr_delivery_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'autonomous PR deliveries are audit-retained and cannot be deleted';
  END IF;
  IF (to_jsonb(OLD) - ARRAY[
        'status', 'current_head_sha', 'recovery_attempts', 'last_evidence_id',
        'merge_decision_id', 'authorization_snapshot_id', 'authorization_evidence_hwm',
        'authorization_decision_hwm', 'authorized_at', 'merged_sha', 'terminal_reason',
        'updated_at', 'completed_at'
      ]::text[])
      IS DISTINCT FROM
      (to_jsonb(NEW) - ARRAY[
        'status', 'current_head_sha', 'recovery_attempts', 'last_evidence_id',
        'merge_decision_id', 'authorization_snapshot_id', 'authorization_evidence_hwm',
        'authorization_decision_hwm', 'authorized_at', 'merged_sha', 'terminal_reason',
        'updated_at', 'completed_at'
      ]::text[]) THEN
    RAISE EXCEPTION 'autonomous PR delivery identity and authority snapshot are immutable';
  END IF;
  IF OLD.status IN ('merged', 'blocked', 'budget_exhausted') THEN
    RAISE EXCEPTION 'terminal autonomous PR delivery state is immutable';
  END IF;
  IF NEW.recovery_attempts < OLD.recovery_attempts THEN
    RAISE EXCEPTION 'autonomous PR delivery recovery attempts cannot decrease';
  END IF;
  IF NEW.recovery_attempts > OLD.recovery_attempts
     AND NEW.status NOT IN ('recovering_ci', 'recovering_conflict') THEN
    RAISE EXCEPTION 'autonomous PR delivery attempts advance only when recovery starts';
  END IF;
  IF NEW.current_head_sha <> OLD.current_head_sha
     AND NOT (OLD.status IN ('recovering_ci', 'recovering_conflict') AND NEW.status = 'queued') THEN
    RAISE EXCEPTION 'autonomous PR delivery head changes only after completed recovery';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status IN ('queued', 'awaiting_checks', 'awaiting_review', 'awaiting_human_approval')
      AND NEW.status IN ('observing', 'blocked', 'budget_exhausted'))
    OR (OLD.status = 'observing'
      AND NEW.status IN ('queued', 'awaiting_checks', 'awaiting_review', 'awaiting_human_approval',
                         'recovering_ci', 'recovering_conflict', 'authorized', 'blocked', 'budget_exhausted'))
    OR (OLD.status IN ('recovering_ci', 'recovering_conflict')
      AND NEW.status IN ('queued', 'blocked', 'budget_exhausted'))
    OR (OLD.status = 'authorized' AND NEW.status IN ('merging', 'blocked'))
    OR (OLD.status = 'merging' AND NEW.status IN ('merged', 'blocked'))
  ) THEN
    RAISE EXCEPTION 'illegal autonomous PR delivery state transition: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_autonomous_pr_delivery_guard ON autonomous_pr_deliveries;
CREATE TRIGGER trg_autonomous_pr_delivery_guard
  BEFORE UPDATE OR DELETE ON autonomous_pr_deliveries
  FOR EACH ROW EXECUTE FUNCTION guard_autonomous_pr_delivery_mutation();

CREATE OR REPLACE FUNCTION guard_autonomous_pr_recovery_attempt_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'autonomous PR recovery attempts are audit-retained and cannot be deleted';
  END IF;
  IF OLD.status <> 'started' OR NEW.status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'autonomous PR recovery attempt permits only one terminal transition';
  END IF;
  IF (to_jsonb(OLD) - ARRAY['status', 'head_sha_after', 'failure_reason', 'finished_at']::text[])
      IS DISTINCT FROM
      (to_jsonb(NEW) - ARRAY['status', 'head_sha_after', 'failure_reason', 'finished_at']::text[]) THEN
    RAISE EXCEPTION 'autonomous PR recovery attempt identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_autonomous_pr_recovery_attempt_guard ON autonomous_pr_delivery_recovery_attempts;
CREATE TRIGGER trg_autonomous_pr_recovery_attempt_guard
  BEFORE UPDATE OR DELETE ON autonomous_pr_delivery_recovery_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_autonomous_pr_recovery_attempt_mutation();

DROP TRIGGER IF EXISTS trg_autonomous_pr_delivery_events_append_only ON autonomous_pr_delivery_events;
CREATE TRIGGER trg_autonomous_pr_delivery_events_append_only
  BEFORE UPDATE OR DELETE ON autonomous_pr_delivery_events
  FOR EACH ROW EXECUTE FUNCTION reject_autonomous_delivery_append_only_mutation();

DROP TRIGGER IF EXISTS trg_autonomous_pr_merge_evidence_append_only ON autonomous_pr_delivery_merge_evidence;
CREATE TRIGGER trg_autonomous_pr_merge_evidence_append_only
  BEFORE UPDATE OR DELETE ON autonomous_pr_delivery_merge_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_autonomous_delivery_append_only_mutation();
