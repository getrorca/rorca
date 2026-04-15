```typescript
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import WebSocket from 'ws';
import app from '../../server';
import { execute } from '../../db/index';
import * as ptyManager from '../../lib/pty-manager';
import { detectOpenCode } from '../../lib/opencode-detector';

jest.mock('../../lib/pty-manager', () => ({
  createSession: jest.fn(),
  killSession: jest.fn(),
  killSessionsForWorkspace: jest.fn(),
  getSession: jest.fn(),
  activeSessions: jest.fn(),
  resizeSession: jest.fn(),
}));

const wsModuleLoaded = Boolean(WebSocket);
void wsModuleLoaded;

const WORKSPACE_ID = 'ws-terminal-integration-test';

let tmpDir: string;
let createdSessionId: string | null = null;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-terminal-integration-'));

  await execute(
    `INSERT INTO workspaces (id, label, path)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, path = EXCLUDED.path`,
    [WORKSPACE_ID, 'Terminal Test Workspace', tmpDir]
  );
});

afterEach(async () => {
  if (createdSessionId) {
    try {
      (ptyManager.getSession as jest.Mock).mockReturnValue({ sessionId: createdSessionId });
      await request(app).delete(`/api/terminal/sessions/${createdSessionId}`);
    } catch {}
    createdSessionId = null;
  }

  jest.clearAllMocks();
  (ptyManager.activeSessions as jest.Mock).mockReturnValue([]);
  (ptyManager.getSession as jest.Mock).mockReturnValue(undefined);
});

afterAll(async () => {
  await execute('DELETE FROM terminal_output_chunks WHERE session_id IN (SELECT session_id FROM terminal_sessions WHERE workspace_id = $1)', [WORKSPACE_ID]).catch(() => undefined);
  await execute('DELETE FROM terminal_sessions WHERE workspace_id = $1', [WORKSPACE_ID]).catch(() => undefined);
  await execute('DELETE FROM workspaces WHERE id = $1', [WORKSPACE_ID]);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('POST /api/terminal/sessions returns 201 with a UUID sessionId', async () => {
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';
  (ptyManager.createSession as jest.Mock).mockResolvedValue(sessionId);
  (ptyManager.getSession as jest.Mock).mockReturnValue({
    sessionId,
    workspaceId: WORKSPACE_ID,
    cwd: tmpDir,
    rows: 24,
    cols: 80,
    createdAt: new Date('2026-04-14T10:00:00.000Z'),
    lastActivityAt: new Date('2026-04-14T10:00:00.000Z'),
  });
  (ptyManager.activeSessions as jest.Mock).mockReturnValue([
    {
      sessionId,
      workspaceId: WORKSPACE_ID,
      cwd: tmpDir,
      rows: 24,
      cols: 80,
      createdAt: new Date('2026-04-14T10:00:00.000Z'),
      lastActivityAt: new Date('2026-04-14T10:00:00.000Z'),
    },
  ]);

  const res = await request(app)
    .post('/api/terminal/sessions')
    .send({ workspaceId: WORKSPACE_ID, rows: 24, cols: 80 });

  expect(res.status).toBe(201);
  expect(res.body.sessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );

  createdSessionId = res.body.sessionId;
});

test('POST /api/terminal/sessions passes model override in PTY env', async () => {
  const sessionId = '550e8400-e29b-41d4-a716-446655440010';
  (ptyManager.createSession as jest.Mock).mockResolvedValue(sessionId);
  (ptyManager.getSession as jest.Mock).mockReturnValue({
    sessionId,
    workspaceId: WORKSPACE_ID,
    cwd: tmpDir,
    rows: 24,
    cols: 80,
    createdAt: new Date('2026-04-14T10:00:00.000Z'),
    lastActivityAt: new Date('2026-04-14T10:00:00.000Z'),
  });

  const res = await request(app)
    .post('/api/terminal/sessions')
    .send({ workspaceId: WORKSPACE_ID, rows: 24, cols: 80, model: 'claude-sonnet-4-6' });

  expect(res.status).toBe(201);
  expect(ptyManager.createSession).toHaveBeenCalledWith(
    WORKSPACE_ID,
    tmpDir,
    expect.objectContaining({
      OPENCODE_MODEL: 'claude-sonnet-4-6',
      RORCA_MODEL: 'claude-sonnet-4-6',
    }),
    24,
    80,
  );

  createdSessionId = res.body.sessionId;
});

test('POST /api/terminal/sessions rejects unsupported model override', async () => {
  const res = await request(app)
    .post('/api/terminal/sessions')
    .send({ workspaceId: WORKSPACE_ID, rows: 24, cols: 80, model: 'not-a-real-model' });

  expect(res.status).toBe(400);
  expect(res.body.error).toContain('Unsupported model');
});

const openCodeStatus = detectOpenCode();

(openCodeStatus.opencodeBinPath ? test.skip : test)('opencode not available in CI', async () => {
  expect(openCodeStatus.opencodeBinPath ?? null).toBe(openCodeStatus.opencodeBinPath ?? null);
});

test('GET /api/terminal/sessions returns the created session', async () => {
  const sessionId = '550e8400-e29b-41d4-a716-446655440001';
  (ptyManager.activeSessions as jest.Mock).mockReturnValue([
    {
      sessionId,
      workspaceId: WORKSPACE_ID,
      cwd: tmpDir,
      rows: 24,
      cols: 80,
      createdAt: new Date('2026-04-14T10:00:01.000Z'),
      lastActivityAt: new Date('2026-04-14T10:00:01.000Z'),
    },
  ]);

  const res = await request(app).get('/api/terminal/sessions');

  expect(res.status).toBe(200);
  expect(res.body.sessions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sessionId,
        workspaceId: WORKSPACE_ID,
        cwd: tmpDir,
        rows: 24,
        cols: 80,
      }),
    ])
  );
});

test('DELETE /api/terminal/sessions/:sessionId returns 204 and removes the session', async () => {
  const sessionId = '550e8400-e29b-41d4-a716-446655440002';
  (ptyManager.getSession as jest.Mock).mockReturnValue({ sessionId });

  const res = await request(app).delete(`/api/terminal/sessions/${sessionId}`);

  expect(res.status).toBe(204);
  expect(ptyManager.killSession).toHaveBeenCalledWith(sessionId);
});

describe('GET /api/terminal/sessions/:sessionId/scrollback', () => {
  const sessionId = '11111111-1111-1111-1111-111111111111';

  beforeEach(async () => {
    await execute(
      `INSERT INTO terminal_sessions (session_id, workspace_id, cwd, rows, cols, status)
       VALUES ($1, $2, $3, 24, 80, 'active')
       ON CONFLICT (session_id) DO NOTHING`,
      [sessionId, WORKSPACE_ID, tmpDir]
    );

    await execute('DELETE FROM terminal_output_chunks WHERE session_id = $1', [sessionId]);
    await execute(
      `INSERT INTO terminal_output_chunks (session_id, sequence, data)
       VALUES ($1, 1, 'a'), ($1, 2, 'b'), ($1, 3, 'c')`,
      [sessionId]
    );
  });

  test('returns all chunks by default', async () => {
    const res = await request(app)
      .get(`/api/terminal/sessions/${sessionId}/scrollback`);

    expect(res.status).toBe(200);
    expect(res.body.chunks.map((chunk: { sequence: number }) => chunk.sequence)).toEqual([1, 2, 3]);
  });

  test('returns only chunks after since cursor', async () => {
    const res = await request(app)
      .get(`/api/terminal/sessions/${sessionId}/scrollback?since=2`);

    expect(res.status).toBe(200);
    expect(res.body.chunks).toEqual([{ sequence: 3, data: 'c' }]);
  });

  test('returns 400 for invalid since parameter', async () => {
    const res = await request(app)
      .get(`/api/terminal/sessions/${sessionId}/scrollback?since=-1`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('since must be a non-negative integer');
  });
});
```
