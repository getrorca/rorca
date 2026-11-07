-- Application-owned dispatch outbox for every fresh pipeline run.
-- pg-boss remains a replaceable transport and never owns execution authority.

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS dispatch_request_hash TEXT,
  ADD COLUMN IF NOT EXISTS dispatch_effective_options_hash TEXT;

ALTER TABLE pipeline_runs DROP CONSTRAINT IF EXISTS pipeline_runs_dispatch_request_hash_check;
ALTER TABLE pipeline_runs ADD CONSTRAINT pipeline_runs_dispatch_request_hash_check
  CHECK (dispatch_request_hash IS NULL OR dispatch_request_hash ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE pipeline_runs DROP CONSTRAINT IF EXISTS pipeline_runs_dispatch_effective_options_hash_check;
ALTER TABLE pipeline_runs ADD CONSTRAINT pipeline_runs_dispatch_effective_options_hash_check
  CHECK (dispatch_effective_options_hash IS NULL OR dispatch_effective_options_hash ~ '^sha256:[0-9a-f]{64}$');

CREATE TABLE IF NOT EXISTS pipeline_dispatch_publications (
  run_id BIGINT PRIMARY KEY REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  queue_name TEXT NOT NULL DEFAULT 'pipeline:run' CHECK (queue_name = 'pipeline:run'),
  boss_job_id UUID NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved','preparing','published','claimed','completed','cancelled','failed')),
  request_hash TEXT CHECK (request_hash IS NULL OR request_hash ~ '^sha256:[0-9a-f]{64}$'),
  effective_options_hash TEXT CHECK (effective_options_hash IS NULL OR effective_options_hash ~ '^sha256:[0-9a-f]{64}$'),
  payload_hash TEXT CHECK (payload_hash IS NULL OR payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  payload JSONB,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  publish_attempts INTEGER NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  published_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (payload IS NULL OR payload_hash IS NOT NULL),
  CONSTRAINT pipeline_dispatch_publications_payload_state_check
    CHECK (state IN ('reserved','preparing') OR payload IS NOT NULL)
);

CREATE OR REPLACE FUNCTION reserve_pipeline_dispatch_publication()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  digest TEXT;
  deterministic_job_id UUID;
BEGIN
  IF NEW.status <> 'queued' THEN
    RETURN NEW;
  END IF;
  digest := md5('rorca:pipeline-dispatch:' || NEW.id::text);
  deterministic_job_id := (
    substr(digest, 1, 8) || '-' || substr(digest, 9, 4) || '-5' || substr(digest, 14, 3)
    || '-a' || substr(digest, 18, 3) || '-' || substr(digest, 21, 12)
  )::uuid;
  INSERT INTO pipeline_dispatch_publications (
    run_id, workspace_id, boss_job_id, request_hash, effective_options_hash
  ) VALUES (
    NEW.id, NEW.workspace_id, deterministic_job_id,
    NEW.dispatch_request_hash, NEW.dispatch_effective_options_hash
  ) ON CONFLICT (run_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pipeline_runs_reserve_dispatch_publication ON pipeline_runs;
CREATE TRIGGER pipeline_runs_reserve_dispatch_publication
AFTER INSERT ON pipeline_runs
FOR EACH ROW EXECUTE FUNCTION reserve_pipeline_dispatch_publication();

-- Preserve any exact TaskManifest publication identity already committed.
INSERT INTO pipeline_dispatch_publications (
  run_id, workspace_id, queue_name, boss_job_id, state, payload_hash,
  lease_owner, lease_expires_at, published_at, created_at, updated_at
)
SELECT run_id, workspace_id, queue_name, boss_job_id,
       'reserved', payload_hash, NULL, NULL, NULL, created_at, updated_at
  FROM task_manifest_dispatch_publications
ON CONFLICT (run_id) DO NOTHING;

-- Existing queued application rows receive deterministic recovery identity.
INSERT INTO pipeline_dispatch_publications (run_id, workspace_id, boss_job_id, request_hash, effective_options_hash)
SELECT run.id, run.workspace_id,
       (substr(d.digest, 1, 8) || '-' || substr(d.digest, 9, 4) || '-5' || substr(d.digest, 14, 3)
        || '-a' || substr(d.digest, 18, 3) || '-' || substr(d.digest, 21, 12))::uuid,
       run.dispatch_request_hash, run.dispatch_effective_options_hash
  FROM pipeline_runs run
 CROSS JOIN LATERAL (SELECT md5('rorca:pipeline-dispatch:' || run.id::text) AS digest) d
 WHERE run.status = 'queued'
ON CONFLICT (run_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_pipeline_dispatch_publication_recovery
  ON pipeline_dispatch_publications(state, lease_expires_at, updated_at)
  WHERE state IN ('reserved','preparing','published','claimed');
