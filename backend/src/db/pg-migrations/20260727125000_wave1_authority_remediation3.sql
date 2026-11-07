-- Copyright (c) 2026 Rorca Inc.
-- SPDX-License-Identifier: Apache-2.0
-- Licensed under the Apache License, Version 2.0.
-- See LICENSE file in the project root for full license text.

BEGIN;

-- Dispatch freezes both the canonical source and the mutable run projection.
-- Provider launch independently re-reads both files and refuses first egress if
-- either byte identity or canonical JSON revision changed after dispatch.
ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS canonical_spec_revision TEXT,
  ADD COLUMN IF NOT EXISTS canonical_spec_bytes_hash TEXT,
  ADD COLUMN IF NOT EXISTS run_spec_path TEXT,
  ADD COLUMN IF NOT EXISTS run_spec_revision TEXT,
  ADD COLUMN IF NOT EXISTS run_spec_bytes_hash TEXT,
  ADD COLUMN IF NOT EXISTS first_provider_launch_verified_at TIMESTAMPTZ;

ALTER TABLE host_story_attempt_envelopes
  ADD COLUMN IF NOT EXISTS canonical_spec_bytes_hash TEXT,
  ADD COLUMN IF NOT EXISTS run_spec_revision TEXT,
  ADD COLUMN IF NOT EXISTS run_spec_bytes_hash TEXT;

-- Ordinary release recovery must retain the exact runtime generation which
-- authored semantic closeout. Every later release transition revalidates it
-- under pipeline-run-authority:<runId> before changing canonical state.
ALTER TABLE pipeline_run_release_intents
  ADD COLUMN IF NOT EXISTS dispatch_fence TEXT;

UPDATE pipeline_run_release_intents intent
   SET dispatch_fence = run.dispatch_fence
  FROM pipeline_runs run
 WHERE run.id = intent.run_id
   AND intent.dispatch_fence IS NULL
   AND run.dispatch_fence IS NOT NULL;

ALTER TABLE pipeline_runs
  DROP CONSTRAINT IF EXISTS pipeline_runs_wave1_spec_hashes_check;
ALTER TABLE pipeline_runs
  ADD CONSTRAINT pipeline_runs_wave1_spec_hashes_check CHECK (
    (canonical_spec_revision IS NULL OR canonical_spec_revision ~ '^sha256:[0-9a-f]{64}$')
    AND (canonical_spec_bytes_hash IS NULL OR canonical_spec_bytes_hash ~ '^sha256:[0-9a-f]{64}$')
    AND (run_spec_revision IS NULL OR run_spec_revision ~ '^sha256:[0-9a-f]{64}$')
    AND (run_spec_bytes_hash IS NULL OR run_spec_bytes_hash ~ '^sha256:[0-9a-f]{64}$')
  );

COMMIT;
