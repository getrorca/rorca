-- 20260812124000_lifecycle_source_publication_authority.sql
-- Server-owned trust root for Genesis package publication receipts consumed by
-- lifecycle source evidence projection. The application/runtime principal can
-- verify exact persisted identities but cannot mint, replace, or remove them.

CREATE TABLE rorca.lifecycle_source_publication_receipts (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  spec_slug TEXT NOT NULL CHECK (btrim(spec_slug) <> ''),
  release_subject_hash TEXT NOT NULL CHECK (release_subject_hash ~ '^sha256:[0-9a-f]{64}$'),
  package_id TEXT NOT NULL CHECK (btrim(package_id) <> ''),
  package_path TEXT NOT NULL CHECK (
    package_path ~ '^genesis/artifacts/export-packs/[A-Za-z0-9][A-Za-z0-9._-]*$'
  ),
  receipt_id TEXT NOT NULL CHECK (receipt_id ~ '^package-event:sha256:[0-9a-f]{64}$'),
  receipt_hash TEXT NOT NULL CHECK (receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  event_hash TEXT NOT NULL CHECK (event_hash ~ '^sha256:[0-9a-f]{64}$'),
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  package_hash TEXT NOT NULL CHECK (package_hash ~ '^sha256:[0-9a-f]{64}$'),
  preview_hash TEXT NOT NULL CHECK (preview_hash ~ '^sha256:[0-9a-f]{64}$'),
  snapshot_hash TEXT NOT NULL CHECK (snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  trusted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, receipt_id),
  UNIQUE (workspace_id, spec_slug, release_subject_hash, package_id, receipt_hash),
  CHECK (receipt_id = 'package-event:' || event_hash)
);

CREATE INDEX lifecycle_source_publication_receipts_subject_idx
  ON rorca.lifecycle_source_publication_receipts
  (workspace_id, spec_slug, release_subject_hash, package_id);

CREATE OR REPLACE FUNCTION rorca.reject_lifecycle_source_publication_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Lifecycle source publication authority receipts are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER lifecycle_source_publication_receipts_immutable
  BEFORE UPDATE OR DELETE ON rorca.lifecycle_source_publication_receipts
  FOR EACH ROW EXECUTE FUNCTION rorca.reject_lifecycle_source_publication_receipt_mutation();

CREATE TRIGGER lifecycle_source_publication_receipts_no_truncate
  BEFORE TRUNCATE ON rorca.lifecycle_source_publication_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION rorca.reject_lifecycle_source_publication_receipt_mutation();

REVOKE ALL ON TABLE rorca.lifecycle_source_publication_receipts FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.reject_lifecycle_source_publication_receipt_mutation() FROM PUBLIC;

DO $$
DECLARE runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
DECLARE writer_user TEXT := current_setting('rorca.canonical_writer_database_user', TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user = '' THEN
    RAISE EXCEPTION 'rorca.runtime_database_user must identify the runtime principal';
  END IF;
  IF writer_user IS NULL OR writer_user = '' OR writer_user = runtime_user THEN
    RAISE EXCEPTION 'rorca.canonical_writer_database_user must identify the distinct publication authority principal';
  END IF;
  EXECUTE format(
    'REVOKE ALL ON rorca.lifecycle_source_publication_receipts FROM %I',
    runtime_user
  );
  EXECUTE format(
    'GRANT SELECT ON rorca.lifecycle_source_publication_receipts TO %I',
    runtime_user
  );
  EXECUTE format(
    'REVOKE ALL ON rorca.lifecycle_source_publication_receipts FROM %I',
    writer_user
  );
  EXECUTE format(
    'GRANT SELECT,INSERT ON rorca.lifecycle_source_publication_receipts TO %I',
    writer_user
  );
  EXECUTE format(
    'GRANT SELECT,INSERT,UPDATE ON rorca.spec_sources TO %I',
    writer_user
  );
END $$;

COMMENT ON TABLE rorca.lifecycle_source_publication_receipts IS
  'Canonical-writer issued, append-only trust root for exact Genesis bridge publication receipts. Runtime may verify but cannot mint authority.';
