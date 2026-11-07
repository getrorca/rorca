/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

const mockPreview = jest.fn();
const mockApply = jest.fn();
const mockList = jest.fn();
const mockMemberGate = jest.fn((req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (req.get('x-workspace-role') === 'member' || req.get('x-workspace-role') === 'admin') next();
  else res.status(403).json({ error: 'Forbidden' });
});
const mockAdminGate = jest.fn((req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (req.get('x-workspace-role') === 'admin') next();
  else res.status(403).json({ error: 'Forbidden' });
});

jest.mock('../../lib/auth-utils', () => ({
  requireWorkspaceMember: () => mockMemberGate,
  requireWorkspaceAdmin: () => mockAdminGate,
}));

jest.mock('../../lib/lifecycle-reconciliation', () => ({
  previewLifecycleReconciliation: (...args: unknown[]) => mockPreview(...args),
  applyLifecycleReconciliation: (...args: unknown[]) => mockApply(...args),
  listLifecycleReconciliationReceipts: (...args: unknown[]) => mockList(...args),
}));

import reconciliationRouter from '../lifecycle-reconciliation';
import { ConflictError, UnprocessableError } from '../../lib/errors';
import { errorHandler } from '../../lib/error-handler';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.user = {
      id: 'actor-1',
      email: 'operator@example.test',
      supabaseId: 'auth-1',
      role: 'user',
    };
    next();
  });
  instance.use('/api/lifecycle', reconciliationRouter);
  instance.use(errorHandler);
  return instance;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPreview.mockResolvedValue({ previewHash: `sha256:${'a'.repeat(64)}` });
  mockApply.mockResolvedValue({ id: 'receipt-1', replayed: false });
  mockList.mockResolvedValue([]);
});

test('preview and receipt history require membership in the selected workspace', async () => {
  const deniedPreview = await request(app())
    .get('/api/lifecycle/specs/spec-a/reconciliation-preview?workspaceId=workspace-a');
  const deniedHistory = await request(app())
    .get('/api/lifecycle/specs/spec-a/reconciliation-receipts?workspaceId=workspace-a');
  expect(deniedPreview.status).toBe(403);
  expect(deniedHistory.status).toBe(403);
  expect(mockPreview).not.toHaveBeenCalled();
  expect(mockList).not.toHaveBeenCalled();

  const preview = await request(app())
    .get('/api/lifecycle/specs/spec-a/reconciliation-preview?workspaceId=workspace-a')
    .set('x-workspace-role', 'member');
  const history = await request(app())
    .get('/api/lifecycle/specs/spec-a/reconciliation-receipts?workspaceId=workspace-a')
    .set('x-workspace-role', 'member');
  expect(preview.status).toBe(200);
  expect(history.status).toBe(200);
  expect(mockPreview).toHaveBeenCalledWith({ workspaceId: 'workspace-a', specId: 'spec-a' });
  expect(mockList).toHaveBeenCalledWith({ workspaceId: 'workspace-a', specId: 'spec-a', limit: undefined });
});

test('receipt persistence requires workspace administration', async () => {
  const body = { workspaceId: 'workspace-a', previewHash: `sha256:${'a'.repeat(64)}` };
  const member = await request(app())
    .post('/api/lifecycle/specs/spec-a/reconcile')
    .set('x-workspace-role', 'member')
    .set('Idempotency-Key', 'reconcile-key')
    .send(body);
  expect(member.status).toBe(403);
  expect(mockApply).not.toHaveBeenCalled();

  const admin = await request(app())
    .post('/api/lifecycle/specs/spec-a/reconcile')
    .set('x-workspace-role', 'admin')
    .set('Idempotency-Key', 'reconcile-key')
    .send(body);
  expect(admin.status).toBe(200);
  expect(mockApply).toHaveBeenCalledWith(expect.objectContaining({
    workspaceId: 'workspace-a',
    specId: 'spec-a',
    idempotencyKey: 'reconcile-key',
    actorId: 'actor-1',
  }));
});

test('surfaces bounded loader failures as structured actionable API errors', async () => {
  mockPreview.mockRejectedValueOnce(new UnprocessableError(
    'Approved spec JSON is malformed',
    'LIFECYCLE_RECONCILIATION_SPEC_INVALID',
    { specId: 'spec-a', remediation: 'Repair the approved spec JSON, then retry reconciliation.' },
  ));
  const malformed = await request(app())
    .get('/api/lifecycle/specs/spec-a/reconciliation-preview?workspaceId=workspace-a')
    .set('x-workspace-role', 'member');
  expect(malformed.status).toBe(422);
  expect(malformed.body).toEqual({
    error: 'Approved spec JSON is malformed',
    code: 'LIFECYCLE_RECONCILIATION_SPEC_INVALID',
    details: {
      specId: 'spec-a',
      remediation: 'Repair the approved spec JSON, then retry reconciliation.',
    },
  });

  mockPreview.mockRejectedValueOnce(new ConflictError(
    'Exact-spec run history exceeds the lifecycle reconciliation bound',
    {
      type: 'lifecycle_reconciliation_run_bound_exceeded',
      specId: 'spec-a',
      maximumRuns: 50,
      remediation: 'Archive superseded run projections before retrying.',
    },
  ));
  const bounded = await request(app())
    .get('/api/lifecycle/specs/spec-a/reconciliation-preview?workspaceId=workspace-a')
    .set('x-workspace-role', 'member');
  expect(bounded.status).toBe(409);
  expect(bounded.body).toMatchObject({
    code: 'CONFLICT',
    details: {
      type: 'lifecycle_reconciliation_run_bound_exceeded',
      specId: 'spec-a',
      maximumRuns: 50,
      remediation: expect.any(String),
    },
  });
});

test('Swagger declares the reconciliation request body and admin write tier', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lifecycle-reconciliation.ts'), 'utf8');
  const writeOperation = source.slice(source.indexOf('/api/lifecycle/specs/{specId}/reconcile:'), source.indexOf("router.post('/specs/:specId/reconcile'"));
  expect(writeOperation).toContain('x-rorca-tier: admin');
  expect(writeOperation).toContain('requestBody:');
  expect(writeOperation).toContain('required: [workspaceId, previewHash]');
  expect(writeOperation).toContain('operatorAttestation:');
});
