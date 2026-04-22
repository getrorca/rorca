import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { execute, queryOne } from '../../db/index';

let app: Express;
let tmpDir: string;
let authToken: string;

beforeEach(async () => {
  jest.resetModules();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-workspace-membership-test-'));
  process.env.NODE_ENV = 'test';
  process.env.AUTH_REQUIRED = 'true';

  const serverMod = require('../../server');
  app = serverMod.default;
  authToken = await getAuthToken(app);
});

afterEach(async () => {
  try {
    await execute(`DELETE FROM workspace_members WHERE workspace_id LIKE 'ws-membership-%'`);
    await execute(`DELETE FROM workspaces WHERE id LIKE 'ws-membership-%'`);
  } catch {}
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.NODE_ENV;
  delete process.env.AUTH_REQUIRED;
});

describe('POST /api/workspaces membership bootstrap', () => {
  it('creates an owner membership row and workspace list is RLS-scoped to the member', async () => {
    const workspaceId = `ws-membership-${Date.now()}`;

    const createRes = await request(app)
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        id: workspaceId,
        label: 'Membership Bootstrap Test',
        path: tmpDir,
        domains: ['saas'],
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.workspace.id).toBe(workspaceId);

    const createdUser = await queryOne<{ auth_id: string | null }>(
      `SELECT auth_id FROM users WHERE email = $1`,
      ['testauth@example.com'],
    );
    expect(createdUser?.auth_id).toBeTruthy();

    const membership = await queryOne<{ workspace_id: string; user_auth_id: string; role: string }>(
      `SELECT workspace_id, user_auth_id::text AS user_auth_id, role
       FROM workspace_members
       WHERE workspace_id = $1 AND user_auth_id = $2::uuid`,
      [workspaceId, createdUser!.auth_id],
    );

    expect(membership).toEqual({
      workspace_id: workspaceId,
      user_auth_id: createdUser!.auth_id,
      role: 'owner',
    });

    const listRes = await request(app)
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${authToken}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.items.some((workspace: { id: string }) => workspace.id === workspaceId)).toBe(true);
  });
});
