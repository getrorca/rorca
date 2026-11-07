/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';

const preview = jest.fn();
const read = jest.fn();
jest.mock('../../lib/run-closeout-reconciliation', () => {
  const actual = jest.requireActual('../../lib/run-closeout-reconciliation');
  return {
    ...actual,
    previewRunCloseoutReconciliation: (...args: unknown[]) => preview(...args),
    getSafeRunCloseoutReconciliation: (...args: unknown[]) => read(...args),
  };
});

import router from '../closeout-reconciliation-public';

const app = express();
app.use('/api/recovery', router);

test('public preview projects opaque identity only and never exposes authority payloads', async () => {
  preview.mockResolvedValue({
    schemaVersion: 'rorca.run-closeout-reconciliation-preview.v1',
    eligible: true,
    canonicalTargetHash: `sha256:${'a'.repeat(64)}`,
    target: {
      runId: 20260316000550,
      workspaceId: 'proof-workspace',
      specId: 'wave-1',
      expiresAt: '2026-07-27T18:00:00.000Z',
      immutableAuthorityHash: `sha256:${'b'.repeat(64)}`,
      immutableAuthority: { git: { worktreeRealpath: '/secret/path' } },
      originalProjection: { lifecycleDiagnostics: { secret: true } },
      ownership: { actor: 'owner' },
      existingOutputs: { receipt: 'secret' },
    },
  });
  read.mockResolvedValue({
    schemaVersion: 'rorca.run-closeout-reconciliation-public.v1',
    runId: 20260316000550,
    workspaceId: 'proof-workspace',
    state: 'eligible',
  });
  const response = await request(app)
    .get('/api/recovery/runs/20260316000550/closeout-reconciliation')
    .query({ workspaceId: 'proof-workspace' });
  expect(response.status).toBe(200);

  const projected = await request(app)
    .get('/api/recovery/runs/20260316000550/closeout-reconciliation/preview')
    .query({ workspaceId: 'proof-workspace' });
  expect(projected.status).toBe(200);
  expect(projected.body.target).toEqual({
    runId: 20260316000550,
    workspaceId: 'proof-workspace',
    specId: 'wave-1',
    expiresAt: '2026-07-27T18:00:00.000Z',
    immutableAuthorityHash: `sha256:${'b'.repeat(64)}`,
  });
  expect(JSON.stringify(projected.body)).not.toMatch(/secret|worktreeRealpath|owner/);
});
