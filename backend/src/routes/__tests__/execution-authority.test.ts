/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

jest.mock('../../lib/execution-authority-policy', () => {
  const actual = jest.requireActual('../../lib/execution-authority-policy');
  return {
    ...actual,
    cancelPolicyAuthorityRequest: jest.fn(),
    createPolicyAuthorityRequest: jest.fn(),
    decidePolicyAuthorityRequest: jest.fn(),
    getPolicyAuthorityRequest: jest.fn(),
    getPolicyExecutionReceipt: jest.fn(),
    listPolicyAuthorityRequests: jest.fn(),
    listPolicyExecutionReceipts: jest.fn(),
  };
});

import { AppError } from '../../lib/errors';
import {
  createPolicyAuthorityRequest,
  decidePolicyAuthorityRequest,
  listPolicyAuthorityRequests,
  getPolicyAuthorityRequest,
} from '../../lib/execution-authority-policy';
import executionAuthorityRouter from '../execution-authority';
import { swaggerSpec } from '../../lib/swagger';

const CAPABILITY = 'rea-002-local-operator-capability';
const REQUEST_ID = '10000000-0000-4000-8000-000000000001';
const INTENT_ID = '10000000-0000-4000-8000-000000000002';
const DIGEST = `sha256:${'a'.repeat(64)}`;

interface OpenApiDocument {
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
}

interface RouterLayer {
  handle: RequestHandler;
  route?: { path: string; stack: RouterLayer[] };
}

const routerStack = (executionAuthorityRouter as unknown as { stack: RouterLayer[] }).stack;

function routeLayer(path: string): RouterLayer {
  const layer = routerStack.find((candidate) => candidate.route?.path === path);
  if (!layer?.route) throw new Error(`Missing fixture route ${path}`);
  return layer;
}

function localRequest(input: {
  params?: Record<string, string>;
  body?: unknown;
  capability?: string;
  idempotencyKey?: string;
  authSource?: 'local-fallback' | 'internal' | 'bearer';
  id?: string;
  email?: string;
} = {}): Request {
  const headers: Record<string, string> = {};
  if (input.capability) headers['x-rorca-operator-capability'] = input.capability;
  if (input.idempotencyKey) headers['idempotency-key'] = input.idempotencyKey;
  return {
    params: input.params ?? {},
    body: input.body ?? {},
    query: {},
    headers,
    header(name: string) { return headers[name.toLowerCase()]; },
    user: {
      id: input.id ?? 'local-admin',
      email: input.email ?? 'local@localhost',
      supabaseId: input.id ?? 'local-admin',
      role: 'admin',
    },
    authSource: input.authSource ?? 'local-fallback',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request;
}

function invokeMiddleware(handler: RequestHandler, req: Request): unknown {
  let failure: unknown;
  try {
    handler(req, {} as Response, ((error?: unknown) => { failure = error; }) as NextFunction);
  } catch (error) {
    failure = error;
  }
  return failure;
}

async function invokeRoute(path: string, req: Request): Promise<{ status: number; body: unknown }> {
  let status = 200;
  let body: unknown;
  const response = {
    status(code: number) { status = code; return this; },
    json(value: unknown) { body = value; return this; },
  } as unknown as Response;
  const handler = routeLayer(path).route!.stack.at(-1)!.handle;
  await handler(req, response, (() => undefined) as NextFunction);
  return { status, body };
}

beforeAll(() => {
  process.env.AUTH_REQUIRED = 'false';
  process.env.RORCA_OPERATOR_CAPABILITY_SHA256 = crypto.createHash('sha256').update(CAPABILITY).digest('hex');
});

afterAll(() => {
  delete process.env.AUTH_REQUIRED;
  delete process.env.RORCA_OPERATOR_CAPABILITY_SHA256;
});

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(listPolicyAuthorityRequests).mockResolvedValue({ items: [], total: 0, hasMore: false });
  jest.mocked(getPolicyAuthorityRequest).mockResolvedValue({
    request: { storyId: 'OTHER-001' },
  } as never);
});

test('forged operator capability digest cannot approve without the operator preimage', () => {
  const layer = routeLayer('/workspaces/:workspaceId/requests/:requestId/approve');
  const failure = invokeMiddleware(layer.route!.stack[0].handle, localRequest({
    capability: process.env.RORCA_OPERATOR_CAPABILITY_SHA256,
  }));

  expect(failure).toBeInstanceOf(AppError);
  expect(failure).toMatchObject({ code: 'FORBIDDEN' });
  expect(decidePolicyAuthorityRequest).not.toHaveBeenCalled();
});

test('explicit local operator approval derives a distinct principal and forwards only the exact digest', async () => {
  jest.mocked(decidePolicyAuthorityRequest).mockResolvedValue({
    decision: {
      schemaVersion: 'rorca.execution-authority.v1',
      id: '10000000-0000-4000-8000-000000000003',
      workspaceId: 'workspace-1',
      requestId: REQUEST_ID,
      requestDigest: DIGEST,
      requestingPrincipal: 'execution:run-42:story-REA-002',
      operatorPrincipal: 'local-operator:local-admin',
      decision: 'approved',
      decisionDigest: `sha256:${'b'.repeat(64)}`,
      reasonCode: 'scope_reviewed',
      createdAt: '2026-08-23T10:00:00.000Z',
    },
    grant: null,
  });
  const req = localRequest({
    params: { workspaceId: 'workspace-1', requestId: REQUEST_ID },
    body: { requestDigest: DIGEST, reasonCode: 'scope_reviewed' },
    capability: CAPABILITY,
    idempotencyKey: 'approval-1',
  });
  const layer = routeLayer('/workspaces/:workspaceId/requests/:requestId/approve');

  expect(invokeMiddleware(layer.route!.stack[0].handle, req)).toBeUndefined();
  const response = await invokeRoute('/workspaces/:workspaceId/requests/:requestId/approve', req);

  expect(response.status).toBe(200);
  expect(decidePolicyAuthorityRequest).toHaveBeenCalledWith({
    workspaceId: 'workspace-1',
    requestId: REQUEST_ID,
    requestDigest: DIGEST,
    operatorPrincipal: 'local-operator:local-admin',
    decision: 'approved',
    reasonCode: 'scope_reviewed',
    idempotencyKey: 'approval-1',
  });
});

test('pending authority program cannot approve its own request', async () => {
  jest.mocked(getPolicyAuthorityRequest).mockResolvedValue({
    request: { storyId: 'REA-007' },
  } as never);
  const response = await invokeRoute('/workspaces/:workspaceId/requests/:requestId/approve', localRequest({
    params: { workspaceId: 'workspace-1', requestId: REQUEST_ID },
    body: { requestDigest: DIGEST, reasonCode: 'scope_reviewed' },
    capability: CAPABILITY,
    idempotencyKey: 'self-approval-1',
  }));

  expect(response.status).toBe(403);
  expect(response.body).toMatchObject({ code: 'FORBIDDEN' });
  expect(decidePolicyAuthorityRequest).not.toHaveBeenCalled();
});

test('strict request DTO rejects provider credential fields before policy persistence', async () => {
  const req = localRequest({
    params: { workspaceId: 'workspace-1' },
    body: {
      intentId: INTENT_ID,
      maximumUses: 1,
      expiresAt: '2026-08-24T10:00:00.000Z',
      credential: 'provider-secret-canary',
    },
    capability: CAPABILITY,
    idempotencyKey: 'request-1',
  });
  const response = await invokeRoute('/workspaces/:workspaceId/requests', req);

  expect(response.status).toBe(400);
  expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  expect(createPolicyAuthorityRequest).not.toHaveBeenCalled();
  expect(JSON.stringify(response.body)).not.toContain('provider-secret-canary');
});

test('authority API projection rejects a poisoned service result without returning the canary', async () => {
  const canary = 'rorca-secret_canary_7f42c9037e9abcde';
  jest.mocked(createPolicyAuthorityRequest).mockResolvedValue({
    credential: canary,
  } as never);
  const response = await invokeRoute('/workspaces/:workspaceId/requests', localRequest({
    params: { workspaceId: 'workspace-1' },
    body: {
      intentId: INTENT_ID,
      maximumUses: 1,
      expiresAt: '2026-08-24T10:00:00.000Z',
    },
    idempotencyKey: 'request-poison-1',
  }));

  expect(response.status).toBe(422);
  expect(response.body).toMatchObject({ code: 'AUTHORITY_BOUNDARY_NOT_REDACTED' });
  expect(JSON.stringify(response.body)).not.toContain(canary);
});

test('internal execution identity cannot inspect or decide through the operator resource', () => {
  const failure = invokeMiddleware(routerStack[0].handle, localRequest({
    id: 'rorca-internal-service',
    email: 'worker@rorca.internal',
    authSource: 'internal',
  }));

  expect(failure).toBeInstanceOf(AppError);
  expect(failure).toMatchObject({ code: 'FORBIDDEN' });
  expect(listPolicyAuthorityRequests).not.toHaveBeenCalled();
});

test('published OpenAPI has typed safe projections and admin rationale on every authority operation', () => {
  // swagger-jsdoc's return type is `object`; this trusted in-process document is
  // narrowed here so every operation is still checked before property access.
  const specification = swaggerSpec as OpenApiDocument;
  const paths = specification.paths ?? {};
  const authorityOperations: Array<Record<string, unknown>> = [];
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!path.startsWith('/api/admin/execution-authority/')) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)
        || !operation || typeof operation !== 'object' || Array.isArray(operation)) continue;
      const operationObject = operation as Record<string, unknown>;
      authorityOperations.push(operationObject);
    }
  }

  expect(authorityOperations).toHaveLength(11);
  for (const operation of authorityOperations) {
    expect(operation['x-rorca-tier']).toBe('admin');
    expect(operation['x-rorca-rationale']).toEqual(expect.any(String));
    expect(operation['x-rorca-mcp']).toBe(false);
    expect(operation['x-rorca-public-api']).toBeUndefined();
  }

  const schemas = specification.components?.schemas ?? {};
  for (const name of [
    'AuthorityRequestProjectionV1',
    'AuthorityDecisionProjectionV1',
    'AuthorityGrantProjectionV1',
    'ExecutionReceiptProjectionV1',
    'AuthorityFailureV1',
  ]) {
    expect(schemas[name]).toBeDefined();
  }
  const publicProjectionSchemas = JSON.stringify({
    request: schemas.AuthorityRequestProjectionV1,
    decision: schemas.AuthorityDecisionProjectionV1,
    grant: schemas.AuthorityGrantProjectionV1,
    receipt: schemas.ExecutionReceiptProjectionV1,
  });
  expect(publicProjectionSchemas).not.toContain('secretReference');
  expect(publicProjectionSchemas).not.toContain('secretFingerprint');
  expect(publicProjectionSchemas).not.toContain('credential');
});
