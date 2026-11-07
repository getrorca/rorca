-- 20260622120000_spec_post_save_run_policy_idempotency.sql — Include effective policy in run idempotency.
-- A save-generation idempotency key can be replayed with a changed post-save policy;
-- the durable workflow run identity must include that effective policy hash while the
-- active-policy partial unique index continues to block duplicate active work for the
-- same workspace/spec/policy.

ALTER TABLE spec_post_save_workflow_runs
  DROP CONSTRAINT IF EXISTS spec_post_save_workflow_runs_idempotency_unique;

ALTER TABLE spec_post_save_workflow_runs
  ADD CONSTRAINT spec_post_save_workflow_runs_idempotency_unique
    UNIQUE (workspace_id, spec_id, effective_policy_hash, idempotency_key);
