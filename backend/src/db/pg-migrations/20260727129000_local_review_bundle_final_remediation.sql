-- Copyright (c) 2026 Rorca Inc.
-- SPDX-License-Identifier: Apache-2.0
-- Licensed under the Apache License, Version 2.0.
-- See LICENSE file in the project root for full license text.

-- The canonical migration runner owns migration and marker atomicity.
-- Exact canonical bytes make request/content/manifest hashes independently
-- recomputable in PostgreSQL. Existing 1.0.0 rows remain readable; every new
-- 1.1.0 row is required to carry all three byte identities by the insert gate.
ALTER TABLE local_review_bundles
  ADD COLUMN IF NOT EXISTS request_bytes BYTEA,
  ADD COLUMN IF NOT EXISTS content_basis_bytes BYTEA,
  ADD COLUMN IF NOT EXISTS manifest_bytes BYTEA;
ALTER TABLE local_review_bundles
  DROP CONSTRAINT IF EXISTS local_review_bundles_adapter_version_check;
ALTER TABLE local_review_bundles
  ADD CONSTRAINT local_review_bundles_adapter_version_check
    CHECK (adapter_version IN ('1.0.0', '1.1.0'));

CREATE OR REPLACE FUNCTION local_review_safe_relative_path(candidate TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT (
    candidate IS NOT NULL
    AND octet_length(candidate) BETWEEN 1 AND 4096
    AND candidate !~ '^/'
    AND candidate !~ '\\'
    AND candidate !~ '[[:cntrl:]]'
    AND candidate !~ '(^|/)[.]{1,2}(/|$)'
    AND candidate !~ '//'
    AND candidate !~ '/$'
  ) IS TRUE
$$;

CREATE OR REPLACE FUNCTION local_review_manifest_is_complete(candidate JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  changed JSONB;
BEGIN
  IF jsonb_typeof(candidate) <> 'object'
     OR octet_length(candidate::text) > 262144
     OR NOT (candidate ?& ARRAY['schemaVersion','adapter','bundleId','contentHash','idempotencyKey','identity','specification','repository','changedFiles','artifacts','validation','evidenceReferences','createdAt','delivery'])
     OR jsonb_typeof(candidate->'adapter') <> 'object'
     OR jsonb_typeof(candidate->'identity') <> 'object'
     OR jsonb_typeof(candidate->'specification') <> 'object'
     OR jsonb_typeof(candidate->'repository') <> 'object'
     OR jsonb_typeof(candidate->'changedFiles') <> 'array'
     OR jsonb_typeof(candidate->'artifacts') <> 'array'
     OR jsonb_typeof(candidate->'validation') <> 'object'
     OR jsonb_typeof(candidate#>'{validation,receipts}') <> 'array'
     OR jsonb_typeof(candidate->'evidenceReferences') <> 'array'
     OR jsonb_typeof(candidate->'delivery') <> 'object' THEN
    RETURN FALSE;
  END IF;
  IF NOT ((candidate->'adapter') ?& ARRAY['contractVersion','adapterId','adapterVersion','label','kind','default','optional','requiresNetwork','requiresCredentials','supportsReviewBundle','supportsExternalChangeRequest','mergeAuthority','deploymentAuthority'])
     OR NOT ((candidate->'identity') ?& ARRAY['workspaceId','specId','storyId','runId','attempt','generation','hostAttemptEnvelopeId'])
     OR NOT ((candidate->'specification') ?& ARRAY['canonicalPath','revision','bytesHash','storyRevision','executionManifestHash'])
     OR NOT ((candidate->'repository') ?& ARRAY['repositoryIdentity','repositoryPathDigest','worktreeIdentity','worktreePathDigest','runBaseSha','baseSha','headSha','branch'])
     OR NOT ((candidate->'validation') ?& ARRAY['status','authoredBy','receipts','agentProseAccepted','ptyAccepted','processExitAcceptedAsPass','memoryAccepted'])
     OR NOT ((candidate->'delivery') ?& ARRAY['reviewStatus','mergeStatus','deploymentStatus','mergeAuthority','deploymentAuthority']) THEN
    RETURN FALSE;
  END IF;
  IF jsonb_typeof(candidate#>'{adapter,requiresNetwork}') <> 'boolean'
     OR jsonb_typeof(candidate#>'{adapter,requiresCredentials}') <> 'boolean'
     OR jsonb_typeof(candidate#>'{adapter,default}') <> 'boolean'
     OR jsonb_typeof(candidate#>'{adapter,optional}') <> 'boolean'
     OR jsonb_typeof(candidate#>'{identity,runId}') <> 'number'
     OR jsonb_typeof(candidate#>'{identity,attempt}') <> 'number'
     OR jsonb_typeof(candidate#>'{validation,agentProseAccepted}') <> 'boolean'
     OR jsonb_typeof(candidate#>'{validation,ptyAccepted}') <> 'boolean'
     OR jsonb_typeof(candidate#>'{validation,processExitAcceptedAsPass}') <> 'boolean'
     OR jsonb_typeof(candidate#>'{validation,memoryAccepted}') <> 'boolean'
     OR jsonb_array_length(candidate->'changedFiles') > 500
     OR jsonb_array_length(candidate->'artifacts') <> 1
     OR jsonb_array_length(candidate#>'{validation,receipts}') > 32
     OR jsonb_array_length(candidate->'evidenceReferences') > 64
     OR NOT local_review_safe_relative_path(candidate#>>'{specification,canonicalPath}')
     OR (candidate#>>'{identity,runId}') !~ '^[1-9][0-9]*$'
     OR (candidate#>>'{identity,attempt}') !~ '^[1-9][0-9]*$'
     OR (candidate#>>'{identity,generation}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR (candidate#>>'{identity,hostAttemptEnvelopeId}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR (candidate->>'bundleId') !~ '^lrb-[0-9a-f]{64}$'
     OR (candidate->>'contentHash') !~ '^sha256:[0-9a-f]{64}$'
     OR (candidate#>>'{specification,revision}') !~ '^sha256:[0-9a-f]{64}$'
     OR (candidate#>>'{specification,bytesHash}') !~ '^sha256:[0-9a-f]{64}$'
     OR (candidate#>>'{specification,storyRevision}') !~ '^sha256:[0-9a-f]{64}$'
     OR (candidate#>>'{specification,executionManifestHash}') !~ '^sha256:[0-9a-f]{64}$'
     OR (candidate#>>'{repository,headSha}') !~ '^[0-9a-f]{40}$'
     OR (candidate#>>'{repository,baseSha}') !~ '^[0-9a-f]{40}$'
     OR (candidate#>>'{repository,runBaseSha}') !~ '^[0-9a-f]{40}$' THEN
    RETURN FALSE;
  END IF;
  FOR changed IN SELECT value FROM jsonb_array_elements(candidate->'changedFiles') LOOP
    IF jsonb_typeof(changed) <> 'object'
       OR NOT (changed ?& ARRAY['path','change','before','after'])
       OR NOT local_review_safe_relative_path(changed->>'path') THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN (
    candidate->>'schemaVersion' = 'rorca.local-review-bundle.v1'
    AND candidate#>>'{adapter,contractVersion}' = 'rorca.delivery-adapter.v1'
    AND candidate#>>'{adapter,adapterId}' = 'local-review-bundle'
    AND candidate#>>'{adapter,adapterVersion}' IN ('1.0.0','1.1.0')
    AND (candidate#>>'{adapter,requiresNetwork}')::boolean = FALSE
    AND (candidate#>>'{adapter,requiresCredentials}')::boolean = FALSE
    AND candidate#>>'{delivery,reviewStatus}' = 'awaiting_local_review'
    AND candidate#>>'{delivery,mergeStatus}' = 'not_authorized'
    AND candidate#>>'{delivery,deploymentStatus}' = 'not_authorized'
    AND candidate#>>'{delivery,mergeAuthority}' = 'none'
    AND candidate#>>'{delivery,deploymentAuthority}' = 'none'
  ) IS TRUE;
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$$;

-- Final fail-closed JSONB contract. These definitions deliberately replace the
-- earlier compatibility implementation in this migration so immutable rows
-- cannot contain payloads that the runtime Zod contract would later reject.
CREATE OR REPLACE FUNCTION local_review_jsonb_has_exact_keys(candidate JSONB, expected TEXT[])
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT (
    jsonb_typeof(candidate) = 'object'
    AND candidate ?& expected
    AND (SELECT count(*) FROM jsonb_object_keys(candidate)) = cardinality(expected)
  ) IS TRUE
$$;

CREATE OR REPLACE FUNCTION local_review_safe_relative_path(candidate TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT (
    candidate IS NOT NULL
    AND octet_length(candidate) BETWEEN 1 AND 4096
    AND candidate !~ '^/' AND candidate !~ '\\' AND candidate !~ '[[:cntrl:]]'
    AND candidate !~ '(^|/)[.]{1,2}(/|$)' AND candidate !~ '//' AND candidate !~ '/$'
    AND candidate !~* '(^|/)([.]git(modules)?|[.]ssh|[.]aws|[.]azure|[.]gcloud|[.]gnupg|[.]docker|[.]kube|[.]env([.][^/]*)?|[.]npmrc|[.]pypirc|credentials?([-_.][^/]*)?|secrets?([-_.][^/]*)?|auth([-_.][^/]*)?|tokens?([-_.][^/]*)?|service[-_.]?accounts?([-_.][^/]*)?|id_(rsa|dsa|ecdsa|ed25519)|[^/]+[.](pem|key|p12|pfx|jks|keystore|secret|kdbx))(/|$)'
  ) IS TRUE
$$;

CREATE OR REPLACE FUNCTION local_review_snapshot_is_complete(candidate JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT (
    local_review_jsonb_has_exact_keys(candidate, ARRAY['bytes','sha256'])
    AND jsonb_typeof(candidate->'bytes') = 'number'
    AND candidate->>'bytes' ~ '^(0|[1-9][0-9]{0,6})$'
    AND (candidate->>'bytes')::bigint BETWEEN 0 AND 1048576
    AND jsonb_typeof(candidate->'sha256') = 'string'
    AND candidate->>'sha256' ~ '^sha256:[0-9a-f]{64}$'
  ) IS TRUE
$$;

CREATE OR REPLACE FUNCTION local_review_manifest_is_complete(candidate JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  changed JSONB;
  artifact JSONB;
  receipt JSONB;
  evidence JSONB;
  total_changed_bytes BIGINT := 0;
BEGIN
  IF (local_review_jsonb_has_exact_keys(candidate, ARRAY[
       'schemaVersion','adapter','bundleId','contentHash','idempotencyKey','identity',
       'specification','repository','changedFiles','artifacts','validation',
       'evidenceReferences','createdAt','delivery'])
     AND octet_length(candidate::text) <= 262144
     AND local_review_jsonb_has_exact_keys(candidate->'adapter', ARRAY[
       'contractVersion','adapterId','adapterVersion','label','kind','default','optional',
       'requiresNetwork','requiresCredentials','supportsReviewBundle',
       'supportsExternalChangeRequest','implementationStatus','mergeAuthority','deploymentAuthority'])
     AND local_review_jsonb_has_exact_keys(candidate->'identity', ARRAY[
       'workspaceId','specId','storyId','runId','attempt','generation','hostAttemptEnvelopeId'])
     AND local_review_jsonb_has_exact_keys(candidate->'specification', ARRAY[
       'canonicalPath','revision','bytesHash','storyRevision','executionManifestHash'])
     AND local_review_jsonb_has_exact_keys(candidate->'repository', ARRAY[
       'repositoryIdentity','repositoryPathDigest','worktreeIdentity','worktreePathDigest',
       'runBaseSha','baseSha','headSha','branch'])
     AND local_review_jsonb_has_exact_keys(candidate->'validation', ARRAY[
       'status','authoredBy','receipts','agentProseAccepted','ptyAccepted',
       'processExitAcceptedAsPass','memoryAccepted'])
     AND local_review_jsonb_has_exact_keys(candidate->'delivery', ARRAY[
       'reviewStatus','mergeStatus','deploymentStatus','mergeAuthority','deploymentAuthority'])
     AND jsonb_typeof(candidate->'changedFiles') = 'array'
     AND jsonb_typeof(candidate->'artifacts') = 'array'
     AND jsonb_typeof(candidate#>'{validation,receipts}') = 'array'
     AND jsonb_typeof(candidate->'evidenceReferences') = 'array'
     AND jsonb_array_length(candidate->'changedFiles') <= 500
     AND jsonb_array_length(candidate->'artifacts') = 1
     AND jsonb_array_length(candidate#>'{validation,receipts}') <= 32
     AND jsonb_array_length(candidate->'evidenceReferences') <= 64) IS DISTINCT FROM TRUE THEN
    RETURN FALSE;
  END IF;

  IF (jsonb_typeof(candidate->'schemaVersion') = 'string'
     AND candidate->>'schemaVersion' = 'rorca.local-review-bundle.v1'
     AND jsonb_typeof(candidate->'bundleId') = 'string'
     AND candidate->>'bundleId' ~ '^lrb-[0-9a-f]{64}$'
     AND jsonb_typeof(candidate->'contentHash') = 'string'
     AND candidate->>'contentHash' ~ '^sha256:[0-9a-f]{64}$'
     AND jsonb_typeof(candidate->'idempotencyKey') = 'string'
     AND octet_length(candidate->>'idempotencyKey') BETWEEN 8 AND 200
     AND candidate->>'idempotencyKey' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
     AND jsonb_typeof(candidate->'createdAt') = 'string'
     AND candidate->>'createdAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([.]\d+)?(Z|[+-]\d{2}:\d{2})$') IS DISTINCT FROM TRUE THEN
    RETURN FALSE;
  END IF;
  PERFORM (candidate->>'createdAt')::timestamptz;

  IF (jsonb_typeof(candidate#>'{adapter,contractVersion}') = 'string'
     AND candidate#>>'{adapter,contractVersion}' = 'rorca.delivery-adapter.v1'
     AND jsonb_typeof(candidate#>'{adapter,adapterId}') = 'string'
     AND candidate#>>'{adapter,adapterId}' = 'local-review-bundle'
     AND jsonb_typeof(candidate#>'{adapter,adapterVersion}') = 'string'
     AND candidate#>>'{adapter,adapterVersion}' IN ('1.0.0','1.1.0')
     AND jsonb_typeof(candidate#>'{adapter,label}') = 'string'
     AND octet_length(candidate#>>'{adapter,label}') BETWEEN 1 AND 120
     AND candidate#>>'{adapter,kind}' = 'local'
     AND jsonb_typeof(candidate#>'{adapter,default}') = 'boolean'
     AND (candidate#>>'{adapter,default}')::boolean = TRUE
     AND jsonb_typeof(candidate#>'{adapter,optional}') = 'boolean'
     AND (candidate#>>'{adapter,optional}')::boolean = FALSE
     AND jsonb_typeof(candidate#>'{adapter,requiresNetwork}') = 'boolean'
     AND (candidate#>>'{adapter,requiresNetwork}')::boolean = FALSE
     AND jsonb_typeof(candidate#>'{adapter,requiresCredentials}') = 'boolean'
     AND (candidate#>>'{adapter,requiresCredentials}')::boolean = FALSE
     AND jsonb_typeof(candidate#>'{adapter,supportsReviewBundle}') = 'boolean'
     AND (candidate#>>'{adapter,supportsReviewBundle}')::boolean = TRUE
     AND jsonb_typeof(candidate#>'{adapter,supportsExternalChangeRequest}') = 'boolean'
     AND (candidate#>>'{adapter,supportsExternalChangeRequest}')::boolean = FALSE
     AND candidate#>>'{adapter,implementationStatus}' = 'canonical_adapter'
     AND candidate#>>'{adapter,mergeAuthority}' = 'none'
     AND candidate#>>'{adapter,deploymentAuthority}' = 'none') IS DISTINCT FROM TRUE THEN
    RETURN FALSE;
  END IF;

  IF (jsonb_typeof(candidate#>'{identity,workspaceId}') = 'string'
     AND octet_length(candidate#>>'{identity,workspaceId}') BETWEEN 1 AND 255
     AND candidate#>>'{identity,workspaceId}' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
     AND jsonb_typeof(candidate#>'{identity,specId}') = 'string'
     AND octet_length(candidate#>>'{identity,specId}') BETWEEN 1 AND 255
     AND jsonb_typeof(candidate#>'{identity,storyId}') = 'string'
     AND octet_length(candidate#>>'{identity,storyId}') BETWEEN 1 AND 160
     AND candidate#>>'{identity,storyId}' !~ '[[:cntrl:]]'
     AND jsonb_typeof(candidate#>'{identity,runId}') = 'number'
     AND candidate#>>'{identity,runId}' ~ '^[1-9][0-9]*$'
     AND (candidate#>>'{identity,runId}')::numeric <= 9007199254740991
     AND jsonb_typeof(candidate#>'{identity,attempt}') = 'number'
     AND candidate#>>'{identity,attempt}' ~ '^[1-9][0-9]*$'
     AND (candidate#>>'{identity,attempt}')::numeric <= 2147483647
     AND jsonb_typeof(candidate#>'{identity,generation}') = 'string'
     AND candidate#>>'{identity,generation}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     AND jsonb_typeof(candidate#>'{identity,hostAttemptEnvelopeId}') = 'string'
     AND candidate#>>'{identity,hostAttemptEnvelopeId}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') IS DISTINCT FROM TRUE THEN
    RETURN FALSE;
  END IF;

  IF (local_review_safe_relative_path(candidate#>>'{specification,canonicalPath}')
     AND candidate#>>'{specification,revision}' ~ '^sha256:[0-9a-f]{64}$'
     AND candidate#>>'{specification,bytesHash}' ~ '^sha256:[0-9a-f]{64}$'
     AND candidate#>>'{specification,storyRevision}' ~ '^sha256:[0-9a-f]{64}$'
     AND candidate#>>'{specification,executionManifestHash}' ~ '^sha256:[0-9a-f]{64}$'
     AND candidate#>>'{repository,repositoryIdentity}' ~ '^sha256:[0-9a-f]{64}$'
     AND candidate#>>'{repository,repositoryPathDigest}' ~ '^sha256:[0-9a-f]{64}$'
     AND candidate#>>'{repository,worktreeIdentity}' ~ '^sha256:[0-9a-f]{64}$'
     AND candidate#>>'{repository,worktreePathDigest}' ~ '^sha256:[0-9a-f]{64}$'
     AND candidate#>>'{repository,runBaseSha}' ~ '^[0-9a-f]{40}$'
     AND candidate#>>'{repository,baseSha}' ~ '^[0-9a-f]{40}$'
     AND candidate#>>'{repository,headSha}' ~ '^[0-9a-f]{40}$'
     AND jsonb_typeof(candidate#>'{repository,branch}') = 'string'
     AND octet_length(candidate#>>'{repository,branch}') BETWEEN 1 AND 1024
     AND candidate#>>'{repository,branch}' !~ '[[:cntrl:]]') IS DISTINCT FROM TRUE THEN
    RETURN FALSE;
  END IF;

  FOR changed IN SELECT value FROM jsonb_array_elements(candidate->'changedFiles') LOOP
    IF (local_review_jsonb_has_exact_keys(changed, ARRAY['path','change','before','after'])
       AND jsonb_typeof(changed->'path') = 'string'
       AND local_review_safe_relative_path(changed->>'path')
       AND jsonb_typeof(changed->'change') = 'string'
       AND changed->>'change' IN ('added','modified','deleted','type_changed','unmerged','unknown')
       AND (jsonb_typeof(changed->'before') = 'null' OR local_review_snapshot_is_complete(changed->'before'))
       AND (jsonb_typeof(changed->'after') = 'null' OR local_review_snapshot_is_complete(changed->'after'))
       AND NOT (jsonb_typeof(changed->'before') = 'null' AND jsonb_typeof(changed->'after') = 'null')) IS DISTINCT FROM TRUE THEN
      RETURN FALSE;
    END IF;
    total_changed_bytes := total_changed_bytes
      + CASE WHEN jsonb_typeof(changed->'before') = 'object' THEN (changed#>>'{before,bytes}')::bigint ELSE 0 END
      + CASE WHEN jsonb_typeof(changed->'after') = 'object' THEN (changed#>>'{after,bytes}')::bigint ELSE 0 END;
    IF total_changed_bytes > 8388608 THEN RETURN FALSE; END IF;
  END LOOP;

  artifact := candidate->'artifacts'->0;
  IF (local_review_jsonb_has_exact_keys(artifact, ARRAY['name','mediaType','bytes','sha256'])
     AND artifact->>'name' = 'changes.patch'
     AND artifact->>'mediaType' = 'text/x-diff'
     AND jsonb_typeof(artifact->'bytes') = 'number'
     AND artifact->>'bytes' ~ '^(0|[1-9][0-9]{0,7})$'
     AND (artifact->>'bytes')::bigint BETWEEN 0 AND 8388608
     AND jsonb_typeof(artifact->'sha256') = 'string'
     AND artifact->>'sha256' ~ '^sha256:[0-9a-f]{64}$') IS DISTINCT FROM TRUE THEN
    RETURN FALSE;
  END IF;

  FOR receipt IN SELECT value FROM jsonb_array_elements(candidate#>'{validation,receipts}') LOOP
    IF (local_review_jsonb_has_exact_keys(receipt, ARRAY[
         'receiptId','gate','checkpointSha','evidenceDigest','passedAt','expiresAt','revoked','trustClass'])
       AND jsonb_typeof(receipt->'receiptId') = 'string'
       AND octet_length(receipt->>'receiptId') BETWEEN 1 AND 255
       AND jsonb_typeof(receipt->'gate') = 'string'
       AND octet_length(receipt->>'gate') BETWEEN 1 AND 80
       AND receipt->>'checkpointSha' ~ '^[0-9a-f]{40}$'
       AND receipt->>'evidenceDigest' ~ '^sha256:[0-9a-f]{64}$'
       AND jsonb_typeof(receipt->'passedAt') = 'string'
       AND receipt->>'passedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([.]\d+)?(Z|[+-]\d{2}:\d{2})$'
       AND jsonb_typeof(receipt->'expiresAt') = 'string'
       AND receipt->>'expiresAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([.]\d+)?(Z|[+-]\d{2}:\d{2})$'
       AND jsonb_typeof(receipt->'revoked') = 'boolean'
       AND receipt->>'trustClass' = 'host_observed') IS DISTINCT FROM TRUE THEN
      RETURN FALSE;
    END IF;
    PERFORM (receipt->>'passedAt')::timestamptz;
    PERFORM (receipt->>'expiresAt')::timestamptz;
  END LOOP;

  FOR evidence IN SELECT value FROM jsonb_array_elements(candidate->'evidenceReferences') LOOP
    IF (local_review_jsonb_has_exact_keys(evidence, ARRAY['kind','reference','digest','trustClass'])
       AND evidence->>'kind' IN ('host_attempt','execution_manifest','attempt_result','closeout_decision','validation_receipt','run_closeout')
       AND jsonb_typeof(evidence->'reference') = 'string'
       AND octet_length(evidence->>'reference') BETWEEN 1 AND 255
       AND (jsonb_typeof(evidence->'digest') = 'null'
         OR (jsonb_typeof(evidence->'digest') = 'string' AND evidence->>'digest' ~ '^sha256:[0-9a-f]{64}$'))
       AND evidence->>'trustClass' = 'host_observed') IS DISTINCT FROM TRUE THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  RETURN (
    candidate#>>'{validation,status}' IN ('passed','blocked')
    AND candidate#>>'{validation,authoredBy}' IN ('host_closeout','none')
    AND ((candidate#>>'{validation,status}' = 'passed' AND candidate#>>'{validation,authoredBy}' = 'host_closeout')
      OR (candidate#>>'{validation,status}' = 'blocked' AND candidate#>>'{validation,authoredBy}' = 'none'))
    AND jsonb_typeof(candidate#>'{validation,agentProseAccepted}') = 'boolean'
    AND (candidate#>>'{validation,agentProseAccepted}')::boolean = FALSE
    AND jsonb_typeof(candidate#>'{validation,ptyAccepted}') = 'boolean'
    AND (candidate#>>'{validation,ptyAccepted}')::boolean = FALSE
    AND jsonb_typeof(candidate#>'{validation,processExitAcceptedAsPass}') = 'boolean'
    AND (candidate#>>'{validation,processExitAcceptedAsPass}')::boolean = FALSE
    AND jsonb_typeof(candidate#>'{validation,memoryAccepted}') = 'boolean'
    AND (candidate#>>'{validation,memoryAccepted}')::boolean = FALSE
    AND candidate#>>'{delivery,reviewStatus}' = 'awaiting_local_review'
    AND candidate#>>'{delivery,mergeStatus}' = 'not_authorized'
    AND candidate#>>'{delivery,deploymentStatus}' = 'not_authorized'
    AND candidate#>>'{delivery,mergeAuthority}' = 'none'
    AND candidate#>>'{delivery,deploymentAuthority}' = 'none'
  ) IS TRUE;
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION local_review_request_matches(
  candidate JSONB, expected_contract TEXT, expected_adapter TEXT, expected_version TEXT,
  expected_workspace TEXT, expected_run BIGINT, expected_story TEXT, expected_attempt INTEGER,
  expected_generation UUID, expected_envelope UUID, expected_actor TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  RETURN (
    local_review_jsonb_has_exact_keys(candidate, ARRAY[
      'contractVersion','adapterId','adapterVersion','workspaceId','runId','storyId',
      'attempt','generation','hostAttemptEnvelopeId','requestedBy'])
    AND jsonb_typeof(candidate->'contractVersion') = 'string'
    AND jsonb_typeof(candidate->'adapterId') = 'string'
    AND jsonb_typeof(candidate->'adapterVersion') = 'string'
    AND jsonb_typeof(candidate->'workspaceId') = 'string'
    AND jsonb_typeof(candidate->'runId') = 'number' AND candidate->>'runId' ~ '^[1-9][0-9]*$'
    AND jsonb_typeof(candidate->'storyId') = 'string'
    AND jsonb_typeof(candidate->'attempt') = 'number' AND candidate->>'attempt' ~ '^[1-9][0-9]*$'
    AND jsonb_typeof(candidate->'generation') = 'string'
    AND candidate->>'generation' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND jsonb_typeof(candidate->'hostAttemptEnvelopeId') = 'string'
    AND candidate->>'hostAttemptEnvelopeId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND jsonb_typeof(candidate->'requestedBy') = 'string'
    AND octet_length(candidate->>'requestedBy') BETWEEN 1 AND 255
    AND candidate->>'contractVersion' IS NOT DISTINCT FROM expected_contract
    AND candidate->>'adapterId' IS NOT DISTINCT FROM expected_adapter
    AND candidate->>'adapterVersion' IS NOT DISTINCT FROM expected_version
    AND candidate->>'workspaceId' IS NOT DISTINCT FROM expected_workspace
    AND (candidate->>'runId')::bigint IS NOT DISTINCT FROM expected_run
    AND candidate->>'storyId' IS NOT DISTINCT FROM expected_story
    AND (candidate->>'attempt')::integer IS NOT DISTINCT FROM expected_attempt
    AND (candidate->>'generation')::uuid IS NOT DISTINCT FROM expected_generation
    AND (candidate->>'hostAttemptEnvelopeId')::uuid IS NOT DISTINCT FROM expected_envelope
    AND candidate->>'requestedBy' IS NOT DISTINCT FROM expected_actor
  ) IS TRUE;
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$$;

CREATE TABLE IF NOT EXISTS local_review_bundle_disqualifications (
  disqualification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id TEXT NOT NULL REFERENCES local_review_bundles(bundle_id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  story_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'host_conflict','cancellation_requested','retry_cancellation_requested',
    'dispatch_fence_changed','validation_receipt_revoked'
  )),
  source_type TEXT NOT NULL CHECK (source_type IN (
    'host_story_attempt_conflict','pipeline_run_cancellation','governed_retry_cancellation',
    'pipeline_dispatch_fence','checkpoint_validation_receipt'
  )),
  source_identity TEXT NOT NULL CHECK (btrim(source_identity) <> '' AND octet_length(source_identity) <= 255),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (bundle_id, reason_code, source_type, source_identity)
);

CREATE TABLE IF NOT EXISTS local_review_projection_gc_audits (
  gc_audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  projection_key TEXT NOT NULL CHECK (projection_key ~ '^sha256/[0-9a-f]{2}/[0-9a-f]{64}$'),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  manifest_hash TEXT CHECK (manifest_hash IS NULL OR manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  reason_code TEXT NOT NULL CHECK (reason_code = 'unreferenced_content_addressed_projection'),
  observed_by TEXT NOT NULL CHECK (length(btrim(observed_by)) BETWEEN 1 AND 255),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (projection_key)
);

CREATE TABLE IF NOT EXISTS local_review_projection_gc_actions (
  action_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  projection_key TEXT NOT NULL CHECK (projection_key ~ '^sha256/[0-9a-f]{2}/[0-9a-f]{64}$'),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  action_type TEXT NOT NULL CHECK (action_type IN ('planned','deleted','preserved','rejected')),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'unreferenced_content_addressed_projection','canonical_reference_present','unsafe_projection_tree'
  )),
  observed_by TEXT NOT NULL CHECK (length(btrim(observed_by)) BETWEEN 1 AND 255),
  detail_code TEXT CHECK (detail_code IS NULL OR (length(btrim(detail_code)) BETWEEN 1 AND 120)),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (projection_key, action_type)
);

CREATE OR REPLACE FUNCTION local_review_bundle_exact_pass_authority(
  requested_envelope_id UUID,
  authority_time TIMESTAMPTZ,
  bundle_head_sha TEXT
) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM host_story_attempt_envelopes envelope
      JOIN pipeline_runs run ON run.id = envelope.run_id AND run.workspace_id = envelope.workspace_id
      JOIN story_closeout_decisions decision
        ON decision.workspace_id = envelope.workspace_id
       AND decision.run_id = envelope.run_id
       AND decision.story_id = envelope.story_id
       AND decision.attempt = envelope.attempt
       AND decision.manifest_hash = envelope.manifest_hash
      JOIN story_results result
        ON result.run_id = envelope.run_id
       AND result.story_id = envelope.story_id
       AND result.closeout_decision_id = decision.decision_id
      JOIN story_commits commit_projection
        ON commit_projection.workspace_id = envelope.workspace_id
       AND commit_projection.spec_id = result.spec_id
       AND commit_projection.run_id = result.run_id
       AND commit_projection.story_id = result.story_id
       AND commit_projection.commit_sha = result.commit_sha
     WHERE envelope.envelope_id = requested_envelope_id
       AND authority_time IS NOT NULL
       AND envelope.finished_at IS NOT NULL
       AND envelope.finished_at IS NOT DISTINCT FROM authority_time
       AND envelope.authority_state IS NOT DISTINCT FROM 'valid'
       AND envelope.outcome = 'success'
       AND envelope.outcome_provenance = 'host_process'
       AND envelope.exit_code = 0
       AND envelope.exit_signal IS NULL
       AND envelope.canonical_spec_path IS NOT NULL
       AND local_review_safe_relative_path(envelope.canonical_spec_path) IS TRUE
       AND envelope.canonical_spec_revision ~ '^sha256:[0-9a-f]{64}$'
       AND envelope.canonical_spec_bytes_hash ~ '^sha256:[0-9a-f]{64}$'
       AND envelope.run_spec_path IS NOT NULL
       AND octet_length(envelope.run_spec_path) BETWEEN 1 AND 4096
       AND envelope.run_spec_revision ~ '^sha256:[0-9a-f]{64}$'
       AND envelope.run_spec_bytes_hash ~ '^sha256:[0-9a-f]{64}$'
       AND envelope.spec_revision IS NOT DISTINCT FROM envelope.run_spec_revision
       AND envelope.story_revision ~ '^sha256:[0-9a-f]{64}$'
       AND envelope.expected_git_sha ~ '^[0-9a-f]{40}$'
       AND envelope.observed_git_sha IS NOT DISTINCT FROM envelope.expected_git_sha
       AND envelope.expected_git_branch IS NOT NULL
       AND octet_length(envelope.expected_git_branch) BETWEEN 1 AND 1024
       AND envelope.worktree_branch IS NOT DISTINCT FROM envelope.expected_git_branch
       AND run.spec_path IS NOT DISTINCT FROM envelope.canonical_spec_path
       AND run.canonical_spec_revision IS NOT DISTINCT FROM envelope.canonical_spec_revision
       AND run.canonical_spec_bytes_hash IS NOT DISTINCT FROM envelope.canonical_spec_bytes_hash
       AND run.run_spec_path IS NOT DISTINCT FROM envelope.run_spec_path
       AND run.run_spec_revision IS NOT DISTINCT FROM envelope.run_spec_revision
       AND run.run_spec_bytes_hash IS NOT DISTINCT FROM envelope.run_spec_bytes_hash
       AND run.dispatch_fence IS NOT DISTINCT FROM envelope.cancellation_fence
       AND result.status = 'pass'
       AND result.spec_id IS NOT DISTINCT FROM envelope.spec_id
       AND result.spec_revision IS NOT DISTINCT FROM envelope.spec_revision
       AND result.story_revision IS NOT DISTINCT FROM envelope.story_revision
       AND result.manifest_hash IS NOT DISTINCT FROM envelope.manifest_hash
       AND result.result_provenance = 'host'
       AND result.result_source = 'execution-engine'
       AND result.integrated IS TRUE
       AND result.commit_sha IS NOT DISTINCT FROM bundle_head_sha
       AND bundle_head_sha ~ '^[0-9a-f]{40}$'
       AND result.commit_author = 'rorca-execution-engine'
       AND result.commit_observed_source = 'worktree_branch'
       AND result.commit_branch = envelope.worktree_branch
       AND result.worktree_path = envelope.worktree_realpath
       AND decision.status = 'accepted'
       AND decision.manifest_hash = envelope.manifest_hash
       AND commit_projection.commit_message = result.commit_message
       AND commit_projection.author = result.commit_author
       AND commit_projection.branch_name = result.commit_branch
       AND commit_projection.observed_source = result.commit_observed_source
       AND (SELECT COUNT(*) FROM story_closeout_decisions counted
             WHERE counted.workspace_id=envelope.workspace_id AND counted.run_id=envelope.run_id
               AND counted.story_id=envelope.story_id AND counted.attempt=envelope.attempt
               AND counted.manifest_hash=envelope.manifest_hash) = 1
       AND (SELECT COUNT(*) FROM story_results counted
             WHERE counted.run_id=envelope.run_id AND counted.story_id=envelope.story_id
               AND counted.closeout_decision_id=decision.decision_id) = 1
       AND (SELECT COUNT(*) FROM story_commits counted
             WHERE counted.workspace_id=envelope.workspace_id AND counted.spec_id=result.spec_id
               AND counted.run_id=result.run_id AND counted.story_id=result.story_id
               AND counted.commit_sha=result.commit_sha) = 1
       AND (SELECT COUNT(*) FROM checkpoint_validation_attestations receipt
             WHERE receipt.workspace_id=envelope.workspace_id AND receipt.run_id=envelope.run_id
               AND receipt.story_id=envelope.story_id AND receipt.branch_name=envelope.worktree_branch
               AND receipt.checkpoint_sha=result.commit_sha AND receipt.validation_gate='execution-engine') = 1
       AND EXISTS (SELECT 1 FROM checkpoint_validation_attestations receipt
             WHERE receipt.workspace_id=envelope.workspace_id AND receipt.run_id=envelope.run_id
               AND receipt.story_id=envelope.story_id AND receipt.branch_name=envelope.worktree_branch
               AND receipt.checkpoint_sha=result.commit_sha AND receipt.validation_gate='execution-engine'
               AND receipt.revoked_at IS NULL AND receipt.passed_at <= authority_time
               AND receipt.expires_at > authority_time)
       AND ((result.accounting_required IS FALSE AND
             (SELECT COUNT(*) FROM token_usage usage WHERE usage.story_result_id=result.id) = 0)
         OR (result.accounting_required IS TRUE AND
             (SELECT COUNT(*) FROM token_usage usage WHERE usage.story_result_id=result.id) = 1
             AND EXISTS (SELECT 1 FROM token_usage usage WHERE usage.story_result_id=result.id
               AND usage.model=result.accounting_model
               AND usage.input_tokens=result.accounting_input_tokens
               AND usage.output_tokens=result.accounting_output_tokens
               AND usage.reasoning_tokens=result.accounting_reasoning_tokens
               AND usage.cost_usd::numeric=result.accounting_cost_usd
               AND usage.cost_source=result.accounting_cost_source
               AND usage.input_cost_per_1k IS NOT DISTINCT FROM result.accounting_input_rate
               AND usage.output_cost_per_1k IS NOT DISTINCT FROM result.accounting_output_rate)))
       AND run.host_closeout_event_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM wal_events closeout
             WHERE closeout.id=run.host_closeout_event_id
               AND closeout.event_type='run_closeout'
               AND closeout.trust_provenance='host'
               AND closeout.trusted_source='worker'
               AND closeout.event_identity_hash ~ '^[0-9a-f]{64}$')
       AND NOT EXISTS (SELECT 1 FROM host_story_attempt_conflicts conflict
             WHERE conflict.workspace_id=envelope.workspace_id AND conflict.run_id=envelope.run_id
               AND conflict.story_id=envelope.story_id AND conflict.attempt=envelope.attempt)
       AND NOT EXISTS (SELECT 1 FROM pipeline_run_cancellation_requests cancellation
             WHERE cancellation.run_id=envelope.run_id)
       AND NOT EXISTS (SELECT 1 FROM governed_retry_dispatches retry
             WHERE retry.retry_run_id=envelope.run_id AND retry.cancellation_requested_at IS NOT NULL)
  )
$$;

CREATE OR REPLACE FUNCTION local_review_bundle_is_current(requested_bundle_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM local_review_bundles bundle
    JOIN host_story_attempt_envelopes envelope ON envelope.envelope_id=bundle.host_attempt_envelope_id
    JOIN pipeline_runs run ON run.id=bundle.run_id AND run.workspace_id=bundle.workspace_id
    WHERE bundle.bundle_id=requested_bundle_id
      AND envelope.workspace_id=bundle.workspace_id AND envelope.run_id=bundle.run_id
      AND envelope.story_id=bundle.story_id AND envelope.attempt=bundle.attempt
      AND envelope.launch_generation=bundle.launch_generation
      AND envelope.authority_state='valid' AND envelope.finished_at=bundle.created_at
      AND run.dispatch_fence=envelope.cancellation_fence
      AND NOT EXISTS (SELECT 1 FROM local_review_bundle_disqualifications disqualified
                       WHERE disqualified.bundle_id=bundle.bundle_id)
      AND NOT EXISTS (SELECT 1 FROM host_story_attempt_conflicts conflict
                       WHERE conflict.workspace_id=bundle.workspace_id AND conflict.run_id=bundle.run_id
                         AND conflict.story_id=bundle.story_id AND conflict.attempt=bundle.attempt)
      AND NOT EXISTS (SELECT 1 FROM pipeline_run_cancellation_requests cancellation
                       WHERE cancellation.run_id=bundle.run_id)
      AND NOT EXISTS (SELECT 1 FROM governed_retry_dispatches retry
                       WHERE retry.retry_run_id=bundle.run_id AND retry.cancellation_requested_at IS NOT NULL)
      AND (bundle.validation_status <> 'passed'
           OR local_review_bundle_exact_pass_authority(
             envelope.envelope_id, bundle.created_at, bundle.manifest_json#>>'{repository,headSha}'))
  )
$$;

CREATE OR REPLACE FUNCTION enforce_local_review_bundle_authority()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  envelope host_story_attempt_envelopes%ROWTYPE;
  run_row pipeline_runs%ROWTYPE;
  request_json JSONB;
  content_json JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pipeline-run-authority:' || NEW.run_id::text, 0));
  IF NEW.adapter_version <> '1.1.0'
     OR NEW.request_bytes IS NULL OR NEW.content_basis_bytes IS NULL OR NEW.manifest_bytes IS NULL
     OR ('sha256:' || encode(digest(NEW.request_bytes, 'sha256'), 'hex')) <> NEW.request_hash
     OR ('sha256:' || encode(digest(NEW.content_basis_bytes, 'sha256'), 'hex')) <> NEW.content_hash
     OR ('sha256:' || encode(digest(NEW.manifest_bytes, 'sha256'), 'hex')) <> NEW.manifest_hash THEN
    RAISE EXCEPTION 'local review bundle byte-derived hashes are incomplete or invalid' USING ERRCODE='23514';
  END IF;
  BEGIN
    request_json := convert_from(NEW.request_bytes, 'UTF8')::jsonb;
    content_json := convert_from(NEW.content_basis_bytes, 'UTF8')::jsonb;
    IF convert_from(NEW.manifest_bytes, 'UTF8')::jsonb <> NEW.manifest_json THEN
      RAISE EXCEPTION 'manifest bytes differ from canonical JSON';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'local review bundle canonical bytes are malformed' USING ERRCODE='23514';
  END;
  IF local_review_manifest_is_complete(NEW.manifest_json) IS DISTINCT FROM TRUE
     OR content_json IS DISTINCT FROM (NEW.manifest_json - 'bundleId' - 'contentHash')
     OR local_review_request_matches(
       request_json, NEW.contract_version, NEW.adapter_id, NEW.adapter_version,
       NEW.workspace_id, NEW.run_id, NEW.story_id, NEW.attempt,
       NEW.launch_generation, NEW.host_attempt_envelope_id, NEW.created_by
     ) IS DISTINCT FROM TRUE
     OR NEW.projection_key IS DISTINCT FROM ('sha256/' || substring(NEW.content_hash FROM 8 FOR 2) || '/' || substring(NEW.content_hash FROM 8)) THEN
    RAISE EXCEPTION 'local review bundle canonical request/content relationships are invalid' USING ERRCODE='23514';
  END IF;
  SELECT * INTO envelope FROM host_story_attempt_envelopes
   WHERE envelope_id=NEW.host_attempt_envelope_id FOR SHARE;
  SELECT * INTO run_row FROM pipeline_runs
   WHERE id=NEW.run_id AND workspace_id=NEW.workspace_id FOR SHARE;
  IF envelope.envelope_id IS NULL
     OR run_row.id IS NULL
     OR envelope.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR envelope.run_id IS DISTINCT FROM NEW.run_id
     OR envelope.story_id IS DISTINCT FROM NEW.story_id
     OR envelope.attempt IS DISTINCT FROM NEW.attempt
     OR envelope.launch_generation IS DISTINCT FROM NEW.launch_generation
     OR envelope.finished_at IS DISTINCT FROM NEW.created_at
     OR envelope.spec_id IS DISTINCT FROM NEW.spec_id
     OR envelope.manifest_hash IS DISTINCT FROM NEW.manifest_json#>>'{specification,executionManifestHash}'
     OR envelope.canonical_spec_path IS DISTINCT FROM NEW.manifest_json#>>'{specification,canonicalPath}'
     OR envelope.canonical_spec_revision IS NULL
     OR envelope.canonical_spec_revision IS DISTINCT FROM NEW.manifest_json#>>'{specification,revision}'
     OR envelope.canonical_spec_bytes_hash IS NULL
     OR envelope.canonical_spec_bytes_hash IS DISTINCT FROM NEW.manifest_json#>>'{specification,bytesHash}'
     OR envelope.run_spec_path IS NULL
     OR envelope.run_spec_revision IS NULL
     OR envelope.run_spec_bytes_hash IS NULL
     OR envelope.spec_revision IS DISTINCT FROM envelope.run_spec_revision
     OR run_row.spec_path IS DISTINCT FROM envelope.canonical_spec_path
     OR run_row.canonical_spec_revision IS DISTINCT FROM envelope.canonical_spec_revision
     OR run_row.canonical_spec_bytes_hash IS DISTINCT FROM envelope.canonical_spec_bytes_hash
     OR run_row.run_spec_path IS DISTINCT FROM envelope.run_spec_path
     OR run_row.run_spec_revision IS DISTINCT FROM envelope.run_spec_revision
     OR run_row.run_spec_bytes_hash IS DISTINCT FROM envelope.run_spec_bytes_hash
     OR envelope.story_revision IS DISTINCT FROM NEW.manifest_json#>>'{specification,storyRevision}'
     OR envelope.base_git_sha::text IS DISTINCT FROM NEW.manifest_json#>>'{repository,runBaseSha}'
     OR envelope.observed_git_sha::text IS DISTINCT FROM NEW.manifest_json#>>'{repository,baseSha}'
     OR envelope.repository_identity IS DISTINCT FROM NEW.manifest_json#>>'{repository,repositoryIdentity}'
     OR envelope.worktree_identity IS DISTINCT FROM NEW.manifest_json#>>'{repository,worktreeIdentity}'
     OR envelope.worktree_branch IS DISTINCT FROM NEW.manifest_json#>>'{repository,branch}'
     OR envelope.authority_state IS DISTINCT FROM 'valid'
     OR EXISTS (SELECT 1 FROM host_story_attempt_conflicts conflict
                 WHERE conflict.workspace_id=envelope.workspace_id AND conflict.run_id=envelope.run_id
                   AND conflict.story_id=envelope.story_id AND conflict.attempt=envelope.attempt) THEN
    RAISE EXCEPTION 'local review bundle differs from immutable host attempt authority' USING ERRCODE='23514';
  END IF;
  IF NEW.validation_status='passed'
     AND NOT local_review_bundle_exact_pass_authority(
       envelope.envelope_id, NEW.created_at, NEW.manifest_json#>>'{repository,headSha}') THEN
    RAISE EXCEPTION 'passed local review bundle lacks complete exact host authority' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Post-finalization authority changes append disqualification evidence instead
-- of mutating immutable bundle rows.
CREATE OR REPLACE FUNCTION append_local_review_disqualifications()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  selected_run BIGINT;
  selected_story TEXT;
  selected_attempt INTEGER;
  selected_reason TEXT;
  selected_type TEXT;
  selected_identity TEXT;
  selected_receipt_id TEXT;
BEGIN
  IF TG_TABLE_NAME='host_story_attempt_conflicts' THEN
    selected_run:=NEW.run_id; selected_story:=NEW.story_id; selected_attempt:=NEW.attempt;
    selected_reason:='host_conflict'; selected_type:='host_story_attempt_conflict'; selected_identity:=NEW.conflict_id::text;
  ELSIF TG_TABLE_NAME='pipeline_run_cancellation_requests' THEN
    selected_run:=NEW.run_id; selected_reason:='cancellation_requested'; selected_type:='pipeline_run_cancellation'; selected_identity:=NEW.run_id::text;
  ELSIF TG_TABLE_NAME='governed_retry_dispatches' THEN
    IF NEW.cancellation_requested_at IS NULL OR (TG_OP='UPDATE' AND OLD.cancellation_requested_at IS NOT NULL) THEN RETURN NEW; END IF;
    selected_run:=NEW.retry_run_id; selected_reason:='retry_cancellation_requested'; selected_type:='governed_retry_cancellation'; selected_identity:=NEW.identity_hash;
  ELSIF TG_TABLE_NAME='pipeline_runs' THEN
    IF NEW.dispatch_fence IS NOT DISTINCT FROM OLD.dispatch_fence THEN RETURN NEW; END IF;
    selected_run:=NEW.id; selected_reason:='dispatch_fence_changed'; selected_type:='pipeline_dispatch_fence'; selected_identity:=COALESCE(NEW.dispatch_fence,'none');
  ELSE
    IF NEW.revoked_at IS NULL OR (TG_OP='UPDATE' AND OLD.revoked_at IS NOT NULL) THEN RETURN NEW; END IF;
    selected_reason:='validation_receipt_revoked'; selected_type:='checkpoint_validation_receipt'; selected_identity:=NEW.id::text;
    selected_receipt_id:=NEW.id::text;
  END IF;
  IF selected_run IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('pipeline-run-authority:' || selected_run::text, 0));
  END IF;
  INSERT INTO local_review_bundle_disqualifications(
    bundle_id,workspace_id,run_id,story_id,attempt,reason_code,source_type,source_identity
  )
  SELECT bundle.bundle_id,bundle.workspace_id,bundle.run_id,bundle.story_id,bundle.attempt,
         selected_reason,selected_type,selected_identity
    FROM local_review_bundles bundle
   WHERE (selected_run IS NULL OR bundle.run_id=selected_run)
     AND (selected_story IS NULL OR bundle.story_id=selected_story)
     AND (selected_attempt IS NULL OR bundle.attempt=selected_attempt)
     AND (selected_receipt_id IS NULL OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(bundle.manifest_json#>'{validation,receipts}') receipt
        WHERE receipt->>'receiptId'=selected_receipt_id))
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION lock_local_review_authority_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected_run BIGINT;
BEGIN
  IF TG_TABLE_NAME='host_story_attempt_conflicts' THEN selected_run:=NEW.run_id;
  ELSIF TG_TABLE_NAME='pipeline_run_cancellation_requests' THEN selected_run:=NEW.run_id;
  ELSIF TG_TABLE_NAME='governed_retry_dispatches' THEN selected_run:=NEW.retry_run_id;
  ELSIF TG_TABLE_NAME='pipeline_runs' THEN
    IF NEW.dispatch_fence IS NOT DISTINCT FROM OLD.dispatch_fence THEN RETURN NEW; END IF;
    selected_run:=NEW.id;
  ELSE
    IF NEW.revoked_at IS NULL THEN RETURN NEW; END IF;
    selected_run:=NEW.run_id;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pipeline-run-authority:' || selected_run::text, 0));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_local_review_host_conflict_lock ON host_story_attempt_conflicts;
CREATE TRIGGER trg_local_review_host_conflict_lock BEFORE INSERT ON host_story_attempt_conflicts
FOR EACH ROW EXECUTE FUNCTION lock_local_review_authority_change();
DROP TRIGGER IF EXISTS trg_local_review_host_conflict_disqualify ON host_story_attempt_conflicts;
CREATE TRIGGER trg_local_review_host_conflict_disqualify AFTER INSERT ON host_story_attempt_conflicts
FOR EACH ROW EXECUTE FUNCTION append_local_review_disqualifications();
DROP TRIGGER IF EXISTS trg_local_review_cancellation_lock ON pipeline_run_cancellation_requests;
CREATE TRIGGER trg_local_review_cancellation_lock BEFORE INSERT ON pipeline_run_cancellation_requests
FOR EACH ROW EXECUTE FUNCTION lock_local_review_authority_change();
DROP TRIGGER IF EXISTS trg_local_review_cancellation_disqualify ON pipeline_run_cancellation_requests;
CREATE TRIGGER trg_local_review_cancellation_disqualify AFTER INSERT ON pipeline_run_cancellation_requests
FOR EACH ROW EXECUTE FUNCTION append_local_review_disqualifications();
DROP TRIGGER IF EXISTS trg_local_review_retry_cancel_lock ON governed_retry_dispatches;
CREATE TRIGGER trg_local_review_retry_cancel_lock BEFORE INSERT OR UPDATE ON governed_retry_dispatches
FOR EACH ROW EXECUTE FUNCTION lock_local_review_authority_change();
DROP TRIGGER IF EXISTS trg_local_review_retry_cancel_disqualify ON governed_retry_dispatches;
CREATE TRIGGER trg_local_review_retry_cancel_disqualify AFTER INSERT OR UPDATE ON governed_retry_dispatches
FOR EACH ROW EXECUTE FUNCTION append_local_review_disqualifications();
DROP TRIGGER IF EXISTS trg_local_review_dispatch_fence_lock ON pipeline_runs;
CREATE TRIGGER trg_local_review_dispatch_fence_lock BEFORE UPDATE OF dispatch_fence ON pipeline_runs
FOR EACH ROW EXECUTE FUNCTION lock_local_review_authority_change();
DROP TRIGGER IF EXISTS trg_local_review_dispatch_fence_disqualify ON pipeline_runs;
CREATE TRIGGER trg_local_review_dispatch_fence_disqualify AFTER UPDATE OF dispatch_fence ON pipeline_runs
FOR EACH ROW EXECUTE FUNCTION append_local_review_disqualifications();
DROP TRIGGER IF EXISTS trg_local_review_receipt_revoke_lock ON checkpoint_validation_attestations;
CREATE TRIGGER trg_local_review_receipt_revoke_lock BEFORE UPDATE OF revoked_at ON checkpoint_validation_attestations
FOR EACH ROW EXECUTE FUNCTION lock_local_review_authority_change();
DROP TRIGGER IF EXISTS trg_local_review_receipt_revoke_disqualify ON checkpoint_validation_attestations;
CREATE TRIGGER trg_local_review_receipt_revoke_disqualify AFTER UPDATE OF revoked_at ON checkpoint_validation_attestations
FOR EACH ROW EXECUTE FUNCTION append_local_review_disqualifications();

-- All canonical delivery/audit rows deny statement-level TRUNCATE as well as
-- row-level UPDATE/DELETE. The GC audit is itself append-only.
CREATE OR REPLACE FUNCTION reject_local_review_bundle_truncate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'local review bundle evidence cannot be truncated' USING ERRCODE='23514';
END;
$$;
DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'local_review_bundles','local_review_bundle_conflicts',
    'local_review_bundle_disqualifications','local_review_projection_gc_audits',
    'local_review_projection_gc_actions'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_no_truncate ON %I', table_name, table_name);
    EXECUTE format('CREATE TRIGGER trg_%I_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_local_review_bundle_truncate()', table_name, table_name);
  END LOOP;
END;
$$;

DROP TRIGGER IF EXISTS trg_local_review_bundle_disqualification_immutable ON local_review_bundle_disqualifications;
CREATE TRIGGER trg_local_review_bundle_disqualification_immutable
BEFORE UPDATE OR DELETE ON local_review_bundle_disqualifications
FOR EACH ROW EXECUTE FUNCTION reject_local_review_bundle_mutation();
DROP TRIGGER IF EXISTS trg_local_review_projection_gc_audit_immutable ON local_review_projection_gc_audits;
CREATE TRIGGER trg_local_review_projection_gc_audit_immutable
BEFORE UPDATE OR DELETE ON local_review_projection_gc_audits
FOR EACH ROW EXECUTE FUNCTION reject_local_review_bundle_mutation();
DROP TRIGGER IF EXISTS trg_local_review_projection_gc_action_immutable ON local_review_projection_gc_actions;
CREATE TRIGGER trg_local_review_projection_gc_action_immutable
BEFORE UPDATE OR DELETE ON local_review_projection_gc_actions
FOR EACH ROW EXECUTE FUNCTION reject_local_review_bundle_mutation();
