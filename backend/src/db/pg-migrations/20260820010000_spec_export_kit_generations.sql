-- 20260820010000_spec_export_kit_generations.sql
-- Durable identities for deterministic Rorca-owned PRD/SDD/PLAN generations.
-- Artifact bytes live in the workspace; sealed generation identities are immutable.

CREATE TABLE rorca.spec_export_kit_generations (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  spec_slug TEXT NOT NULL CHECK (btrim(spec_slug) <> ''),
  spec_material_hash TEXT NOT NULL CHECK (spec_material_hash ~ '^sha256:[0-9a-f]{64}$'),
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  kit_path TEXT NOT NULL CHECK (
    kit_path ~ '^forge/export-kits/[A-Za-z0-9._-]+/[0-9a-f]{64}$'
  ),
  classification TEXT NOT NULL DEFAULT 'native_complete'
    CHECK (classification IN ('native_complete', 'legacy_complete', 'legacy_partial')),
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'sealed')),
  persist_receipt_id TEXT,
  approval_receipt_id TEXT,
  seal_hash TEXT CHECK (seal_hash IS NULL OR seal_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  sealed_at TIMESTAMPTZ,
  UNIQUE (workspace_id, spec_slug, manifest_hash),
  CHECK (
    (state = 'draft' AND approval_receipt_id IS NULL AND seal_hash IS NULL AND sealed_at IS NULL)
    OR
    (state = 'sealed' AND seal_hash IS NOT NULL AND sealed_at IS NOT NULL)
  )
);

CREATE INDEX spec_export_kit_generations_lookup_idx
  ON rorca.spec_export_kit_generations (workspace_id, spec_slug, created_at DESC);

CREATE OR REPLACE FUNCTION rorca.enforce_spec_export_kit_generation_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Export-kit generations are append-only' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'sealed' THEN
    RAISE EXCEPTION 'Sealed export-kit generations are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.workspace_id <> OLD.workspace_id
    OR NEW.spec_slug <> OLD.spec_slug
    OR NEW.spec_material_hash <> OLD.spec_material_hash
    OR NEW.manifest_hash <> OLD.manifest_hash
    OR NEW.kit_path <> OLD.kit_path
    OR NEW.classification <> OLD.classification
    OR NEW.created_at <> OLD.created_at
    OR NEW.persist_receipt_id IS DISTINCT FROM OLD.persist_receipt_id THEN
    RAISE EXCEPTION 'Export-kit generation identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.state <> 'sealed' THEN
    RAISE EXCEPTION 'Draft export-kit generations may only transition to sealed' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spec_export_kit_generations_immutable
  BEFORE UPDATE OR DELETE ON rorca.spec_export_kit_generations
  FOR EACH ROW EXECUTE FUNCTION rorca.enforce_spec_export_kit_generation_immutability();

REVOKE ALL ON TABLE rorca.spec_export_kit_generations FROM PUBLIC;
REVOKE ALL ON SEQUENCE rorca.spec_export_kit_generations_id_seq FROM PUBLIC;
DO $$
DECLARE runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user = '' THEN
    RAISE EXCEPTION 'rorca.runtime_database_user must identify the runtime principal';
  END IF;
  EXECUTE format(
    'GRANT SELECT,INSERT,UPDATE ON rorca.spec_export_kit_generations TO %I',
    runtime_user
  );
  EXECUTE format(
    'GRANT USAGE,SELECT ON SEQUENCE rorca.spec_export_kit_generations_id_seq TO %I',
    runtime_user
  );
END $$;

COMMENT ON TABLE rorca.spec_export_kit_generations IS
  'Append-only deterministic Rorca export-kit identities; each generation binds exact canonical spec material to PRD/SDD/PLAN hashes and becomes immutable when sealed.';
