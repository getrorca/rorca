/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationIntentResponse,
  readOperationIntentResponse,
  validateOperationIntentResponse,
} from '../operation-intents';
import {
  CreateReleaseIntentSchema,
  OPERATION_INTENT_PROJECTION_VERSION,
  RELEASE_INTENT_PROVENANCE_VERSION,
  RELEASE_INTENT_SCHEMA_VERSION,
  RELEASE_INTENT_VALIDATION_VERSION,
  releaseIntentCiEvidenceDigest,
  releaseIntentDigest,
  type CreateReleaseIntent,
  type OperationIntentProjection,
  type ReleaseIntentValidation,
} from '../../lib/release-intent';

const OPERATION_INTENT_ID = '11111111-1111-4111-8111-111111111111';
const GRANT_ID = '22222222-2222-4222-8222-222222222222';
const digest = (character: string) => `sha256:${character.repeat(64)}`;

function input(): CreateReleaseIntent {
  return CreateReleaseIntentSchema.parse({
    workspaceId: 'workspace-api',
    releaseIntent: {
      schemaVersion: RELEASE_INTENT_SCHEMA_VERSION,
      sourceRevision: 'a'.repeat(40),
      artifacts: { artifactDigests: [digest('1')], imageDigests: [digest('2')] },
      migrationSetDigest: digest('3'),
      configurationBindingGeneration: 4,
      featureFlagDigest: digest('4'),
      rolloutCohort: { cohortId: 'canary', percentage: 5, selectorDigest: digest('5') },
      changeWindow: { startsAt: '2026-08-23T10:00:00Z', endsAt: '2026-08-23T11:00:00Z' },
      providerApprovalReference: {
        provider: 'github-protected-environment',
        approvalId: 'approval/1',
        environment: 'production',
        evidenceDigest: digest('6'),
      },
      rollback: {
        owner: 'release-operator',
        procedure: { procedureId: 'rollback/exact', procedureDigest: digest('7') },
      },
      healthSignals: [{
        signalId: 'error-rate', source: 'metrics', evidenceKey: 'error-rate',
        aggregation: 'average', unit: 'percent',
      }],
      abortConditions: [{
        conditionId: 'abort-errors', signalId: 'error-rate', operator: 'gte', threshold: 5,
        observationWindowSeconds: 300, requiredSamples: 3,
      }],
    },
    provenance: {
      schemaVersion: RELEASE_INTENT_PROVENANCE_VERSION,
      ciEvidence: [{
        provider: 'github-actions', pipelineId: 'pipeline/1', jobId: 'job/1',
        sourceRevision: 'a'.repeat(40), artifactDigest: digest('1'), result: 'passed',
        evidenceDigest: digest('8'), observedAt: '2026-08-23T09:30:00Z',
      }],
      stagingReceiptDigests: [digest('9')],
      attestationDigests: [],
    },
  });
}

function projection(value: CreateReleaseIntent): OperationIntentProjection {
  return {
    schemaVersion: OPERATION_INTENT_PROJECTION_VERSION,
    operationIntentId: OPERATION_INTENT_ID,
    workspaceId: value.workspaceId,
    intentKind: 'release',
    intentDigest: releaseIntentDigest(value),
    ciEvidenceDigest: releaseIntentCiEvidenceDigest(value.provenance),
    releaseIntent: value.releaseIntent,
    provenance: value.provenance,
    immutable: true,
    createdBy: 'operator-one',
    createdAt: '2026-08-23T09:45:00.000Z',
  };
}

test('create returns only the strict redacted immutable OperationIntent projection', async () => {
  const value = input();
  const expected = projection(value);
  let persisted: { input: CreateReleaseIntent; createdBy: string } | undefined;
  const response = await createOperationIntentResponse({
    async create(candidate, createdBy) {
      persisted = { input: candidate, createdBy };
      return expected;
    },
  }, 'operator-one', value);

  assert.deepEqual(persisted, { input: value, createdBy: 'operator-one' });
  assert.deepEqual(response, { operationIntent: expected });
  assert.equal(response.operationIntent.immutable, true);
  assert.doesNotMatch(JSON.stringify(response), /controlToken|environmentSecrets|secretReference/);

  await assert.rejects(createOperationIntentResponse({
    async create() { throw new Error('must not persist invalid input'); },
  }, 'operator-one', { ...value, controlToken: 'never-return-this' }), /Invalid operation intent request/);
});

test('read returns the stored immutable projection and fails closed when absent', async () => {
  const expected = projection(input());
  assert.deepEqual(await readOperationIntentResponse({
    async get(workspaceId, operationIntentId) {
      assert.equal(workspaceId, expected.workspaceId);
      assert.equal(operationIntentId, expected.operationIntentId);
      return expected;
    },
  }, expected.workspaceId, expected.operationIntentId), { operationIntent: expected });

  await assert.rejects(readOperationIntentResponse({
    async get() { return null; },
  }, expected.workspaceId, expected.operationIntentId), /not found/);
});

test('validate accepts only persisted grant identity, not caller-supplied digest or CI evidence', async () => {
  const expected: ReleaseIntentValidation = {
    schemaVersion: RELEASE_INTENT_VALIDATION_VERSION,
    valid: true,
    operationIntentId: OPERATION_INTENT_ID,
    workspaceId: 'workspace-api',
    intentDigest: digest('a'),
    ciEvidenceDigest: digest('b'),
    grantId: GRANT_ID,
    grantExpiresAt: '2026-08-23T11:30:00.000Z',
  };
  let observed: string[] = [];
  assert.deepEqual(await validateOperationIntentResponse({
    async validate(workspaceId, operationIntentId, grantId) {
      observed = [workspaceId, operationIntentId, grantId];
      return expected;
    },
  }, OPERATION_INTENT_ID, { workspaceId: 'workspace-api', grantId: GRANT_ID }), {
    validation: expected,
  });
  assert.deepEqual(observed, ['workspace-api', OPERATION_INTENT_ID, GRANT_ID]);

  await assert.rejects(validateOperationIntentResponse({
    async validate() { throw new Error('must not trust changed evidence'); },
  }, OPERATION_INTENT_ID, {
    workspaceId: 'workspace-api',
    grantId: GRANT_ID,
    ciEvidenceDigest: digest('c'),
  }), /Invalid operation intent request/);
});

