-- Copyright (c) 2026 Rorca Inc.
-- SPDX-License-Identifier: Apache-2.0
-- Licensed under the Apache License, Version 2.0.
-- See LICENSE file in the project root for full license text.

-- Provider-neutral delivery metadata is canonical in PostgreSQL. The filesystem
-- contains only a content-addressed immutable projection; no provider, merge, or
-- deployment authority is represented by these rows.
CREATE TABLE IF NOT EXISTS local_review_bundles (
  bundle_id TEXT PRIMARY KEY CHECK (bundle_id ~ '^lrb-[0-9a-f]{64}$'),
  contract_version TEXT NOT NULL CHECK (contract_version = 'rorca.delivery-adapter.v1'),
  schema_version TEXT NOT NULL CHECK (schema_version = 'rorca.local-review-bundle.v1'),
  adapter_id TEXT NOT NULL CHECK (adapter_id = 'local-review-bundle'),
  adapter_version TEXT NOT NULL CHECK (adapter_version = '1.0.0'),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  spec_id TEXT NOT NULL CHECK (btrim(spec_id) <> '' AND octet_length(spec_id) <= 255),
  story_id TEXT NOT NULL CHECK (btrim(story_id) <> '' AND octet_length(story_id) <= 160),
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  launch_generation UUID NOT NULL,
  host_attempt_envelope_id UUID NOT NULL REFERENCES host_story_attempt_envelopes(envelope_id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (
    octet_length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  content_hash TEXT NOT NULL UNIQUE CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  projection_key TEXT NOT NULL UNIQUE CHECK (projection_key ~ '^sha256/[0-9a-f]{2}/[0-9a-f]{64}$'),
  manifest_json JSONB NOT NULL CHECK ((
    jsonb_typeof(manifest_json) = 'object'
    AND manifest_json->>'schemaVersion' = 'rorca.local-review-bundle.v1'
    AND octet_length(manifest_json::text) <= 262144
    -- CHECK normally accepts NULL; explicit key gates keep malformed JSON closed.
    AND manifest_json ?& ARRAY['schemaVersion','adapter','bundleId','contentHash','idempotencyKey','identity','specification','repository','changedFiles','artifacts','validation','evidenceReferences','createdAt','delivery']
    AND (manifest_json->'adapter') ?& ARRAY['contractVersion','adapterId','adapterVersion','requiresNetwork','requiresCredentials']
    AND (manifest_json->'identity') ?& ARRAY['workspaceId','specId','storyId','runId','attempt','generation','hostAttemptEnvelopeId']
    AND (manifest_json->'specification') ?& ARRAY['canonicalPath','revision','bytesHash','storyRevision','executionManifestHash']
    AND (manifest_json->'repository') ?& ARRAY['repositoryIdentity','repositoryPathDigest','worktreeIdentity','worktreePathDigest','runBaseSha','baseSha','headSha','branch']
    AND (manifest_json->'validation') ?& ARRAY['status','authoredBy','receipts','agentProseAccepted','ptyAccepted','processExitAcceptedAsPass','memoryAccepted']
    AND (manifest_json->'delivery') ?& ARRAY['reviewStatus','mergeStatus','deploymentStatus','mergeAuthority','deploymentAuthority']
  ) IS TRUE),
  validation_status TEXT NOT NULL CHECK (validation_status IN ('passed','blocked')),
  merge_status TEXT NOT NULL CHECK (merge_status = 'not_authorized'),
  deployment_status TEXT NOT NULL CHECK (deployment_status = 'not_authorized'),
  created_by TEXT NOT NULL CHECK (btrim(created_by) <> '' AND octet_length(created_by) <= 255),
  created_at TIMESTAMPTZ NOT NULL,
  finalized_at TIMESTAMPTZ NOT NULL,
  UNIQUE (workspace_id, adapter_id, idempotency_key),
  UNIQUE (workspace_id, run_id, story_id, attempt, launch_generation, adapter_id),
  CHECK (bundle_id = 'lrb-' || substring(content_hash FROM 8)),
  CHECK ((projection_key = ('sha256/' || substring(content_hash FROM 8 FOR 2) || '/' || substring(content_hash FROM 8))) IS TRUE),
  CHECK (finalized_at = created_at),
  CHECK (manifest_json->>'bundleId' = bundle_id),
  CHECK (manifest_json->>'contentHash' = content_hash),
  CHECK (manifest_json->>'idempotencyKey' = idempotency_key),
  CHECK (manifest_json#>>'{identity,workspaceId}' = workspace_id),
  CHECK ((manifest_json#>>'{identity,runId}')::bigint = run_id),
  CHECK (manifest_json#>>'{identity,specId}' = spec_id),
  CHECK (manifest_json#>>'{identity,storyId}' = story_id),
  CHECK ((manifest_json#>>'{identity,attempt}')::integer = attempt),
  CHECK ((manifest_json#>>'{identity,generation}')::uuid = launch_generation),
  CHECK ((manifest_json#>>'{identity,hostAttemptEnvelopeId}')::uuid = host_attempt_envelope_id),
  CHECK (manifest_json#>>'{adapter,contractVersion}' = contract_version),
  CHECK (manifest_json#>>'{adapter,adapterId}' = adapter_id),
  CHECK (manifest_json#>>'{adapter,adapterVersion}' = adapter_version),
  CHECK (manifest_json#>>'{adapter,requiresNetwork}' = 'false'),
  CHECK (manifest_json#>>'{adapter,requiresCredentials}' = 'false'),
  CHECK (manifest_json#>>'{validation,status}' = validation_status),
  CHECK ((validation_status = 'passed' AND manifest_json#>>'{validation,authoredBy}' = 'host_closeout')
      OR (validation_status = 'blocked' AND manifest_json#>>'{validation,authoredBy}' = 'none')),
  CHECK (manifest_json#>>'{validation,agentProseAccepted}' = 'false'),
  CHECK (manifest_json#>>'{validation,ptyAccepted}' = 'false'),
  CHECK (manifest_json#>>'{validation,processExitAcceptedAsPass}' = 'false'),
  CHECK (manifest_json#>>'{validation,memoryAccepted}' = 'false'),
  CHECK (manifest_json#>>'{delivery,mergeStatus}' = 'not_authorized'),
  CHECK (manifest_json#>>'{delivery,deploymentStatus}' = 'not_authorized'),
  CHECK (manifest_json#>>'{delivery,mergeAuthority}' = 'none'),
  CHECK (manifest_json#>>'{delivery,deploymentAuthority}' = 'none'),
  CHECK ((manifest_json->>'createdAt')::timestamptz = created_at)
);

CREATE INDEX IF NOT EXISTS idx_local_review_bundles_run
  ON local_review_bundles (workspace_id, run_id, finalized_at DESC);

CREATE TABLE IF NOT EXISTS local_review_bundle_conflicts (
  conflict_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  adapter_id TEXT NOT NULL CHECK (adapter_id = 'local-review-bundle'),
  idempotency_key TEXT NOT NULL CHECK (
    octet_length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  existing_request_hash TEXT NOT NULL CHECK (existing_request_hash ~ '^sha256:[0-9a-f]{64}$'),
  conflicting_request_hash TEXT NOT NULL CHECK (conflicting_request_hash ~ '^sha256:[0-9a-f]{64}$'),
  reason_code TEXT NOT NULL CHECK (reason_code = 'changed_replay'),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  observed_by TEXT NOT NULL CHECK (length(observed_by) BETWEEN 1 AND 255),
  FOREIGN KEY (workspace_id, adapter_id, idempotency_key)
    REFERENCES local_review_bundles(workspace_id, adapter_id, idempotency_key)
    ON DELETE RESTRICT,
  CHECK (existing_request_hash <> conflicting_request_hash)
);

CREATE INDEX IF NOT EXISTS idx_local_review_bundle_conflicts_scope
  ON local_review_bundle_conflicts (workspace_id, adapter_id, idempotency_key, observed_at DESC);

CREATE OR REPLACE FUNCTION enforce_local_review_bundle_authority()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  envelope host_story_attempt_envelopes%ROWTYPE;
BEGIN
  SELECT * INTO envelope FROM host_story_attempt_envelopes
   WHERE envelope_id = NEW.host_attempt_envelope_id FOR SHARE;
  IF envelope.envelope_id IS NULL
     OR envelope.workspace_id <> NEW.workspace_id
     OR envelope.run_id <> NEW.run_id
     OR envelope.story_id <> NEW.story_id
     OR envelope.attempt <> NEW.attempt
     OR envelope.launch_generation <> NEW.launch_generation
     OR envelope.finished_at IS NULL
     OR envelope.finished_at <> NEW.created_at
     OR envelope.spec_id <> NEW.spec_id
     OR envelope.manifest_hash <> (NEW.manifest_json#>>'{specification,executionManifestHash}')
     OR envelope.canonical_spec_path <> (NEW.manifest_json#>>'{specification,canonicalPath}')
     OR envelope.canonical_spec_revision <> (NEW.manifest_json#>>'{specification,revision}')
     OR envelope.canonical_spec_bytes_hash <> (NEW.manifest_json#>>'{specification,bytesHash}')
     OR envelope.story_revision <> (NEW.manifest_json#>>'{specification,storyRevision}')
     OR envelope.manifest_hash <> (NEW.manifest_json#>>'{specification,executionManifestHash}')
     OR envelope.base_git_sha <> (NEW.manifest_json#>>'{repository,runBaseSha}')
     OR envelope.observed_git_sha <> (NEW.manifest_json#>>'{repository,baseSha}')
     OR envelope.expected_git_sha <> (NEW.manifest_json#>>'{repository,headSha}')
     OR envelope.repository_identity <> (NEW.manifest_json#>>'{repository,repositoryIdentity}')
     OR envelope.worktree_identity <> (NEW.manifest_json#>>'{repository,worktreeIdentity}')
     OR envelope.worktree_branch <> (NEW.manifest_json#>>'{repository,branch}')
     OR envelope.canonical_spec_bytes_hash <> (NEW.manifest_json#>>'{specification,bytesHash}')
     OR envelope.repository_identity <> (NEW.manifest_json#>>'{repository,repositoryIdentity}')
     OR envelope.worktree_identity <> (NEW.manifest_json#>>'{repository,worktreeIdentity}')
     OR envelope.base_git_sha::text <> (NEW.manifest_json#>>'{repository,runBaseSha}')
     OR envelope.observed_git_sha::text <> (NEW.manifest_json#>>'{repository,baseSha}')
     OR envelope.worktree_branch <> (NEW.manifest_json#>>'{repository,branch}')
     OR envelope.authority_state <> 'valid'
     OR EXISTS (
       SELECT 1 FROM host_story_attempt_conflicts conflict
        WHERE conflict.workspace_id = envelope.workspace_id
          AND conflict.run_id = envelope.run_id
          AND conflict.story_id = envelope.story_id
          AND conflict.attempt = envelope.attempt
     ) THEN
    RAISE EXCEPTION 'local review bundle differs from immutable host attempt authority'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.validation_status = 'passed' AND NOT EXISTS (
    SELECT 1
      FROM story_closeout_decisions decision
      JOIN pipeline_runs run ON run.id = decision.run_id AND run.workspace_id = decision.workspace_id
      JOIN story_results result
        ON result.run_id = decision.run_id
       AND result.story_id = decision.story_id
       AND result.closeout_decision_id = decision.decision_id
      JOIN checkpoint_validation_attestations receipt
        ON receipt.workspace_id = decision.workspace_id
       AND receipt.run_id = decision.run_id
       AND receipt.story_id = decision.story_id
       AND receipt.branch_name = envelope.worktree_branch
       AND receipt.checkpoint_sha = result.commit_sha
       AND receipt.validation_gate = 'execution-engine'
     WHERE decision.workspace_id = NEW.workspace_id
       AND decision.run_id = NEW.run_id
       AND decision.story_id = NEW.story_id
       AND decision.attempt = NEW.attempt
       AND decision.manifest_hash = envelope.manifest_hash
       AND decision.status = 'accepted'
       AND result.status = 'pass'
       AND result.result_provenance = 'host'
       AND result.result_source = 'execution-engine'
       AND result.integrated = TRUE
       AND result.commit_author = 'rorca-execution-engine'
       AND result.commit_branch = envelope.worktree_branch
       AND result.worktree_path = envelope.worktree_realpath
       AND result.commit_sha = (NEW.manifest_json#>>'{repository,headSha}')
       AND run.dispatch_fence = envelope.cancellation_fence
       AND NOT EXISTS (SELECT 1 FROM pipeline_run_cancellation_requests cancellation WHERE cancellation.run_id = run.id)
       AND NOT EXISTS (SELECT 1 FROM governed_retry_dispatches retry
                        WHERE retry.retry_run_id = run.id AND retry.cancellation_requested_at IS NOT NULL)
       AND envelope.outcome = 'success'
       AND envelope.outcome_provenance = 'host_process'
       AND envelope.exit_code = 0
       AND envelope.exit_signal IS NULL
       AND receipt.revoked_at IS NULL
       AND receipt.passed_at <= NEW.created_at
       AND receipt.expires_at > NEW.created_at
  ) THEN
    RAISE EXCEPTION 'passed local review bundle lacks exact host closeout and validation authority'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_local_review_bundle_authority ON local_review_bundles;
CREATE TRIGGER trg_local_review_bundle_authority
BEFORE INSERT ON local_review_bundles
FOR EACH ROW EXECUTE FUNCTION enforce_local_review_bundle_authority();

CREATE OR REPLACE FUNCTION reject_local_review_bundle_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'finalized local review bundles are immutable'
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS trg_local_review_bundle_immutable ON local_review_bundles;
CREATE TRIGGER trg_local_review_bundle_immutable
BEFORE UPDATE OR DELETE ON local_review_bundles
FOR EACH ROW EXECUTE FUNCTION reject_local_review_bundle_mutation();

DROP TRIGGER IF EXISTS trg_local_review_bundle_conflict_immutable ON local_review_bundle_conflicts;
CREATE TRIGGER trg_local_review_bundle_conflict_immutable
BEFORE UPDATE OR DELETE ON local_review_bundle_conflicts
FOR EACH ROW EXECUTE FUNCTION reject_local_review_bundle_mutation();
