-- 20260718170000_gate6_release_contract.sql
-- Gate 6: make release_pending writable, freeze direct-base/release-ref identity,
-- and align all new governed commit subjects to the canonical 40-hex Git SHA.

-- The original unnamed CHECK from 001_init.sql is named by PostgreSQL using
-- this deterministic table/column convention. Replace it upgrade-safely.
ALTER TABLE pipeline_runs
  DROP CONSTRAINT IF EXISTS pipeline_runs_status_check,
  ADD CONSTRAINT pipeline_runs_status_check CHECK (status IN (
    'running', 'paused', 'done', 'failed', 'partial_failure', 'cancelled',
    'queued', 'release_pending', 'pi_native'
  ));

ALTER TABLE pipeline_run_release_intents
  ADD COLUMN IF NOT EXISTS base_branch TEXT,
  ADD COLUMN IF NOT EXISTS base_sha CHAR(40),
  ADD COLUMN IF NOT EXISTS provider_release_ref TEXT,
  ADD COLUMN IF NOT EXISTS integration_checkout_path TEXT;

-- NOT VALID preserves historical rows created before exact base identity was
-- available while enforcing the complete contract for every new/updated row.
ALTER TABLE pipeline_run_release_intents
  DROP CONSTRAINT IF EXISTS pipeline_run_release_intents_base_identity_ck,
  ADD CONSTRAINT pipeline_run_release_intents_base_identity_ck CHECK (
    NULLIF(btrim(base_branch), '') IS NOT NULL
    AND base_sha ~ '^[0-9a-f]{40}$'
    AND NULLIF(btrim(integration_checkout_path), '') IS NOT NULL
    AND (
      (external_send AND merge_strategy IN ('pr', 'draft-pr', 'branch-only')
        AND NULLIF(btrim(provider_release_ref), '') IS NOT NULL)
      OR
      (NOT external_send OR merge_strategy = 'direct')
    )
  ) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_release_provider_ref_unique
  ON pipeline_run_release_intents (
    lower(repository_owner), lower(repository_name), provider_release_ref
  )
  WHERE provider_release_ref IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_pipeline_run_release_intent_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.spec_id IS DISTINCT FROM OLD.spec_id
    OR NEW.authorized_sha IS DISTINCT FROM OLD.authorized_sha
    OR NEW.branch_name IS DISTINCT FROM OLD.branch_name
    OR NEW.execution_workspace_path IS DISTINCT FROM OLD.execution_workspace_path
    OR NEW.execution_worktree_path IS DISTINCT FROM OLD.execution_worktree_path
    OR NEW.repository_owner IS DISTINCT FROM OLD.repository_owner
    OR NEW.repository_name IS DISTINCT FROM OLD.repository_name
    OR NEW.repository_authority_source IS DISTINCT FROM OLD.repository_authority_source
    OR NEW.repository_binding_id IS DISTINCT FROM OLD.repository_binding_id
    OR NEW.repository_installation_id IS DISTINCT FROM OLD.repository_installation_id
    OR NEW.repository_id IS DISTINCT FROM OLD.repository_id
    OR NEW.merge_strategy IS DISTINCT FROM OLD.merge_strategy
    OR NEW.auto_merge IS DISTINCT FROM OLD.auto_merge
    OR NEW.external_send IS DISTINCT FROM OLD.external_send
    OR NEW.deployment_allowed IS DISTINCT FROM OLD.deployment_allowed
    OR NEW.identity_hash IS DISTINCT FROM OLD.identity_hash
    OR NEW.base_branch IS DISTINCT FROM OLD.base_branch
    OR NEW.base_sha IS DISTINCT FROM OLD.base_sha
    OR NEW.provider_release_ref IS DISTINCT FROM OLD.provider_release_ref
    OR NEW.integration_checkout_path IS DISTINCT FROM OLD.integration_checkout_path
  ) THEN
    RAISE EXCEPTION 'pipeline run release intent authority identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Historical 64-hex values remain readable for audit but cannot authorize in
-- runtime schemas. PostgreSQL enforces 40-hex for every new commit subject.
ALTER TABLE ssdlc_decisions
  DROP CONSTRAINT IF EXISTS ssdlc_decisions_commit_subject_sha_ck,
  ADD CONSTRAINT ssdlc_decisions_commit_subject_sha_ck CHECK (
    subject_type IS DISTINCT FROM 'commit_sha'
    OR subject_value ~ '^[0-9a-f]{40}$'
  ) NOT VALID;

-- Workflow dispatch is hard disabled. New/revalidated App profiles require only
-- Actions read; historical actions:write bindings remain audit data but become
-- fail-closed invalid until the provider profile is explicitly downgraded and
-- revalidated by an authorized operator.
CREATE OR REPLACE VIEW github_workspace_repository_authority AS
SELECT b.workspace_id,
       b.repo_owner,
       b.repo_name,
       'github-app-installation'::text AS authority_source,
       CASE
         WHEN b.status = 'disabled' THEN 'disabled'
         WHEN b.status = 'active' AND r.status = 'active' AND i.status = 'active'
              AND b.provider_profile_verified_at >= NOW() - INTERVAL '24 hours'
              AND b.provider_hook_configured = TRUE
              AND b.permissions = '{"metadata":"read","actions":"read","checks":"write","contents":"write","issues":"read","pull_requests":"write","statuses":"write"}'::jsonb
              AND jsonb_array_length(b.events) = 4
              AND b.events @> '["check_run","issues","pull_request","push"]'::jsonb THEN 'active'
         ELSE 'invalid'
       END::text AS authority_status,
       b.id AS binding_id,
       b.installation_id,
       b.repository_id,
       b.provider_hook_configured AS webhook_configured,
       b.signed_delivery_observed,
       b.created_at AS connected_at,
       b.last_webhook_at,
       COALESCE(c.auto_pr_enabled, FALSE) AS auto_pr_enabled,
       COALESCE(c.auto_pr_target_branch, 'main') AS auto_pr_target_branch,
       COALESCE(c.auto_pr_reviewers, '[]'::jsonb) AS auto_pr_reviewers,
       c.workflow_config
  FROM github_app_workspace_bindings b
  JOIN github_app_registrations r ON r.id = b.registration_id
  JOIN github_app_installations i
    ON i.id = b.installation_record_id
   AND i.registration_id = b.registration_id
   AND i.installation_id = b.installation_id
  LEFT JOIN github_repository_configs c ON c.workspace_id = b.workspace_id
 WHERE b.superseded_at IS NULL
UNION ALL
SELECT w.workspace_id,
       w.repo_owner,
       w.repo_name,
       'pat-oauth-fallback'::text AS authority_source,
       w.authority_status::text AS authority_status,
       NULL::uuid AS binding_id,
       NULL::bigint AS installation_id,
       NULL::bigint AS repository_id,
       (w.webhook_id IS NOT NULL)::boolean AS webhook_configured,
       (w.last_webhook_at IS NOT NULL)::boolean AS signed_delivery_observed,
       w.created_at AS connected_at,
       w.last_webhook_at,
       COALESCE(c.auto_pr_enabled, w.auto_pr_enabled) AS auto_pr_enabled,
       COALESCE(c.auto_pr_target_branch, w.auto_pr_target_branch) AS auto_pr_target_branch,
       COALESCE(c.auto_pr_reviewers, w.auto_pr_reviewers) AS auto_pr_reviewers,
       COALESCE(c.workflow_config, w.workflow_config) AS workflow_config
  FROM workspace_github_webhooks w
  LEFT JOIN github_repository_configs c ON c.workspace_id = w.workspace_id
 WHERE w.authority_status = 'active' AND w.webhook_secret_revoked_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM github_app_workspace_bindings b
      WHERE b.workspace_id = w.workspace_id AND b.superseded_at IS NULL
   );
