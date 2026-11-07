-- Persist the exact immutable spec/repository/path subject on governed execution attempts.

ALTER TABLE rorca.governed_execution_attempts
  ADD COLUMN spec_id TEXT,
  ADD COLUMN spec_version INTEGER,
  ADD COLUMN spec_hash TEXT,
  ADD COLUMN story_version INTEGER,
  ADD COLUMN story_hash TEXT,
  ADD COLUMN criteria_manifest_hash TEXT,
  ADD COLUMN base_sha TEXT,
  ADD COLUMN current_sha TEXT,
  ADD COLUMN expected_head_sha TEXT,
  ADD COLUMN allowed_path_manifest_hash TEXT,
  ADD COLUMN required_path_manifest_hash TEXT,
  ADD COLUMN changed_path_manifest_hash TEXT,
  ADD COLUMN forbidden_path_manifest_hash TEXT;

UPDATE rorca.governed_execution_attempts a
SET spec_id=w.payload_json->'spec'->>'specId',
    spec_version=(w.payload_json->'spec'->>'specVersion')::INTEGER,
    spec_hash=w.payload_json->'spec'->>'specHash',
    story_version=(w.payload_json->'spec'->>'storyVersion')::INTEGER,
    story_hash=w.payload_json->'spec'->>'storyHash',
    criteria_manifest_hash=w.payload_json->'spec'->>'criteriaManifestHash',
    base_sha=w.payload_json->'repository'->>'baseSha',
    current_sha=w.payload_json->'repository'->>'currentSha',
    expected_head_sha=w.payload_json->'repository'->>'expectedHeadSha',
    allowed_path_manifest_hash=w.payload_json->'repository'->>'allowedPathManifestHash',
    required_path_manifest_hash=w.payload_json->'repository'->>'requiredPathManifestHash',
    changed_path_manifest_hash=w.payload_json->'repository'->>'changedPathManifestHash',
    forbidden_path_manifest_hash=w.payload_json->'repository'->>'forbiddenPathManifestHash'
FROM rorca.governed_work_package_revisions w
WHERE w.workspace_id=a.workspace_id AND w.mission_id=a.mission_id
  AND w.work_package_id=a.work_package_id AND w.work_package_revision=a.work_package_revision;

ALTER TABLE rorca.governed_execution_attempts
  ALTER COLUMN spec_id SET NOT NULL,
  ALTER COLUMN spec_version SET NOT NULL,
  ALTER COLUMN spec_hash SET NOT NULL,
  ALTER COLUMN story_version SET NOT NULL,
  ALTER COLUMN story_hash SET NOT NULL,
  ALTER COLUMN criteria_manifest_hash SET NOT NULL,
  ALTER COLUMN base_sha SET NOT NULL,
  ALTER COLUMN current_sha SET NOT NULL,
  ALTER COLUMN expected_head_sha SET NOT NULL,
  ALTER COLUMN allowed_path_manifest_hash SET NOT NULL,
  ALTER COLUMN required_path_manifest_hash SET NOT NULL,
  ALTER COLUMN changed_path_manifest_hash SET NOT NULL,
  ALTER COLUMN forbidden_path_manifest_hash SET NOT NULL;

ALTER TABLE rorca.governed_execution_attempts
  ADD CONSTRAINT governed_attempt_spec_version_ck CHECK(spec_version>0 AND story_version>0),
  ADD CONSTRAINT governed_attempt_spec_hash_ck CHECK(spec_hash ~ '^sha256:[0-9a-f]{64}$' AND story_hash ~ '^sha256:[0-9a-f]{64}$' AND criteria_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT governed_attempt_git_sha_ck CHECK(base_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$' AND current_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$' AND expected_head_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  ADD CONSTRAINT governed_attempt_path_hash_ck CHECK(allowed_path_manifest_hash ~ '^sha256:[0-9a-f]{64}$' AND required_path_manifest_hash ~ '^sha256:[0-9a-f]{64}$' AND changed_path_manifest_hash ~ '^sha256:[0-9a-f]{64}$' AND forbidden_path_manifest_hash ~ '^sha256:[0-9a-f]{64}$');

UPDATE rorca.wave2_schema_readiness
SET migration_version=20260729136000, installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='ready' AND migration_version=20260729135000
  AND contract_source_digest='sha256:b06bd5bdd4d999879d14a548b29c91ddd09cc702c280d6fa651cccc0baeeddb2';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM rorca.wave2_schema_readiness WHERE singleton=TRUE AND state='ready'
    AND migration_version=20260729136000 AND contract_source_digest='sha256:b06bd5bdd4d999879d14a548b29c91ddd09cc702c280d6fa651cccc0baeeddb2') THEN
    RAISE EXCEPTION 'Wave 2 exact attempt subject readiness transition failed closed' USING ERRCODE='55000';
  END IF;
END;
$$;
