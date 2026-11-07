-- CCS-002: Durable context capture event and memory candidate storage.
-- Uses timestamp-format migration naming to avoid parallel branch collisions.

CREATE TABLE IF NOT EXISTS context_events (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  actor TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  summary TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  related_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  trust_tier TEXT NOT NULL DEFAULT 'agent_observation',
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT context_events_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT context_events_event_type_check CHECK (
    event_type IN (
      'manual_cli_note',
      'manual_note',
      'git_commit',
      'git_range',
      'daemon_scan',
      'pr_merge',
      'incident',
      'duckbrain_import',
      'duckbrain_memory',
      'hermes_event',
      'hermes_session'
    )
  ),
  CONSTRAINT context_events_trust_tier_check CHECK (
    trust_tier IN (
      'agent_observation',
      'working_note',
      'engineering_decision',
      'approved_policy',
      'verified_fact'
    )
  ),
  CONSTRAINT context_events_source_system_nonempty_check CHECK (length(btrim(source_system)) > 0),
  CONSTRAINT context_events_source_ref_nonempty_check CHECK (length(btrim(source_ref)) > 0),
  CONSTRAINT context_events_idempotency_key_nonempty_check CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT context_events_payload_object_check CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT context_events_provenance_object_check CHECK (jsonb_typeof(provenance) = 'object'),
  CONSTRAINT context_events_related_files_array_check CHECK (jsonb_typeof(related_files) = 'array'),
  CONSTRAINT context_events_metadata_object_check CHECK (jsonb_typeof(metadata) = 'object')
);

ALTER TABLE context_events ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE context_events ADD COLUMN IF NOT EXISTS event_type TEXT NOT NULL DEFAULT 'manual_cli_note';
ALTER TABLE context_events ADD COLUMN IF NOT EXISTS source_system TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE context_events ADD COLUMN IF NOT EXISTS source_ref TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE context_events ADD COLUMN IF NOT EXISTS actor TEXT;
ALTER TABLE context_events ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE context_events ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT '';
ALTER TABLE context_events ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE context_events ADD COLUMN IF NOT EXISTS provenance JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE context_events ADD COLUMN IF NOT EXISTS related_files JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE context_events ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE context_events ADD COLUMN IF NOT EXISTS trust_tier TEXT NOT NULL DEFAULT 'agent_observation';
ALTER TABLE context_events ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE context_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE context_events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE context_events
SET idempotency_key = 'context_event:' || id::text
WHERE idempotency_key IS NULL;

ALTER TABLE context_events ALTER COLUMN idempotency_key SET NOT NULL;
ALTER TABLE context_events ALTER COLUMN event_type SET DEFAULT 'manual_cli_note';
ALTER TABLE context_events ALTER COLUMN source_system SET DEFAULT 'unknown';
ALTER TABLE context_events ALTER COLUMN source_ref SET DEFAULT 'unknown';
ALTER TABLE context_events ALTER COLUMN summary SET DEFAULT '';
ALTER TABLE context_events ALTER COLUMN payload SET DEFAULT '{}'::jsonb;
ALTER TABLE context_events ALTER COLUMN provenance SET DEFAULT '{}'::jsonb;
ALTER TABLE context_events ALTER COLUMN related_files SET DEFAULT '[]'::jsonb;
ALTER TABLE context_events ALTER COLUMN metadata SET DEFAULT '{}'::jsonb;
ALTER TABLE context_events ALTER COLUMN trust_tier SET DEFAULT 'agent_observation';
ALTER TABLE context_events ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE context_events ALTER COLUMN updated_at SET DEFAULT NOW();

CREATE TABLE IF NOT EXISTS memory_candidates (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  context_event_id BIGINT REFERENCES context_events(id) ON DELETE SET NULL,
  event_type TEXT,
  source_system TEXT,
  source_ref TEXT,
  actor TEXT,
  occurred_at TIMESTAMPTZ,
  suggested_category TEXT NOT NULL,
  title TEXT NOT NULL,
  rule TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  related_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence TEXT NOT NULL DEFAULT 'low',
  trust_tier TEXT NOT NULL DEFAULT 'agent_observation',
  review_status TEXT NOT NULL DEFAULT 'pending',
  reviewer TEXT,
  reviewed_at TIMESTAMPTZ,
  promoted_memory_id INTEGER REFERENCES memories(id) ON DELETE SET NULL,
  promoted_at TIMESTAMPTZ,
  idempotency_key TEXT NOT NULL,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  claim TEXT,
  policy TEXT,
  incident_learning TEXT,
  security_sensitive BOOLEAN NOT NULL DEFAULT FALSE,
  regulated_domain BOOLEAN NOT NULL DEFAULT FALSE,
  requires_review BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT memory_candidates_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT memory_candidates_event_type_check CHECK (
    event_type IS NULL OR event_type IN (
      'manual_cli_note',
      'manual_note',
      'git_commit',
      'git_range',
      'daemon_scan',
      'pr_merge',
      'incident',
      'duckbrain_import',
      'duckbrain_memory',
      'hermes_event',
      'hermes_session'
    )
  ),
  CONSTRAINT memory_candidates_category_check CHECK (
    suggested_category IN (
      'Architecture',
      'Convention',
      'Bug Fix',
      'Decision',
      'Pattern',
      'Gotcha'
    )
  ),
  CONSTRAINT memory_candidates_confidence_check CHECK (confidence IN ('high', 'medium', 'low')),
  CONSTRAINT memory_candidates_trust_tier_check CHECK (
    trust_tier IN (
      'agent_observation',
      'working_note',
      'engineering_decision',
      'approved_policy',
      'verified_fact'
    )
  ),
  CONSTRAINT memory_candidates_review_status_check CHECK (
    review_status IN (
      'pending',
      'approved',
      'rejected',
      'superseded',
      'duplicate',
      'deferred'
    )
  ),
  CONSTRAINT memory_candidates_idempotency_key_nonempty_check CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT memory_candidates_related_files_array_check CHECK (jsonb_typeof(related_files) = 'array'),
  CONSTRAINT memory_candidates_provenance_object_check CHECK (jsonb_typeof(provenance) = 'object'),
  CONSTRAINT memory_candidates_metadata_object_check CHECK (jsonb_typeof(metadata) = 'object')
);

ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS context_event_id BIGINT;
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS event_type TEXT;
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS source_system TEXT;
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS source_ref TEXT;
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS actor TEXT;
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ;
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS suggested_category TEXT NOT NULL DEFAULT 'Decision';
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS rule TEXT NOT NULL DEFAULT '';
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS context TEXT NOT NULL DEFAULT '';
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS related_files JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS confidence TEXT NOT NULL DEFAULT 'low';
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS trust_tier TEXT NOT NULL DEFAULT 'agent_observation';
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS reviewer TEXT;
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS promoted_memory_id INTEGER;
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ;
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS provenance JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS claim TEXT;
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS policy TEXT;
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS incident_learning TEXT;
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS security_sensitive BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS regulated_domain BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS requires_review BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE memory_candidates
SET idempotency_key = 'memory_candidate:' || id::text
WHERE idempotency_key IS NULL;

ALTER TABLE memory_candidates ALTER COLUMN idempotency_key SET NOT NULL;
ALTER TABLE memory_candidates ALTER COLUMN suggested_category SET DEFAULT 'Decision';
ALTER TABLE memory_candidates ALTER COLUMN title SET DEFAULT '';
ALTER TABLE memory_candidates ALTER COLUMN rule SET DEFAULT '';
ALTER TABLE memory_candidates ALTER COLUMN context SET DEFAULT '';
ALTER TABLE memory_candidates ALTER COLUMN related_files SET DEFAULT '[]'::jsonb;
ALTER TABLE memory_candidates ALTER COLUMN confidence SET DEFAULT 'low';
ALTER TABLE memory_candidates ALTER COLUMN trust_tier SET DEFAULT 'agent_observation';
ALTER TABLE memory_candidates ALTER COLUMN review_status SET DEFAULT 'pending';
ALTER TABLE memory_candidates ALTER COLUMN provenance SET DEFAULT '{}'::jsonb;
ALTER TABLE memory_candidates ALTER COLUMN metadata SET DEFAULT '{}'::jsonb;
ALTER TABLE memory_candidates ALTER COLUMN security_sensitive SET DEFAULT FALSE;
ALTER TABLE memory_candidates ALTER COLUMN regulated_domain SET DEFAULT FALSE;
ALTER TABLE memory_candidates ALTER COLUMN requires_review SET DEFAULT TRUE;
ALTER TABLE memory_candidates ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE memory_candidates ALTER COLUMN updated_at SET DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'context_events_workspace_id_fkey'
  ) THEN
    ALTER TABLE context_events
      ADD CONSTRAINT context_events_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'context_events_event_type_check'
  ) THEN
    ALTER TABLE context_events
      ADD CONSTRAINT context_events_event_type_check
      CHECK (event_type IN ('manual_cli_note', 'manual_note', 'git_commit', 'git_range', 'daemon_scan', 'pr_merge', 'incident', 'duckbrain_import', 'duckbrain_memory', 'hermes_event', 'hermes_session'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'context_events_trust_tier_check'
  ) THEN
    ALTER TABLE context_events
      ADD CONSTRAINT context_events_trust_tier_check
      CHECK (trust_tier IN ('agent_observation', 'working_note', 'engineering_decision', 'approved_policy', 'verified_fact'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'context_events_source_system_nonempty_check'
  ) THEN
    ALTER TABLE context_events
      ADD CONSTRAINT context_events_source_system_nonempty_check
      CHECK (length(btrim(source_system)) > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'context_events_source_ref_nonempty_check'
  ) THEN
    ALTER TABLE context_events
      ADD CONSTRAINT context_events_source_ref_nonempty_check
      CHECK (length(btrim(source_ref)) > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'context_events_idempotency_key_nonempty_check'
  ) THEN
    ALTER TABLE context_events
      ADD CONSTRAINT context_events_idempotency_key_nonempty_check
      CHECK (length(btrim(idempotency_key)) > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'context_events_payload_object_check'
  ) THEN
    ALTER TABLE context_events
      ADD CONSTRAINT context_events_payload_object_check
      CHECK (jsonb_typeof(payload) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'context_events_provenance_object_check'
  ) THEN
    ALTER TABLE context_events
      ADD CONSTRAINT context_events_provenance_object_check
      CHECK (jsonb_typeof(provenance) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'context_events_related_files_array_check'
  ) THEN
    ALTER TABLE context_events
      ADD CONSTRAINT context_events_related_files_array_check
      CHECK (jsonb_typeof(related_files) = 'array');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'context_events_metadata_object_check'
  ) THEN
    ALTER TABLE context_events
      ADD CONSTRAINT context_events_metadata_object_check
      CHECK (jsonb_typeof(metadata) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memory_candidates_workspace_id_fkey'
  ) THEN
    ALTER TABLE memory_candidates
      ADD CONSTRAINT memory_candidates_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memory_candidates_context_event_id_fkey'
  ) THEN
    ALTER TABLE memory_candidates
      ADD CONSTRAINT memory_candidates_context_event_id_fkey
      FOREIGN KEY (context_event_id) REFERENCES context_events(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memory_candidates_promoted_memory_id_fkey'
  ) THEN
    ALTER TABLE memory_candidates
      ADD CONSTRAINT memory_candidates_promoted_memory_id_fkey
      FOREIGN KEY (promoted_memory_id) REFERENCES memories(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memory_candidates_event_type_check'
  ) THEN
    ALTER TABLE memory_candidates
      ADD CONSTRAINT memory_candidates_event_type_check
      CHECK (event_type IS NULL OR event_type IN ('manual_cli_note', 'manual_note', 'git_commit', 'git_range', 'daemon_scan', 'pr_merge', 'incident', 'duckbrain_import', 'duckbrain_memory', 'hermes_event', 'hermes_session'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memory_candidates_category_check'
  ) THEN
    ALTER TABLE memory_candidates
      ADD CONSTRAINT memory_candidates_category_check
      CHECK (suggested_category IN ('Architecture', 'Convention', 'Bug Fix', 'Decision', 'Pattern', 'Gotcha'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memory_candidates_confidence_check'
  ) THEN
    ALTER TABLE memory_candidates
      ADD CONSTRAINT memory_candidates_confidence_check
      CHECK (confidence IN ('high', 'medium', 'low'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memory_candidates_trust_tier_check'
  ) THEN
    ALTER TABLE memory_candidates
      ADD CONSTRAINT memory_candidates_trust_tier_check
      CHECK (trust_tier IN ('agent_observation', 'working_note', 'engineering_decision', 'approved_policy', 'verified_fact'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memory_candidates_review_status_check'
  ) THEN
    ALTER TABLE memory_candidates
      ADD CONSTRAINT memory_candidates_review_status_check
      CHECK (review_status IN ('pending', 'approved', 'rejected', 'superseded', 'duplicate', 'deferred'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memory_candidates_idempotency_key_nonempty_check'
  ) THEN
    ALTER TABLE memory_candidates
      ADD CONSTRAINT memory_candidates_idempotency_key_nonempty_check
      CHECK (length(btrim(idempotency_key)) > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memory_candidates_related_files_array_check'
  ) THEN
    ALTER TABLE memory_candidates
      ADD CONSTRAINT memory_candidates_related_files_array_check
      CHECK (jsonb_typeof(related_files) = 'array');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memory_candidates_provenance_object_check'
  ) THEN
    ALTER TABLE memory_candidates
      ADD CONSTRAINT memory_candidates_provenance_object_check
      CHECK (jsonb_typeof(provenance) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memory_candidates_metadata_object_check'
  ) THEN
    ALTER TABLE memory_candidates
      ADD CONSTRAINT memory_candidates_metadata_object_check
      CHECK (jsonb_typeof(metadata) = 'object');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS context_events_idempotency_key_key
  ON context_events (idempotency_key);

CREATE INDEX IF NOT EXISTS idx_context_events_workspace_occurred_at
  ON context_events (workspace_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_context_events_workspace_event_type
  ON context_events (workspace_id, event_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_context_events_source
  ON context_events (workspace_id, source_system, source_ref);

CREATE INDEX IF NOT EXISTS idx_context_events_trust_tier
  ON context_events (workspace_id, trust_tier, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_context_events_related_files
  ON context_events USING GIN (related_files);

CREATE INDEX IF NOT EXISTS idx_context_events_payload
  ON context_events USING GIN (payload);

CREATE INDEX IF NOT EXISTS idx_context_events_metadata
  ON context_events USING GIN (metadata);

CREATE UNIQUE INDEX IF NOT EXISTS memory_candidates_idempotency_key_key
  ON memory_candidates (idempotency_key);

CREATE INDEX IF NOT EXISTS idx_memory_candidates_workspace_status
  ON memory_candidates (workspace_id, review_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_candidates_workspace_category
  ON memory_candidates (workspace_id, suggested_category, review_status);

CREATE INDEX IF NOT EXISTS idx_memory_candidates_context_event
  ON memory_candidates (context_event_id)
  WHERE context_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_candidates_promoted_memory
  ON memory_candidates (promoted_memory_id)
  WHERE promoted_memory_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_candidates_source
  ON memory_candidates (workspace_id, source_system, source_ref)
  WHERE source_system IS NOT NULL AND source_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_candidates_trust_tier
  ON memory_candidates (workspace_id, trust_tier, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_candidates_requires_review
  ON memory_candidates (workspace_id, requires_review, review_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_candidates_related_files
  ON memory_candidates USING GIN (related_files);

CREATE INDEX IF NOT EXISTS idx_memory_candidates_metadata
  ON memory_candidates USING GIN (metadata);
