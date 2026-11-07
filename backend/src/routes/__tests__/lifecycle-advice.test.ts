/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';

const mockAdvice = jest.fn();
const mockEvaluatorError = jest.fn();

jest.mock('../../lib/phase-advisor', () => ({
  generatePhaseAdvice: (...args: unknown[]) => mockAdvice(...args),
}));

jest.mock('../../lib/lifecycle-operations', () => ({
  recordLifecycleEvaluatorError: (...args: unknown[]) => mockEvaluatorError(...args),
}));

jest.mock('../../lib/ssdlc-lifecycle-read', () => {
  const actual = jest.requireActual('../../lib/ssdlc-lifecycle-read');
  return { ...actual };
});

import lifecycleRouter from '../lifecycle';
import { NotFoundError } from '../../lib/errors';
import { errorHandler } from '../../lib/error-handler';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.user = {
      id: 'local-admin',
      email: 'admin@rorca.local',
      supabaseId: 'local-auth',
      role: 'admin',
    };
    next();
  });
  instance.use('/api/lifecycle', lifecycleRouter);
  instance.use(errorHandler);
  return instance;
}

const ADVISORY_PAYLOAD = {
  advisory: true,
  workspaceId: 'ws-a',
  specId: 'safe-spec',
  phaseId: 'testing',
  generatedAt: '2026-07-15T12:00:00.000Z',
  suggestions: [{ text: 'Attach approved evidence to the QA gate.', cites: ['REQ-QA-1'] }],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockAdvice.mockResolvedValue(ADVISORY_PAYLOAD);
  mockEvaluatorError.mockResolvedValue(undefined);
});

describe('POST /api/lifecycle/specs/:specId/advice', () => {
  test('returns advisory suggestions for a phase without persisting anything', async () => {
    const response = await request(app())
      .post('/api/lifecycle/specs/safe-spec/advice?workspaceId=ws-a')
      .send({ phaseId: 'testing' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(ADVISORY_PAYLOAD);
    expect(response.body.advisory).toBe(true);
    expect(mockAdvice).toHaveBeenCalledWith({ workspaceId: 'ws-a', specId: 'safe-spec', phaseId: 'testing', storyId: undefined });
  });

  test('forwards the optional storyId scope', async () => {
    const response = await request(app())
      .post('/api/lifecycle/specs/safe-spec/advice?workspaceId=ws-a')
      .send({ phaseId: 'testing', storyId: 'US-011' });

    expect(response.status).toBe(200);
    expect(mockAdvice).toHaveBeenCalledWith({ workspaceId: 'ws-a', specId: 'safe-spec', phaseId: 'testing', storyId: 'US-011' });
  });

  test('rejects an unknown phaseId before calling the advisor', async () => {
    const response = await request(app())
      .post('/api/lifecycle/specs/safe-spec/advice?workspaceId=ws-a')
      .send({ phaseId: 'evidence' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(mockAdvice).not.toHaveBeenCalled();
  });

  test('rejects a missing or malformed storyId', async () => {
    const missing = await request(app())
      .post('/api/lifecycle/specs/safe-spec/advice?workspaceId=ws-a')
      .send({ phaseId: 'testing', storyId: 'bad story id!' });
    expect(missing.status).toBe(400);
    expect(mockAdvice).not.toHaveBeenCalled();

    const nonString = await request(app())
      .post('/api/lifecycle/specs/safe-spec/advice?workspaceId=ws-a')
      .send({ phaseId: 'testing', storyId: 42 });
    expect(nonString.status).toBe(400);
    expect(mockAdvice).not.toHaveBeenCalled();
  });

  test('requires workspace scope before generation', async () => {
    const response = await request(app())
      .post('/api/lifecycle/specs/safe-spec/advice')
      .send({ phaseId: 'testing' });

    expect(response.status).toBe(400);
    expect(mockAdvice).not.toHaveBeenCalled();
  });

  test('propagates unknown workspace or spec as a typed 404', async () => {
    mockAdvice.mockRejectedValueOnce(new NotFoundError('Lifecycle spec', 'missing-spec'));
    const response = await request(app())
      .post('/api/lifecycle/specs/missing-spec/advice?workspaceId=ws-b')
      .send({ phaseId: 'testing' });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  test('audits advisor failures without replacing the route error', async () => {
    mockAdvice.mockRejectedValueOnce(new Error('model budget exhausted'));
    const response = await request(app())
      .post('/api/lifecycle/specs/safe-spec/advice?workspaceId=ws-a')
      .send({ phaseId: 'testing' });

    expect(response.status).toBe(500);
    expect(mockEvaluatorError).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-a',
      specId: 'safe-spec',
      operation: 'advice',
      error: expect.any(Error),
    }));
  });
});
