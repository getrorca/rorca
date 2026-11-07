/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../lib/error-handler';

const preview = jest.fn();
const run = jest.fn();
const list = jest.fn();
const adminGate = jest.fn((req: express.Request, res: express.Response, next: express.NextFunction) => {
  const workspaceId = typeof req.query.workspaceId === 'string'
    ? req.query.workspaceId
    : (req.body as { workspaceId?: string } | undefined)?.workspaceId;
  if (req.get('x-workspace-id') === workspaceId && req.get('x-workspace-role') === 'admin') next();
  else res.status(403).json({ error: 'Forbidden' });
});

jest.mock('../../lib/auth-utils', () => ({
  requireWorkspaceAdmin: () => adminGate,
}));


jest.mock('../../lib/pre-staging-qualification', () => ({
  previewPreStagingQualification: (...args: unknown[]) => preview(...args),
  runPreStagingQualification: (...args: unknown[]) => run(...args),
  listPreStagingQualifications: (...args: unknown[]) => list(...args),
}));

import router from '../pre-staging-qualification';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { id: 'operator-1', email: 'operator@example.test', supabaseId: 'operator-1', role: 'admin', plan: 'enterprise' };
  next();
});
app.use('/api/lifecycle', router);
app.use(errorHandler);

const previewValue = {
  schemaVersion: 'rorca.pre-staging-qualification-preview.v1',
  workspaceId: 'ws-1', specId: 'spec-1', title: 'Spec 1', specRevisionHash: `sha256:${'a'.repeat(64)}`,
  compiledPlanId: '7', planId: 'plan-1', policyVersion: 'policy-1', compilerVersion: 'compiler-1',
  headSha: 'b'.repeat(40), cleanHead: true, runId: 42, checks: [], availableCategories: [], unavailableCategories: [],
  requiredCategories: [], missingRequiredCategories: [], preconditions: { canExecute: true, blockers: [] },
  authority: { stagingAuthorityGranted: false, rationale: 'Evidence only.' }, previewHash: `sha256:${'c'.repeat(64)}`,
  observedAt: '2026-08-11T00:00:00.000Z',
};
const receiptValue = {
  schemaVersion: 'rorca.pre-staging-qualification-receipt.v1', id: 'receipt-1', workspaceId: 'ws-1', specId: 'spec-1',
  specRevisionHash: `sha256:${'a'.repeat(64)}`, compiledPlanId: '7', runId: 42, headSha: 'b'.repeat(40),
  previewHash: previewValue.previewHash, status: 'passed', mechanisms: [], checkResults: [], evidenceIds: [],
  readiness: { stagingAuthorityGranted: false }, receiptHash: `sha256:${'d'.repeat(64)}`,
  createdBy: 'operator-1', createdAt: '2026-08-11T00:01:00.000Z', replayed: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  preview.mockResolvedValue(previewValue);
  run.mockResolvedValue(receiptValue);
  list.mockResolvedValue([receiptValue]);
});

test('returns an exact read-only preview with optional run binding', async () => {
  const response = await request(app)
    .get('/api/lifecycle/specs/spec-1/pre-staging-qualification/preview')
    .set('x-workspace-id', 'ws-1')
    .set('x-workspace-role', 'admin')
    .query({ workspaceId: 'ws-1', runId: 42 });

  expect(response.status).toBe(200);
  expect(response.body.previewHash).toBe(previewValue.previewHash);
  expect(preview).toHaveBeenCalledWith({ workspaceId: 'ws-1', specId: 'spec-1', runId: 42 });
});

test('executes only the preview-bound request and derives the actor from authentication', async () => {
  const response = await request(app)
    .post('/api/lifecycle/specs/spec-1/pre-staging-qualification/run')
    .set('x-workspace-id', 'ws-1')
    .set('x-workspace-role', 'admin')
    .set('Idempotency-Key', 'qualification-request-1')
    .send({ workspaceId: 'ws-1', previewHash: previewValue.previewHash, runId: 42 });

  expect(response.status).toBe(201);
  expect(run).toHaveBeenCalledWith({
    workspaceId: 'ws-1', specId: 'spec-1', previewHash: previewValue.previewHash,
    idempotencyKey: 'qualification-request-1', actorId: 'operator-1', runId: 42,
  });
});

test('rejects missing idempotency and caller-supplied authority before execution', async () => {
  const missing = await request(app)
    .post('/api/lifecycle/specs/spec-1/pre-staging-qualification/run')
    .set('x-workspace-id', 'ws-1')
    .set('x-workspace-role', 'admin')
    .send({ workspaceId: 'ws-1', previewHash: previewValue.previewHash });
  const forged = await request(app)
    .post('/api/lifecycle/specs/spec-1/pre-staging-qualification/run')
    .set('x-workspace-id', 'ws-1')
    .set('x-workspace-role', 'admin')
    .set('Idempotency-Key', 'qualification-request-2')
    .send({ workspaceId: 'ws-1', previewHash: previewValue.previewHash, actorId: 'forged-admin' });

  expect(missing.status).toBe(400);
  expect(forged.status).toBe(400);
  expect(run).not.toHaveBeenCalled();
});

test('lists immutable receipt history for the selected spec', async () => {
  const response = await request(app)
    .get('/api/lifecycle/specs/spec-1/pre-staging-qualifications')
    .set('x-workspace-id', 'ws-1')
    .set('x-workspace-role', 'admin')
    .query({ workspaceId: 'ws-1', limit: 5 });

  expect(response.status).toBe(200);
  expect(response.body.items).toEqual([receiptValue]);
  expect(list).toHaveBeenCalledWith({ workspaceId: 'ws-1', specId: 'spec-1', limit: 5 });
});

test('requires workspace administration for every qualification read and execution route', async () => {
  const deniedPreview = await request(app)
    .get('/api/lifecycle/specs/spec-1/pre-staging-qualification/preview')
    .set('x-workspace-id', 'ws-1')
    .set('x-workspace-role', 'member')
    .query({ workspaceId: 'ws-1' });
  const deniedRun = await request(app)
    .post('/api/lifecycle/specs/spec-1/pre-staging-qualification/run')
    .set('x-workspace-id', 'ws-1')
    .set('x-workspace-role', 'admin')
    .set('Idempotency-Key', 'qualification-request-cross-workspace')
    .send({ workspaceId: 'ws-other', previewHash: previewValue.previewHash });
  const deniedHistory = await request(app)
    .get('/api/lifecycle/specs/spec-1/pre-staging-qualifications')
    .set('x-workspace-id', 'ws-1')
    .set('x-workspace-role', 'member')
    .query({ workspaceId: 'ws-1' });

  expect(deniedPreview.status).toBe(403);
  expect(deniedRun.status).toBe(403);
  expect(deniedHistory.status).toBe(403);
  expect(preview).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
});
