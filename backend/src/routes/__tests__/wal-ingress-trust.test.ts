/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';

const operationalQueryOne = jest.fn();
const broadcastAll = jest.fn();
let denyWorkspace = false;

jest.mock('../../db/index', () => ({
  operationalQueryOne: (...args: unknown[]) => operationalQueryOne(...args),
  query: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../lib/sse-hub', () => ({
  broadcastAll: (...args: unknown[]) => broadcastAll(...args),
}));
jest.mock('../../lib/auth-utils', () => ({
  requireWorkspaceMember: () => (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (denyWorkspace) res.status(403).json({ error: 'Forbidden' });
    else next();
  },
}));

import walRouter from '../wal';

const app = express();
app.use(express.json());
app.use('/api/wal', walRouter);

beforeEach(() => {
  jest.clearAllMocks();
  denyWorkspace = false;
});

test('forged POST fields are persisted only as untrusted caller provenance', async () => {
  operationalQueryOne.mockResolvedValue({
    id: 1,
    ts: '2026-07-18T10:00:00.000Z',
    event_type: 'story_passed',
    workspace_id: 'ws-a',
    spec_id: 'spec-a',
    story_id: 'US-001',
    actor: 'caller',
    payload: JSON.stringify({ run_id: 41, commit_sha: 'a'.repeat(40) }),
    trust_provenance: 'untrusted',
  });

  const response = await request(app).post('/api/wal').send({
    event_type: 'story_passed',
    workspace_id: 'ws-a',
    spec_id: 'spec-a',
    story_id: 'US-001',
    payload: { run_id: 41, commit_sha: 'a'.repeat(40) },
    idempotency_key: 'caller-forgery-1',
    trust_provenance: 'host',
    trusted_source: 'worker',
    canonical_run_id: 41,
    event_identity_hash: 'f'.repeat(64),
  });

  expect(response.status).toBe(201);
  const config = operationalQueryOne.mock.calls[0][0] as { text: string; values: unknown[] };
  expect(config.text).toContain("'untrusted', NULL, NULL, NULL");
  expect(config.text).not.toContain("'host', $8");
  expect(config.values).toHaveLength(7);
  expect(broadcastAll).toHaveBeenCalledWith(expect.objectContaining({ trust_provenance: 'untrusted' }));
});

test('idempotency accepts only exact duplicate caller payload identity', async () => {
  operationalQueryOne
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce({
      id: 7,
      ts: '2026-07-18T10:00:00.000Z',
      event_type: 'story_started',
      workspace_id: 'ws-a',
      spec_id: 'spec-a',
      story_id: 'US-001',
      actor: 'caller',
      payload: { run_id: 41, story_title: 'Original title' },
      trust_provenance: 'untrusted',
    });
  const response = await request(app).post('/api/wal').send({
    event_type: 'story_started',
    workspace_id: 'ws-a',
    spec_id: 'spec-a',
    story_id: 'US-001',
    idempotency_key: 'caller-duplicate-1',
    payload: { run_id: 41, story_title: 'Changed title' },
  });
  expect(response.status).toBe(409);
  expect(broadcastAll).not.toHaveBeenCalled();
});

test('workspace membership is enforced as defense in depth', async () => {
  denyWorkspace = true;
  const response = await request(app).post('/api/wal').send({
    event_type: 'story_started',
    workspace_id: 'victim-workspace',
  });
  expect(response.status).toBe(403);
  expect(operationalQueryOne).not.toHaveBeenCalled();
});

test('caller cannot preempt the deterministic trusted outbox namespace', async () => {
  const response = await request(app).post('/api/wal').send({
    event_type: 'run_finished',
    workspace_id: 'ws-a',
    idempotency_key: `trusted-wal:v1:${'a'.repeat(64)}`,
    payload: { run_id: 41, status: 'done' },
  });
  expect(response.status).toBe(400);
  expect(operationalQueryOne).not.toHaveBeenCalled();
});
