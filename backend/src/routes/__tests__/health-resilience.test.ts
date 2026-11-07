/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';

let releaseDatabaseCheck: (() => void) | null = null;
let databaseChecks = 0;

jest.mock('../../db/index', () => ({
  pool: { totalCount: 18, idleCount: 0, waitingCount: 20 },
  operationalPool: { totalCount: 1, idleCount: 1, waitingCount: 0 },
  combinedPoolStats: jest.fn().mockReturnValue({ total: 19, idle: 1, waiting: 20 }),
  detectCloudProvider: jest.fn().mockReturnValue('self-hosted'),
  operationalQueryOne: jest.fn().mockResolvedValue({
    active_runs: 3, pg_version: '16-test', extensions: '{age,pgcrypto,vector}',
  }),
  dbHealthCheck: jest.fn(() => {
    databaseChecks++;
    return new Promise(resolve => {
      releaseDatabaseCheck = () => resolve({
        ok: true, latencyMs: 1,
        poolStats: { total: 18, idle: 0, waiting: 20, maxSize: 18 },
        extensions: [], cloud: false, provider: 'self-hosted',
        extensionStatus: { vector: false, age: false },
      });
    });
  }),
  query: jest.fn().mockResolvedValue([]),
  queryOne: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../lib/opencode-detector', () => ({
  detectOpenCodeAsync: jest.fn().mockResolvedValue({
    opencodeInstalled: false, opencodeVersion: null, opencodeBinPath: null,
  }),
}));
jest.mock('../../lib/codex-detector', () => ({
  detectCodexAsync: jest.fn().mockResolvedValue({
    codexInstalled: false, codexVersion: null, codexBinPath: null,
  }),
}));
jest.mock('../../lib/pi-detector', () => ({
  detectPiAsync: jest.fn().mockResolvedValue({
    piInstalled: false, piVersion: null, piBinPath: null,
  }),
}));

describe('health responsiveness under isolated pool pressure', () => {
  test('detailed diagnostics single-flight while live and reserved-pool ready remain responsive', async () => {
    const healthRouter = require('../health').default;
    const app = express();
    app.use('/api/health', healthRouter);

    const firstDetailed = request(app).get('/api/health/detailed');
    const firstPromise = firstDetailed.then(response => response);
    for (let i = 0; i < 20 && !releaseDatabaseCheck; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(releaseDatabaseCheck).not.toBeNull();

    const started = performance.now();
    const [live, ready, concurrentDetailed] = await Promise.all([
      request(app).get('/api/health/live'),
      request(app).get('/api/health/ready'),
      request(app).get('/api/health/detailed'),
    ]);
    const elapsedMs = performance.now() - started;

    expect(live.status).toBe(200);
    expect(ready.status).toBe(200);
    expect(ready.body.active_runs).toBe(3);
    expect(ready.body.extensions).toEqual(['age', 'pgcrypto', 'vector']);
    expect(ready.body.graphMode).toBe('full');
    expect(concurrentDetailed.status).toBe(503);
    expect(concurrentDetailed.body.diagnostics.refreshInProgress).toBe(true);
    expect(elapsedMs).toBeLessThan(500);
    expect(databaseChecks).toBe(1);

    releaseDatabaseCheck!();
    const completed = await firstPromise;
    expect(completed.status).toBe(200);
  });
});
