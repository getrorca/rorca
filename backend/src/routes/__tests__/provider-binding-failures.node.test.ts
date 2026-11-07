/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import {
  StripeEmergencyRotationRequestSchema,
  StripeRollbackReceiptSchema,
  StripeRuntimeAuthenticationFailureSchema,
  type StripeCredentialIncident,
  type StripeEmergencyRotationRequest,
} from '../../lib/stripe-credential-failure';
import type { StripeCredentialFailureRouteService } from '../provider-bindings';
import {
  createStripeCredentialIncidentsHandler,
  createStripeRuntimeAuthenticationFailureHandler,
} from '../provider-bindings';

const WORKSPACE_ID = 'workspace-stripe-failure-route';
const BINDING_ID = 'a0000000-0000-4000-8000-000000000001';
const REQUEST_ID = 'a0000000-0000-4000-8000-000000000002';
const RECEIPT_ID = 'a0000000-0000-4000-8000-000000000003';
const INTENT_ID = 'a0000000-0000-4000-8000-000000000004';
const REPLACEMENT_BINDING_ID = 'a0000000-0000-4000-8000-000000000005';
const PRIOR_FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const REPLACEMENT_FINGERPRINT = `sha256:${'b'.repeat(64)}`;
const TARGET_REFERENCE = 'runtime-binding://rorca/disposable-failure-route';
const NOW = '2026-08-24T15:00:00.000Z';

function runtimeFailure() {
  return StripeRuntimeAuthenticationFailureSchema.parse({
    schemaVersion: 'rorca.stripe-runtime-authentication-failure.v1',
    fingerprint: PRIOR_FINGERPRINT,
    mode: 'test',
    affectedResource: {
      applicationId: 'rorca-disposable-payments',
      resourceType: 'payment_intents',
      resourceId: 'disposable-route-target',
    },
    evidence: {
      evidenceType: 'stripe_runtime_authentication_failure',
      operation: 'payment_intents.read',
      providerHttpStatus: 401,
      providerRequestReference: 'req_runtime_route_failure',
      targetBindingReference: TARGET_REFERENCE,
      observedAt: NOW,
    },
  });
}

function emergencyRequest(): StripeEmergencyRotationRequest {
  const failure = runtimeFailure();
  return StripeEmergencyRotationRequestSchema.parse({
    schemaVersion: 'rorca.stripe-emergency-rotation-request.v1',
    requestId: REQUEST_ID,
    requestType: 'RUNTIME_AUTHENTICATION_FAILURE',
    workspaceId: WORKSPACE_ID,
    bindingId: BINDING_ID,
    accountId: 'acct_rorca_failure_route',
    fingerprint: PRIOR_FINGERPRINT,
    mode: 'test',
    affectedResource: failure.affectedResource,
    permissionManifest: ['payment_intents.read'],
    evidence: failure.evidence,
    state: 'AWAITING_DASHBOARD_AUTHENTICATION',
    authority: {
      canGrant: false,
      canBroadenPermissions: false,
      canCrossWorkspace: false,
      canCrossMode: false,
      canInjectSecret: false,
      requiresDashboardAuthentication: true,
    },
    requestedAt: NOW,
  });
}

function rollbackIncident(): StripeCredentialIncident {
  const priorStatus = {
    schemaVersion: 'rorca.stripe-credential-status-receipt.v1' as const,
    fingerprint: PRIOR_FINGERPRINT,
    status: 'active' as const,
    mode: 'test' as const,
    operation: 'payment_intents.read',
    resourceType: 'payment_intents',
    resourceId: 'pi_route_canary',
    providerRequestReference: 'req_prior_active',
    evidenceCode: 'provider_operation_succeeded' as const,
    observedAt: NOW,
  };
  return {
    kind: 'rollback',
    receipt: StripeRollbackReceiptSchema.parse({
      schemaVersion: 'rorca.stripe-rollback-receipt.v1',
      receiptId: RECEIPT_ID,
      intentId: INTENT_ID,
      intentDigest: `sha256:${'c'.repeat(64)}`,
      workspaceId: WORKSPACE_ID,
      bindingId: BINDING_ID,
      replacementBindingId: REPLACEMENT_BINDING_ID,
      mode: 'test',
      targetBindingReference: TARGET_REFERENCE,
      priorFingerprint: PRIOR_FINGERPRINT,
      replacementFingerprint: REPLACEMENT_FINGERPRINT,
      failurePhase: 'CANARY',
      failureCode: 'STRIPE_CANARY_FAILED',
      disposition: 'ROLLED_BACK',
      priorBindingStatus: 'retained_active',
      replacementSecretStatus: 'quarantined',
      targetDisposition: 'prior_restored',
      priorProviderStatus: priorStatus,
      replacementProviderStatus: { ...priorStatus, fingerprint: REPLACEMENT_FINGERPRINT },
      targetReadback: {
        targetBindingReference: TARGET_REFERENCE,
        activeFingerprint: PRIOR_FINGERPRINT,
        health: 'healthy',
        bindingGeneration: 1,
        observedAt: NOW,
      },
      manualReconciliation: null,
      settledAt: NOW,
    }),
  };
}

function serviceFixture() {
  const emergency = emergencyRequest();
  const incidents: StripeCredentialIncident[] = [
    { kind: 'emergency', request: emergency },
    rollbackIncident(),
  ];
  const createCalls: unknown[] = [];
  const listCalls: unknown[] = [];
  const service: StripeCredentialFailureRouteService = {
    async createEmergencyRequest(input) {
      createCalls.push(input);
      return emergency;
    },
    async listIncidents(workspaceId, limit) {
      listCalls.push({ workspaceId, limit });
      return incidents;
    },
  };
  return { service, emergency, incidents, createCalls, listCalls };
}

async function invokeHandler(
  handler: RequestHandler,
  input: { params: Record<string, string>; body?: unknown; query?: Record<string, string> },
): Promise<{ body?: unknown; status: number; error?: unknown }> {
  let responseBody: unknown;
  let status = 200;
  let forwardedError: unknown;
  const response = {
    status(value: number) {
      status = value;
      return response;
    },
    json(value: unknown) {
      responseBody = value;
      return response;
    },
  };
  const next: NextFunction = (error?: unknown) => {
    forwardedError = error;
  };
  await handler(
    {
      params: input.params,
      body: input.body,
      query: input.query ?? {},
    } as unknown as Request,
    response as unknown as Response,
    next,
  );
  return { body: responseBody, status, error: forwardedError };
}

describe('Stripe credential failure routes', () => {
  it('creates a typed inert emergency request linked to exact runtime evidence', async () => {
    const fixture = serviceFixture();
    const failure = runtimeFailure();
    const result = await invokeHandler(
      createStripeRuntimeAuthenticationFailureHandler(fixture.service, async () => true),
      {
        params: { id: WORKSPACE_ID, bindingId: BINDING_ID },
        body: failure,
      },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.status, 202);
    assert.deepEqual(result.body, { emergencyRequest: fixture.emergency });
    assert.deepEqual(fixture.createCalls, [{
      workspaceId: WORKSPACE_ID,
      bindingId: BINDING_ID,
      failure,
    }]);
    assert.equal(fixture.emergency.authority.canGrant, false);
    assert.equal(fixture.emergency.authority.requiresDashboardAuthentication, true);
    assert.doesNotMatch(
      JSON.stringify(result.body),
      /(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/,
    );
  });

  it('rejects credential-bearing incident evidence before service invocation without echoing it', async () => {
    const fixture = serviceFixture();
    const credential = ['rk', 'test', 'forbiddenRouteCredential123'].join('_');
    const failure = runtimeFailure();
    const result = await invokeHandler(
      createStripeRuntimeAuthenticationFailureHandler(fixture.service, async () => true),
      {
        params: { id: WORKSPACE_ID, bindingId: BINDING_ID },
        body: {
          ...failure,
          evidence: { ...failure.evidence, providerRequestReference: credential },
        },
      },
    );

    assert.ok(result.error && typeof result.error === 'object' && 'statusCode' in result.error);
    assert.equal(result.error.statusCode, 400);
    assert.equal(JSON.stringify(result.error).includes(credential), false);
    assert.equal(fixture.createCalls.length, 0);
  });

  it('paginates secret-free rollback and emergency evidence for the Dashboard', async () => {
    const fixture = serviceFixture();
    const result = await invokeHandler(
      createStripeCredentialIncidentsHandler(fixture.service, async () => true),
      {
        params: { id: WORKSPACE_ID },
        query: { limit: '25' },
      },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.status, 200);
    assert.ok(result.body && typeof result.body === 'object' && 'items' in result.body);
    assert.deepEqual(result.body.items, fixture.incidents);
    assert.deepEqual(fixture.listCalls, [{ workspaceId: WORKSPACE_ID, limit: 250 }]);
    assert.doesNotMatch(
      JSON.stringify(result.body),
      /(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/,
    );
  });
});
