/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { authRequired } from '../auth-utils';
import { declareHermesAuthority, hermesAuthorityHeaders } from '../hermes-authority';

const MCP_TOKEN = 'm'.repeat(64);

jest.mock('../mcp-auth', () => ({
  getMcpPublicToken: jest.fn(() => MCP_TOKEN),
  getMcpAdminToken: jest.fn(() => 'a'.repeat(64)),
}));

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use(authRequired);
  instance.all('*', (req, res) => res.json({
    userId: req.user?.id,
    email: req.user?.email,
    campaignServiceAuth: req.campaignServiceAuth ?? null,
  }));
  return instance;
}

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.AUTH_REQUIRED = 'false';
});

afterAll(() => {
  delete process.env.AUTH_REQUIRED;
});

test.each([
  '/api/recall?workspaceId=ws-1',
  '/api/lifecycle/decisions/state?workspaceId=ws-1',
  '/api/workspaces/ws-1/github/app',
  '/api/pipeline/runs?workspaceId=ws-1',
  '/api/pipeline/runs/42',
  '/api/pipeline/runs/42/liveness?storyId=ROR-29',
])('accepts MCP bearer only on exact campaign read projection %s', async (route) => {
  const response = await request(app())
    .get(route)
    .set('Authorization', `Bearer ${MCP_TOKEN}`)
    .set(hermesAuthorityHeaders(declareHermesAuthority('subscription', 'service-audit')));
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    userId: 'rorca-hermes-service',
    email: 'hermes@rorca.internal',
    campaignServiceAuth: 'mcp-public',
  });
});

test('accepts MCP bearer on trigger only when strict campaign member is present', async () => {
  const accepted = await request(app())
    .post('/api/pipeline/trigger')
    .set('Authorization', `Bearer ${MCP_TOKEN}`)
    .set(hermesAuthorityHeaders(declareHermesAuthority('dispatch', 'operator-dispatch')))
    .send({ dispatchAuthorization: { schemaVersion: 'hermes.campaign-dispatch-authorization.v1' } });
  expect(accepted.status).toBe(200);
  expect(accepted.body.campaignServiceAuth).toBe('mcp-public');

  const denied = await request(app())
    .post('/api/pipeline/trigger')
    .set('Authorization', `Bearer ${MCP_TOKEN}`)
    .send({ workspaceId: 'ws-1' });
  expect(denied.status).toBe(401);
});

test('denies a campaign projection with no Hermes authority declaration', async () => {
  const response = await request(app())
    .get('/api/pipeline/runs?workspaceId=ws-1')
    .set('Authorization', `Bearer ${MCP_TOKEN}`);
  expect(response.status).toBe(403);
  expect(response.body.code).toBe('HERMES_AUTHORITY_DENIED');
});

test.each([
  '/api/users/me',
  '/api/pipeline/campaigns/campaign-1/pause',
  '/api//pipeline/runs/42',
  '/api/pipeline/runs%2f42',
  '/api/workspaces/ws-1/github/app/setup/start',
])('never broadens MCP bearer into general API admin authority: %s', async (route) => {
  const response = route.endsWith('/pause')
    ? await request(app()).post(route).set('Authorization', `Bearer ${MCP_TOKEN}`).send({})
    : await request(app()).get(route).set('Authorization', `Bearer ${MCP_TOKEN}`);
  expect(response.status).toBe(401);
});

test('ordinary credential-free local single-user semantics remain unchanged', async () => {
  const response = await request(app()).post('/api/pipeline/trigger').send({ workspaceId: 'ws-1' });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ userId: 'local-admin', campaignServiceAuth: null });
});
