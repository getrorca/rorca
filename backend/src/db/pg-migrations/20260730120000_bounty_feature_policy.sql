-- Operator-owned, fail-closed feature boundary for bounty target effects.
-- Repository/workspace configuration is deliberately not consulted by this policy.

CREATE TABLE IF NOT EXISTS bounty_feature_policy (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  state TEXT NOT NULL CHECK (state IN ('disabled', 'enabled')),
  mission_mode TEXT NOT NULL CHECK (mission_mode = 'bounty'),
  revision BIGINT NOT NULL CHECK (revision > 0),
  audit_identity TEXT NOT NULL CHECK (length(trim(audit_identity)) > 0),
  authority_source TEXT NOT NULL CHECK (authority_source = 'admin_mutation'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bounty_feature_policy_audit (
  id BIGSERIAL PRIMARY KEY,
  previous_state TEXT CHECK (previous_state IS NULL OR previous_state IN ('disabled', 'enabled')),
  state TEXT NOT NULL CHECK (state IN ('disabled', 'enabled')),
  mission_mode TEXT NOT NULL CHECK (mission_mode = 'bounty'),
  revision BIGINT NOT NULL CHECK (revision > 0),
  audit_identity TEXT NOT NULL CHECK (length(trim(audit_identity)) > 0),
  authority_source TEXT NOT NULL CHECK (authority_source = 'admin_mutation'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS bounty_feature_policy_audit_revision_idx
  ON bounty_feature_policy_audit(revision);

CREATE OR REPLACE FUNCTION reject_bounty_policy_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'bounty feature policy audit rows are immutable';
END;
$$;

DROP TRIGGER IF EXISTS bounty_feature_policy_audit_immutable ON bounty_feature_policy_audit;
CREATE TRIGGER bounty_feature_policy_audit_immutable
BEFORE UPDATE OR DELETE ON bounty_feature_policy_audit
FOR EACH ROW EXECUTE FUNCTION reject_bounty_policy_audit_mutation();
