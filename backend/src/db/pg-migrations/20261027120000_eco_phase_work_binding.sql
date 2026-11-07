-- Additive immutable external-work pins; NOT evidence acceptance, tool policy,
-- execution authority, a scheduling queue, or a lease allocator.
CREATE UNIQUE INDEX IF NOT EXISTS eco_claim_workspace_identity
  ON ssdlc_lifecycle_dispatch_claims(claim_id,workspace_id);
CREATE TABLE IF NOT EXISTS eco_phase_work_revisions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  phase_work_id UUID NOT NULL,
  revision BIGINT NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  content_hash TEXT NOT NULL CHECK(content_hash ~ '^sha256:[0-9a-f]{64}$'),
  canonical_body JSONB NOT NULL,
  canonical_bytes TEXT NOT NULL CHECK(octet_length(canonical_bytes)<=1048576),
  recipe_hash TEXT NOT NULL CHECK(recipe_hash ~ '^sha256:[0-9a-f]{64}$'),
  source_set_hash TEXT NOT NULL CHECK(source_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,phase_work_id,revision),
  UNIQUE(workspace_id,phase_work_id,revision,content_hash),
  CHECK(canonical_bytes::jsonb=canonical_body),
  CHECK(content_hash='sha256:'||encode(digest(convert_to(canonical_bytes,'UTF8'),'sha256'),'hex')),
  CHECK(canonical_body->>'workspaceId'=workspace_id),
  CHECK(canonical_body->>'id'=phase_work_id::text),
  CHECK((canonical_body->>'revision')::bigint=revision),
  CHECK(canonical_body->'recipeBinding'->>'contentHash'=recipe_hash)
);
CREATE TABLE IF NOT EXISTS eco_phase_dispatch_bindings (
  claim_id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  phase_work_id UUID NOT NULL,
  revision BIGINT NOT NULL,
  content_hash TEXT NOT NULL,
  provider_spec_version TEXT NOT NULL CHECK(length(provider_spec_version) BETWEEN 1 AND 256),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(claim_id,workspace_id) REFERENCES ssdlc_lifecycle_dispatch_claims(claim_id,workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,phase_work_id,revision,content_hash)
    REFERENCES eco_phase_work_revisions(workspace_id,phase_work_id,revision,content_hash) ON DELETE RESTRICT,
  -- Conservative reservation: uncertain/terminal claims cannot be silently
  -- replaced by a fresh key. Explicit successor protocol is not implemented.
  UNIQUE(workspace_id,phase_work_id,revision)
);
CREATE OR REPLACE FUNCTION guard_eco_phase_work_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'External phase-work pins are immutable'; END $$;
CREATE TRIGGER eco_phase_work_revision_immutable BEFORE UPDATE OR DELETE ON eco_phase_work_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_eco_phase_work_immutable();
CREATE TRIGGER eco_phase_work_binding_immutable BEFORE UPDATE OR DELETE ON eco_phase_dispatch_bindings
  FOR EACH ROW EXECUTE FUNCTION guard_eco_phase_work_immutable();
CREATE TRIGGER eco_phase_work_revision_no_truncate BEFORE TRUNCATE ON eco_phase_work_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION guard_eco_phase_work_immutable();
CREATE TRIGGER eco_phase_work_binding_no_truncate BEFORE TRUNCATE ON eco_phase_dispatch_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION guard_eco_phase_work_immutable();
ALTER TABLE eco_phase_work_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE eco_phase_dispatch_bindings ENABLE ROW LEVEL SECURITY;
CREATE POLICY eco_revision_workspace ON eco_phase_work_revisions
  USING(workspace_id=current_setting('rorca.workspace_id',TRUE))
  WITH CHECK(workspace_id=current_setting('rorca.workspace_id',TRUE));
CREATE POLICY eco_binding_workspace ON eco_phase_dispatch_bindings
  USING(workspace_id=current_setting('rorca.workspace_id',TRUE))
  WITH CHECK(workspace_id=current_setting('rorca.workspace_id',TRUE));
REVOKE ALL ON eco_phase_work_revisions,eco_phase_dispatch_bindings FROM PUBLIC;
DO $$ DECLARE runtime_user TEXT:=current_setting('rorca.runtime_database_user',TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user='' THEN RAISE EXCEPTION 'Explicit runtime database principal required'; END IF;
  EXECUTE format('GRANT SELECT,INSERT ON rorca.eco_phase_work_revisions,rorca.eco_phase_dispatch_bindings TO %I',runtime_user);
END $$;
