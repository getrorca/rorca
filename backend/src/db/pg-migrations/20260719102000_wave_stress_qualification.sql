-- Deterministic stress/soak ownership inventory and protected sentinel proofs.
-- pg-boss owns its own schema; queue jobs are referenced by opaque ID only.

CREATE TABLE IF NOT EXISTS wave_qualification_namespaces (
  qualification_namespace TEXT PRIMARY KEY
    CHECK (qualification_namespace ~ '^qrun_[a-f0-9]{24}$'),
  isolation_marker TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL UNIQUE,
  spec_id TEXT NOT NULL UNIQUE,
  synthetic_run_id TEXT NOT NULL UNIQUE,
  profile TEXT NOT NULL CHECK (profile IN ('ci', 'soak', 'diagnostic')),
  seed TEXT NOT NULL CHECK (length(seed) BETWEEN 1 AND 128),
  parallelism INTEGER NOT NULL CHECK (parallelism IN (2, 4)),
  first_attempt BOOLEAN NOT NULL DEFAULT TRUE CHECK (first_attempt),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (isolation_marker = 'rorca-qualification-owned:' || qualification_namespace),
  CHECK (workspace_id = 'qws-' || qualification_namespace),
  CHECK (spec_id = 'qspec-' || qualification_namespace),
  CHECK (synthetic_run_id = 'qualification-run-' || qualification_namespace)
);

CREATE TABLE IF NOT EXISTS wave_qualification_resource_inventory (
  qualification_namespace TEXT NOT NULL
    REFERENCES wave_qualification_namespaces (qualification_namespace) ON DELETE CASCADE,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN (
    'workspace', 'spec', 'run', 'story_result', 'wal_event', 'lease',
    'integration_record', 'queue_job'
  )),
  resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 256),
  ownership_marker TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (qualification_namespace, resource_kind, resource_id),
  CHECK (ownership_marker = 'rorca-qualification-owned:' || qualification_namespace)
);

CREATE INDEX IF NOT EXISTS idx_wave_qualification_inventory_kind
  ON wave_qualification_resource_inventory (qualification_namespace, resource_kind);

CREATE TABLE IF NOT EXISTS wave_qualification_protected_sentinels (
  qualification_namespace TEXT NOT NULL
    REFERENCES wave_qualification_namespaces (qualification_namespace) ON DELETE CASCADE,
  sentinel_name TEXT NOT NULL CHECK (sentinel_name ~ '^[a-z][a-z0-9_-]{0,63}$'),
  before_hash CHAR(64) NOT NULL CHECK (before_hash ~ '^[0-9a-f]{64}$'),
  after_hash CHAR(64) NOT NULL CHECK (after_hash ~ '^[0-9a-f]{64}$'),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (qualification_namespace, sentinel_name),
  CHECK (before_hash = after_hash)
);

CREATE OR REPLACE FUNCTION assert_wave_qualification_inventory_complete(target_namespace TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  required_kind TEXT;
  target_marker TEXT := 'rorca-qualification-owned:' || target_namespace;
BEGIN
  IF target_namespace !~ '^qrun_[a-f0-9]{24}$'
     OR NOT EXISTS (
       SELECT 1 FROM wave_qualification_namespaces
        WHERE qualification_namespace = target_namespace
          AND isolation_marker = target_marker
     ) THEN
    RAISE EXCEPTION 'qualification namespace identity is missing or invalid';
  END IF;

  FOREACH required_kind IN ARRAY ARRAY[
    'workspace', 'spec', 'run', 'story_result', 'wal_event', 'lease',
    'integration_record', 'queue_job'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM wave_qualification_resource_inventory
       WHERE qualification_namespace = target_namespace
         AND resource_kind = required_kind
         AND ownership_marker = target_marker
    ) THEN
      RAISE EXCEPTION 'qualification ownership proof missing for %', required_kind;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM wave_qualification_protected_sentinels
     WHERE qualification_namespace = target_namespace
  ) THEN
    RAISE EXCEPTION 'protected production sentinel proof is missing';
  END IF;
END;
$$;
