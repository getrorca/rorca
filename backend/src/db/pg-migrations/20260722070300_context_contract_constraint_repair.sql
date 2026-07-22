-- Repair the unified context contract after brownfield installs retained both
-- the narrow UCC-007 checks and later compatibility checks. PostgreSQL applies
-- both constraints as an intersection, rejecting every legacy public-ingress
-- value. Replace them with one explicit compatibility union per column.

ALTER TABLE context_events
  DROP CONSTRAINT IF EXISTS context_events_event_type_ucc007_check,
  DROP CONSTRAINT IF EXISTS context_events_trust_tier_ucc007_check,
  DROP CONSTRAINT IF EXISTS context_events_event_type_capture_compat_check,
  DROP CONSTRAINT IF EXISTS context_events_trust_tier_capture_compat_check;

ALTER TABLE memory_candidates
  DROP CONSTRAINT IF EXISTS memory_candidates_event_type_ucc007_check,
  DROP CONSTRAINT IF EXISTS memory_candidates_trust_tier_ucc007_check,
  DROP CONSTRAINT IF EXISTS memory_candidates_event_type_capture_compat_check,
  DROP CONSTRAINT IF EXISTS memory_candidates_trust_tier_capture_compat_check;

ALTER TABLE context_events
  ADD CONSTRAINT context_events_event_type_capture_compat_check
  CHECK (event_type IS NULL OR event_type IN (
    'commit', 'note', 'file_change', 'manual', 'reconcile',
    'manual_cli_note', 'manual_note', 'git_commit', 'git_range', 'daemon_scan',
    'pr_merge', 'incident', 'duckbrain_import', 'duckbrain_memory', 'hermes_event', 'hermes_session',
    'agent_cli_session', 'ide_session', 'shell_command', 'editor_activity', 'explicit_memory', 'ci_pr'
  )) NOT VALID,
  ADD CONSTRAINT context_events_trust_tier_capture_compat_check
  CHECK (trust_tier IS NULL OR trust_tier IN (
    'authoritative', 'trusted', 'community', 'unverified',
    'agent_observation', 'working_note', 'engineering_decision', 'approved_policy', 'verified_fact',
    'untrusted', 'local', 'verified', 'privileged'
  )) NOT VALID;

ALTER TABLE memory_candidates
  ADD CONSTRAINT memory_candidates_event_type_capture_compat_check
  CHECK (event_type IS NULL OR event_type IN (
    'commit', 'note', 'file_change', 'manual', 'reconcile',
    'manual_cli_note', 'manual_note', 'git_commit', 'git_range', 'daemon_scan',
    'pr_merge', 'incident', 'duckbrain_import', 'duckbrain_memory', 'hermes_event', 'hermes_session',
    'agent_cli_session', 'ide_session', 'shell_command', 'editor_activity', 'explicit_memory', 'ci_pr'
  )) NOT VALID,
  ADD CONSTRAINT memory_candidates_trust_tier_capture_compat_check
  CHECK (trust_tier IS NULL OR trust_tier IN (
    'authoritative', 'trusted', 'community', 'unverified',
    'agent_observation', 'working_note', 'engineering_decision', 'approved_policy', 'verified_fact',
    'untrusted', 'local', 'verified', 'privileged'
  )) NOT VALID;
