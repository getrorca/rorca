/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { CanonicalLifecycleEvidence } from '../../lib/ssdlc-evidence';
import {
  createHermesProductionConfirmer,
  type DeploymentResolution,
  type PostDeployHealthResult,
} from '../hermes-production-confirmation';

const NOW = new Date('2026-03-16T00:06:29.000Z');
const CHECKED_AT = '2026-03-16T00:06:28.000Z';
const DEPLOYMENT_ID = 'deploy-prod-018';
const release = { commitSha: 'a'.repeat(40), artifactDigest: `sha256:${'b'.repeat(64)}` };
const target = { environment: 'production' as const, provider: 'fly', service: 'rorca-api', region: 'iad' };
const scope = {
  workspaceId: 'workspace-1', specSlug: 'source-verified-delivery', runId: 18,
  storyId: 'AAV-018', phaseId: 'deployment', gateId: 'deployment-confirmation',
};

function input() {
  return {
    scope, release, target,
    actor: 'hermes:production-confirmer',
    rawReference: 'provider://fly/rorca-api/deployments/latest',
  };
}

function confirmer(
  resolution: DeploymentResolution,
  health: PostDeployHealthResult,
  emitted: CanonicalLifecycleEvidence[],
  healthCalls: string[],
) {
  return createHermesProductionConfirmer({
    async resolveDeployment(request) {
      assert.deepEqual(request.target, target);
      assert.deepEqual(request.release, release);
      return resolution;
    },
    async checkDeploymentHealth(request) {
      healthCalls.push(request.deploymentId);
      assert.deepEqual(request.target, target);
      return health;
    },
    async emitProductionEvidence(evidence) { emitted.push(evidence); },
  }, { now: () => NOW });
}

test('confirms the deployment ID, exact production target, and healthy post-deploy result', async () => {
  const emitted: CanonicalLifecycleEvidence[] = [];
  const healthCalls: string[] = [];
  const health = { status: 'healthy' as const, checkedAt: CHECKED_AT, summary: 'Readiness probe returned 200.' };
  const result = await confirmer(
    { state: 'confirmed', deploymentId: DEPLOYMENT_ID, target }, health, emitted, healthCalls,
  ).confirm(input());

  assert.equal(result.state, 'confirmed');
  assert.equal(result.deploymentId, DEPLOYMENT_ID);
  assert.deepEqual(result.target, target);
  assert.deepEqual(result.observedTarget, target);
  assert.deepEqual(result.healthResult, health);
  assert.deepEqual(healthCalls, [DEPLOYMENT_ID]);
  assert.equal(emitted[0], result.evidence);
  assert.equal(result.evidence.scope.phaseId, 'production');
  assert.equal(result.evidence.status, 'passed');
  assert.deepEqual(result.evidence.subject, { type: 'deployment_id', value: DEPLOYMENT_ID });
  assert.deepEqual(result.evidence.releaseIdentity, { ...release, deploymentId: DEPLOYMENT_ID });
  assert.equal(result.evidence.details.deployment_id, DEPLOYMENT_ID);
  assert.deepEqual(result.evidence.details.targetIdentity, target);
  assert.deepEqual(result.evidence.details.healthResult, health);
});

test('emits an honest unknown production state without inventing deployment or health evidence', async () => {
  const emitted: CanonicalLifecycleEvidence[] = [];
  const healthCalls: string[] = [];
  const result = await confirmer(
    { state: 'unknown', reason: 'Provider has not indexed the release yet.' },
    { status: 'healthy', checkedAt: CHECKED_AT, summary: 'must not be used' },
    emitted,
    healthCalls,
  ).confirm(input());

  assert.equal(result.state, 'unknown');
  assert.equal(result.deploymentId, null);
  assert.equal(result.observedTarget, null);
  assert.equal(result.healthResult, null);
  assert.equal(result.reason, 'Provider has not indexed the release yet.');
  assert.deepEqual(healthCalls, []);
  assert.equal(result.evidence.status, 'unknown');
  assert.match(result.evidence.excerpt ?? '', /state is unknown/);
  assert.deepEqual(result.evidence.subject, { type: 'artifact_digest', value: release.artifactDigest });
  assert.deepEqual(result.evidence.releaseIdentity, { ...release, deploymentId: null });
  assert.equal(result.evidence.details.confirmationState, 'unknown');
  assert.equal(result.evidence.details.deployment_id, null);
  assert.equal(result.evidence.details.healthResult, null);
  assert.equal(emitted.length, 1);
});

test('keeps provider unavailability distinct from an unknown deployment lookup', async () => {
  const emitted: CanonicalLifecycleEvidence[] = [];
  const healthCalls: string[] = [];
  const result = await confirmer(
    { state: 'unavailable', reason: 'Provider deployment API timed out.' },
    { status: 'healthy', checkedAt: CHECKED_AT, summary: 'must not be used' },
    emitted,
    healthCalls,
  ).confirm(input());

  assert.equal(result.state, 'unavailable');
  assert.equal(result.deploymentId, null);
  assert.equal(result.healthResult, null);
  assert.equal(result.reason, 'Provider deployment API timed out.');
  assert.deepEqual(healthCalls, []);
  assert.equal(result.evidence.status, 'unknown');
  assert.match(result.evidence.excerpt ?? '', /state is unavailable/);
  assert.equal(result.evidence.details.confirmationState, 'unavailable');
  assert.equal(emitted.length, 1);
});

test('refuses to confirm a deployment bound to a different production target', async () => {
  const emitted: CanonicalLifecycleEvidence[] = [];
  const healthCalls: string[] = [];
  const observedTarget = { ...target, region: 'ord' };
  const result = await confirmer(
    { state: 'confirmed', deploymentId: DEPLOYMENT_ID, target: observedTarget },
    { status: 'healthy', checkedAt: CHECKED_AT, summary: 'must not be used' },
    emitted,
    healthCalls,
  ).confirm(input());

  assert.equal(result.state, 'unknown');
  assert.equal(result.deploymentId, null);
  assert.deepEqual(result.observedTarget, observedTarget);
  assert.equal(result.healthResult, null);
  assert.match(result.reason, /different production target/);
  assert.deepEqual(healthCalls, []);
  assert.equal(result.evidence.status, 'unknown');
  assert.equal(result.evidence.details.confirmationState, 'unknown');
  assert.deepEqual(result.evidence.details.targetIdentity, target);
  assert.deepEqual(result.evidence.details.observedTargetIdentity, observedTarget);
  assert.equal(result.evidence.details.deployment_id, null);
  assert.equal(emitted.length, 1);
});

test('preserves a failed post-deploy health check as production failure evidence', async () => {
  const emitted: CanonicalLifecycleEvidence[] = [];
  const healthCalls: string[] = [];
  const health = { status: 'unhealthy' as const, checkedAt: CHECKED_AT, summary: 'Readiness probe returned 503.' };
  const result = await confirmer(
    { state: 'confirmed', deploymentId: DEPLOYMENT_ID, target }, health, emitted, healthCalls,
  ).confirm(input());

  assert.equal(result.state, 'failed_health');
  assert.equal(result.deploymentId, DEPLOYMENT_ID);
  assert.deepEqual(result.healthResult, health);
  assert.deepEqual(healthCalls, [DEPLOYMENT_ID]);
  assert.equal(result.evidence.status, 'story_caused_failure');
  assert.deepEqual(result.evidence.subject, { type: 'deployment_id', value: DEPLOYMENT_ID });
  assert.equal(result.evidence.details.confirmationState, 'failed_health');
  assert.deepEqual(result.evidence.details.healthResult, health);
  assert.match(result.evidence.excerpt ?? '', /failed its post-deploy health check/);
  assert.equal(emitted.length, 1);
});
