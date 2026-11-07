-- Copyright (c) 2026 Rorca Inc.
-- SPDX-License-Identifier: Apache-2.0
-- Licensed under the Apache License, Version 2.0.
-- See LICENSE file in the project root for full license text.

-- Node does not expose a portable descriptor-relative recursive deletion
-- primitive. Preserve historical GC evidence, but make all new restart
-- maintenance outcomes explicitly non-destructive and able to identify bounded
-- crash-left staging observations without persisting attacker-controlled names.
ALTER TABLE local_review_projection_gc_actions
  DROP CONSTRAINT IF EXISTS local_review_projection_gc_actions_projection_key_check,
  DROP CONSTRAINT IF EXISTS local_review_projection_gc_actions_action_type_check,
  DROP CONSTRAINT IF EXISTS local_review_projection_gc_actions_reason_code_check;

ALTER TABLE local_review_projection_gc_actions
  ADD CONSTRAINT local_review_projection_gc_actions_projection_key_check CHECK (
    projection_key ~ '^sha256/[0-9a-f]{2}/[0-9a-f]{64}$'
    OR projection_key ~ '^staging/sha256/[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT local_review_projection_gc_actions_action_type_check CHECK (
    action_type IN (
      'planned','deleted','preserved','rejected','retained','operator_maintenance_required'
    )
  ),
  ADD CONSTRAINT local_review_projection_gc_actions_reason_code_check CHECK (
    reason_code IN (
      'unreferenced_content_addressed_projection','canonical_reference_present',
      'unsafe_projection_tree','automatic_deletion_unsupported',
      'staging_restart_recovery','prior_action_outcome_indeterminate'
    )
  );

COMMENT ON TABLE local_review_projection_gc_actions IS
  'Append-only local review projection maintenance ledger. Historical planned/deleted rows remain evidence; current maintenance retains descendants and records non-destructive or operator-maintenance outcomes.';
COMMENT ON COLUMN local_review_projection_gc_actions.projection_key IS
  'Content-addressed projection key or non-reversible staging observation identity; never an absolute or attacker-controlled filesystem path.';
