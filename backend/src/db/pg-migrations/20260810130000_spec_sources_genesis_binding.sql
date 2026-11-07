-- 20260810130000_spec_sources_genesis_binding.sql
-- Genesis binding columns for spec_sources. A genesis-bound row records the
-- immutable authority projection a spec was bound to (package/evidence
-- identity, hashes, citation summary, chunk ids, citations, review state,
-- sensitivity) plus the principal who bound it. Genesis-bound rows are
-- immutable after insert: the bridge-owned projection must stay byte-for-byte
-- stable for the life of the binding. Webhook-discovered rows (source_kind
-- IS NULL) keep the historical mutable refresh workflow.
-- runPgMigrations supplies the transaction boundary for this file.

ALTER TABLE spec_sources
  ADD COLUMN IF NOT EXISTS source_kind TEXT,
  ADD COLUMN IF NOT EXISTS source_id TEXT,
  ADD COLUMN IF NOT EXISTS package_hash TEXT,
  ADD COLUMN IF NOT EXISTS content_hash TEXT,
  ADD COLUMN IF NOT EXISTS citation_summary TEXT,
  ADD COLUMN IF NOT EXISTS evidence_chunk_ids JSONB,
  ADD COLUMN IF NOT EXISTS citations JSONB,
  ADD COLUMN IF NOT EXISTS review_status TEXT,
  ADD COLUMN IF NOT EXISTS sensitivity TEXT,
  ADD COLUMN IF NOT EXISTS bound_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bound_by TEXT;

ALTER TABLE spec_sources DROP CONSTRAINT IF EXISTS spec_sources_source_kind_ck;
ALTER TABLE spec_sources ADD CONSTRAINT spec_sources_source_kind_ck
  CHECK (source_kind IS NULL OR source_kind IN ('genesis_package', 'genesis_evidence'));

ALTER TABLE spec_sources DROP CONSTRAINT IF EXISTS spec_sources_binding_complete_ck;
ALTER TABLE spec_sources ADD CONSTRAINT spec_sources_binding_complete_ck
  CHECK (source_kind IS NULL OR (
    source_id IS NOT NULL AND package_hash IS NOT NULL AND content_hash IS NOT NULL
    AND citation_summary IS NOT NULL AND evidence_chunk_ids IS NOT NULL
    AND citations IS NOT NULL AND review_status IS NOT NULL AND sensitivity IS NOT NULL
    AND bound_at IS NOT NULL AND bound_by IS NOT NULL
  ));

ALTER TABLE spec_sources DROP CONSTRAINT IF EXISTS spec_sources_package_hash_ck;
ALTER TABLE spec_sources ADD CONSTRAINT spec_sources_package_hash_ck
  CHECK (package_hash IS NULL OR package_hash ~ '^sha256:[a-f0-9]{64}$');

ALTER TABLE spec_sources DROP CONSTRAINT IF EXISTS spec_sources_content_hash_ck;
ALTER TABLE spec_sources ADD CONSTRAINT spec_sources_content_hash_ck
  CHECK (content_hash IS NULL OR content_hash ~ '^sha256:[a-f0-9]{64}$');

ALTER TABLE spec_sources DROP CONSTRAINT IF EXISTS spec_sources_review_status_ck;
ALTER TABLE spec_sources ADD CONSTRAINT spec_sources_review_status_ck
  CHECK (review_status IS NULL OR review_status IN ('approved', 'trusted', 'pending', 'unreviewed'));

ALTER TABLE spec_sources DROP CONSTRAINT IF EXISTS spec_sources_sensitivity_ck;
ALTER TABLE spec_sources ADD CONSTRAINT spec_sources_sensitivity_ck
  CHECK (sensitivity IS NULL OR sensitivity IN ('public', 'internal', 'confidential', 'restricted'));

CREATE OR REPLACE FUNCTION spec_sources_binding_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.source_kind IS NOT NULL THEN
    RAISE EXCEPTION 'spec_sources row bound to % is immutable', OLD.source_kind
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS spec_sources_binding_immutable_trigger ON spec_sources;
CREATE TRIGGER spec_sources_binding_immutable_trigger
BEFORE UPDATE OR DELETE ON spec_sources
FOR EACH ROW EXECUTE FUNCTION spec_sources_binding_immutable();

COMMENT ON TABLE spec_sources IS
  'Spec provenance: mutable webhook discovery plus immutable Genesis bridge bindings.';
