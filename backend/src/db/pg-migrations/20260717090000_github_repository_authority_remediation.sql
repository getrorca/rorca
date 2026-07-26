-- 20260717090000_github_repository_authority_remediation.sql
-- Canonical GitHub repository authority, immutable App identity, typed vault
-- references, and audit-retained binding replacement.

-- Secret references can now prove both provider and secret kind through a FK.
CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_vault_secret_typed_identity
  ON integration_vault_secrets (id, provider, secret_kind);

ALTER TABLE github_app_registrations
  ADD COLUMN IF NOT EXISTS private_key_provider TEXT NOT NULL DEFAULT 'github_app',
  ADD COLUMN IF NOT EXISTS private_key_secret_kind TEXT NOT NULL DEFAULT 'private_key',
  ADD COLUMN IF NOT EXISTS webhook_secret_provider TEXT NOT NULL DEFAULT 'github_app',
  ADD COLUMN IF NOT EXISTS webhook_secret_kind TEXT NOT NULL DEFAULT 'webhook_secret';

ALTER TABLE github_app_registrations
  DROP CONSTRAINT IF EXISTS github_app_registration_private_key_type_check,
  ADD CONSTRAINT github_app_registration_private_key_type_check
    CHECK (private_key_provider = 'github_app' AND private_key_secret_kind = 'private_key'),
  DROP CONSTRAINT IF EXISTS github_app_registration_webhook_secret_type_check,
  ADD CONSTRAINT github_app_registration_webhook_secret_type_check
    CHECK (webhook_secret_provider = 'github_app' AND webhook_secret_kind = 'webhook_secret'),
  DROP CONSTRAINT IF EXISTS github_app_registration_private_key_typed_fk,
  ADD CONSTRAINT github_app_registration_private_key_typed_fk
    FOREIGN KEY (private_key_secret_id, private_key_provider, private_key_secret_kind)
    REFERENCES integration_vault_secrets(id, provider, secret_kind) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS github_app_registration_webhook_secret_typed_fk,
  ADD CONSTRAINT github_app_registration_webhook_secret_typed_fk
    FOREIGN KEY (webhook_secret_id, webhook_secret_provider, webhook_secret_kind)
    REFERENCES integration_vault_secrets(id, provider, secret_kind) ON DELETE RESTRICT;

-- Drop the dependent two-column binding FK before replacing its referenced
-- installation uniqueness with the full immutable installation identity.
ALTER TABLE github_app_workspace_bindings
  DROP CONSTRAINT IF EXISTS ga_binding_installation_registration_fk;

ALTER TABLE github_app_installations
  DROP CONSTRAINT IF EXISTS ga_install_id_registration_key,
  ADD CONSTRAINT ga_install_identity_key
    UNIQUE (id, registration_id, installation_id);

ALTER TABLE github_app_workspace_bindings
  ADD COLUMN IF NOT EXISTS provider_profile_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_hook_configured BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS signed_delivery_observed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS superseded_by_principal TEXT,
  ADD COLUMN IF NOT EXISTS replacement_reason TEXT;

-- Replace the original global uniqueness constraints with one current binding.
ALTER TABLE github_app_workspace_bindings
  DROP CONSTRAINT IF EXISTS ga_binding_workspace_key,
  DROP CONSTRAINT IF EXISTS ga_binding_registration_repository_key,
  DROP CONSTRAINT IF EXISTS ga_binding_registration_install_repo_key;
DROP INDEX IF EXISTS uq_github_app_binding_repo_name_ci;

ALTER TABLE github_app_workspace_bindings
  DROP CONSTRAINT IF EXISTS ga_binding_installation_identity_fk,
  ADD CONSTRAINT ga_binding_installation_identity_fk
    FOREIGN KEY (installation_record_id, registration_id, installation_id)
    REFERENCES github_app_installations(id, registration_id, installation_id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS github_app_binding_supersession_check,
  ADD CONSTRAINT github_app_binding_supersession_check CHECK (
    (superseded_at IS NULL AND superseded_by_principal IS NULL AND replacement_reason IS NULL)
    OR (superseded_at IS NOT NULL AND btrim(COALESCE(superseded_by_principal, '')) <> ''
        AND btrim(COALESCE(replacement_reason, '')) <> '' AND status = 'disabled')
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_github_app_one_current_workspace_binding
  ON github_app_workspace_bindings (workspace_id) WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_github_app_one_current_repository_binding
  ON github_app_workspace_bindings (registration_id, repository_id) WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_github_app_current_repo_name_ci
  ON github_app_workspace_bindings (registration_id, lower(repo_owner), lower(repo_name))
  WHERE superseded_at IS NULL;

-- Retain neutral workflow/PR configuration independently from webhook secrets.
CREATE TABLE IF NOT EXISTS github_repository_configs (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_owner TEXT NOT NULL CHECK (repo_owner ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$'),
  repo_name TEXT NOT NULL CHECK (repo_name ~ '^[A-Za-z0-9._-]{1,100}$'),
  auto_pr_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  auto_pr_target_branch TEXT NOT NULL DEFAULT 'main' CHECK (btrim(auto_pr_target_branch) <> ''),
  auto_pr_reviewers JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(auto_pr_reviewers) = 'array'),
  workflow_config JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO github_repository_configs
  (workspace_id, repo_owner, repo_name, auto_pr_enabled, auto_pr_target_branch,
   auto_pr_reviewers, workflow_config, created_at)
SELECT workspace_id, repo_owner, repo_name, auto_pr_enabled, auto_pr_target_branch,
       auto_pr_reviewers, workflow_config, created_at
  FROM workspace_github_webhooks
ON CONFLICT (workspace_id) DO NOTHING;

ALTER TABLE workspace_github_webhooks
  ADD COLUMN IF NOT EXISTS authority_status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retirement_reason TEXT,
  ADD COLUMN IF NOT EXISTS webhook_secret_revoked_at TIMESTAMPTZ;
ALTER TABLE workspace_github_webhooks
  DROP CONSTRAINT IF EXISTS workspace_github_webhooks_authority_status_check,
  ADD CONSTRAINT workspace_github_webhooks_authority_status_check CHECK (
    (authority_status = 'active' AND retired_at IS NULL AND retirement_reason IS NULL AND webhook_secret_revoked_at IS NULL)
    OR (authority_status = 'retired' AND retired_at IS NOT NULL AND webhook_secret_revoked_at IS NOT NULL
        AND btrim(COALESCE(retirement_reason, '')) <> '')
  );

-- One canonical read model. Any current App binding wins even when disabled or
-- invalid, which prevents silent privilege fallback to a legacy secret.
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
              AND b.permissions = '{"metadata":"read","actions":"write","checks":"write","contents":"write","issues":"read","pull_requests":"write","statuses":"write"}'::jsonb
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

CREATE OR REPLACE FUNCTION guard_github_app_registration_identity()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'GitHub App registrations are audit-retained';
  END IF;
  IF (to_jsonb(OLD) - ARRAY['status','updated_at','disabled_at']::text[])
     IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY['status','updated_at','disabled_at']::text[]) THEN
    RAISE EXCEPTION 'GitHub App registration identity and secret references are immutable; create a replacement registration';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_github_app_registration_identity ON github_app_registrations;
CREATE TRIGGER trg_github_app_registration_identity
  BEFORE UPDATE OR DELETE ON github_app_registrations
  FOR EACH ROW EXECUTE FUNCTION guard_github_app_registration_identity();

CREATE OR REPLACE FUNCTION guard_github_app_installation_identity()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'GitHub App installations are audit-retained';
  END IF;
  IF (to_jsonb(OLD) - ARRAY['status','last_validated_at','status_changed_at']::text[])
     IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY['status','last_validated_at','status_changed_at']::text[]) THEN
    RAISE EXCEPTION 'GitHub App installation identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_github_app_installation_identity ON github_app_installations;
CREATE TRIGGER trg_github_app_installation_identity
  BEFORE UPDATE OR DELETE ON github_app_installations
  FOR EACH ROW EXECUTE FUNCTION guard_github_app_installation_identity();

CREATE OR REPLACE FUNCTION guard_github_app_binding_identity()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'GitHub App bindings are audit-retained; supersede instead of deleting';
  END IF;
  IF (to_jsonb(OLD) - ARRAY[
        'permissions','events','status','last_validated_at','last_webhook_at',
        'validation_error_code','status_changed_at','provider_profile_verified_at',
        'provider_hook_configured','signed_delivery_observed','superseded_at',
        'superseded_by_principal','replacement_reason'
      ]::text[])
     IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY[
        'permissions','events','status','last_validated_at','last_webhook_at',
        'validation_error_code','status_changed_at','provider_profile_verified_at',
        'provider_hook_configured','signed_delivery_observed','superseded_at',
        'superseded_by_principal','replacement_reason'
      ]::text[]) THEN
    RAISE EXCEPTION 'GitHub App workspace/repository/installation binding identity is immutable';
  END IF;
  IF OLD.superseded_at IS NOT NULL AND (
       NEW.superseded_at IS DISTINCT FROM OLD.superseded_at
       OR NEW.superseded_by_principal IS DISTINCT FROM OLD.superseded_by_principal
       OR NEW.replacement_reason IS DISTINCT FROM OLD.replacement_reason
     ) THEN
    RAISE EXCEPTION 'GitHub App binding supersession evidence is immutable';
  END IF;
  IF OLD.superseded_at IS NULL AND NEW.superseded_at IS NULL AND (
       NEW.superseded_by_principal IS NOT NULL OR NEW.replacement_reason IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'GitHub App binding supersession evidence must be written atomically';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_github_app_binding_identity ON github_app_workspace_bindings;
CREATE TRIGGER trg_github_app_binding_identity
  BEFORE UPDATE OR DELETE ON github_app_workspace_bindings
  FOR EACH ROW EXECUTE FUNCTION guard_github_app_binding_identity();

-- The existing webhook ledger supports bounded at-least-once redelivery. A
-- fresh claim token prevents a stale request from acknowledging a reclaimed
-- delivery; payloads remain provider-redelivered rather than duplicated here.
ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
UPDATE webhook_events
   SET processing_started_at = COALESCE(processing_started_at, created_at),
       claim_token = COALESCE(claim_token, md5(provider || ':' || delivery_id || ':' || id::text)::uuid),
       attempt_count = GREATEST(attempt_count, 1)
 WHERE status = 'processing';
UPDATE webhook_events
   SET completed_at = COALESCE(completed_at, created_at)
 WHERE status = 'completed';
ALTER TABLE webhook_events
  DROP CONSTRAINT IF EXISTS ga_webhook_event_claim_state_check,
  ADD CONSTRAINT ga_webhook_event_claim_state_check CHECK (
    attempt_count >= 0 AND attempt_count <= 5
    AND (status <> 'processing' OR (claim_token IS NOT NULL AND processing_started_at IS NOT NULL))
    AND (status <> 'completed' OR completed_at IS NOT NULL)
  );
CREATE INDEX IF NOT EXISTS idx_webhook_events_reclaim
  ON webhook_events (provider, status, processing_started_at)
  WHERE status IN ('processing', 'failed');

-- Manifest state remains one-time, operator/session bound and CSRF middleware
-- still protects each local POST. A regenerated browser CSRF token is not used
-- as a cross-site callback identity.
ALTER TABLE github_app_setup_states ALTER COLUMN csrf_digest DROP NOT NULL;
