/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';

const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockExecute = jest.fn();

jest.mock('../../db/index', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  execute: (...args: unknown[]) => mockExecute(...args),
  transaction: jest.fn(),
}));

jest.mock('../../lib/pg-boss', () => ({
  getBoss: jest.fn(),
}));

jest.mock('../../lib/sse-hub', () => ({
  broadcastAll: jest.fn(),
  attachSSE: jest.fn(),
  createBoundedTopicSseSink: jest.fn(),
  subscribeTopic: jest.fn(),
}));

jest.mock('../../worker', () => ({ sweepOrphanProcesses: jest.fn() }));

import pipelineRouter, { cleanupOrphanRuns } from '../pipeline';

describe('configured pg-boss schema startup reconciliation', () => {
  const previousSchema = process.env.RORCA_PGBOSS_SCHEMA;

  afterEach(() => {
    jest.clearAllMocks();
    if (previousSchema === undefined) delete process.env.RORCA_PGBOSS_SCHEMA;
    else process.env.RORCA_PGBOSS_SCHEMA = previousSchema;
  });

  test('preserves application run state when the configured schema owns its live transport job', async () => {
    process.env.RORCA_PGBOSS_SCHEMA = 'pgboss_cert_alt';
    mockQuery.mockResolvedValue([{ id: 42, pid: null, opencode_server_pid: null, workspace_id: 'ws-cert', agent_type: 'pi' }]);
    mockQueryOne
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async (sql: string, params: unknown[]) => {
        expect(sql).toContain('FROM "pgboss_cert_alt".job');
        expect(sql).not.toContain('FROM pgboss.job');
        expect(params).toEqual(['42']);
        return { id: 'transport-job-42' };
      });

    await expect(cleanupOrphanRuns()).resolves.toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('preserves application state when configured queue evidence is unavailable', async () => {
    process.env.RORCA_PGBOSS_SCHEMA = 'pgboss_cert_alt';
    mockQuery.mockResolvedValue([{ id: 43, pid: null, opencode_server_pid: null, workspace_id: 'ws-cert', agent_type: 'pi' }]);
    mockQueryOne
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('configured schema unavailable'));

    await expect(cleanupOrphanRuns()).resolves.toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('generic transport retry cannot bypass application-owned retry authority', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/pipeline', pipelineRouter);

    const response = await request(app)
      .post('/api/pipeline/queue/failed-jobs/11111111-1111-4111-8111-111111111111/retry')
      .send({});

    expect(response.status).toBe(422);
    expect(response.body.error).toMatch(/transport rows are not retry authority/);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('fails closed on an invalid configured schema before touching application state', async () => {
    process.env.RORCA_PGBOSS_SCHEMA = 'pgboss_cert_alt;drop';
    mockQuery.mockResolvedValue([{ id: 44, pid: null, opencode_server_pid: null, workspace_id: 'ws-cert', agent_type: 'pi' }]);
    mockQueryOne.mockResolvedValueOnce(undefined);

    await expect(cleanupOrphanRuns()).rejects.toThrow(/bounded pgboss_/);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
