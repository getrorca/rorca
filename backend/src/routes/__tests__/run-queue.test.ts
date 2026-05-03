/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { queryOne, execute } from '../../db/index';

let app: Express;
let tmpDir: string;
let authToken: string;

// run-queue route uses Number(workspaceId) for DB queries, so use a numeric-string ID
const WORKSPACE_ID = '42';

beforeEach(async () => {
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-queue-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
await execute(`INSERT INTO workspaces (id, label, path) VALUES ($1, 'Test Workspace', $2) ON CONFLICT (id) DO NOTHING`, [WORKSPACE_ID, tmpDir]);

  authToken = await getAuthToken(app);
});

afterEach(() => {
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

describe('GET /api/run-queue', () => {
  it('returns empty list when queue is empty', async () => {
    const res = await request(app)
      .get(`/api/run-queue?workspaceId=${WORKSPACE_ID}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('returns pending queue entries ordered by position', async () => {
    await execute(`INSERT INTO run_queue (workspace_id, spec_id, spec_path, position, status) VALUES ($1, 'spec-b', 'path/b.json', 2, 'pending')`, [WORKSPACE_ID]);
    await execute(`INSERT INTO run_queue (workspace_id, spec_id, spec_path, position, status) VALUES ($1, 'spec-a', 'path/a.json', 1, 'pending')`, [WORKSPACE_ID]);

    const res = await request(app)
      .get(`/api/run-queue?workspaceId=${WORKSPACE_ID}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].spec_id).toBe('spec-a');
    expect(res.body.items[1].spec_id).toBe('spec-b');
  });

  it('returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .get('/api/run-queue')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspaceid/i);
  });
});

describe('GET /api/run-queue/status', () => {
  it('returns zero queue length with no entries', async () => {
    const res = await request(app)
      .get(`/api/run-queue/status?workspaceId=${WORKSPACE_ID}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.queueLength).toBe(0);
    expect(res.body.nextSpec).toBeNull();
    expect(res.body.runningRunId).toBeNull();
  });

  it('returns queue length and next spec', async () => {
    await execute(`INSERT INTO run_queue (workspace_id, spec_id, spec_path, position, status) VALUES ($1, 'spec-1', 'path/1.json', 1, 'pending')`, [WORKSPACE_ID]);
    await execute(`INSERT INTO run_queue (workspace_id, spec_id, spec_path, position, status) VALUES ($1, 'spec-2', 'path/2.json', 2, 'pending')`, [WORKSPACE_ID]);

    const res = await request(app)
      .get(`/api/run-queue/status?workspaceId=${WORKSPACE_ID}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.queueLength).toBe(2);
    expect(res.body.nextSpec).not.toBeNull();
    expect(res.body.nextSpec.spec_id).toBe('spec-1');
  });

  it('works without workspaceId (global status)', async () => {
    const res = await request(app)
      .get('/api/run-queue/status')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('queueLength');
    expect(res.body).toHaveProperty('nextSpec');
    expect(res.body).toHaveProperty('runningRunId');
  });
});

describe('POST /api/run-queue', () => {
  it('adds a spec to the queue', async () => {
    const res = await request(app)
      .post('/api/run-queue')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: WORKSPACE_ID,
        specId: 'my-spec',
        specPath: 'forge/specs/approved/my-spec.json',
      });

    expect(res.status).toBe(201);
    expect(res.body.spec_id).toBe('my-spec');
    // workspace_id may be returned as number since WORKSPACE_ID is a numeric string
    expect(String(res.body.workspace_id)).toBe(WORKSPACE_ID);
    expect(res.body.position).toBe(1);
    expect(res.body.status).toBe('pending');
  });

  it('assigns sequential positions', async () => {
    await request(app)
      .post('/api/run-queue')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID, specId: 'spec-1', specPath: 'path/1.json' });

    const res = await request(app)
      .post('/api/run-queue')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID, specId: 'spec-2', specPath: 'path/2.json' });

    expect(res.status).toBe(201);
    expect(res.body.position).toBe(2);
  });

  it('returns 400 for missing required fields', async () => {
    const res = await request(app)
      .post('/api/run-queue')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/specId/i);
  });

  it('returns 404 for nonexistent workspace', async () => {
    const res = await request(app)
      .post('/api/run-queue')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'nonexistent', specId: 'spec', specPath: 'path.json' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/workspace not found/i);
  });
});

describe('DELETE /api/run-queue/:id', () => {
  it('removes an entry from the queue', async () => {
    const result = await queryOne<{ id: number }>(`INSERT INTO run_queue (workspace_id, spec_id, spec_path, position, status) VALUES ($1, 'spec-x', 'path/x.json', 1, 'pending') RETURNING id`, [WORKSPACE_ID]);
    const entryId = result!.id;

    const res = await request(app)
      .delete(`/api/run-queue/${entryId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const gone = await queryOne(`SELECT id FROM run_queue WHERE id = $1`, [entryId]);
    expect(gone).toBeUndefined();
  });

  it('returns 404 for nonexistent entry', async () => {
    const res = await request(app)
      .delete('/api/run-queue/99999')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid ID', async () => {
    const res = await request(app)
      .delete('/api/run-queue/notanumber')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
  });
});

describe('PUT /api/run-queue/reorder', () => {
  it('reorders entries by given ID order', async () => {
    const r1 = await queryOne<{ id: number }>(`INSERT INTO run_queue (workspace_id, spec_id, spec_path, position, status) VALUES ($1, 'spec-a', 'a.json', 1, 'pending') RETURNING id`, [WORKSPACE_ID]);
    const r2 = await queryOne<{ id: number }>(`INSERT INTO run_queue (workspace_id, spec_id, spec_path, position, status) VALUES ($1, 'spec-b', 'b.json', 2, 'pending') RETURNING id`, [WORKSPACE_ID]);

    const id1 = r1!.id;
    const id2 = r2!.id;

    const res = await request(app)
      .put('/api/run-queue/reorder')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ orderedIds: [id2, id1] }); // flip order

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const updated1 = await queryOne(`SELECT position FROM run_queue WHERE id = $1`, [id1]) as { position: number };
    const updated2 = await queryOne(`SELECT position FROM run_queue WHERE id = $1`, [id2]) as { position: number };

    expect(updated2.position).toBe(1);
    expect(updated1.position).toBe(2);
  });

  it('returns 400 for empty orderedIds', async () => {
    const res = await request(app)
      .put('/api/run-queue/reorder')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ orderedIds: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-empty array/i);
  });
});
