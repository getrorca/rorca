-- Repository-scoped provider authority leases. Credential values remain in the
-- canonical provider process cache; this relation stores only bounded authority
-- metadata and settlement facts.

ALTER TABLE github_app_workspace_bindings
  ADD COLUMN IF NOT EXISTS binding_generation BIGINT NOT NULL DEFAULT 1
  CHECK (binding_generation > 0);

CREATE OR REPLACE FUNCTION advance_github_app_binding_generation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.binding_generation IS DISTINCT FROM OLD.binding_generation THEN
    RAISE EXCEPTION 'GitHub App binding generation is database-managed';
  END IF;

  IF NEW.permissions IS DISTINCT FROM OLD.permissions
     OR NEW.events IS DISTINCT FROM OLD.events
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.validation_error_code IS DISTINCT FROM OLD.validation_error_code
     OR NEW.provider_profile_verified_at IS DISTINCT FROM OLD.provider_profile_verified_at
     OR NEW.provider_hook_configured IS DISTINCT FROM OLD.provider_hook_configured
     OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    NEW.binding_generation := OLD.binding_generation + 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_github_app_binding_advance_generation ON github_app_workspace_bindings;
CREATE TRIGGER trg_github_app_binding_advance_generation
  BEFORE UPDATE ON github_app_workspace_bindings
  FOR EACH ROW EXECUTE FUNCTION advance_github_app_binding_generation();

-- Preserve the canonical immutable binding identity while allowing the
-- generation trigger to advance its monotonic fence.
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
        'superseded_by_principal','replacement_reason','binding_generation'
      ]::text[])
     IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY[
        'permissions','events','status','last_validated_at','last_webhook_at',
        'validation_error_code','status_changed_at','provider_profile_verified_at',
        'provider_hook_configured','signed_delivery_observed','superseded_at',
        'superseded_by_principal','replacement_reason','binding_generation'
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

CREATE TABLE IF NOT EXISTS provider_authority_leases (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  provider_id TEXT NOT NULL CHECK (provider_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  provider_binding_id TEXT NOT NULL CHECK (btrim(provider_binding_id) <> ''),
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  authority_grant_id UUID NOT NULL UNIQUE,
  repository_external_id TEXT NOT NULL CHECK (btrim(repository_external_id) <> ''),
  repository_owner TEXT NOT NULL CHECK (btrim(repository_owner) <> ''),
  repository_name TEXT NOT NULL CHECK (btrim(repository_name) <> ''),
  capabilities JSONB NOT NULL CHECK (
    jsonb_typeof(capabilities) = 'array'
    AND jsonb_array_length(capabilities) BETWEEN 1 AND 5
    AND capabilities <@ '["scm.repository.read","scm.branch.write","scm.pull_request.write","scm.checks.read","scm.review.request"]'::jsonb
    AND jsonb_array_length(capabilities) =
      CASE WHEN capabilities @> '["scm.repository.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN capabilities @> '["scm.branch.write"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN capabilities @> '["scm.pull_request.write"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN capabilities @> '["scm.checks.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN capabilities @> '["scm.review.request"]'::jsonb THEN 1 ELSE 0 END
  ),
  permissions JSONB NOT NULL CHECK (
    jsonb_typeof(permissions) = 'object'
    AND permissions ->> 'metadata' = 'read'
    AND permissions - ARRAY['metadata','contents','pull_requests','checks'] = '{}'::jsonb
    AND CASE
      WHEN capabilities @> '["scm.branch.write"]'::jsonb THEN permissions ->> 'contents' = 'write'
      WHEN capabilities @> '["scm.repository.read"]'::jsonb THEN permissions ->> 'contents' = 'read'
      ELSE NOT (permissions ? 'contents')
    END
    AND CASE
      WHEN capabilities @> '["scm.pull_request.write"]'::jsonb
        OR capabilities @> '["scm.review.request"]'::jsonb
        THEN permissions ->> 'pull_requests' = 'write'
      ELSE NOT (permissions ? 'pull_requests')
    END
    AND CASE
      WHEN capabilities @> '["scm.checks.read"]'::jsonb THEN permissions ->> 'checks' = 'read'
      ELSE NOT (permissions ? 'checks')
    END
  ),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'settled', 'reconciliation_required')),
  minted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  settlement_outcome TEXT CHECK (settlement_outcome IS NULL OR settlement_outcome IN ('completed','denied','cancelled','expired','failed')),
  settlement_kind TEXT CHECK (settlement_kind IS NULL OR settlement_kind IN ('revoked','verified_expiry','revocation_failed')),
  settled_at TIMESTAMPTZ,
  revocation_verified_at TIMESTAMPTZ,
  CONSTRAINT provider_authority_lease_expiry_check CHECK (
    expires_at > minted_at AND expires_at <= minted_at + INTERVAL '2 hours'
  ),
  CONSTRAINT provider_authority_lease_settlement_check CHECK (
    (state = 'active' AND settlement_outcome IS NULL AND settlement_kind IS NULL AND settled_at IS NULL AND revocation_verified_at IS NULL)
    OR (state = 'settled' AND settlement_outcome IS NOT NULL AND settlement_kind IN ('revoked','verified_expiry')
        AND settled_at IS NOT NULL AND revocation_verified_at IS NOT NULL)
    OR (state = 'reconciliation_required' AND settlement_outcome IS NOT NULL AND settlement_kind = 'revocation_failed'
        AND settled_at IS NOT NULL AND revocation_verified_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_provider_authority_leases_binding_state
  ON provider_authority_leases (workspace_id, provider_id, provider_binding_id, state, expires_at);

CREATE OR REPLACE FUNCTION guard_provider_authority_lease()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Provider authority leases are audit-retained';
  END IF;
  IF OLD.state <> 'active' THEN
    RAISE EXCEPTION 'Settled provider authority lease facts are immutable';
  END IF;
  IF (to_jsonb(OLD) - ARRAY['state','settlement_outcome','settlement_kind','settled_at','revocation_verified_at']::text[])
     IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY['state','settlement_outcome','settlement_kind','settled_at','revocation_verified_at']::text[]) THEN
    RAISE EXCEPTION 'Provider authority lease identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_provider_authority_lease_guard ON provider_authority_leases;
CREATE TRIGGER trg_provider_authority_lease_guard
  BEFORE UPDATE OR DELETE ON provider_authority_leases
  FOR EACH ROW EXECUTE FUNCTION guard_provider_authority_lease();

DROP TRIGGER IF EXISTS trg_provider_authority_lease_no_truncate ON provider_authority_leases;
CREATE TRIGGER trg_provider_authority_lease_no_truncate
  BEFORE TRUNCATE ON provider_authority_leases
  FOR EACH STATEMENT EXECUTE FUNCTION guard_provider_authority_lease();

REVOKE ALL PRIVILEGES ON TABLE provider_authority_leases FROM PUBLIC;
