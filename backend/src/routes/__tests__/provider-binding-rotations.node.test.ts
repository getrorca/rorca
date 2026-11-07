/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { StripeAuthorityProviderAdapter, type StripeProviderBinding } from '../../lib/stripe-authority-provider-adapter';
import { requireLocalOperatorBoundary } from '../../lib/local-operator-boundary';
import {
  createStripeRotationIntent,
  stripeRotationIntentDigest,
  type StripeRotationApproval,
  type StripeRotationIntentInput,
} from '../../lib/stripe-credential-rotation';
import type {
  StripeCredentialRotationRouteService,
} from '../provider-bindings';
import {
  createProviderBindingsRouter,
  createStripeCutoverAdvanceHandler,
  createStripeRevocationCompletionHandler,
  createStripeRotationAuthenticationCompletionHandler,
  createStripeRotationIntentHandler,
} from '../provider-bindings';

interface ExpressRouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: RequestHandler }>;
  };
}

const WORKSPACE_ID = 'workspace-stripe-route-rotation';
const BINDING_ID = '60000000-0000-4000-8000-000000000001';
const INTENT_ID = '60000000-0000-4000-8000-000000000002';
const CAPTURE_ID = '60000000-0000-4000-8000-000000000003';
const NOW = new Date('2026-08-23T12:00:00.000Z');

const BINDING: StripeProviderBinding = {
  providerId: 'stripe',
  bindingId: BINDING_ID,
  workspaceId: WORKSPACE_ID,
  accountId: 'acct_rorca_route_rotation',
  mode: 'test',
  scope: {
    applicationId: 'rorca-disposable-fixture',
    resourceType: 'payment_intents',
    resourceId: 'disposable-target',
  },
  credentialClass: 'restricted_api_key',
  keyKind: 'restricted',
  permissionManifest: ['payment_intents.read'],
  owner: 'rorca-stripe-operator',
  fingerprint: `sha256:${'a'.repeat(64)}`,
  secretStoreReference: 'secret-store://rorca/current-route-key',
  targetBindingReference: 'runtime-binding://rorca/disposable-target',
  status: 'active',
  generation: 1,
  lastVerifiedAt: '2026-08-23T11:00:00.000Z',
};

function rotationInput(): StripeRotationIntentInput {
  return {
    workspaceId: WORKSPACE_ID,
    bindingId: BINDING_ID,
    accountId: BINDING.accountId,
    currentFingerprint: BINDING.fingerprint,
    permissionManifest: [...BINDING.permissionManifest],
    mode: 'test',
    targetBindingReference: BINDING.targetBindingReference,
    replacementCredentialClass: 'restricted_api_key',
    canary: {
      operation: 'payment_intents.read',
      resourceType: 'payment_intents',
      resourceId: 'disposable-canary',
      timeoutMs: 10_000,
    },
    gracePeriodSeconds: 300,
    rollback: {
      strategy: 'restore_previous_binding',
      keepPriorCredentialActive: true,
      quarantineReplacement: true,
      verificationTimeoutMs: 10_000,
    },
    humanSteps: {
      dashboardReauthentication: 'required',
      restrictedKeyCreation: 'required',
      mfaAutomation: 'forbidden',
      providerControlBypass: 'forbidden',
    },
  };
}

function approval(intent = rotationInput()): StripeRotationApproval {
  return {
    schemaVersion: 'rorca.stripe-rotation-approval.v1',
    intentDigest: stripeRotationIntentDigest(intent),
    authorityReceiptId: '60000000-0000-4000-8000-000000000004',
    approvedBy: 'operator:rorca-owner',
    approvedAt: '2026-08-23T11:59:00.000Z',
    expiresAt: '2026-08-23T12:30:00.000Z',
  };
}

function routeFixture() {
  const input = rotationInput();
  const intent = createStripeRotationIntent({
    intentId: INTENT_ID,
    intent: input,
    approval: approval(input),
    binding: BINDING,
    now: NOW,
  });
  const safeCapture = {
    reference: `secret-store://rorca/provider-credentials/${CAPTURE_ID}` as const,
    fingerprint: `sha256:${'b'.repeat(64)}`,
    provenance: {
      schemaVersion: 'rorca.stripe-capture-provenance.v1' as const,
      captureReceiptReference: `credential-capture://rorca/${CAPTURE_ID}` as const,
      provider: 'stripe' as const,
      channel: 'trusted_local_operator' as const,
      providerEvidenceId: '60000000-0000-4000-8000-000000000005',
      operatorId: 'operator:stripe-owner',
      capturedAt: '2026-08-23T12:01:00.000Z',
      targetBindingReference: intent.targetBindingReference,
    },
  };
  const record = {
    intent,
    lifecycle: {
      state: 'WAITING_FOR_AUTHENTICATION' as const,
      timeoutDisposition: 'paused' as const,
      activeElapsedMs: 0,
      waitingSince: intent.createdAt,
      resumedAt: null,
      resumeCount: 0 as const,
      providerEvidenceDigest: null,
      capture: null,
    },
  };
  const cutoverState = {
    state: 'READY_FOR_STAGING' as const,
    intentId: intent.intentId,
    intentDigest: intent.intentDigest,
    workspaceId: intent.workspaceId,
    bindingId: intent.bindingId,
    replacementBindingId: '60000000-0000-4000-8000-000000000006',
    targetBindingReference: intent.targetBindingReference,
    priorFingerprint: intent.currentFingerprint,
    replacementFingerprint: safeCapture.fingerprint,
    initializedAt: '2026-08-23T12:02:00.000Z',
    priorCredentialStatus: 'active' as const,
  };
  const createCalls: unknown[] = [];
  const completionCalls: unknown[] = [];
  const advanceCalls: unknown[] = [];
  const revocationCalls: unknown[] = [];
  const service: StripeCredentialRotationRouteService = {
    async createApprovedIntent(requestInput) {
      createCalls.push(requestInput);
      return record;
    },
    async get(workspaceId, intentId) {
      return workspaceId === WORKSPACE_ID && intentId === INTENT_ID ? record : null;
    },
    async getCutover() {
      return null;
    },
    async completeAuthentication(requestInput) {
      completionCalls.push(requestInput);
      return safeCapture;
    },
    async advanceCutover(requestInput) {
      advanceCalls.push(requestInput);
      return cutoverState;
    },
    async completeRevocation(requestInput) {
      revocationCalls.push(requestInput);
      return cutoverState;
    },
  };
  return {
    input,
    intent,
    record,
    safeCapture,
    cutoverState,
    service,
    createCalls,
    completionCalls,
    advanceCalls,
    revocationCalls,
  };
}

async function invokeHandler(
  handler: RequestHandler,
  params: Record<string, string>,
  body: unknown,
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
    { params, body } as unknown as Request,
    response as unknown as Response,
    next,
  );
  return { body: responseBody, status, error: forwardedError };
}

describe('Stripe credential rotation routes', () => {
  it('creates a secret-free waiting ceremony bound to the path', async () => {
    const fixture = routeFixture();
    const result = await invokeHandler(
      createStripeRotationIntentHandler(fixture.service, async () => true),
      { id: WORKSPACE_ID, bindingId: BINDING_ID },
      { intent: fixture.input, approval: approval(fixture.input) },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.status, 201);
    assert.equal(fixture.createCalls.length, 1);
    assert.ok(result.body && typeof result.body === 'object' && 'ceremony' in result.body);
    const ceremony = result.body.ceremony;
    assert.ok(ceremony && typeof ceremony === 'object' && 'state' in ceremony && 'timeoutDisposition' in ceremony);
    assert.equal(ceremony.state, 'WAITING_FOR_AUTHENTICATION');
    assert.equal(ceremony.timeoutDisposition, 'paused');
    assert.doesNotMatch(JSON.stringify(result.body), /(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/);
  });

  it('rejects credential fields at the ordinary create boundary without echoing values', async () => {
    const fixture = routeFixture();
    const credential = ['rk', 'test', 'forbiddenCredential123'].join('_');
    const result = await invokeHandler(
      createStripeRotationIntentHandler(fixture.service, async () => true),
      { id: WORKSPACE_ID, bindingId: BINDING_ID },
      { intent: { ...fixture.input, replacement: credential }, approval: approval(fixture.input) },
    );

    assert.ok(result.error && typeof result.error === 'object' && 'statusCode' in result.error);
    assert.equal(result.error.statusCode, 400);
    assert.equal(JSON.stringify(result.error).includes(credential), false);
    assert.equal(fixture.createCalls.length, 0);
  });

  it('completes with reference-only input and returns exactly reference, fingerprint, and provenance', async () => {
    const fixture = routeFixture();
    const handler = createStripeRotationAuthenticationCompletionHandler(fixture.service, async () => true);
    const completion = {
      intentDigest: fixture.intent.intentDigest,
      captureReceiptReference: fixture.safeCapture.provenance.captureReceiptReference,
    };
    const result = await invokeHandler(
      handler,
      { id: WORKSPACE_ID, bindingId: BINDING_ID, intentId: INTENT_ID },
      completion,
    );

    assert.equal(result.error, undefined);
    assert.deepEqual(result.body, fixture.safeCapture);
    assert.ok(result.body && typeof result.body === 'object');
    assert.deepEqual(Object.keys(result.body).sort(), ['fingerprint', 'provenance', 'reference']);
    assert.deepEqual(fixture.completionCalls, [{
      workspaceId: WORKSPACE_ID,
      intentId: INTENT_ID,
      completion,
    }]);
  });

  it('rejects prompt-scripted raw replacement input before completion service invocation', async () => {
    const fixture = routeFixture();
    const credential = ['rk', 'test', 'promptExtractedCredential123'].join('_');
    const result = await invokeHandler(
      createStripeRotationAuthenticationCompletionHandler(fixture.service, async () => true),
      { id: WORKSPACE_ID, bindingId: BINDING_ID, intentId: INTENT_ID },
      {
        intentDigest: fixture.intent.intentDigest,
        captureReceiptReference: fixture.safeCapture.provenance.captureReceiptReference,
        replacement: credential,
      },
    );

    assert.ok(result.error && typeof result.error === 'object' && 'statusCode' in result.error);
    assert.equal(result.error.statusCode, 400);
    assert.equal(JSON.stringify(result.error).includes(credential), false);
    assert.equal(fixture.completionCalls.length, 0);
  });

  it('advances only by immutable digest and returns secret-free persisted cutover state', async () => {
    const fixture = routeFixture();
    const result = await invokeHandler(
      createStripeCutoverAdvanceHandler(fixture.service, async () => true),
      { id: WORKSPACE_ID, bindingId: BINDING_ID, intentId: INTENT_ID },
      { intentDigest: fixture.intent.intentDigest },
    );

    assert.equal(result.error, undefined);
    assert.deepEqual(result.body, { cutover: fixture.cutoverState });
    assert.deepEqual(fixture.advanceCalls, [{
      workspaceId: WORKSPACE_ID,
      intentId: INTENT_ID,
      intentDigest: fixture.intent.intentDigest,
    }]);
    assert.doesNotMatch(JSON.stringify(result.body), /(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+/);
  });

  it('accepts signed revocation metadata but rejects any raw old credential field', async () => {
    const fixture = routeFixture();
    const evidence = {
      schemaVersion: 'rorca.stripe-dashboard-revocation-evidence.v1',
      evidenceId: '60000000-0000-4000-8000-000000000007',
      intentDigest: fixture.intent.intentDigest,
      workspaceId: WORKSPACE_ID,
      accountId: fixture.intent.accountId,
      mode: 'test',
      priorFingerprint: fixture.intent.currentFingerprint,
      dashboardSessionReference: 'stripe-dashboard-session://rorca/revocation-route',
      dashboardReauthenticatedAt: '2026-08-23T12:10:00.000Z',
      revokedAt: '2026-08-23T12:11:00.000Z',
      operatorId: 'operator:stripe-owner',
      attestationKeyId: 'stripe-dashboard-route-key',
      signature: 's'.repeat(64),
    };
    const handler = createStripeRevocationCompletionHandler(fixture.service, async () => true);
    const result = await invokeHandler(
      handler,
      { id: WORKSPACE_ID, bindingId: BINDING_ID, intentId: INTENT_ID },
      { intentDigest: fixture.intent.intentDigest, evidence },
    );

    assert.equal(result.error, undefined);
    assert.deepEqual(result.body, { cutover: fixture.cutoverState });
    assert.equal(fixture.revocationCalls.length, 1);

    const credential = ['rk', 'test', 'forbiddenOldCredential123'].join('_');
    const rejected = await invokeHandler(
      handler,
      { id: WORKSPACE_ID, bindingId: BINDING_ID, intentId: INTENT_ID },
      { intentDigest: fixture.intent.intentDigest, evidence, oldKey: credential },
    );
    assert.ok(rejected.error && typeof rejected.error === 'object' && 'statusCode' in rejected.error);
    assert.equal(rejected.error.statusCode, 400);
    assert.equal(JSON.stringify(rejected.error).includes(credential), false);
    assert.equal(fixture.revocationCalls.length, 1);
  });

  it('mounts mutation routes behind explicit local operator capability', () => {
    const fixture = routeFixture();
    const capability = 'operator-capability-fixture';
    const previousDigest = process.env.RORCA_OPERATOR_CAPABILITY_SHA256;
    const previousAuthRequired = process.env.AUTH_REQUIRED;
    process.env.RORCA_OPERATOR_CAPABILITY_SHA256 = createHash('sha256').update(capability).digest('hex');
    delete process.env.AUTH_REQUIRED;
    try {
      const router = createProviderBindingsRouter(
        new StripeAuthorityProviderAdapter(async () => []),
        async () => true,
        fixture.service,
      );
      // Express 4 does not publish route-stack types; this named assertion is
      // limited to verifying the mounted security middleware contract.
      const introspectableRouter = router as unknown as { stack: ExpressRouteLayer[] };
      const layers = introspectableRouter.stack;
      const mutationPaths = [
        '/:id/provider-bindings/:bindingId/rotation-intents',
        '/:id/provider-bindings/:bindingId/rotation-intents/:intentId/complete-authentication',
        '/:id/provider-bindings/:bindingId/rotation-intents/:intentId/advance-cutover',
        '/:id/provider-bindings/:bindingId/rotation-intents/:intentId/complete-revocation',
      ];
      for (const routePath of mutationPaths) {
        const mutationLayer = layers.find((layer) =>
          layer.route?.path === routePath && layer.route.methods.post);
        assert.ok(mutationLayer?.route);
        assert.equal(mutationLayer.route.stack[0]?.handle, requireLocalOperatorBoundary);
      }

      const operatorRequest = {
        user: {
          id: 'local-admin',
          email: 'admin@rorca.local',
          supabaseId: '00000000-0000-0000-0000-000000000001',
          role: 'admin',
          teamId: 'default',
          sessionId: 'rotation-route-test',
        },
        socket: { remoteAddress: '127.0.0.1' },
        headers: {},
      } as unknown as Request;
      assert.throws(
        () => requireLocalOperatorBoundary(operatorRequest, {} as Response, () => undefined),
        (error: unknown) => {
          assert.ok(error && typeof error === 'object' && 'statusCode' in error);
          return error.statusCode === 403;
        },
      );

      operatorRequest.headers['x-rorca-operator-capability'] = capability;
      let accepted = false;
      requireLocalOperatorBoundary(operatorRequest, {} as Response, (error?: unknown) => {
        assert.equal(error, undefined);
        accepted = true;
      });
      assert.equal(accepted, true);
    } finally {
      if (previousDigest === undefined) delete process.env.RORCA_OPERATOR_CAPABILITY_SHA256;
      else process.env.RORCA_OPERATOR_CAPABILITY_SHA256 = previousDigest;
      if (previousAuthRequired === undefined) delete process.env.AUTH_REQUIRED;
      else process.env.AUTH_REQUIRED = previousAuthRequired;
    }
  });
});
