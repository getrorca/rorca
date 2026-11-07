/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import type { Server } from 'http';
import request from 'supertest';
import {
  PROVIDER_MUTATION_ROUTES,
  providerMutationApiTemplate,
  type ProviderMutationRoute,
} from '../../../../shared/contracts/provider-mutation-routes';

const query = jest.fn();
const queryOne = jest.fn();
const execute = jest.fn();
const transaction = jest.fn();
const resolveWorkspaceGitHubToken = jest.fn();
const storeOAuthToken = jest.fn();
const revokeToken = jest.fn();
const markTokenValidated = jest.fn();
const getIntegrationSecret = jest.fn();
const insertPreparedIntegrationSecret = jest.fn();
const prepareIntegrationSecret = jest.fn();
const fetchMock = jest.fn();
const originalFetch = global.fetch;

jest.mock('../../db/index', () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  execute: (...args: unknown[]) => execute(...args),
  transaction: (...args: unknown[]) => transaction(...args),
}));

jest.mock('../../lib/github-token-resolver', () => ({
  resolveWorkspaceGitHubToken: (...args: unknown[]) => resolveWorkspaceGitHubToken(...args),
}));

jest.mock('../../lib/integration-vault', () => ({
  storeOAuthToken: (...args: unknown[]) => storeOAuthToken(...args),
  revokeToken: (...args: unknown[]) => revokeToken(...args),
  markTokenValidated: (...args: unknown[]) => markTokenValidated(...args),
  getIntegrationSecret: (...args: unknown[]) => getIntegrationSecret(...args),
  insertPreparedIntegrationSecret: (...args: unknown[]) => insertPreparedIntegrationSecret(...args),
  prepareIntegrationSecret: (...args: unknown[]) => prepareIntegrationSecret(...args),
}));

import workspaceGithubRouter from '../workspace-github';
import workspaceGithubAppRouter from '../workspace-github-app';
import deliveryGovernanceRouter from '../delivery-governance';
import githubChecksRouter from '../github-checks';
import { webhookAdminRouter } from '../webhooks';
import { errorHandler } from '../../lib/error-handler';

const SAMPLE_SHA = 'a'.repeat(40);

function canonicalPath(route: ProviderMutationRoute): string {
  const template = providerMutationApiTemplate(route);
  if (route.routerModule === 'webhooks') return template.replace(':id', '17');
  return template
    .replace(':id', 'ws-1')
    .replace(':policyId', 'policy-1')
    .replace(':sha', SAMPLE_SHA);
}

function mixedCasePath(pathname: string): string {
  if (pathname.includes('/github')) return pathname.replace('/github', '/GITHUB');
  if (pathname.includes('/checks')) return pathname.replace('/checks', '/CHECKS');
  return pathname.replace('/dlq', '/DLQ');
}

function encodedStaticPath(pathname: string): string {
  if (pathname.includes('/github')) return pathname.replace('/github', '/%67ithub');
  if (pathname.includes('/checks')) return pathname.replace('/checks', '/%63hecks');
  return pathname.replace('/dlq', '/%64lq');
}

function doubleSlashPath(pathname: string): string {
  if (pathname.includes('/github')) return pathname.replace('/github', '//github');
  if (pathname.includes('/checks')) return pathname.replace('/checks', '//checks');
  return pathname.replace('/dlq', '//dlq');
}

function encodedParameterPath(route: ProviderMutationRoute, pathname: string): string {
  if (route.routerModule === 'github-checks') return pathname.replace(SAMPLE_SHA, `%61${'a'.repeat(39)}`);
  if (route.routerModule === 'webhooks') return pathname.replace('/17/', '/%31%37/');
  return pathname.replace('/ws-1/', '/ws%2D1/');
}

function malformedPath(route: ProviderMutationRoute, pathname: string): string {
  if (route.routerModule === 'github-checks') return pathname.replace(SAMPLE_SHA, '%ZZ');
  if (route.routerModule === 'webhooks') return pathname.replace('/17/', '/%ZZ/');
  return pathname.replace('/ws-1/', '/%ZZ/');
}

function boundaryApp() {
  const app = express();
  app.enable('case sensitive routing');
  app.enable('strict routing');
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: 'local-admin',
      email: 'admin@rorca.local',
      supabaseId: '00000000-0000-0000-0000-000000000001',
      role: 'admin',
      plan: 'pro',
    };
    next();
  });
  app.use('/api/workspaces', workspaceGithubRouter);
  app.use('/api/workspaces', workspaceGithubAppRouter);
  app.use('/api/workspaces', deliveryGovernanceRouter);
  app.use('/api/github/checks', githubChecksRouter);
  app.use('/api/webhooks', webhookAdminRouter);
  app.use(errorHandler);
  return app;
}

let app: Server;

async function call(pathname: string, method: ProviderMutationRoute['method']) {
  const operation = method === 'DELETE' ? request(app).delete(pathname) : request(app).post(pathname);
  return operation.send({ workspaceId: 'ws-1' });
}

beforeAll(async () => {
  app = await new Promise<Server>((resolve, reject) => {
    const listener = boundaryApp().listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.AUTH_REQUIRED;
  delete process.env.RORCA_OPERATOR_CAPABILITY_SHA256;
  global.fetch = fetchMock as typeof fetch;
});

afterAll(async () => {
  app.closeAllConnections();
  await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
  delete process.env.AUTH_REQUIRED;
  delete process.env.RORCA_OPERATOR_CAPABILITY_SHA256;
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

function expectNoPreGuardEffects(): void {
  expect(query).not.toHaveBeenCalled();
  expect(queryOne).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  expect(transaction).not.toHaveBeenCalled();
  expect(resolveWorkspaceGitHubToken).not.toHaveBeenCalled();
  expect(storeOAuthToken).not.toHaveBeenCalled();
  expect(revokeToken).not.toHaveBeenCalled();
  expect(markTokenValidated).not.toHaveBeenCalled();
  expect(getIntegrationSecret).not.toHaveBeenCalled();
  expect(insertPreparedIntegrationSecret).not.toHaveBeenCalled();
  expect(prepareIntegrationSecret).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
}

test('read-only diagnostics, local previews, and inert compatibility remain capability-free', async () => {
  const probes = [
    request(app).get('/api/workspaces/ws-1/github'),
    request(app).get('/api/workspaces/ws-1/github/account'),
    request(app).get('/api/workspaces/ws-1/github/app'),
    request(app).post('/api/workspaces/ws-1/github/test-connection'),
    request(app).post('/api/workspaces/ws-1/github/pr-template-preview'),
    request(app).post('/api/workspaces/ws-1/github/dispatch'),
  ];
  for (const probe of probes) {
    const response = await probe.send({});
    expect(response.status).not.toBe(503);
  }
});

test('every canonical Express mutation, including exact OAuth disconnect, reaches the route-local guard first', async () => {
  for (const route of PROVIDER_MUTATION_ROUTES) {
    const response = await call(canonicalPath(route), route.method);
    expect({ route: route.id, status: response.status }).toEqual({ route: route.id, status: 503 });
    expect(response.body.error).toMatch(/disabled in local mode/i);
  }
  expectNoPreGuardEffects();
});

test('strict authority routers reject optional trailing slash, mixed case, encoded static, and duplicate slash variants', async () => {
  for (const route of PROVIDER_MUTATION_ROUTES) {
    const canonical = canonicalPath(route);
    for (const variant of [
      `${canonical}/`,
      mixedCasePath(canonical),
      encodedStaticPath(canonical),
    ]) {
      const response = await call(variant, route.method);
      expect({ route: route.id, variant, status: response.status }).toEqual({ route: route.id, variant, status: 404 });
    }

    const duplicateSlash = doubleSlashPath(canonical);
    const duplicateResponse = await call(duplicateSlash, route.method);
    expect([404, 503]).toContain(duplicateResponse.status);
    if (duplicateResponse.status === 503) {
      expect(duplicateResponse.body.error).toMatch(/disabled in local mode/i);
    }
  }
  expectNoPreGuardEffects();
});

test('encoded parameters still cross the guard while malformed encodings are rejected before effects', async () => {
  for (const route of PROVIDER_MUTATION_ROUTES) {
    const canonical = canonicalPath(route);
    const encoded = await call(encodedParameterPath(route, canonical), route.method);
    expect([400, 404, 503]).toContain(encoded.status);
    if (encoded.status === 503) {
      expect(encoded.body.error).toMatch(/disabled in local mode/i);
    }

    const malformed = await call(malformedPath(route, canonical), route.method);
    expect([400, 404]).toContain(malformed.status);
  }
  expectNoPreGuardEffects();
});
