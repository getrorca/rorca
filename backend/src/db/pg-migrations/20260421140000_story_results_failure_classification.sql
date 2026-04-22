-- CP-001: Add failure classification columns to story_results.
-- failure_reason: normalized failure reason enum (e.g. 'agent_timeout', 'merge_conflict')
-- recovery_class: 'transient' | 'terminal' | 'policy_fail' — drives cascade prevention dispatcher
-- Existing rows without these columns remain readable (reader code treats NULL recovery_class as 'terminal').

ALTER TABLE story_results ADD COLUMN IF NOT EXISTS failure_reason TEXT NULL;
ALTER TABLE story_results ADD COLUMN IF NOT EXISTS recovery_class TEXT NULL
  CHECK (recovery_class IS NULL OR recovery_class IN ('transient', 'terminal', 'policy_fail'));
