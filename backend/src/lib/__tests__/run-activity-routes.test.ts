/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { INTERNAL_SERVICE_USER_ID } from '../auth-utils';
import { AppError } from '../errors';

const page = jest.fn();
const listStatusPlanes = jest.fn();
const ingestTelemetryBatch = jest.fn();
const queryOne = jest.fn();

jest.mock('../../db/index', () => ({ queryOne: (...args: unknown[]) => queryOne(...args) }));
jest.mock('../run-activity-store', () => ({
  runActivityStore: {
    page: (...args: unknown[]) => page(...args),
    listStatusPlanes: (...args: unknown[]) => listStatusPlanes(...args),
    ingestTelemetryBatch: (...args: unknown[]) => ingestTelemetryBatch(...args),
  },
}));

import runActivityRouter from '../../routes/run-activity';

const emptyProjectionPage = {
  schemaVersion: 'rorca.run-activity-page.v1', status: 'ok', resetReason: null, streamId: 'stream:one',
  runtimeGeneration: 1, firstRetainedSequence: 1, lastDurableSequence: 0, events: [], nextCursor: 'cursor:next',
  hasMore: false, authoritative: false, authorityEffect: 'none',
};

function appFor(userId: string | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) req.user = { id: userId, email: `${userId}@local`, supabaseId: `auth:${userId}`, role: 'admin' };
    (req as Request & { requestId?: string }).requestId = 'request:run-activity';
    next();
  });
  app.use('/api/mission-control/v1/run-activity', runActivityRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json(error.toJSON());
      return;
    }
    res.status(500).json({ error: 'Internal error' });
  });
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  queryOne.mockResolvedValue({ member: true });
  page.mockResolvedValue(emptyProjectionPage);
  listStatusPlanes.mockResolvedValue([]);
  ingestTelemetryBatch.mockResolvedValue({ duplicate: false, batchId: 'batch:one', firstStreamSequence: 1,
    lastStreamSequence: 1, eventCount: 1 });
});

describe('Wave 3B run activity HTTP boundary', () => {
  test('requires exact workspace membership before returning replay data', async () => {
    queryOne.mockResolvedValueOnce(undefined);
    const denied = await request(appFor('user:one')).get('/api/mission-control/v1/run-activity/runs/7/events')
      .query({ workspaceId: 'workspace:other' });
    expect(denied.status).toBe(403);
    expect(page).not.toHaveBeenCalled();

    const allowed = await request(appFor('user:one')).get('/api/mission-control/v1/run-activity/runs/7/events')
      .query({ workspaceId: 'workspace:one', limit: 25, tail: true });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ status: 'ok', authoritative: false, authorityEffect: 'none' });
    expect(page).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace:one', runId: 7, limit: 25, tail: true }));
  });

  test('returns all seven planes and explicit non-authority labels without an aggregate green badge', async () => {
    listStatusPlanes.mockResolvedValue([
      { plane: 'runtime_health', status: 'healthy', sourceClass: 'sandbox_resource_monitor', sourceIdentity: 'runtime:probe' },
      { plane: 'queue_outbox_freshness', status: 'failed', sourceClass: 'queue_outbox_monitor', sourceIdentity: 'queue:probe' },
    ]);
    const response = await request(appFor('user:one')).get('/api/mission-control/v1/run-activity/runs/7/state')
      .query({ workspaceId: 'workspace:one' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ schemaVersion: 'rorca.run-view-state.v1', state: 'empty', planeCount: 7,
      authoritative: false, authorityEffect: 'none', authorityLabels: {
        terminalOutput: 'observability_only', completionCandidate: 'proposal_only',
        storyCompletion: 'verified_StoryCloseoutDecision.accepted_only', mergeDeploymentProduction: 'not_authorized',
      } });
    expect(response.body).not.toHaveProperty('healthy');
    expect(response.body.notices.join(' ')).toMatch(/no aggregate readiness authority/);
  });

  test('federated telemetry requires an internal relay and exact runtime header', async () => {
    const body = { workspaceId: 'workspace:one', runtimeId: 'runtime:one' };
    const denied = await request(appFor('user:one')).post('/api/mission-control/v1/run-activity/telemetry/batches')
      .set('x-rorca-runtime-id', 'runtime:one').send(body);
    expect(denied.status).toBe(401);
    expect(ingestTelemetryBatch).not.toHaveBeenCalled();

    const mismatched = await request(appFor(INTERNAL_SERVICE_USER_ID)).post('/api/mission-control/v1/run-activity/telemetry/batches')
      .set('x-rorca-runtime-id', 'runtime:other').send(body);
    expect(mismatched.status).toBe(401);

    const accepted = await request(appFor(INTERNAL_SERVICE_USER_ID)).post('/api/mission-control/v1/run-activity/telemetry/batches')
      .set('x-rorca-runtime-id', 'runtime:one').send(body);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ schemaVersion: 'rorca.runtime-telemetry-receipt.v1',
      projectionOnly: true, authorityEffect: 'none', eventCount: 1 });
  });

  test('surfaces explicit reset/gap responses without substituting another stream', async () => {
    page.mockResolvedValueOnce({ ...emptyProjectionPage, status: 'reset', resetReason: 'scope_mismatch',
      streamId: null, runtimeGeneration: null, events: [], nextCursor: null });
    const response = await request(appFor('user:one')).get('/api/mission-control/v1/run-activity/runs/7/events')
      .query({ workspaceId: 'workspace:one', cursor: 'x'.repeat(40) });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'reset', resetReason: 'scope_mismatch', events: [] });
  });

  test('strips tail mode from live replay so cursor handoff cannot fail', async () => {
    page.mockResolvedValueOnce({ ...emptyProjectionPage, status: 'reset', resetReason: 'scope_mismatch',
      streamId: null, runtimeGeneration: null, events: [], nextCursor: null });
    const response = await request(appFor('user:one')).get('/api/mission-control/v1/run-activity/runs/7/live')
      .query({ workspaceId: 'workspace:one', tail: true });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/event-stream/);
    expect(response.text).toContain('event: reset');
    expect(page).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace:one', runId: 7 }));
    expect(page.mock.calls[0]![0]).not.toHaveProperty('tail');
  });
});
