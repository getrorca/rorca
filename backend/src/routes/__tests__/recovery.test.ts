import express from 'express';
import request from 'supertest';

jest.mock('../../lib/checkpoint-reconciliation', () => ({
  checkpointReconciliationSchema: require('zod').z.object({
    workspaceId: require('zod').z.string(),
  }).passthrough(),
  reconcileCheckpoint: jest.fn(),
}));

import recoveryRouter from '../recovery';
import { reconcileCheckpoint } from '../../lib/checkpoint-reconciliation';

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
