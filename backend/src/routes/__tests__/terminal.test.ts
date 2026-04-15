```typescript
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { execute, queryOne } from '../../db/index';
import * as ptyManager from '../../lib/pty-manager';
import { resolveVaultProvider } from '../../lib/llm-client';
import { getDecryptedProviderKey } from '../../lib/vault';

// Mock pty-manager before imports
jest.mock('../../lib/pty-manager', () => ({
  createSession: jest.fn(),
  killSession: jest.fn(),
  killSessionsForWorkspace: jest.fn(),
  getSession: jest.fn(),
  activeSessions: jest.fn(),
  resizeSession: jest.fn(),
}));

// Mock llm-client before any imports that use it
jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockImplementation((m: string) =>
    ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'].includes(m)
  ),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
}));

jest.mock('../../lib/vault', () => ({
  getDecryptedProviderKey: jest.fn().mockResolvedValue(null),
}));

let app: Express;
let tmpDir: string;
let authToken: string;

const WORKSPACE_ID = 'ws-terminal-test';

beforeEach(async () => {
  jest.resetModules();
  jest.clearAllMocks();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-terminal-test-'));
  process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;

  // Seed a workspace
  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, 'Test Workspace', $2) ON CONFLICT (id) DO NOTHING`,
    [WORKSPACE_ID, tmpDir]
  );

  authToken = await getAuthToken(app);
});

afterEach(async () => {
  try {
    const { closePool } = require('../../db/index');
    await closePool();
  } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.NODE_ENV;
});

// ─── POST /api/terminal/sessions ────────────────────────────────────────────

describe('POST /api/terminal/sessions', () => {
  test('creates a PTY session and returns 201 with sessionId', async () => {
    const mockSessionId = 'session-123';
    (ptyManager.createSession as jest.Mock).mockResolvedValue(mockSessionId);

    const res = await request(app)
      .post('/api/terminal/sessions')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID, rows: 24, cols: 80 });

    expect(res.status).toBe(201);
    expect(res.body.sessionId).toBe(mockSessionId);
    expect(res.body.workspaceId).toBe(WORKSPACE_ID);
    expect(res.body.cwd).toBe(tmpDir);
    expect(res.body.rows).toBe(24);
    expect(res.body.cols).toBe(80);
    expect(res.body.createdAt).toBeDefined();

    expect(ptyManager.createSession).toHaveBeenCalledWith(
      WORKSPACE_ID,
      tmpDir,
      expect.any(Object), // env
      24,
      80
    );
  });

  test('returns 503 when node-pty is not available', async () => {
    (ptyManager.createSession as jest.Mock).mockRejectedValue({
      code: 'PTY_NOT_AVAILABLE',
      message: 'node-pty native module not loaded. Run: cd backend && npm rebuild node-pty',
    });

    const res = await request(app)
      .post('/api/terminal/sessions')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID, rows: 24, cols: 80 });

    expect(res.status).toBe(503);
    expect(res.body.error).toContain('node-pty native module not loaded');
    expect(res.body.code).toBe('SERVICE_UNAVAILABLE');
  });

  test('injects workspace vars, vault key, model, workspace id, and strips Claude nested vars', async () => {
    (ptyManager.createSession as jest.Mock).mockResolvedValue('session-env');
    (resolveVaultProvider as jest.Mock).mockReturnValue('openrouter');
    (getDecryptedProviderKey as jest.Mock).mockResolvedValue('vault-secret');

    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'entry';
    process.env.CLAUDE_AGENT_SDK_VERSION = 'sdk';
    process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = '1';
    process.env.RORCA_MODEL = 'openai/old-model';

    await execute(
      `INSERT INTO workspace_env_vars (workspace_id, key, value, updated_at)
       VALUES ($1, 'RORCA_MODEL', 'openrouter/auto', NOW()),
              ($1, 'FOO', 'bar', NOW())
       ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [WORKSPACE_ID]
    );

    const res = await request(app)
      .post('/api/terminal/sessions')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID, rows: 24, cols: 80 });

    expect(res.status).toBe(201);
    const env = (ptyManager.createSession as jest.Mock).mock.calls[0][2];
    expect(env.FOO).toBe('bar');
    expect(env.RORCA_WORKSPACE_ID).toBe(WORKSPACE_ID);
    expect(env.OPENCODE_MODEL).toBe('openrouter/auto');
    expect(env.OPENROUTER_API_KEY).toBe('vault-secret');
    expect(env.RORCA_MODEL).toBe('openrouter/auto');
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDE_AGENT_SDK_VERSION).toBeUndefined();
    expect(env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBeUndefined();
  });

  test('returns 500 with descriptive error when vault key resolution fails', async () => {
    (resolveVaultProvider as jest.Mock).mockReturnValue('anthropic');
    (getDecryptedProviderKey as jest.Mock).mockResolvedValue(null);

    await execute(
      `INSERT INTO workspace_env_vars (workspace_id, key, value, updated_at)
       VALUES ($1, 'RORCA_MODEL', 'anthropic/claude-sonnet-4-5-20250929', NOW())
       ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [WORKSPACE_ID]
    );

    const res = await request(app)
      .post('/api/terminal/sessions')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID, rows: 24, cols: 80 });

    expect(res.status).toBe(500);
    expect(String(res.body.error)).toContain('Failed to resolve active vault API key');
  });

  test('returns 404 when workspace does not exist', async () => {
    const res = await request(app)
      .post('/api/terminal/sessions')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'non-existent', rows: 24, cols: 80 });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Workspace not found');
  });

  test('defaults rows and cols if not provided', async () => {
    const mockSessionId = 'session-456';
    (ptyManager.createSession as jest.Mock).mockResolvedValue(mockSessionId);

    const res = await request(app)
      .post('/api/terminal/sessions')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID });

    expect(res.status).toBe(201);
    expect(res.body.rows).toBe(24);
    expect(res.body.cols).toBe(80);
  });

  test('returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .post('/api/terminal/sessions')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ rows: 24, cols: 80 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('workspaceId is required');
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('persists terminal session row after creation', async () => {
    const mockSessionId = '11111111-1111-1111-1111-111111111111';
    (ptyManager.createSession as jest.Mock).mockResolvedValue(mockSessionId);

    const res = await request(app)
      .post('/api/terminal/sessions')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID, rows: 24, cols: 80 });

    expect(res.status).toBe(201);

    const row = await queryOne<{
      session_id: string;
      workspace_id: string;
      status: string;
      rows: number;
      cols: number;
    }>(
      `SELECT session_id, workspace_id, status, rows, cols
       FROM terminal_sessions
       WHERE session_id = $1`,
      [mockSessionId]
    );

    expect(row).toBeDefined();
    expect(row?.workspace_id).toBe(WORKSPACE_ID);
    expect(row?.status).toBe('active');
    expect(row?.rows).toBe(24);
    expect(row?.cols).toBe(80);
  });
});

// ─── DELETE /api/terminal/sessions/:sessionId ───────────────────────────────

describe('DELETE /api/terminal/sessions/:sessionId', () => {
  test('kills session and returns 204', async () => {
    const mockSession = {
      sessionId: 'session-123',
      workspaceId: 1,
      cwd: tmpDir,
      rows: 24,
      cols: 80,
      createdAt: new Date(),
      lastActivityAt: new Date(),
    };
    (ptyManager.getSession as jest.Mock).mockReturnValue(mockSession);

    const res = await request(app)
      .delete('/api/terminal/sessions/session-123')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(204);
    expect(ptyManager.killSession).toHaveBeenCalledWith('session-123');
  });

  test('returns 404 if session does not exist', async () => {
    (ptyManager.getSession as jest.Mock).mockReturnValue(undefined);

    const res = await request(app)
      .delete('/api/terminal/sessions/non-existent')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Session not found');
  });
});

// ─── GET /api/terminal/sessions ─────────────────────────────────────────────

describe('GET /api/terminal/sessions', () => {
  test('returns active sessions', async () => {
    const mockSessions = [
      {
        sessionId: 'session-1',
        workspaceId: 1,
        cwd: '/tmp/workspace1',
        rows: 24,
        cols: 80,
        createdAt: new Date('2026-04-15T10:00:00Z'),
        lastActivityAt: new Date('2026-04-15T10:05:00Z'),
        ptyProcess: {} as any,
      },
      {
        sessionId: 'session-2',
        workspaceId: 2,
        cwd: '/tmp/workspace2',
        rows: 30,
        cols: 120,
        createdAt: new Date('2026-04-15T11:00:00Z'),
        lastActivityAt: new Date('2026-04-15T11:10:00Z'),
        ptyProcess: {} as any,
      },
    ];
    (ptyManager.activeSessions as jest.Mock).mockReturnValue(mockSessions);

    const res = await request(app)
      .get('/api/terminal/sessions')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.sessions[0].sessionId).toBe('session-1');
    expect(res.body.sessions[0].workspaceId).toBe(1);
    expect(res.body.sessions[0].cwd).toBe('/tmp/workspace1');
    expect(res.body.sessions[0].rows).toBe(24);
    expect(res.body.sessions[0].cols).toBe(80);
    expect(res.body.sessions[0].createdAt).toBeDefined();
    expect(res.body.sessions[0].lastActivityAt).toBeDefined();
  });

  test('returns empty array when no sessions exist', async () => {
    (ptyManager.activeSessions as jest.Mock).mockReturnValue([]);

    const res = await request(app)
      .get('/api/terminal/sessions')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([]);
  });
});

// ─── PATCH /api/terminal/sessions/:sessionId/resize ─────────────────────────

describe('GET /api/terminal/health', () => {
  test('returns active session and chunk counts', async () => {
    await execute(
      `INSERT INTO terminal_sessions (session_id, workspace_id, cwd, status)
       VALUES ($1, $2, $3, 'active'), ($4, $2, $3, 'ended')`,
      ['11111111-1111-4111-8111-111111111111', WORKSPACE_ID, tmpDir, '22222222-2222-4222-8222-222222222222']
    );

    await execute(
      `INSERT INTO terminal_output_chunks (session_id, sequence, data)
       VALUES ($1, 1, $2), ($1, 2, $3), ($4, 1, $5)`,
      [
        '11111111-1111-4111-8111-111111111111',
        'chunk-1',
        'chunk-2',
        '22222222-2222-4222-8222-222222222222',
        'chunk-3',
      ]
    );

    const res = await request(app)
      .get('/api/terminal/health')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ activeSessions: 1, totalChunks: 3 });
  });
});

describe('PATCH /api/terminal/sessions/:sessionId/resize', () => {
  test('resizes session and returns 200', async () => {
    const res = await request(app)
      .patch('/api/terminal/sessions/session-123/resize')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ rows: 40, cols: 120 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(ptyManager.resizeSession).toHaveBeenCalledWith('session-123', 40, 120);
  });

  test('returns 404 if session does not exist', async () => {
    (ptyManager.resizeSession as jest.Mock).mockImplementation(() => {
      throw new Error('Session session-xyz not found');
    });

    const res = await request(app)
      .patch('/api/terminal/sessions/session-xyz/resize')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ rows: 40, cols: 120 });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Session not found');
  });
});
```
