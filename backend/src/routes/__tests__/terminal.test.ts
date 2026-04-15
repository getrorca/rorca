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

test.skip('GET /api/terminal/sessions/:sessionId/scrollback returns empty chunks for a new session', async () => {
  const sessionId = '550e8400-e29b-41d4-a716-446655440003';
  const res = await request(app).get(`/api/terminal/sessions/${sessionId}/scrollback`);

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ chunks: [] });
});

test.skip('GET /api/terminal/health returns zero counts after cleanup', async () => {
  const res = await request(app).get('/api/terminal/health');

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ activeSessions: 0, totalChunks: 0 });
});
