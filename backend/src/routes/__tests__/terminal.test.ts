/**
 * OCT-024: Terminal route tests — graceful node-pty failure
 */

import request from 'supertest';
import express from 'express';
import terminalRouter from '../terminal';
import { errorHandler } from '../../lib/error-handler';

// Mock dependencies
jest.mock('../../lib/pty-manager');
jest.mock('../../db/index');

const mockPtyManager = require('../../lib/pty-manager');
const mockDb = require('../../db/index');

describe('POST /api/terminal/sessions', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/terminal', terminalRouter);
    app.use(errorHandler);
    jest.clearAllMocks();
  });

  it('returns 503 when node-pty is not available', async () => {
    // Mock workspace query to succeed
    mockDb.queryOne.mockResolvedValue({ id: 1, path: '/fake/workspace' });

    // Mock createSession to throw PTY_NOT_AVAILABLE error
    mockPtyManager.createSession.mockRejectedValue({
      code: 'PTY_NOT_AVAILABLE',
      message: 'node-pty native module not loaded. Run: cd backend && npm rebuild node-pty',
    });

    const res = await request(app)
      .post('/api/terminal/sessions')
      .send({ workspaceId: 1, rows: 24, cols: 80 })
      .expect(503);

    expect(res.body).toMatchObject({
      error: expect.stringContaining('node-pty native module not loaded'),
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('returns 404 when workspace does not exist', async () => {
    mockDb.queryOne.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/terminal/sessions')
      .send({ workspaceId: 999, rows: 24, cols: 80 })
      .expect(404);

    expect(res.body).toMatchObject({
      error: expect.stringContaining('Workspace'),
      code: 'NOT_FOUND',
    });
  });

  it('returns 201 when PTY session is created successfully', async () => {
    mockDb.queryOne.mockResolvedValue({ id: 1, path: '/fake/workspace' });
    mockPtyManager.createSession.mockResolvedValue('test-session-id-123');

    const res = await request(app)
      .post('/api/terminal/sessions')
      .send({ workspaceId: 1, rows: 24, cols: 80 })
      .expect(201);

    expect(res.body).toEqual({ sessionId: 'test-session-id-123' });
    expect(mockPtyManager.createSession).toHaveBeenCalledWith(
      1,
      '/fake/workspace',
      expect.any(Object), // process.env
      24,
      80
    );
  });

  it('returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .post('/api/terminal/sessions')
      .send({ rows: 24, cols: 80 })
      .expect(400);

    expect(res.body).toMatchObject({
      error: expect.stringContaining('workspaceId is required'),
      code: 'VALIDATION_ERROR',
    });
  });
});
