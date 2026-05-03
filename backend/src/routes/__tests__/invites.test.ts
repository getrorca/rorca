/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import crypto from 'crypto';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { queryOne, execute } from '../../db/index';

jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

let app: Express;
let tmpDir: string;
let authToken: string;

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function _createTestUser(email: string, password: string = 'password123') {
  const bcrypt = require('bcryptjs');
  const id = crypto.randomUUID();
  const hash = bcrypt.hashSync(password, 4);
  await execute(`INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)`, [id, email, 'Test User', hash]);
  return { id, email };
}

async function createTeam(ownerId: string, name: string = 'Test Team') {
  const id = crypto.randomUUID();
  const slug = 'team-' + id.slice(0, 8);
  await execute(`INSERT INTO teams (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)`, [id, name, slug, ownerId]);
  await execute(`INSERT INTO team_members (team_id, user_id, role, accepted_at, last_active_at) VALUES ($1, $2, 'admin', NOW(), NOW())`, [id, ownerId]);
  return { id, name, slug };
}

async function createInvite(teamId: string, invitedById: string, email: string, role: string = 'editor', expiresInMs: number = 7 * 24 * 60 * 60 * 1000) {
  const rawToken = crypto.randomUUID();
  const tokenHash = hashToken(rawToken);
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + expiresInMs).toISOString();
  await execute(`INSERT INTO team_invites (id, team_id, email, token_hash, invited_by, role, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, teamId, email, tokenHash, invitedById, role, expiresAt]);
  return { id, rawToken, tokenHash, email, role, expiresAt };
}

beforeEach(async () => {
  jest.resetModules();

  jest.mock('../../lib/llm-client', () => ({
    chatComplete: jest.fn(),
    getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
    isValidModel: jest.fn().mockReturnValue(true),
    DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
    resolveVaultProvider: jest.fn().mockReturnValue(null),
    getModelInfo: jest.fn().mockReturnValue(undefined),
    SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
  }));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-invites-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
authToken = await getAuthToken(app);
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

// ─── GET /api/invites/:token ───────────────────────────────────────────────

describe('GET /api/invites/:token', () => {
  test('returns invite details for a valid token', async () => {
    const owner = await queryOne(`SELECT id FROM users WHERE email = 'testauth@example.com'`) as { id: string };
    const team = await createTeam(owner.id);
    const invite = await createInvite(team.id, owner.id, 'invitee@example.com', 'editor');

    const res = await request(app).get(`/api/invites/${invite.rawToken}`);

    expect(res.status).toBe(200);
    expect(res.body.teamId).toBe(team.id);
    expect(res.body.teamName).toBe(team.name);
    expect(res.body.email).toBe('invitee@example.com');
    expect(res.body.role).toBe('editor');
    expect(res.body.expiresAt).toBeDefined();
  });

  test('returns 404 for invalid token', async () => {
    const res = await request(app).get('/api/invites/not-a-real-token');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Invalid invite token/i);
  });

  test('returns 410 for expired invite', async () => {
    const owner = await queryOne(`SELECT id FROM users WHERE email = 'testauth@example.com'`) as { id: string };
    const team = await createTeam(owner.id);
    // Create invite that expired 1ms ago
    const invite = await createInvite(team.id, owner.id, 'expired@example.com', 'viewer', -1);

    const res = await request(app).get(`/api/invites/${invite.rawToken}`);

    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/expired/i);
  });

  test('returns 410 for already-accepted invite', async () => {
    const owner = await queryOne(`SELECT id FROM users WHERE email = 'testauth@example.com'`) as { id: string };
    const team = await createTeam(owner.id);
    const invite = await createInvite(team.id, owner.id, 'accepted@example.com');

    // Mark as accepted
    await execute(`UPDATE team_invites SET accepted_at = NOW() WHERE id = $1`, [invite.id]);

    const res = await request(app).get(`/api/invites/${invite.rawToken}`);

    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/already been accepted/i);
  });
});

// ─── POST /api/invites/:token/accept ─────────────────────────────────────

describe('POST /api/invites/:token/accept', () => {
  test('accepts a valid invite and adds user to team', async () => {
    const owner = await queryOne(`SELECT id FROM users WHERE email = 'testauth@example.com'`) as { id: string };
    const team = await createTeam(owner.id);

    // Register the invitee
    const inviteeRes = await request(app)
      .post('/api/auth/register')
      .send({ email: 'invitee@example.com', password: 'password123', displayName: 'Invitee' });
    const inviteeToken = inviteeRes.body.accessToken;

    const invite = await createInvite(team.id, owner.id, 'invitee@example.com', 'editor');

    const res = await request(app)
      .post(`/api/invites/${invite.rawToken}/accept`)
      .set('Authorization', `Bearer ${inviteeToken}`);

    expect(res.status).toBe(200);
    expect(res.body.teamId).toBe(team.id);
    expect(res.body.role).toBe('editor');
  });

  test('returns 404 for invalid token', async () => {
    const res = await request(app)
      .post('/api/invites/not-a-real-token/accept')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
  });

  test('returns 403 when email does not match invite', async () => {
    const owner = await queryOne(`SELECT id FROM users WHERE email = 'testauth@example.com'`) as { id: string };
    const team = await createTeam(owner.id);
    const invite = await createInvite(team.id, owner.id, 'different@example.com');

    // authToken belongs to testauth@example.com, not different@example.com
    const res = await request(app)
      .post(`/api/invites/${invite.rawToken}/accept`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/different email/i);
  });

  test('returns 410 for expired invite', async () => {
    const owner = await queryOne(`SELECT id FROM users WHERE email = 'testauth@example.com'`) as { id: string };
    const team = await createTeam(owner.id);
    const invite = await createInvite(team.id, owner.id, 'testauth@example.com', 'editor', -1);

    const res = await request(app)
      .post(`/api/invites/${invite.rawToken}/accept`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(410);
  });
});
