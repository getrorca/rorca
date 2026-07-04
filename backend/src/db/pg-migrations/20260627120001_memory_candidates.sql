-- US-004: Reviewable memory candidates — distilled, human-reviewable knowledge awaiting governance.
--
-- A memory candidate is knowledge captured from outside a Rorca run (derived from one or more
-- context_events) that has been distilled into the same shape as durable memory (category / title /
-- rule / context / related files), but is NOT yet trusted. Per the Context Intelligence Platform
-- contract (docs/context-intelligence-platform.md §2.5, §3, §5):
--
--   * Captured knowledge enters ONLY as a reviewable candidate, never as durable memory.
--   * The governance gate (US-035) is absolute: pending / rejected / duplicate / superseded
--     candidates NEVER enter default retrieval or prompt composition. Only an APPROVED candidate
--     that has been promoted through the existing durable memory path (the `memories` table)
--     becomes retrievable. The promoted_memory_id FK below records that promotion linkage, and a
--     CHECK enforces that no non-approved candidate can ever carry a promoted memory.
--   * Ingestion (US-032) de-duplicates via idempotency; the unique constraint enforces that here.
--
-- review_status mirrors the review actions in US-034 (approve / edit-and-approve → 'approved';
-- reject → 'rejected'; duplicate → 'duplicate'; supersede → 'superseded'; revisit → 'revisit').

CREATE TABLE IF NOT EXISTS memory_candidates (
  id                 BIGSERIAL PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Provenance back to the raw event that produced this candidate (nullable: a candidate may be
  -- authored directly, e.g. via the sidecar `remember` command, without a distinct stored event).
  context_event_id   BIGINT REFERENCES context_events(id) ON DELETE SET NULL,
  source_system      TEXT NOT NULL,                 -- e.g. 'rorca-capture', 'git', 'manual'
  source_ref         TEXT,                          -- e.g. commit SHA, file path, note id

  -- Distilled knowledge (same shape as durable `memories` so promotion is a clean copy).
  category           TEXT NOT NULL,
  title              TEXT NOT NULL,
  rule               TEXT NOT NULL,                 -- the actionable lesson
  context            TEXT,                          -- why it matters
  related_files      JSONB NOT NULL DEFAULT '[]',

  -- Confidence mirrors `memories.confidence`; trust tier ranks the *source's* authority (US-016
  -- ranker uses trust/authority). Captured knowledge starts at the lowest tier until reviewed.
  confidence         TEXT NOT NULL DEFAULT 'medium'
                     CHECK (confidence IN ('high', 'medium', 'low')),
  trust_tier         TEXT NOT NULL DEFAULT 'unverified'
                     CHECK (trust_tier IN ('authoritative', 'trusted', 'community', 'unverified')),

  -- Review lifecycle. The CHECK is the lifecycle validator: only these states are valid.
  review_status      TEXT NOT NULL DEFAULT 'pending'
                     CHECK (review_status IN ('pending', 'approved', 'rejected', 'duplicate', 'superseded', 'revisit')),
  reviewer           TEXT,                          -- who took the review decision
  reviewed_at        TIMESTAMPTZ,
  review_note        TEXT,

  -- When review_status = 'duplicate', the candidate this one duplicates (self-referential).
  duplicate_of_candidate_id BIGINT REFERENCES memory_candidates(id) ON DELETE SET NULL,

  -- Promotion linkage: the durable memory an APPROVED candidate was promoted into (US-035 gate).
  promoted_memory_id INTEGER REFERENCES memories(id) ON DELETE SET NULL,
  promoted_at        TIMESTAMPTZ,

  -- Idempotency key (ingestion-stamped) prevents duplicate candidates on offline-queue flush/retry.
  idempotency_key    TEXT NOT NULL,

  -- Version-stamped per design doc §6 / US-002 so the candidate contract can evolve safely.
  schema_version     INTEGER NOT NULL DEFAULT 1,
  metadata           JSONB NOT NULL DEFAULT '{}',

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ── Lifecycle / value validators ──────────────────────────────────────────────────────────
  CONSTRAINT memory_candidates_category_not_blank CHECK (length(btrim(category)) > 0),
  CONSTRAINT memory_candidates_title_not_blank    CHECK (length(btrim(title)) > 0),
  CONSTRAINT memory_candidates_rule_not_blank     CHECK (length(btrim(rule)) > 0),
  CONSTRAINT memory_candidates_source_not_blank   CHECK (length(btrim(source_system)) > 0),
  CONSTRAINT memory_candidates_idem_not_blank     CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT memory_candidates_schema_version_positive CHECK (schema_version >= 1),

  -- A candidate cannot duplicate itself.
  CONSTRAINT memory_candidates_no_self_duplicate CHECK (duplicate_of_candidate_id IS NULL OR duplicate_of_candidate_id <> id),

  -- Governance gate at the DB boundary: ONLY an approved candidate may carry a promoted memory.
  CONSTRAINT memory_candidates_promotion_requires_approval
    CHECK (promoted_memory_id IS NULL OR review_status = 'approved'),

  -- promoted_at and promoted_memory_id are set together or not at all.
  CONSTRAINT memory_candidates_promotion_timestamp
    CHECK ((promoted_memory_id IS NULL) = (promoted_at IS NULL)),

  -- A decided (terminal) status must record who decided and when; pending/revisit need not.
  CONSTRAINT memory_candidates_decided_has_reviewer
    CHECK (review_status IN ('pending', 'revisit') OR reviewed_at IS NOT NULL),

  -- Idempotency guarantee: a given key may exist at most once per workspace.
  CONSTRAINT memory_candidates_idempotency_unique UNIQUE (workspace_id, idempotency_key)
);

-- Hot path: the pending review queue for a workspace, oldest-first (FIFO review).
CREATE INDEX IF NOT EXISTS idx_memory_candidates_pending
  ON memory_candidates (workspace_id, created_at)
  WHERE review_status = 'pending';

-- General list/filter by status, most-recent-first.
CREATE INDEX IF NOT EXISTS idx_memory_candidates_status
  ON memory_candidates (workspace_id, review_status, created_at DESC);

-- Trace candidates back to their originating raw event.
CREATE INDEX IF NOT EXISTS idx_memory_candidates_event
  ON memory_candidates (context_event_id)
  WHERE context_event_id IS NOT NULL;

-- Find the candidate behind a promoted durable memory (and audit promotions).
CREATE INDEX IF NOT EXISTS idx_memory_candidates_promoted
  ON memory_candidates (promoted_memory_id)
  WHERE promoted_memory_id IS NOT NULL;

-- Related-file containment queries (e.g. "candidates touching src/foo.ts").
CREATE INDEX IF NOT EXISTS idx_memory_candidates_related_files
  ON memory_candidates USING GIN (related_files);
