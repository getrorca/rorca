/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CoolifyAuthorityProviderAdapter,
  CoolifyBindingValidationError,
  CreateCoolifyBindingSchema,
  buildCoolifyProductionDeploymentPayload,
  buildCoolifyStagingDeploymentPayload,
  probeCoolifyBinding,
} from '../coolify-authority-provider-adapter';
import { CoolifyProviderBindingSchema } from '../authority-provider-adapter';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const APPLICATION_UUID = '22222222-2222-4222-8222-222222222222';
const ENVIRONMENT_UUID = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'coolify-control-token-never-project';
const BASE_URL = 'https://coolify.example.test';

interface FixtureOverrides {
  project?: unknown;
  application?: unknown;
  environment?: unknown;
  team?: unknown;
  reject?: boolean;
}

function providerDependencies(overrides: FixtureOverrides = {}, requests: Array<{ url: string; authorization: string | null }> = []) {
  const fixtureByPath: Record<string, unknown> = {
    [`/api/v1/projects/${PROJECT_UUID}`]: overrides.project ?? { id: 10, uuid: PROJECT_UUID },
    [`/api/v1/applications/${APPLICATION_UUID}`]: overrides.application ?? {
      id: 20,
      uuid: APPLICATION_UUID,
      project_uuid: PROJECT_UUID,
      environment_uuid: ENVIRONMENT_UUID,
      permissions: ['applications.deploy'],
    },
    [`/api/v1/projects/${PROJECT_UUID}/${ENVIRONMENT_UUID}`]: overrides.environment ?? {
      id: 30,
      uuid: ENVIRONMENT_UUID,
      project_uuid: PROJECT_UUID,
      name: 'staging',
      applications: [{ uuid: APPLICATION_UUID }],
    },
    '/api/v1/teams/current': overrides.team ?? {
      id: 40,
      user_id: 50,
      permissions: ['applications.deploy'],
    },
  };
  return {
    now: () => new Date('2026-08-21T10:00:00.000Z'),
    resolveHostname: async () => ['8.8.8.8'],
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      if (overrides.reject) throw new TypeError('fixture network failure');
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      requests.push({ url: url.toString(), authorization: headers.get('authorization') });
      const fixture = fixtureByPath[url.pathname];
      return new Response(JSON.stringify(fixture), {
        status: fixture === undefined ? 404 : 200,
        headers: { 'content-type': 'application/json', 'x-coolify-version': '4.0.0' },
      });
    },
  };
}

const healthyInput = {
  baseUrl: BASE_URL,
  projectUuid: PROJECT_UUID,
  applicationUuid: APPLICATION_UUID,
  environmentUuid: ENVIRONMENT_UUID,
  environmentKind: 'staging' as const,
  capabilityPolicy: {
    allowedActions: ['deploy.staging' as const],
    preauthorizedStaging: true,
    maxLeaseSeconds: 300,
  },
  controlToken: TOKEN,
};

async function rejectsWithReason(
  reason: CoolifyBindingValidationError['reason'],
  overrides: FixtureOverrides,
  input = healthyInput,
): Promise<void> {
  await assert.rejects(
    probeCoolifyBinding(input, providerDependencies(overrides)),
    (error: unknown) => error instanceof CoolifyBindingValidationError && error.reason === reason,
  );
}

test('probe resolves exact immutable target identity and emits a redacted capability profile', async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const profile = await probeCoolifyBinding(healthyInput, providerDependencies({}, requests));

  assert.deepEqual(profile.target, {
    project: { uuid: PROJECT_UUID, numericId: 10 },
    application: { uuid: APPLICATION_UUID, numericId: 20 },
    environment: { uuid: ENVIRONMENT_UUID, numericId: 30 },
  });
  assert.deepEqual(profile.allowedActions, ['deploy.staging']);
  assert.deepEqual(profile.principal, {
    subjectId: '50',
    teamId: '40',
    scopes: ['applications.deploy'],
  });
  assert.equal(profile.verifiedAt, '2026-08-21T10:00:00.000Z');
  assert.equal(profile.expiresAt, '2026-08-21T10:15:00.000Z');
  assert.equal(requests.length, 4);
  assert.ok(requests.every((request) => request.authorization === `Bearer ${TOKEN}`));
  assert.ok(requests.some((request) => request.url.endsWith(`/api/v1/projects/${PROJECT_UUID}/${ENVIRONMENT_UUID}`)));
  assert.equal(JSON.stringify(profile).includes(TOKEN), false);
  assert.equal(JSON.stringify(profile).toLowerCase().includes('authorization'), false);
});

test('binding lookup never infers a deployment target without an exact selector', async () => {
  const adapter = new CoolifyAuthorityProviderAdapter(providerDependencies());

  await assert.rejects(
    adapter.getProviderBinding('workspace-one'),
    (error: unknown) => error instanceof CoolifyBindingValidationError && error.reason === 'ambiguous',
  );
});

test('probe fails closed for unreachable, ambiguous, non-resolvable, wrong-environment, and permission-deficient targets', async () => {
  await rejectsWithReason('unreachable', { reject: true });
  await rejectsWithReason('ambiguous', { application: [{ uuid: APPLICATION_UUID }, { uuid: APPLICATION_UUID }] });
  await rejectsWithReason('not_resolvable', {
    application: { id: 20, uuid: APPLICATION_UUID, permissions: ['applications.deploy'] },
  });
  await rejectsWithReason('not_resolvable', {
    application: {
      id: 20,
      uuid: '99999999-9999-4999-8999-999999999999',
      name: 'shared-application-name',
      project_uuid: PROJECT_UUID,
      environment_uuid: ENVIRONMENT_UUID,
      permissions: ['applications.deploy'],
    },
  });
  await rejectsWithReason('wrong_environment', {
    environment: {
      id: 30,
      uuid: ENVIRONMENT_UUID,
      project_uuid: PROJECT_UUID,
      name: 'production',
      applications: [{ uuid: APPLICATION_UUID }],
    },
  });
  await rejectsWithReason('permission_deficient', {
    application: {
      id: 20,
      uuid: APPLICATION_UUID,
      project_uuid: PROJECT_UUID,
      environment_uuid: ENVIRONMENT_UUID,
      permissions: ['applications.read'],
    },
    team: { id: 40, user_id: 50, permissions: ['applications.read'] },
  });
  await rejectsWithReason('permission_deficient', {
    team: { id: 40, user_id: 50, permissions: ['applications.read'] },
  });
});

test('provider profile data cannot reflect the control credential into projections or errors', async () => {
  await assert.rejects(
    probeCoolifyBinding(healthyInput, providerDependencies({
      team: {
        id: 40,
        user_id: TOKEN,
        permissions: ['applications.deploy', TOKEN],
      },
    })),
    (error: unknown) => {
      assert.ok(error instanceof CoolifyBindingValidationError);
      assert.equal(error.reason, 'not_resolvable');
      assert.equal(`${error.name}:${error.message}:${JSON.stringify(error)}`.includes(TOKEN), false);
      return true;
    },
  );
});

test('malformed provider capability profiles fail as non-resolvable binding errors', async () => {
  await rejectsWithReason('not_resolvable', {
    team: {
      id: 40,
      user_id: 50,
      permissions: ['applications.deploy', 'x'.repeat(121)],
    },
  });
});

test('binding schema prohibits cross-environment capability and credential fields', () => {
  const binding = {
    providerId: 'coolify' as const,
    bindingId: '44444444-4444-4444-8444-444444444444',
    workspaceId: 'workspace-one',
    bindingStatus: 'active' as const,
    environmentKind: 'staging' as const,
    baseUrl: BASE_URL,
    target: {
      projectUuid: PROJECT_UUID,
      applicationUuid: APPLICATION_UUID,
      environmentUuid: ENVIRONMENT_UUID,
    },
    capabilityPolicy: {
      allowedActions: ['deploy.staging' as const],
      preauthorizedStaging: true,
      maxLeaseSeconds: 300,
    },
    bindingGeneration: 1,
    secretReference: {
      store: 'api-key-vault' as const,
      secretId: '55555555-5555-4555-8555-555555555555',
      purpose: 'control-token' as const,
    },
    verifiedProfile: {
      schemaVersion: 'rorca.coolify-verified-profile.v1',
      providerVersion: '4.0.0',
      target: {
        project: { uuid: PROJECT_UUID, numericId: 10 },
        application: { uuid: APPLICATION_UUID, numericId: 20 },
        environment: { uuid: ENVIRONMENT_UUID, numericId: 30 },
      },
      principal: { subjectId: '50', teamId: '40', scopes: ['applications.deploy'] },
      allowedActions: ['deploy.staging' as const],
      verifiedAt: '2026-08-21T10:00:00.000Z',
      expiresAt: '2026-08-21T10:15:00.000Z',
    },
    lastValidationError: null,
  };
  assert.equal(CoolifyProviderBindingSchema.safeParse(binding).success, true);
  assert.equal(CoolifyProviderBindingSchema.safeParse({
    ...binding,
    capabilityPolicy: { ...binding.capabilityPolicy, allowedActions: ['deploy.production'] },
  }).success, false);
  assert.equal(CoolifyProviderBindingSchema.safeParse({ ...binding, controlToken: TOKEN }).success, false);
  assert.equal(CoolifyProviderBindingSchema.safeParse({
    ...binding,
    verifiedProfile: {
      ...binding.verifiedProfile,
      target: {
        ...binding.verifiedProfile.target,
        application: {
          ...binding.verifiedProfile.target.application,
          uuid: '99999999-9999-4999-8999-999999999999',
        },
      },
    },
  }).success, false);
  assert.equal(CoolifyProviderBindingSchema.safeParse({
    ...binding,
    verifiedProfile: null,
  }).success, false);
  assert.equal(CreateCoolifyBindingSchema.safeParse({
    ...healthyInput,
    userId: 'operator-one',
    capabilityPolicy: {
      ...healthyInput.capabilityPolicy,
      allowedActions: ['deploy.production'],
    },
  }).success, false);
  assert.equal(CreateCoolifyBindingSchema.safeParse({
    ...healthyInput,
    userId: 'operator-one',
    capabilityPolicy: {
      ...healthyInput.capabilityPolicy,
      productionApprovalMode: 'independent_external',
    },
  }).success, false);
});

test('staging deployment payload binds the exact application, revision, digest, and configuration generation', () => {
  const stagingBinding = CoolifyProviderBindingSchema.parse({
    providerId: 'coolify',
    bindingId: '44444444-4444-4444-8444-444444444444',
    workspaceId: 'workspace-one',
    bindingStatus: 'active',
    environmentKind: 'staging',
    baseUrl: BASE_URL,
    target: {
      projectUuid: PROJECT_UUID,
      applicationUuid: APPLICATION_UUID,
      environmentUuid: ENVIRONMENT_UUID,
    },
    capabilityPolicy: {
      allowedActions: ['deploy.staging'],
      preauthorizedStaging: true,
      maxLeaseSeconds: 300,
    },
    bindingGeneration: 1,
    secretReference: {
      store: 'api-key-vault',
      secretId: '55555555-5555-4555-8555-555555555555',
      purpose: 'control-token',
    },
    verifiedProfile: {
      schemaVersion: 'rorca.coolify-verified-profile.v1',
      providerVersion: '4.0.0',
      target: {
        project: { uuid: PROJECT_UUID, numericId: 10 },
        application: { uuid: APPLICATION_UUID, numericId: 20 },
        environment: { uuid: ENVIRONMENT_UUID, numericId: 30 },
      },
      principal: { subjectId: '50', teamId: '40', scopes: ['applications.deploy'] },
      allowedActions: ['deploy.staging'],
      verifiedAt: '2026-08-21T10:00:00.000Z',
      expiresAt: '2026-08-21T10:15:00.000Z',
    },
    lastValidationError: null,
  });
  const revision = {
    sourceRevision: 'a'.repeat(40),
    imageDigest: `sha256:${'b'.repeat(64)}`,
  };
  assert.deepEqual(buildCoolifyStagingDeploymentPayload(stagingBinding, revision, 12), {
    uuid: APPLICATION_UUID,
    commit_sha: revision.sourceRevision,
    image_digest: revision.imageDigest,
    configuration_binding_generation: 12,
  });
  assert.throws(
    () => buildCoolifyStagingDeploymentPayload({
      ...stagingBinding,
      environmentKind: 'production',
      capabilityPolicy: {
        allowedActions: ['deploy.production'],
        preauthorizedStaging: false,
        maxLeaseSeconds: 300,
      },
      verifiedProfile: {
        ...stagingBinding.verifiedProfile!,
        allowedActions: ['deploy.production'],
      },
    }, revision, 12),
    (error: unknown) => error instanceof CoolifyBindingValidationError
      && error.reason === 'wrong_environment',
  );
});

test('production payload binds exact immutable release inputs and approved cohort', () => {
  const productionBinding = CoolifyProviderBindingSchema.parse({
    providerId: 'coolify',
    bindingId: '44444444-4444-4444-8444-444444444444',
    workspaceId: 'workspace-one',
    bindingStatus: 'active',
    environmentKind: 'production',
    baseUrl: BASE_URL,
    target: {
      projectUuid: PROJECT_UUID,
      applicationUuid: APPLICATION_UUID,
      environmentUuid: ENVIRONMENT_UUID,
    },
    capabilityPolicy: {
      allowedActions: ['deploy.production'],
      preauthorizedStaging: false,
      productionApprovalMode: 'independent_external',
      maxLeaseSeconds: 300,
    },
    bindingGeneration: 1,
    secretReference: {
      store: 'api-key-vault',
      secretId: '55555555-5555-4555-8555-555555555555',
      purpose: 'control-token',
    },
    verifiedProfile: {
      schemaVersion: 'rorca.coolify-verified-profile.v1',
      providerVersion: '4.0.0',
      target: {
        project: { uuid: PROJECT_UUID, numericId: 10 },
        application: { uuid: APPLICATION_UUID, numericId: 20 },
        environment: { uuid: ENVIRONMENT_UUID, numericId: 30 },
      },
      principal: { subjectId: '50', teamId: '40', scopes: ['applications.deploy'] },
      allowedActions: ['deploy.production'],
      verifiedAt: '2026-08-21T10:00:00.000Z',
      expiresAt: '2026-08-21T10:15:00.000Z',
    },
    lastValidationError: null,
  });
  const releaseIntent = {
    schemaVersion: 'rorca.release-intent.v1' as const,
    sourceRevision: 'a'.repeat(40),
    artifacts: {
      artifactDigests: [`sha256:${'b'.repeat(64)}`],
      imageDigests: [`sha256:${'c'.repeat(64)}`],
    },
    migrationSetDigest: `sha256:${'d'.repeat(64)}`,
    configurationBindingGeneration: 12,
    featureFlagDigest: `sha256:${'e'.repeat(64)}`,
    rolloutCohort: {
      cohortId: 'canary',
      percentage: 10,
      selectorDigest: `sha256:${'f'.repeat(64)}`,
    },
    changeWindow: {
      startsAt: '2026-08-21T10:00:00.000Z',
      endsAt: '2026-08-21T11:00:00.000Z',
    },
    providerApprovalReference: {
      provider: 'github',
      approvalId: 'approval-1',
      environment: 'production',
      evidenceDigest: `sha256:${'1'.repeat(64)}`,
    },
    rollback: {
      owner: 'release-owner',
      procedure: {
        procedureId: 'restore',
        procedureDigest: `sha256:${'2'.repeat(64)}`,
      },
    },
    healthSignals: [{
      signalId: 'health',
      source: 'metrics' as const,
      evidenceKey: 'health.rate',
      aggregation: 'minimum' as const,
      unit: 'percent',
    }],
    abortConditions: [{
      conditionId: 'abort',
      signalId: 'health',
      operator: 'lt' as const,
      threshold: 99,
      observationWindowSeconds: 60,
      requiredSamples: 3,
    }],
  };

  assert.deepEqual(buildCoolifyProductionDeploymentPayload(productionBinding, releaseIntent), {
    uuid: APPLICATION_UUID,
    commit_sha: releaseIntent.sourceRevision,
    artifact_digests: releaseIntent.artifacts.artifactDigests,
    image_digests: releaseIntent.artifacts.imageDigests,
    migration_set_digest: releaseIntent.migrationSetDigest,
    configuration_binding_generation: 12,
    feature_flag_digest: releaseIntent.featureFlagDigest,
    rollout_cohort: releaseIntent.rolloutCohort,
    rollout_phase: 'canary',
  });
});
