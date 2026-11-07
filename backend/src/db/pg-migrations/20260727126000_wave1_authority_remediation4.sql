-- Copyright (c) 2026 Rorca Inc.
-- SPDX-License-Identifier: Apache-2.0
-- Licensed under the Apache License, Version 2.0.
-- See LICENSE file in the project root for full license text.

BEGIN;

-- Keep canonical source authority distinct from the exact run-owned payload
-- revision named by the execution manifest. Every provider attempt also binds
-- an explicit pre-spawn HEAD/branch expectation and re-observes it while the
-- provider is stopped behind the host launch gate.
ALTER TABLE host_story_attempt_envelopes
  ADD COLUMN IF NOT EXISTS canonical_spec_revision TEXT,
  ADD COLUMN IF NOT EXISTS expected_git_sha TEXT,
  ADD COLUMN IF NOT EXISTS expected_git_branch TEXT;

ALTER TABLE host_story_attempt_conflicts
  DROP CONSTRAINT IF EXISTS host_story_attempt_conflicts_reason_code_check;
ALTER TABLE host_story_attempt_conflicts
  ADD CONSTRAINT host_story_attempt_conflicts_reason_code_check CHECK (reason_code IN (
    'payload_changed','stale_generation','spec_revision_mismatch','canonical_path_mismatch',
    'git_revision_mismatch','worktree_identity_mismatch','cancellation_fence_mismatch',
    'repository_path_unreadable','canonical_spec_file_missing','canonical_spec_file_unreadable',
    'canonical_spec_invalid_json','canonical_spec_path_moved','canonical_spec_path_escape',
    'run_spec_file_missing','run_spec_file_unreadable','run_spec_invalid_json',
    'run_spec_path_moved','run_spec_path_escape'
  ));

ALTER TABLE host_story_attempt_envelopes
  DROP CONSTRAINT IF EXISTS host_story_attempt_envelopes_remediation4_check;
ALTER TABLE host_story_attempt_envelopes
  ADD CONSTRAINT host_story_attempt_envelopes_remediation4_check CHECK (
    (canonical_spec_revision IS NULL OR canonical_spec_revision ~ '^sha256:[0-9a-f]{64}$')
    AND (expected_git_sha IS NULL OR expected_git_sha ~ '^[0-9a-f]{40}$')
    AND (expected_git_branch IS NULL OR length(btrim(expected_git_branch)) > 0)
  );

COMMIT;
