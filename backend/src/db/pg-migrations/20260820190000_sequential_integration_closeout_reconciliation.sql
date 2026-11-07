-- 20260820190000_sequential_integration_closeout_reconciliation.sql
-- Reconcile accepted sequential story integrations created after the original
-- legacy closeout backfill but before the worker began reconciling sequential
-- integration ledgers at semantic closeout. Trusted host run_closeout evidence
-- is the only authority; existing ledger rows remain immutable.
--
-- runPgMigrations supplies the transaction boundary for this file.

WITH canonical_closeout AS (
  SELECT
    run.id AS run_id,
    wal.id AS wal_id,
    wal.event_identity_hash,
    wal.payload
  FROM rorca.pipeline_runs run
  JOIN rorca.wal_events wal ON wal.id = run.host_closeout_event_id
  WHERE wal.event_type = 'run_closeout'
    AND wal.trust_provenance = 'host'
    AND wal.trusted_source = 'worker'
    AND wal.outbox_ready_at IS NOT NULL
),
ancestry AS (
  SELECT
    closeout.run_id,
    closeout.wal_id,
    closeout.event_identity_hash,
    element.value AS resulting_head,
    element.ordinality - 1 AS integration_order
  FROM canonical_closeout closeout
  CROSS JOIN LATERAL jsonb_array_elements_text(closeout.payload->'integration_ancestry')
    WITH ORDINALITY AS element(value, ordinality)
)
INSERT INTO rorca.story_integration_ledger (
  run_id, story_id, attempt, wave_index, integration_order, state,
  source_commit, source_base_commit, expected_parent_head, resulting_head,
  frozen_manifest_hash, validation_identity, finalization_identity, finalized_at
)
SELECT
  decision.run_id,
  decision.story_id,
  decision.attempt,
  0 AS wave_index,
  position.integration_order,
  'finalized',
  position.resulting_head AS source_commit,
  COALESCE(
    previous.resulting_head,
    left(encode(digest(('sequential-closeout-base:' || decision.run_id::text), 'sha256'), 'hex'), 40)
  ) AS source_base_commit,
  COALESCE(
    previous.resulting_head,
    left(encode(digest(('sequential-closeout-base:' || decision.run_id::text), 'sha256'), 'hex'), 40)
  ) AS expected_parent_head,
  position.resulting_head,
  left(encode(digest((
    'sequential-closeout-ledger:' || decision.run_id::text || ':' || decision.story_id || ':' || decision.attempt::text
  ), 'sha256'), 'hex'), 64) AS frozen_manifest_hash,
  jsonb_build_object(
    'schemaVersion', 'rorca.sequential-integration-closeout-reconciliation.v1',
    'evidence', 'trusted-wal:' || position.wal_id || ':' || position.event_identity_hash,
    'runId', decision.run_id
  ) AS validation_identity,
  jsonb_build_object(
    'schemaVersion', 'rorca.sequential-integration-closeout-reconciliation.v1',
    'idempotencyKey', 'sequential-closeout-ledger:' || decision.run_id || ':' || decision.story_id || ':' || decision.attempt,
    'runId', decision.run_id
  ) AS finalization_identity,
  NOW() AS finalized_at
FROM rorca.story_closeout_decisions decision
JOIN rorca.story_commits commit_row
  ON commit_row.run_id = decision.run_id
 AND commit_row.story_id = decision.story_id
JOIN ancestry position
  ON position.run_id = decision.run_id
 AND position.resulting_head = lower(commit_row.commit_sha)
LEFT JOIN ancestry previous
  ON previous.run_id = position.run_id
 AND previous.integration_order = position.integration_order - 1
WHERE decision.status = 'accepted'
  AND NOT EXISTS (
    SELECT 1 FROM rorca.story_integration_ledger existing
    WHERE existing.run_id = decision.run_id
      AND existing.story_id = decision.story_id
      AND existing.attempt = decision.attempt
  )
ON CONFLICT (run_id, story_id, attempt) DO NOTHING;
