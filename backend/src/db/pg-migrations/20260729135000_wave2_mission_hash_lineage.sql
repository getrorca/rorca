-- Bind work-package revisions to the exact immutable mission revision/hash and advance Wave 2 readiness.

ALTER TABLE rorca.governed_mission_versions
  ADD CONSTRAINT governed_mission_versions_revision_hash_uq
  UNIQUE(workspace_id,mission_id,mission_revision,mission_hash);

ALTER TABLE rorca.governed_work_package_revisions
  ADD CONSTRAINT governed_work_package_mission_revision_hash_fk
  FOREIGN KEY(workspace_id,mission_id,mission_revision,mission_hash)
  REFERENCES rorca.governed_mission_versions(workspace_id,mission_id,mission_revision,mission_hash)
  ON DELETE RESTRICT;

UPDATE rorca.wave2_schema_readiness
SET migration_version=20260729135000, installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='ready' AND migration_version=20260729134000
  AND contract_source_digest='sha256:b06bd5bdd4d999879d14a548b29c91ddd09cc702c280d6fa651cccc0baeeddb2';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM rorca.wave2_schema_readiness
    WHERE singleton=TRUE AND state='ready' AND migration_version=20260729135000
      AND contract_source_digest='sha256:b06bd5bdd4d999879d14a548b29c91ddd09cc702c280d6fa651cccc0baeeddb2'
  ) THEN
    RAISE EXCEPTION 'Wave 2 mission hash lineage readiness transition failed closed' USING ERRCODE='55000';
  END IF;
END;
$$;
