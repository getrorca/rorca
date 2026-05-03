/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

const mockQueryOne = jest.fn().mockResolvedValue(undefined);
const mockQuery = jest.fn().mockResolvedValue([]);
const mockExecute = jest.fn().mockResolvedValue({ rowCount: 0 });
const mockDetectPi = jest.fn();
const mockListPiModels = jest.fn();

jest.mock('../db/index', () => ({
  query: (...args) => mockQuery(...args),
  queryOne: (...args) => mockQueryOne(...args),
  execute: (...args) => mockExecute(...args),
}));

jest.mock('../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../lib/pi-detector', () => ({
  PI_INSTALL_METHODS: {
    npm: 'npm install -g @mariozechner/pi-coding-agent',
    pnpm: 'pnpm add -g @mariozechner/pi-coding-agent',
    bun: 'bun add -g @mariozechner/pi-coding-agent',
    curl: 'curl -fsSL https://pi.mariozechner.com/install.sh | sh',
  },
  detectPi: (...args) => mockDetectPi(...args),
  listPiModels: (...args) => mockListPiModels(...args),
}));

async function buildApp() {
  const express = require('express');
  const configRouter = require('../routes/config').default;
  const { errorHandler } = require('../lib/error-handler');

  const app = express();
  app.use(express.json());
  app.use('/api/config', configRouter);
  app.use(errorHandler);
  return app;
}

describe('CLI-016: GET /api/config/pi-models', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('returns 200 with models, count, and piBinPath when Pi CLI is installed', async () => {
    mockDetectPi.mockReturnValue({
      piInstalled: true,
      piVersion: '1.2.3',
      piBinPath: '/usr/local/bin/pi',
    });
    mockListPiModels.mockReturnValue([
      {
        provider: 'openai',
        model: 'gpt-5',
        contextTokens: 200000,
        maxOutTokens: 100000,
        thinking: true,
        images: false,
      },
    ]);

    const app = await buildApp();
    const request = require('supertest');
    const res = await request(app).get('/api/config/pi-models');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      models: [
        {
          provider: 'openai',
          model: 'gpt-5',
          contextTokens: 200000,
          maxOutTokens: 100000,
          thinking: true,
          images: false,
        },
      ],
      count: 1,
      piBinPath: '/usr/local/bin/pi',
    });
    expect(mockListPiModels).toHaveBeenCalledWith('/usr/local/bin/pi');
  });

  it('returns 404 with PI_NOT_FOUND and install methods when Pi CLI is missing', async () => {
    mockDetectPi.mockReturnValue({
      piInstalled: false,
      piVersion: null,
      piBinPath: null,
    });

    const app = await buildApp();
    const request = require('supertest');
    const res = await request(app).get('/api/config/pi-models');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: 'Pi CLI not installed',
      code: 'PI_NOT_FOUND',
      installMethods: {
        npm: 'npm install -g @mariozechner/pi-coding-agent',
        pnpm: 'pnpm add -g @mariozechner/pi-coding-agent',
        bun: 'bun add -g @mariozechner/pi-coding-agent',
        curl: 'curl -fsSL https://pi.mariozechner.com/install.sh | sh',
      },
    });
    expect(mockListPiModels).not.toHaveBeenCalled();
  });

  it('caches the response for 60 seconds', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    mockDetectPi.mockReturnValue({
      piInstalled: true,
      piVersion: '1.2.3',
      piBinPath: '/usr/local/bin/pi',
    });
    mockListPiModels.mockReturnValue([
      {
        provider: 'anthropic',
        model: 'claude-sonnet',
        contextTokens: 200000,
        maxOutTokens: 32000,
        thinking: true,
        images: true,
      },
    ]);

    const app = await buildApp();
    const request = require('supertest');

    nowSpy.mockReturnValue(1_000);
    const first = await request(app).get('/api/config/pi-models');

    nowSpy.mockReturnValue(30_000);
    const second = await request(app).get('/api/config/pi-models');

    nowSpy.mockReturnValue(61_001);
    const third = await request(app).get('/api/config/pi-models');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    expect(mockListPiModels).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });
});
