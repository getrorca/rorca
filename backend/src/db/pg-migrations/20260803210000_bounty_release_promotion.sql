-- Trusted post-commit release promotion receipts. These rows are append-only and
-- may only be referenced by an enabled bounty policy revision.
CREATE TABLE IF NOT EXISTS bounty_release_promotions (
  id UUID PRIMARY KEY,
  qualification_receipt_hash TEXT NOT NULL CHECK (qualification_receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  source_sha TEXT NOT NULL CHECK (source_sha ~ '^[0-9a-f]{40,64}$'),
  bindings JSONB NOT NULL,
  bindings_hash TEXT NOT NULL CHECK (bindings_hash ~ '^sha256:[0-9a-f]{64}$'),
  signer_key_hash TEXT NOT NULL CHECK (signer_key_hash ~ '^sha256:[0-9a-f]{64}$'),
  signed_payload JSONB NOT NULL,
  signature TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  admitted_by TEXT NOT NULL CHECK (length(trim(admitted_by)) > 0),
  admitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > issued_at)
);

CREATE TABLE IF NOT EXISTS bounty_release_promotion_revocations (
  promotion_id UUID PRIMARY KEY REFERENCES bounty_release_promotions(id),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  revoked_by TEXT NOT NULL CHECK (length(trim(revoked_by)) > 0),
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE bounty_feature_policy
  ADD COLUMN IF NOT EXISTS promotion_receipt_id UUID REFERENCES bounty_release_promotions(id);
ALTER TABLE bounty_feature_policy_audit
  ADD COLUMN IF NOT EXISTS promotion_receipt_id UUID REFERENCES bounty_release_promotions(id);

CREATE OR REPLACE FUNCTION reject_bounty_release_promotion_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'bounty release promotion rows are immutable';
END;
$$;

DROP TRIGGER IF EXISTS bounty_release_promotions_immutable ON bounty_release_promotions;
CREATE TRIGGER bounty_release_promotions_immutable
BEFORE UPDATE OR DELETE ON bounty_release_promotions
FOR EACH ROW EXECUTE FUNCTION reject_bounty_release_promotion_mutation();

DROP TRIGGER IF EXISTS bounty_release_promotion_revocations_immutable ON bounty_release_promotion_revocations;
CREATE TRIGGER bounty_release_promotion_revocations_immutable
BEFORE UPDATE OR DELETE ON bounty_release_promotion_revocations
FOR EACH ROW EXECUTE FUNCTION reject_bounty_release_promotion_mutation();
