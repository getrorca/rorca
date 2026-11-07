/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProductionDeploymentResponse,
  createProviderBindingResponse,
  createStagingDeploymentResponse,
  reconcileStagingDeploymentResponse,
  reconcileProductionDeploymentResponse,
} from '../provider-bindings';
import type { CoolifyProviderBinding } from '../../lib/authority-provider-adapter';

const TOKEN = 'coolify-browser-control-token-never-return';

const binding: CoolifyProviderBinding = {
  providerId: 'coolify',
  bindingId: '44444444-4444-4444-8444-444444444444',
  workspaceId: 'workspace-one',
  bindingStatus: 'active',
  environmentKind: 'staging',
  baseUrl: 'https://coolify.example.test',
  target: {
    projectUuid: '11111111-1111-4111-8111-111111111111',
    applicationUuid: '22222222-2222-4222-8222-222222222222',
    environmentUuid: '33333333-3333-4333-8333-333333333333',
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
      project: { uuid: '11111111-1111-4111-8111-111111111111', numericId: 10 },
      application: { uuid: '22222222-2222-4222-8222-222222222222', numericId: 20 },
      environment: { uuid: '33333333-3333-4333-8333-333333333333', numericId: 30 },
    },
    principal: { subjectId: '50', teamId: '40', scopes: ['applications.deploy'] },
    allowedActions: ['deploy.staging'],
    verifiedAt: '2026-08-21T10:00:00.000Z',
    expiresAt: '2026-08-21T10:15:00.000Z',
  },
  lastValidationError: null,
};

test('create response consumes the control token once and returns only the redacted binding projection', async () => {
  let observedToken = '';
  const response = await createProviderBindingResponse({
    async createProviderBinding(input) {
      observedToken = input.controlToken;
      return binding;
    },
  }, 'user-one', {
    workspaceId: 'workspace-one',
    baseUrl: binding.baseUrl,
    ...binding.target,
    environmentKind: 'staging',
    controlToken: TOKEN,
    capabilityPolicy: binding.capabilityPolicy,
  });

  const serialized = JSON.stringify(response);
  assert.equal(observedToken, TOKEN);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes('controlToken'), false);
  assert.deepEqual(response, { binding });
});

test('create response fails closed if an adapter attempts to return credential material', async () => {
  await assert.rejects(
    createProviderBindingResponse({
      async createProviderBinding() {
        return { ...binding, controlToken: TOKEN };
      },
    }, 'user-one', {
      workspaceId: 'workspace-one',
      baseUrl: binding.baseUrl,
      ...binding.target,
      environmentKind: 'staging',
      controlToken: TOKEN,
      capabilityPolicy: binding.capabilityPolicy,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(`${error.message}:${JSON.stringify(error)}`.includes(TOKEN), false);
      assert.ok('code' in error);
      assert.equal(error.code, 'PROVIDER_BINDING_REDACTION_FAILED');
      return true;
    },
  );
});

test('staging authority helpers validate exact immutable requests and preserve typed waits', async () => {
  const requestBody = {
    workspaceId: 'workspace-one',
    bindingId: binding.bindingId,
    bindingGeneration: 1,
    operationId: '66666666-6666-4666-8666-666666666666',
    revision: {
      sourceRevision: 'a'.repeat(40),
      imageDigest: `sha256:${'b'.repeat(64)}`,
    },
    configurationBindingGeneration: 9,
    healthSignals: [{
      name: 'application.health',
      source: 'application',
      field: 'health_status',
      expectedValue: 'healthy',
    }],
  };
  let deployed: unknown;
  let reconciled: unknown;
  const service = {
    async deploy(input: unknown) {
      deployed = input;
      return {
        status: 'waiting_for_authorization' as const,
        operationId: requestBody.operationId,
      };
    },
    async reconcile(workspaceId: string, operationId: string) {
      reconciled = { workspaceId, operationId };
      return {
        status: 'reconciliation_required' as const,
        operationId,
        providerDeploymentId: 'deployment-staging-1',
      };
    },
  };

  assert.deepEqual(await createStagingDeploymentResponse(service, requestBody), {
    result: {
      status: 'waiting_for_authorization',
      operationId: requestBody.operationId,
    },
  });
  assert.deepEqual(deployed, requestBody);
  assert.deepEqual(await reconcileStagingDeploymentResponse(
    service,
    requestBody.workspaceId,
    requestBody.operationId,
  ), {
    result: {
      status: 'reconciliation_required',
      operationId: requestBody.operationId,
      providerDeploymentId: 'deployment-staging-1',
    },
  });
  assert.deepEqual(reconciled, {
    workspaceId: requestBody.workspaceId,
    operationId: requestBody.operationId,
  });
  await assert.rejects(
    createStagingDeploymentResponse(service, {
      ...requestBody,
      revision: { sourceRevision: 'main', imageDigest: null },
    }),
    /Invalid provider binding request/,
  );
});

test('production authority helper preserves typed waits and supplies only the authenticated operator identity', async () => {
  const requestBody = {
    workspaceId: 'workspace-one',
    bindingId: binding.bindingId,
    bindingGeneration: 1,
    operationId: '66666666-6666-4666-8666-666666666666',
    operationIntentId: '77777777-7777-4777-8777-777777777777',
    grantId: '88888888-8888-4888-8888-888888888888',
    intentDigest: `sha256:${'a'.repeat(64)}`,
    ciEvidenceDigest: `sha256:${'b'.repeat(64)}`,
    rolloutCohort: {
      cohortId: 'canary',
      percentage: 10,
      selectorDigest: `sha256:${'c'.repeat(64)}`,
    },
    approval: {
      kind: 'external_gate' as const,
      evidence: {
        provider: 'github',
        evidenceId: '99999999-9999-4999-8999-999999999999',
      },
    },
  };
  let deployed: unknown;
  let operatorId: string | undefined;
  let reconciled: unknown;
  const service = {
    async deploy(input: unknown, localOperatorId?: string) {
      deployed = input;
      operatorId = localOperatorId;
      return {
        status: 'waiting_for_change_window' as const,
        operationId: requestBody.operationId,
        reason: 'window_not_started' as const,
        startsAt: '2026-08-24T13:00:00.000Z',
        endsAt: '2026-08-24T14:00:00.000Z',
      };
    },
    async reconcile(workspaceId: string, operationId: string) {
      reconciled = { workspaceId, operationId };
      return {
        status: 'reconciliation_required' as const,
        operationId,
        phase: 'canary' as const,
        actionId: operationId,
        providerDeploymentId: 'coolify-canary-1',
        healthEvaluation: null,
      };
    },
  };

  const response = await createProductionDeploymentResponse(
    service,
    'authenticated-local-operator',
    requestBody,
  );
  assert.equal(response.result.status, 'waiting_for_change_window');
  assert.deepEqual(deployed, requestBody);
  assert.equal(operatorId, 'authenticated-local-operator');
  assert.deepEqual(await reconcileProductionDeploymentResponse(
    service,
    requestBody.workspaceId,
    requestBody.operationId,
  ), {
    result: {
      status: 'reconciliation_required',
      operationId: requestBody.operationId,
      phase: 'canary',
      actionId: requestBody.operationId,
      providerDeploymentId: 'coolify-canary-1',
      healthEvaluation: null,
    },
  });
  assert.deepEqual(reconciled, {
    workspaceId: requestBody.workspaceId,
    operationId: requestBody.operationId,
  });

  await assert.rejects(
    createProductionDeploymentResponse(service, 'authenticated-local-operator', {
      ...requestBody,
      localSelfAttestation: { approved: true },
    }),
    /Invalid provider binding request/,
  );
});

