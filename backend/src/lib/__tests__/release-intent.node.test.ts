/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CreateReleaseIntentSchema,
  OPERATION_INTENT_GRANT_VERSION,
  OPERATION_INTENT_PROJECTION_VERSION,
  RELEASE_INTENT_PROVENANCE_VERSION,
  RELEASE_INTENT_SCHEMA_VERSION,
  canonicalReleaseIntentCiEvidence,
  canonicalReleaseIntent,
  releaseIntentCiEvidenceDigest,
  releaseIntentDigest,
  validateReleaseIntentGrant,
  type CreateReleaseIntent,
  type OperationIntentGrant,
  type OperationIntentProjection,
} from '../release-intent';

const digest = (character: string) => `sha256:${character.repeat(64)}`;

function releaseInput(): CreateReleaseIntent {
  return CreateReleaseIntentSchema.parse({
    workspaceId: 'workspace-release',
    releaseIntent: {
      schemaVersion: RELEASE_INTENT_SCHEMA_VERSION,
      sourceRevision: 'a'.repeat(40),
      artifacts: {
        artifactDigests: [digest('1')],
        imageDigests: [digest('2')],
      },
      migrationSetDigest: digest('3'),
      configurationBindingGeneration: 7,
      featureFlagDigest: digest('4'),
      rolloutCohort: {
        cohortId: 'production-canary',
        percentage: 10,
        selectorDigest: digest('5'),
      },
      changeWindow: {
        startsAt: '2026-08-23T10:00:00.000Z',
        endsAt: '2026-08-23T11:00:00.000Z',
      },
      providerApprovalReference: {
        provider: 'github-protected-environment',
        approvalId: 'approval/891',
        environment: 'production',
        evidenceDigest: digest('6'),
      },
      rollback: {
        owner: 'release-operator',
        procedure: {
          procedureId: 'restore-previous-revision',
          procedureDigest: digest('7'),
        },
      },
      healthSignals: [{
        signalId: 'http-error-rate',
        source: 'metrics',
        evidenceKey: 'metrics.http.error-rate',
        aggregation: 'average',
        unit: 'percent',
      }],
      abortConditions: [{
        conditionId: 'abort-http-errors',
        signalId: 'http-error-rate',
        operator: 'gte',
        threshold: 5,
        observationWindowSeconds: 300,
        requiredSamples: 5,
      }],
    },
    provenance: {
      schemaVersion: RELEASE_INTENT_PROVENANCE_VERSION,
      ciEvidence: [{
        provider: 'github-actions',
        pipelineId: 'pipeline/144',
        jobId: 'job/991',
        sourceRevision: 'a'.repeat(40),
        artifactDigest: digest('1'),
        result: 'passed',
        evidenceDigest: digest('8'),
        observedAt: '2026-08-23T09:30:00.000Z',
      }],
      stagingReceiptDigests: [digest('9')],
      attestationDigests: [digest('b')],
    },
  });
}

function projectionFor(input: CreateReleaseIntent, operationIntentId: string): OperationIntentProjection {
  return {
    schemaVersion: OPERATION_INTENT_PROJECTION_VERSION,
    operationIntentId,
    workspaceId: input.workspaceId,
    intentKind: 'release',
    intentDigest: releaseIntentDigest(input),
    ciEvidenceDigest: releaseIntentCiEvidenceDigest(input.provenance),
    releaseIntent: input.releaseIntent,
    provenance: input.provenance,
    immutable: true,
    createdBy: 'local-operator',
    createdAt: '2026-08-23T09:45:00.000Z',
  };
}

function grantFor(projection: OperationIntentProjection): OperationIntentGrant {
  return {
    schemaVersion: OPERATION_INTENT_GRANT_VERSION,
    grantId: '33333333-3333-4333-8333-333333333333',
    operationIntentId: projection.operationIntentId,
    workspaceId: projection.workspaceId,
    intentDigest: projection.intentDigest,
    ciEvidenceDigest: projection.ciEvidenceDigest,
    issuedAt: '2026-08-23T09:50:00.000Z',
    expiresAt: '2026-08-23T11:30:00.000Z',
  };
}

test('ReleaseIntent canonical serialization and digest ignore object insertion order and normalize timestamps', () => {
  const first = releaseInput();
  const second = CreateReleaseIntentSchema.parse({
    provenance: {
      ...first.provenance,
      ciEvidence: [{
        ...first.provenance.ciEvidence[0],
        observedAt: '2026-08-23T11:30:00+02:00',
      }],
    },
    releaseIntent: {
      ...first.releaseIntent,
      changeWindow: {
        startsAt: '2026-08-23T12:00:00+02:00',
        endsAt: '2026-08-23T13:00:00+02:00',
      },
    },
    workspaceId: first.workspaceId,
  });

  assert.equal(canonicalReleaseIntent(first), canonicalReleaseIntent(second));
  assert.equal(releaseIntentDigest(first), releaseIntentDigest(second));
  assert.equal(
    canonicalReleaseIntentCiEvidence(first.provenance),
    canonicalReleaseIntentCiEvidence(second.provenance),
  );
  assert.equal(
    releaseIntentCiEvidenceDigest(first.provenance),
    releaseIntentCiEvidenceDigest(second.provenance),
  );
});

test('canonical serialization ignores logical set insertion order', () => {
  const first = releaseInput();
  first.releaseIntent.artifacts.artifactDigests.push(digest('a'));
  first.releaseIntent.artifacts.imageDigests.push(digest('b'));
  first.releaseIntent.healthSignals.push({
    signalId: 'request-latency',
    source: 'metrics',
    evidenceKey: 'metrics.http.latency',
    aggregation: 'maximum',
    unit: 'milliseconds',
  });
  first.releaseIntent.abortConditions.push({
    conditionId: 'abort-request-latency',
    signalId: 'request-latency',
    operator: 'gte',
    threshold: 500,
    observationWindowSeconds: 120,
    requiredSamples: 3,
  });
  first.provenance.ciEvidence.push({
    provider: 'github-actions',
    pipelineId: 'pipeline/145',
    jobId: 'job/992',
    sourceRevision: first.releaseIntent.sourceRevision,
    artifactDigest: digest('a'),
    result: 'passed',
    evidenceDigest: digest('c'),
    observedAt: '2026-08-23T09:35:00.000Z',
  });
  first.provenance.stagingReceiptDigests.push(digest('d'));
  first.provenance.attestationDigests.push(digest('e'));

  const reordered = structuredClone(first);
  reordered.releaseIntent.artifacts.artifactDigests.reverse();
  reordered.releaseIntent.artifacts.imageDigests.reverse();
  reordered.releaseIntent.healthSignals.reverse();
  reordered.releaseIntent.abortConditions.reverse();
  reordered.provenance.ciEvidence.reverse();
  reordered.provenance.stagingReceiptDigests.reverse();
  reordered.provenance.attestationDigests.reverse();

  assert.equal(canonicalReleaseIntent(first), canonicalReleaseIntent(reordered));
  assert.equal(releaseIntentDigest(first), releaseIntentDigest(reordered));
  assert.equal(
    canonicalReleaseIntentCiEvidence(first.provenance),
    canonicalReleaseIntentCiEvidence(reordered.provenance),
  );
  assert.equal(
    releaseIntentCiEvidenceDigest(first.provenance),
    releaseIntentCiEvidenceDigest(reordered.provenance),
  );
});

test('every release input and provenance evidence change invalidates the intent digest', () => {
  const base = releaseInput();
  const mutations: Array<[string, (value: CreateReleaseIntent) => void]> = [
    ['revision', (value) => { value.releaseIntent.sourceRevision = 'c'.repeat(40); }],
    ['artifact', (value) => { value.releaseIntent.artifacts.artifactDigests[0] = digest('c'); }],
    ['image', (value) => { value.releaseIntent.artifacts.imageDigests[0] = digest('d'); }],
    ['migrations', (value) => { value.releaseIntent.migrationSetDigest = digest('e'); }],
    ['configuration', (value) => { value.releaseIntent.configurationBindingGeneration += 1; }],
    ['flags', (value) => { value.releaseIntent.featureFlagDigest = digest('f'); }],
    ['cohort', (value) => { value.releaseIntent.rolloutCohort.percentage = 20; }],
    ['window', (value) => { value.releaseIntent.changeWindow.endsAt = '2026-08-23T11:30:00.000Z'; }],
    ['approval reference', (value) => { value.releaseIntent.providerApprovalReference.approvalId = 'approval/892'; }],
    ['rollback', (value) => { value.releaseIntent.rollback.procedure.procedureDigest = digest('0'); }],
    ['health', (value) => { value.releaseIntent.healthSignals[0]!.aggregation = 'maximum'; }],
    ['abort conditions', (value) => { value.releaseIntent.abortConditions[0]!.threshold = 4; }],
    ['CI evidence', (value) => { value.provenance.ciEvidence[0]!.evidenceDigest = digest('a'); }],
    ['staging evidence', (value) => { value.provenance.stagingReceiptDigests[0] = digest('a'); }],
    ['attestation evidence', (value) => { value.provenance.attestationDigests[0] = digest('c'); }],
  ];

  const baseDigest = releaseIntentDigest(base);
  for (const [name, mutate] of mutations) {
    const changed = structuredClone(base);
    mutate(changed);
    assert.notEqual(releaseIntentDigest(changed), baseDigest, name);
  }
});

test('a persisted grant authorizes only its exact operation intent and CI evidence', () => {
  const originalInput = releaseInput();
  const original = projectionFor(originalInput, '11111111-1111-4111-8111-111111111111');
  const grant = grantFor(original);
  assert.equal(
    validateReleaseIntentGrant(original, grant, new Date('2026-08-23T10:00:00.000Z')).valid,
    true,
  );

  const changedInput = structuredClone(originalInput);
  changedInput.provenance.ciEvidence[0]!.evidenceDigest = digest('a');
  const changedEvidence = projectionFor(changedInput, original.operationIntentId);
  assert.throws(
    () => validateReleaseIntentGrant(changedEvidence, grant, new Date('2026-08-23T10:00:00.000Z')),
    /exact release intent and CI evidence/,
  );

  const anotherIntent = projectionFor(originalInput, '22222222-2222-4222-8222-222222222222');
  assert.throws(
    () => validateReleaseIntentGrant(anotherIntent, grant, new Date('2026-08-23T10:00:00.000Z')),
    /exact release intent and CI evidence/,
  );
  assert.throws(
    () => validateReleaseIntentGrant(original, grant, new Date('2026-08-23T12:00:00.000Z')),
    /expired/,
  );
});

test('strict immutable projections reject environment-secret extension fields and dangling abort signals', () => {
  const input = releaseInput();
  assert.equal(CreateReleaseIntentSchema.safeParse({
    ...input,
    environmentSecrets: { CONTROL_TOKEN: 'never-project-this' },
  }).success, false);
  assert.equal(CreateReleaseIntentSchema.safeParse({
    ...input,
    provenance: {
      ...input.provenance,
      controlToken: 'never-project-this',
    },
  }).success, false);
  assert.equal(CreateReleaseIntentSchema.safeParse({
    ...input,
    releaseIntent: {
      ...input.releaseIntent,
      abortConditions: [{
        ...input.releaseIntent.abortConditions[0],
        signalId: 'undeclared-signal',
      }],
    },
  }).success, false);
});
