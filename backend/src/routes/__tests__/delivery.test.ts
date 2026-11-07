/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { authRequired, LOCAL_ADMIN } from '../../lib/auth-utils';
import { csrfProtection } from '../../lib/csrf';

jest.unmock('../../lib/auth-utils');
jest.unmock('../../lib/csrf');

const createMock = jest.fn();
const getMock = jest.fn();
const listMock = jest.fn();
const queryOneMock = jest.fn();

jest.mock('../../db/index', () => ({ queryOne: (...args: unknown[]) => queryOneMock(...args) }));

jest.mock('../../lib/local-review-bundle-adapter', () => ({
  LocalReviewBundleAdapter: jest.fn().mockImplementation(() => ({ create: createMock })),
  getLocalReviewBundle: (...args: unknown[]) => getMock(...args),
  listLocalReviewBundles: (...args: unknown[]) => listMock(...args),
}));

import router from '../delivery';

function appFor(user: Request['user'] = LOCAL_ADMIN, withCsrf = false) {
  const app = express();
  app.use(express.json());
  if (withCsrf) app.use(csrfProtection);
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/delivery', router);
  app.use((error: { statusCode?: number; message?: string; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: error.message, code: error.code });
  });
  return app;
}

function productionComposedApp() {
  const app = express();
  app.use(express.json());
  app.use(authRequired);
  app.use(csrfProtection);
  app.use('/api/delivery', router);
  app.use((error: { statusCode?: number; message?: string; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: error.message, code: error.code });
  });
  return app;
}

const originalAuthRequired = process.env.AUTH_REQUIRED;

beforeEach(() => jest.clearAllMocks());
afterEach(() => {
  if (originalAuthRequired === undefined) delete process.env.AUTH_REQUIRED;
  else process.env.AUTH_REQUIRED = originalAuthRequired;
});

test('adapter catalog declares local default and optional GitHub without credential or network lookup', async () => {
  const response = await request(appFor()).get('/api/delivery/adapters');
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    contractVersion: 'rorca.delivery-adapter.v1',
    defaultAdapterId: 'local-review-bundle',
  });
  expect(response.body.adapters).toEqual(expect.arrayContaining([
    expect.objectContaining({ adapterId: 'local-review-bundle', default: true, requiresNetwork: false, requiresCredentials: false }),
    expect.objectContaining({ adapterId: 'github-app', optional: true, default: false }),
  ]));
  expect(getMock).not.toHaveBeenCalled();
  expect(listMock).not.toHaveBeenCalled();
  expect(createMock).not.toHaveBeenCalled();
});

test('safe list and detail forward only exact workspace-scoped identities', async () => {
  listMock.mockResolvedValue({ schemaVersion: 'rorca.local-review-bundle-read.v1', items: [], limit: 20 });
  getMock.mockResolvedValue({
    schemaVersion: 'rorca.local-review-bundle-read.v1',
    bundleId: `lrb-${'a'.repeat(64)}`,
    projectionIntegrity: 'verified',
    delivery: { mergeStatus: 'not_authorized', deploymentStatus: 'not_authorized' },
  });
  const listed = await request(appFor()).get('/api/delivery/review-bundles')
    .query({ workspaceId: 'workspace-one', runId: '42', limit: '5' });
  expect(listed.status).toBe(200);
  expect(listMock).toHaveBeenCalledWith({ workspaceId: 'workspace-one', runId: 42, limit: 5 });

  const detail = await request(appFor()).get(`/api/delivery/review-bundles/lrb-${'a'.repeat(64)}`)
    .query({ workspaceId: 'workspace-one', runId: '42' });
  expect(detail.status).toBe(200);
  expect(getMock).toHaveBeenCalledWith({ workspaceId: 'workspace-one', runId: 42, bundleId: `lrb-${'a'.repeat(64)}` });
  expect(JSON.stringify(detail.body)).not.toMatch(/worktreeRealpath|transcript|credential|patchBytes/);
});

test('rejects protected runs and invalid limits before downstream delivery queries', async () => {
  const protectedList = await request(appFor()).get('/api/delivery/review-bundles')
    .query({ workspaceId: 'workspace-one', runId: '20260316000549' });
  expect(protectedList.status).toBe(409);
  const protectedDetail = await request(appFor()).get(`/api/delivery/review-bundles/lrb-${'a'.repeat(64)}`)
    .query({ workspaceId: 'workspace-one', runId: '20260316000549' });
  expect(protectedDetail.status).toBe(409);
  const protectedCreate = await request(appFor()).post('/api/delivery/review-bundles')
    .set('Idempotency-Key', 'review:protected:exact')
    .send({
      workspaceId: 'workspace-one', runId: 20260316000549, storyId: 'US-001', attempt: 1,
      generation: '22222222-2222-4222-8222-222222222222',
      hostAttemptEnvelopeId: '11111111-1111-4111-8111-111111111111',
    });
  expect(protectedCreate.status).toBe(409);
  expect(listMock).not.toHaveBeenCalled();
  expect(getMock).not.toHaveBeenCalled();
  expect(createMock).not.toHaveBeenCalled();

  for (const limit of ['0', '101', '1.5', 'not-a-number']) {
    const invalid = await request(appFor()).get('/api/delivery/review-bundles')
      .query({ workspaceId: 'workspace-one', limit });
    expect(invalid.status).toBe(400);
  }
  expect(listMock).not.toHaveBeenCalled();
});

test('creation is human-admin authorized, idempotent, and rejects caller-authored authority fields', async () => {
  const app = appFor();
  createMock.mockResolvedValue({
    manifest: {
      schemaVersion: 'rorca.local-review-bundle.v1', bundleId: `lrb-${'b'.repeat(64)}`,
      contentHash: `sha256:${'b'.repeat(64)}`, validation: { status: 'blocked' },
      delivery: {
        reviewStatus: 'awaiting_local_review', mergeStatus: 'not_authorized', deploymentStatus: 'not_authorized',
        mergeAuthority: 'none', deploymentAuthority: 'none',
      },
    },
    manifestHash: `sha256:${'c'.repeat(64)}`,
    projectionKey: `sha256/bb/${'b'.repeat(64)}`,
    replayed: false,
  });
  const created = await request(app)
    .post('/api/delivery/review-bundles')
    .set('Idempotency-Key', 'review:workspace-one:42:US-001')
    .send({
      workspaceId: 'workspace-one', runId: 42, storyId: 'US-001', attempt: 1,
      generation: '22222222-2222-4222-8222-222222222222',
      hostAttemptEnvelopeId: '11111111-1111-4111-8111-111111111111',
    });
  expect(created.status).toBe(201);
  expect(createMock).toHaveBeenCalledWith({
    workspaceId: 'workspace-one', runId: 42, storyId: 'US-001', attempt: 1,
    generation: '22222222-2222-4222-8222-222222222222',
    hostAttemptEnvelopeId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: 'review:workspace-one:42:US-001', requestedBy: LOCAL_ADMIN.id,
  });
  expect(created.body.delivery).toMatchObject({ mergeAuthority: 'none', deploymentAuthority: 'none' });

  const fabricatedPass = await request(app)
    .post('/api/delivery/review-bundles')
    .set('Idempotency-Key', 'review:workspace-one:42:US-001')
    .send({
      workspaceId: 'workspace-one', runId: 42, storyId: 'US-001', attempt: 1,
      generation: '22222222-2222-4222-8222-222222222222',
      hostAttemptEnvelopeId: '11111111-1111-4111-8111-111111111111', validationStatus: 'passed',
    });
  expect(fabricatedPass.status).toBe(400);
  expect(createMock).toHaveBeenCalledTimes(1);
});

test('browser creation crosses the real CSRF boundary before adapter invocation', async () => {
  const body = {
    workspaceId: 'workspace-one', runId: 42, storyId: 'US-001', attempt: 1,
    generation: '22222222-2222-4222-8222-222222222222',
    hostAttemptEnvelopeId: '11111111-1111-4111-8111-111111111111',
  };
  const rejected = await request(appFor(LOCAL_ADMIN, true)).post('/api/delivery/review-bundles')
    .set('Origin', 'http://localhost:5210')
    .set('Idempotency-Key', 'review:workspace-one:42:csrf')
    .send(body);
  expect(rejected.status).toBe(403);
  expect(createMock).not.toHaveBeenCalled();

  createMock.mockResolvedValue({
    manifest: {
      schemaVersion: 'rorca.local-review-bundle.v1', bundleId: `lrb-${'a'.repeat(64)}`,
      contentHash: `sha256:${'a'.repeat(64)}`, validation: { status: 'blocked' },
      delivery: { mergeAuthority: 'none', deploymentAuthority: 'none' },
    },
    manifestHash: `sha256:${'b'.repeat(64)}`, projectionKey: `sha256/aa/${'a'.repeat(64)}`, replayed: false,
  });
  const accepted = await request(appFor(LOCAL_ADMIN, true)).post('/api/delivery/review-bundles')
    .set('Origin', 'http://localhost:5210')
    .set('Cookie', '_csrf=exact-test-token')
    .set('X-CSRF-Token', 'exact-test-token')
    .set('Idempotency-Key', 'review:workspace-one:42:csrf')
    .send(body);
  expect(accepted.status).toBe(201);
  expect(createMock).toHaveBeenCalledTimes(1);
});

test('bounds workspace query identity before a hosted membership lookup', async () => {
  const hostedMember = {
    id: 'hosted-member', email: 'member@example.test', supabaseId: 'member-auth', role: 'user',
  };
  const malformed = await request(appFor(hostedMember)).get('/api/delivery/review-bundles')
    .query({ workspaceId: 'bad workspace' });
  expect(malformed.status).toBe(400);
  const oversized = await request(appFor(hostedMember)).get('/api/delivery/review-bundles')
    .query({ workspaceId: `w${'x'.repeat(256)}` });
  expect(oversized.status).toBe(400);
  expect(queryOneMock).not.toHaveBeenCalled();

  queryOneMock.mockResolvedValueOnce(undefined);
  const nonMember = await request(appFor(hostedMember)).get('/api/delivery/review-bundles')
    .query({ workspaceId: 'workspace-one' });
  expect(nonMember.status).toBe(403);
  expect(queryOneMock).toHaveBeenCalledTimes(1);
  expect(listMock).not.toHaveBeenCalled();
});

test('production-composed auth and CSRF allow local human creation and disable hosted creation', async () => {
  const body = {
    workspaceId: 'workspace-one', runId: 42, storyId: 'US-001', attempt: 1,
    generation: '22222222-2222-4222-8222-222222222222',
    hostAttemptEnvelopeId: '11111111-1111-4111-8111-111111111111',
  };
  createMock.mockResolvedValue({
    manifest: {
      schemaVersion: 'rorca.local-review-bundle.v1', bundleId: `lrb-${'a'.repeat(64)}`,
      contentHash: `sha256:${'a'.repeat(64)}`, validation: { status: 'blocked' },
      delivery: { mergeAuthority: 'none', deploymentAuthority: 'none' },
    },
    manifestHash: `sha256:${'b'.repeat(64)}`, projectionKey: `sha256/aa/${'a'.repeat(64)}`, replayed: false,
  });
  delete process.env.AUTH_REQUIRED;
  const local = await request(productionComposedApp()).post('/api/delivery/review-bundles')
    .set('Origin', 'http://localhost:5210')
    .set('Cookie', '_csrf=exact-test-token')
    .set('X-CSRF-Token', 'exact-test-token')
    .set('Idempotency-Key', 'review:workspace-one:42:composed')
    .send(body);
  expect(local.status).toBe(201);
  expect(createMock).toHaveBeenCalledTimes(1);

  process.env.AUTH_REQUIRED = 'true';
  const hosted = await request(productionComposedApp()).post('/api/delivery/review-bundles')
    .set('Authorization', 'Bearer unsupported-hosted-human-token')
    .set('Origin', 'http://localhost:5210')
    .set('Cookie', '_csrf=exact-test-token')
    .set('X-CSRF-Token', 'exact-test-token')
    .set('Idempotency-Key', 'review:workspace-one:42:hosted')
    .send(body);
  expect(hosted.status).toBe(401);
  expect(queryOneMock).not.toHaveBeenCalled();
  expect(createMock).toHaveBeenCalledTimes(1);

  const oversizedToken = await request(productionComposedApp()).post('/api/delivery/review-bundles')
    .set('Authorization', `Bearer ${'x'.repeat(8193)}`)
    .set('Origin', 'http://localhost:5210')
    .set('Cookie', '_csrf=exact-test-token')
    .set('X-CSRF-Token', 'exact-test-token')
    .set('Idempotency-Key', 'review:workspace-one:42:oversized-token')
    .send(body);
  expect(oversizedToken.status).toBe(401);
  expect(queryOneMock).not.toHaveBeenCalled();
});

test('internal services cannot cross the local bundle creation authority boundary', async () => {
  const response = await request(appFor({
    id: 'rorca-internal-service', email: 'scheduler@rorca.internal',
    supabaseId: '00000000-0000-0000-0000-000000000000', role: 'admin',
  }))
    .post('/api/delivery/review-bundles')
    .set('Idempotency-Key', 'review:workspace-one:42:US-001')
    .send({
      workspaceId: 'workspace-one', runId: 42, storyId: 'US-001', attempt: 1,
      generation: '22222222-2222-4222-8222-222222222222',
      hostAttemptEnvelopeId: '11111111-1111-4111-8111-111111111111',
    });
  expect(response.status).toBe(403);
  expect(createMock).not.toHaveBeenCalled();
});
