/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Server } from 'http';
import request from 'supertest';
import { execute, query, queryOne } from '../../db/index';
import { getAuthToken } from './helpers/auth-helper';

jest.mock('../../lib/pg-boss', () => ({
  initBoss: jest.fn().mockResolvedValue(undefined),
  getBoss: jest.fn(() => ({ send: jest.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111') })),
}));

interface Fixture {
  workspaceA: string;
  workspaceB: string;
  rootA: string;
  rootB: string;
  slug: string;
  titleA: string;
  titleB: string;
}

let app: Server;
let authToken: string;
let fixture: Fixture | undefined;

function writePending(root: string, slug: string, title: string): void {
  const pending = path.join(root, 'forge', 'specs', 'pending');
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(pending, `${slug}.json`), JSON.stringify({
    title,
    generatedAt: '2026-07-24T00:00:00.000Z',
    userStories: [{
      id: 'US-001',
      title: `${title} story`,
      description: `${title} description`,
      acceptanceCriteria: [`${title} criterion`],
      dependsOn: [],
    }],
  }, null, 2));
}

async function cleanupFixture(current: Fixture | undefined): Promise<void> {
  if (!current) return;
  await execute('DELETE FROM spec_search_index WHERE workspace_id = ANY($1::text[])', [[current.workspaceA, current.workspaceB]]);
  await execute(
    `DELETE FROM wal_events
      WHERE workspace_id = ANY($1::text[])
         OR (spec_id = $2 AND payload ->> 'workspaceId' = ANY($1::text[]))`,
    [[current.workspaceA, current.workspaceB], current.slug],
  );
  await execute('DELETE FROM spec_versions WHERE spec_slug = $1', [current.slug]);
  await execute('DELETE FROM workspaces WHERE id = ANY($1::text[])', [[current.workspaceA, current.workspaceB]]);
  fs.rmSync(current.rootA, { recursive: true, force: true });
  fs.rmSync(current.rootB, { recursive: true, force: true });
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const serverMod = require('../../server');
  app = serverMod.default.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    app.once('listening', resolve);
    app.once('error', reject);
  });
  authToken = await getAuthToken();
});

afterEach(async () => {
  await cleanupFixture(fixture);
  fixture = undefined;
});

afterAll(async () => {
  app.closeAllConnections();
  await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
  delete process.env.NODE_ENV;
});

test('spec versions, rejection WAL, archive, diff, and restore never cross workspace identity for a shared slug', async () => {
  const nonce = randomUUID();
  fixture = {
    workspaceA: `ws-spec-version-a-${nonce}`,
    workspaceB: `ws-spec-version-b-${nonce}`,
    rootA: fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-spec-version-a-')),
    rootB: fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-spec-version-b-')),
    slug: `shared-spec-${nonce}`,
    titleA: `Workspace A secret ${nonce}`,
    titleB: `Workspace B public ${nonce}`,
  };

  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, 'Version A', $2), ($3, 'Version B', $4)`,
    [fixture.workspaceA, fixture.rootA, fixture.workspaceB, fixture.rootB],
  );
  writePending(fixture.rootA, fixture.slug, fixture.titleA);
  writePending(fixture.rootB, fixture.slug, fixture.titleB);

  const rejected = await request(app)
    .post(`/api/specs/${fixture.slug}/reject`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: fixture.workspaceA, reason: 'fixture rejection' });
  expect(rejected.status).toBe(200);

  const snapshot = await queryOne<{ workspace_id: string | null; version: number }>(
    'SELECT workspace_id, version FROM spec_versions WHERE spec_slug = $1 ORDER BY version ASC LIMIT 1',
    [fixture.slug],
  );
  expect(snapshot).toEqual({ workspace_id: fixture.workspaceA, version: 1 });

  const rejectionWal = await queryOne<{ workspace_id: string | null }>(
    `SELECT workspace_id FROM wal_events
      WHERE event_type = 'spec_rejected' AND spec_id = $1
      ORDER BY id DESC LIMIT 1`,
    [fixture.slug],
  );
  expect(rejectionWal?.workspace_id).toBe(fixture.workspaceA);

  const versionsFromB = await request(app)
    .get(`/api/specs/${fixture.slug}/versions`)
    .query({ workspaceId: fixture.workspaceB })
    .set('Authorization', `Bearer ${authToken}`);
  expect(versionsFromB.status).toBe(200);
  expect(versionsFromB.body.items).toHaveLength(1);
  expect(versionsFromB.body.items[0]).toMatchObject({ title: fixture.titleB, status: 'pending' });

  const maxVersion = await queryOne<{ max_version: number }>(
    'SELECT MAX(version)::int AS max_version FROM spec_versions WHERE spec_slug = $1',
    [fixture.slug],
  );
  const secondAVersion = Number(maxVersion?.max_version ?? 0) + 1;
  await execute(
    `INSERT INTO spec_versions (workspace_id, spec_slug, version, content_json, status)
     VALUES ($1, $2, $3, $4, 'rejected')`,
    [fixture.workspaceA, fixture.slug, secondAVersion, JSON.stringify({ title: `${fixture.titleA} v2`, userStories: [] })],
  );

  const diffFromB = await request(app)
    .get(`/api/specs/${fixture.slug}/diff`)
    .query({ workspaceId: fixture.workspaceB, v1: 1, v2: secondAVersion })
    .set('Authorization', `Bearer ${authToken}`);
  expect(diffFromB.status).toBe(404);

  fs.rmSync(path.join(fixture.rootB, 'forge', 'specs', 'pending', `${fixture.slug}.json`));
  await execute(
    `INSERT INTO wal_events (event_type, spec_id, workspace_id, actor, payload)
     VALUES ('spec_rejected', $1, $2, 'fixture', $3)`,
    [fixture.slug, fixture.workspaceB, JSON.stringify({ workspaceId: fixture.workspaceB, reason: 'B has no snapshot' })],
  );

  const archiveFromB = await request(app)
    .get('/api/specs/archive')
    .query({ workspaceId: fixture.workspaceB, status: 'rejected', q: fixture.titleA })
    .set('Authorization', `Bearer ${authToken}`);
  expect(archiveFromB.status).toBe(200);
  expect(archiveFromB.body.items).toEqual([]);

  const restoreFromB = await request(app)
    .post(`/api/specs/${fixture.slug}/versions/1/restore`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: fixture.workspaceB });
  expect(restoreFromB.status).toBe(404);
  expect(fs.existsSync(path.join(fixture.rootB, 'forge', 'specs', 'pending', `${fixture.slug}.json`))).toBe(false);

  const bVersions = await query<{ workspace_id: string | null; content_json: unknown }>(
    'SELECT workspace_id, content_json FROM spec_versions WHERE workspace_id = $1 AND spec_slug = $2',
    [fixture.workspaceB, fixture.slug],
  );
  expect(bVersions).toHaveLength(1);
  expect(bVersions[0].workspace_id).toBe(fixture.workspaceB);
  expect(JSON.stringify(bVersions[0].content_json)).toContain(fixture.titleB);
  expect(JSON.stringify(bVersions[0].content_json)).not.toContain(fixture.titleA);
});
