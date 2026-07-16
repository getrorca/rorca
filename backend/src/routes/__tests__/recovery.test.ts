/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';

jest.mock('../../lib/checkpoint-reconciliation', () => ({
  checkpointAttestationLookupSchema: require('zod').z.object({
    workspaceId: require('zod').z.string(),
    runId: require('zod').z.number().int().positive(),
    storyId: require('zod').z.string(),
    branch: require('zod').z.string(),
    checkpointSha: require('zod').z.string().length(40),
  }),
  checkpointReconciliationSchema: require('zod').z.object({
    workspaceId: require('zod').z.string(),
  }).passthrough(),
  getCheckpointAttestationReference: jest.fn(),
  reconcileCheckpoint: jest.fn(),
}));

import recoveryRouter from '../recovery';
import { getCheckpointAttestationReference, reconcileCheckpoint } from '../../lib/checkpoint-reconciliation';

const mockedLookup = getCheckpointAttestationReference as jest.Mock;
const mockedReconcile = reconcileCheckpoint as jest.Mock;
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { req.user = { role: 'admin' }; next(); });
app.use('/api/admin/recovery', recoveryRouter);

describe('admin recovery checkpoint route boundary', () => {
  beforeEach(() => jest.resetAllMocks());

  it('rejects a non-admin caller before parsing or reconciliation', async () => {
    const denied = express();
    denied.use(express.json());
    denied.use((req: any, _res, next) => { req.user = { role: 'user' }; next(); });
    denied.use('/api/admin/recovery', recoveryRouter);
    const response = await request(denied).post('/api/admin/recovery/checkpoints/reconcile').send({ workspaceId: 'ws' });
    expect(response.status).toBe(403);
    expect(mockedReconcile).not.toHaveBeenCalled();
  });

  it('returns an AppError validation response before the governed service for malformed bodies', async () => {
    const response = await request(app).post('/api/admin/recovery/checkpoints/reconcile').send({});
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(mockedReconcile).not.toHaveBeenCalled();
  });

  it('returns only an existing opaque trusted-attestation reference', async () => {
    mockedLookup.mockResolvedValueOnce({
      attestationId: '11111111-1111-4111-8111-111111111111',
      attestationDigest: 'a'.repeat(64),
      validationGate: 'ci',
      expiresAt: '2026-07-05T00:00:00.000Z',
    });
    const response = await request(app).get('/api/admin/recovery/checkpoints/attestation').query({
      workspaceId: 'ws', runId: 21, storyId: 'US-002', branch: 'recovery/checkpoint', checkpointSha: '0'.repeat(40),
    });
    expect(response.status).toBe(200);
    expect(response.body.attestationId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('uses 201 for reconciliation and 200 for an idempotent replay', async () => {
    mockedReconcile
      .mockResolvedValueOnce({ reconciled: true, idempotent: false })
      .mockResolvedValueOnce({ reconciled: true, idempotent: true });

    const first = await request(app).post('/api/admin/recovery/checkpoints/reconcile').send({ workspaceId: 'ws' });
    const replay = await request(app).post('/api/admin/recovery/checkpoints/reconcile').send({ workspaceId: 'ws' });

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(mockedReconcile).toHaveBeenCalledTimes(2);
  });
});
