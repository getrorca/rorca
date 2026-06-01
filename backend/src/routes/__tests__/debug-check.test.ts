/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as os from 'os';

jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

let app: any;

beforeEach(async () => {
  process.stderr.write('BEFORE_EACH_START\n');
  try {
    jest.resetModules();
    jest.mock('../../lib/llm-client', () => ({
      chatComplete: jest.fn(),
      getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
      isValidModel: jest.fn().mockReturnValue(true),
      resolveVaultProvider: jest.fn().mockReturnValue(null),
      getModelInfo: jest.fn().mockReturnValue(undefined),
      DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
      SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
    }));
    process.env.NODE_ENV = 'test';
    process.stderr.write('LOADING_SERVER\n');
    const serverMod = require('../../server');
    app = serverMod.default;
    process.stderr.write('SERVER_LOADED\n');

    const { execute } = require('../../db/index');
    await execute(`INSERT INTO workspaces (id, label, path) VALUES ('ws-dbg', 'Debug WS', $1) ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`, [os.tmpdir()]);
    process.stderr.write('WORKSPACE_SEEDED\n');
  } catch(e: any) {
    process.stderr.write(`BEFORE_EACH_ERROR: ${e.message}\n${e.stack}\n`);
    throw e;
  }
});

test('debug: simple test', async () => {
  process.stderr.write('TEST_BODY_REACHED\n');
  expect(1).toBe(1);
});
