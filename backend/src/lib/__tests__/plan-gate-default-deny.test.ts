/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { getEffectiveUser } from '../get-user';
import { planGate } from '../plan-gate';
import { swaggerSpec } from '../swagger';
import type { AuthUser } from '../auth-utils';

jest.mock('../get-user', () => ({
  getEffectiveUser: jest.fn(),
}));

const localAdmin: AuthUser = {
  id: 'local-admin',
  email: 'local@rorca.internal',
  supabaseId: '00000000-0000-0000-0000-000000000001',
  role: 'admin',
  plan: 'enterprise',
};
const ordinaryUser: AuthUser = {
  id: 'ordinary-user',
  email: 'ordinary@example.test',
  supabaseId: '10000000-0000-4000-8000-000000000001',
  role: 'user',
  plan: 'enterprise',
};
const hermesService: AuthUser = {
  id: 'rorca-hermes-service',
  email: 'hermes@rorca.internal',
  supabaseId: '00000000-0000-0000-0000-000000000002',
  role: 'admin',
};

const mockGetEffectiveUser = jest.mocked(getEffectiveUser);

function gatedApp(user: AuthUser = localAdmin) {
  const app = express();
  app.use(((req, _res, next) => {
    req.user = user;
    next();
  }) as RequestHandler);
  app.use(planGate());
  app.use((_req, res) => res.status(204).end());
  return app;
}

function concretePath(openApiPath: string): string {
  return openApiPath.replace(/\{[^/]+\}/g, 'fixture');
}

async function invokePlanGate(method: string, path: string, user: AuthUser): Promise<{ status: number; body: unknown }> {
  const middleware = planGate();
  let status = 204;
  let body: unknown;
  let nextError: unknown;
  const response = {
    status(code: number) {
      status = code;
      return response;
    },
    json(value: unknown) {
      body = value;
      return response;
    },
  };

  await middleware(
    { method: method.toUpperCase(), path, headers: {}, user } as any,
    response as any,
    (error?: unknown) => { nextError = error; },
  );
  if (nextError) throw nextError;
  return { status, body };
}

const mutatingNativeOperations = Object.entries((swaggerSpec as any).paths ?? {}).flatMap(([openApiPath, operations]) =>
  Object.entries(operations as Record<string, Record<string, unknown>>)
    .filter(([method, operation]) => ['post', 'put', 'patch', 'delete'].includes(method)
      && operation?.['x-rorca-native-api'] === true)
    .map(([method]) => ({ method, path: concretePath(openApiPath) }))
);

beforeEach(() => {
  mockGetEffectiveUser.mockImplementation(async (req) => (req.user as AuthUser | undefined) ?? null);
});

describe('planGate exact OpenAPI default-deny', () => {
  test('passes an exact public operation to its protected router', async () => {
    const response = await request(gatedApp()).get('/api/workspaces');
    expect(response.status).toBe(204);
  });

  test('passes an exact admin operation for the local admin principal', async () => {
    const response = await request(gatedApp()).get('/api/pipeline/runs/42/context-inspector-events');
    expect(response.status).toBe(204);
  });

  test('passes an explicitly classified native operation to its route-level authority', async () => {
    const response = await request(gatedApp()).post('/api/workspaces');
    expect(response.status).toBe(204);
  });

  test.each([
    ['POST', '/api/workspaces/fixture/env-vars'],
    ['POST', '/api/skills/install'],
    ['POST', '/api/skills/install-from-sh'],
    ['POST', '/api/skills/install-from-github'],
  ])('keeps shipped native UI operation reachable for a local administrator: %s %s', async (method, path) => {
    const response = await (request(gatedApp()) as any)[method.toLowerCase()](path);
    expect(response.status).toBe(204);
  });

  test.each([
    ['ordinary authenticated human', ordinaryUser],
    ['Hermes internal service', hermesService],
  ])('denies %s authority over every mutating native operation', async (_label, user) => {
    expect(mutatingNativeOperations.length).toBeGreaterThan(0);
    const escaped: string[] = [];
    for (const operation of mutatingNativeOperations) {
      const response = await invokePlanGate(operation.method, operation.path, user);
      if (response.status !== 403) {
        escaped.push(`${operation.method.toUpperCase()} ${operation.path}: ${response.status} ${JSON.stringify(response.body)}`);
      }
    }
    expect(escaped).toEqual([]);
  });

  test('denies an explicitly classified sensitive operation', async () => {
    const response = await request(gatedApp()).get('/api/auth/me');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Not found' });
  });

  test('denies an unmatched protected method/path instead of falling through', async () => {
    const response = await request(gatedApp()).post('/api/pipeline/not-a-real-operation');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Not found' });
  });
});
