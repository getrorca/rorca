/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type NextFunction, type Request, type Response } from 'express';
import { AppError } from '../../lib/errors';
import { StripeAuthorityProviderAdapter, type StripeBindingReader } from '../../lib/stripe-authority-provider-adapter';
import { createProviderBindingsInventoryHandler } from '../stripe-credential-ceremonies';

const WORKSPACE_ID = 'workspace-stripe-route';
const rows = [
  {
    id: '20000000-0000-4000-8000-000000000001',
    workspace_id: WORKSPACE_ID,
    provider_account_id: 'acct_rorca_fixture',
    mode: 'test' as const,
    application_id: 'rorca-fixture',
    resource_type: 'payment_intents',
    resource_id: 'disposable-target',
    credential_class: 'restricted_api_key' as const,
    key_kind: 'restricted' as const,
    permission_manifest: ['payment_intents.read'],
    owner: 'rorca-operator',
    fingerprint: `sha256:${'e'.repeat(64)}`,
    secret_store_reference: 'secret-store://rorca/stripe-route-test',
    target_binding_reference: 'runtime-binding://rorca/stripe-route-test',
    status: 'active' as const,
    binding_generation: 1,
    last_verified_at: new Date('2026-08-21T10:00:00.000Z'),
  },
  {
    id: '20000000-0000-4000-8000-000000000002',
    workspace_id: WORKSPACE_ID,
    provider_account_id: 'acct_rorca_fixture',
    mode: 'live' as const,
    application_id: 'rorca-fixture',
    resource_type: 'webhook_endpoints',
    resource_id: 'disposable-endpoint',
    credential_class: 'webhook_signing_secret' as const,
    key_kind: 'signing_secret' as const,
    permission_manifest: ['webhook.signature.verify'],
    owner: 'rorca-operator',
    fingerprint: `sha256:${'f'.repeat(64)}`,
    secret_store_reference: 'secret-store://rorca/stripe-route-live',
    target_binding_reference: 'runtime-binding://rorca/stripe-route-live',
    status: 'staged' as const,
    binding_generation: 2,
    last_verified_at: null,
  },
];

interface InventoryResponse {
  provider: string;
  workspaceId: string;
  mode: 'test' | 'live' | null;
  total: number;
  hasMore: boolean;
  cursor?: string;
  items: Array<{ mode: 'test' | 'live'; credentialClass: string }>;
}

async function invoke(
  query: Record<string, string> = {},
  workspaceReader: (workspaceId: string) => Promise<boolean> = async (workspaceId) => workspaceId === WORKSPACE_ID,
): Promise<{ body?: InventoryResponse; error?: unknown }> {
  const reader: StripeBindingReader = async (workspaceId) => workspaceId === WORKSPACE_ID ? rows : [];
  const handler = createProviderBindingsInventoryHandler(
    new StripeAuthorityProviderAdapter(reader),
    workspaceReader,
  );
  let body: InventoryResponse | undefined;
  let forwardedError: unknown;
  const response = {
    json(value: InventoryResponse) {
      body = value;
      return response;
    },
  };
  const next: NextFunction = (error?: unknown) => {
    forwardedError = error;
  };
  await handler(
    { params: { id: WORKSPACE_ID }, query } as unknown as Request,
    response as unknown as Response,
    next,
  );
  return { body, error: forwardedError };
}

describe('GET /api/workspaces/:id/provider-bindings', () => {
  it('returns all modes and credential classes as secret-free metadata by default', async () => {
    const { body, error } = await invoke();

    assert.equal(error, undefined);
    assert.ok(body);
    assert.equal(body.provider, 'stripe');
    assert.equal(body.mode, null);
    assert.equal(body.total, 2);
    assert.equal(body.hasMore, false);
    assert.deepEqual(body.items.map((binding) => binding.credentialClass), [
      'restricted_api_key',
      'webhook_signing_secret',
    ]);
    assert.doesNotMatch(JSON.stringify(body), /(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/);
  });

  it('filters by exact mode without fallback', async () => {
    const { body, error } = await invoke({ mode: 'live' });
    assert.equal(error, undefined);
    assert.ok(body);
    assert.equal(body.total, 1);
    assert.equal(body.items[0].mode, 'live');
    assert.equal(body.items[0].credentialClass, 'webhook_signing_secret');
  });

  it('bounds inventory pages through the canonical cursor contract', async () => {
    const { body, error } = await invoke({ limit: '1' });
    assert.equal(error, undefined);
    assert.ok(body);
    assert.equal(body.items.length, 1);
    assert.equal(body.total, 2);
    assert.equal(body.hasMore, true);
    assert.equal(typeof body.cursor, 'string');
  });

  it('reports invalid modes and absent workspaces through typed API errors', async () => {
    const invalid = await invoke({ mode: 'production' });
    assert.ok(invalid.error instanceof AppError);
    assert.equal(invalid.error.statusCode, 400);
    assert.equal(invalid.error.code, 'VALIDATION_ERROR');

    const absent = await invoke({}, async () => false);
    assert.ok(absent.error instanceof AppError);
    assert.equal(absent.error.statusCode, 404);
    assert.equal(absent.error.code, 'NOT_FOUND');
  });
});
