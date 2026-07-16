/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Tests for POST /api/pipeline/quick-run — context injection behavior.
 *
 * Tests:
 *  1. All three blocks (direction stack, MEMORY.md, skills) present and
 *     prepended in correct order before === INSTRUCTIONS ===.
 *  2. Missing MEMORY.md (ENOENT) silently skipped.
 *  3. Empty direction stack — block omitted.
 *  4. No installed skills — block omitted.
 *  5. All context missing — prompt equals instructions only.
 *  6. Acceptance criteria limit in prompt is '8'.
 *
 * Strategy:
 *  - Integration test via supertest (real DB, real server — same as pipeline.test.ts)
 *  - jest.mock at module level for llm-client to prevent real LLM calls
 *  - jest.spyOn per-test for synthesize(), fs.promises.readFile, and db.query
 *    to control what context reaches the prompt without touching DB rows
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { execute } from '../../db/index';

// ── Module-level mock: prevent real LLM calls ─────────────────────────────────

jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

// ── State ─────────────────────────────────────────────────────────────────────

let app: Express;
let tmpDir: string;
let wsDir: string;
let authToken: string;
let mockChatComplete: jest.Mock;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Valid single-story LLM response the route will accept without error. */
const VALID_LLM_RESPONSE = JSON.stringify({
  stories: [
    {
      id: 'QR-001',
      title: 'Test story',
      description: 'A description',
      acceptanceCriteria: ['AC1'],
      dependsOn: [],
    },
  ],
});

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeEach(async () => {
  try {
    jest.resetModules();

    // Re-apply the llm-client mock after resetModules
    jest.mock('../../lib/llm-client', () => ({
      chatComplete: jest.fn(),
      getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
      isValidModel: jest.fn().mockReturnValue(true),
      DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
      resolveVaultProvider: jest.fn().mockReturnValue(null),
      getModelInfo: jest.fn().mockReturnValue(undefined),
      SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
    }));

    process.env.NODE_ENV = 'test';

    const serverMod = require('../../server');
    app = serverMod.default;

    // Resolve the mock reference
    mockChatComplete = require('../../lib/llm-client').chatComplete as jest.Mock;

    // Default LLM response — parseable single-story JSON
    mockChatComplete.mockResolvedValue({ text: VALID_LLM_RESPONSE, usage: { input: 10, output: 50 } });

    // Create temp workspace dir with required forge/ structure
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-qr-test-'));
    wsDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'approved'), { recursive: true });
    fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'pending'), { recursive: true });

    // Register test user, get auth token
    authToken = await getAuthToken(app);

    // Set user to paid plan (avoids 403 plan_required guard)
    await execute(`UPDATE users SET plan = 'pro' WHERE email = 'testauth@example.com'`);

    // Seed workspace in DB (upsert to avoid duplicate key on second+ run)
    await execute(
      `INSERT INTO workspaces (id, label, path) VALUES ('ws-qr', 'QR Workspace', $1)
       ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
      [wsDir]
    );
  } catch (err) {
    console.error('[beforeEach] SETUP FAILED:', err);
    throw err;
  }
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  jest.restoreAllMocks();
  delete process.env.NODE_ENV;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/pipeline/quick-run — context injection', () => {
  test('(1) all three blocks present and prepended in correct order', async () => {
    // Arrange: spy on synthesize to return a known direction string
    const dirStack = require('../../lib/direction-stack');
    jest.spyOn(dirStack, 'synthesize').mockReturnValue('DIRECTION CONTENT');

    // Spy on fs.promises.readFile to simulate MEMORY.md present
    jest.spyOn(fs.promises, 'readFile').mockResolvedValue('MEMORY CONTENT' as any);

    // Spy on db.query to return two skills for installed_skills
    const db = require('../../db/index');
    jest.spyOn(db, 'query').mockImplementation(async (...args: unknown[]) => {
      const sql = args[0] as string;
      if (sql.includes('installed_skills')) {
        return [
          { name: 'react', description: 'React skill' },
          { name: 'tailwind', description: 'Tailwind skill' },
        ];
      }
      return [];
    });

    // Act
    const res = await request(app)
      .post('/api/pipeline/quick-run')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-qr', brief: 'Add a login page' });

    // We expect the route to reach chatComplete (or fail at LLM parse) — but
    // the important thing is chatComplete was called with the injected context.
    expect(mockChatComplete).toHaveBeenCalledTimes(1);

    const messages: Array<{ role: string; content: string }> = mockChatComplete.mock.calls[0][0];
    const prompt = messages[0].content;

    // Direction stack first
    const dirIdx = prompt.indexOf('=== DIRECTION STACK ===');
    expect(dirIdx).toBeGreaterThanOrEqual(0);
    expect(prompt).toContain('DIRECTION CONTENT');

    // MEMORY.md after direction stack
    const memIdx = prompt.indexOf('=== MEMORY.md ===');
    expect(memIdx).toBeGreaterThan(dirIdx);
    expect(prompt).toContain('MEMORY CONTENT');

    // Skills after MEMORY.md
    const skillsIdx = prompt.indexOf('=== INSTALLED SKILLS ===');
    expect(skillsIdx).toBeGreaterThan(memIdx);
    expect(prompt).toContain('- react: React skill');
    expect(prompt).toContain('- tailwind: Tailwind skill');

    // Instructions section last (after all context blocks)
    const instrIdx = prompt.indexOf('=== INSTRUCTIONS: READ THIS FIRST ===');
    expect(instrIdx).toBeGreaterThan(skillsIdx);

    // Confirm test response is not a validation error (400/403/404)
    // 422 = no run-loop engine found in test env (expected), 201/500 = normal paths
    expect([201, 422, 500]).toContain(res.status);
  });

  test('(2) missing MEMORY.md (ENOENT) is silently skipped', async () => {
    // Arrange
    const dirStack = require('../../lib/direction-stack');
    jest.spyOn(dirStack, 'synthesize').mockReturnValue('DIRECTION CONTENT');

    const enoentError = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    jest.spyOn(fs.promises, 'readFile').mockRejectedValue(enoentError);

    const db = require('../../db/index');
    jest.spyOn(db, 'query').mockImplementation(async (...args: unknown[]) => {
      const sql = args[0] as string;
      if (sql.includes('installed_skills')) return [];
      return [];
    });

    // Act
    await request(app)
      .post('/api/pipeline/quick-run')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-qr', brief: 'Add a login page' });

    expect(mockChatComplete).toHaveBeenCalledTimes(1);
    const prompt: string = mockChatComplete.mock.calls[0][0][0].content;

    // Direction block present
    expect(prompt).toContain('=== DIRECTION STACK ===');
    expect(prompt).toContain('DIRECTION CONTENT');

    // MEMORY.md block absent
    expect(prompt).not.toContain('=== MEMORY.md ===');
  });

  test('(3) empty direction stack — block omitted', async () => {
    // Arrange: synthesize returns empty string
    const dirStack = require('../../lib/direction-stack');
    jest.spyOn(dirStack, 'synthesize').mockReturnValue('');

    jest.spyOn(fs.promises, 'readFile').mockResolvedValue('MEMORY CONTENT' as any);

    const db = require('../../db/index');
    jest.spyOn(db, 'query').mockImplementation(async (...args: unknown[]) => {
      const sql = args[0] as string;
      if (sql.includes('installed_skills')) return [{ name: 'react', description: 'React' }];
      return [];
    });

    // Act
    await request(app)
      .post('/api/pipeline/quick-run')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-qr', brief: 'Add a login page' });

    expect(mockChatComplete).toHaveBeenCalledTimes(1);
    const prompt: string = mockChatComplete.mock.calls[0][0][0].content;

    // Direction block absent
    expect(prompt).not.toContain('=== DIRECTION STACK ===');

    // MEMORY.md still present
    expect(prompt).toContain('=== MEMORY.md ===');
    expect(prompt).toContain('MEMORY CONTENT');

    // Skills still present
    expect(prompt).toContain('=== INSTALLED SKILLS ===');
  });

  test('(4) no installed skills — skills block omitted', async () => {
    // Arrange
    const dirStack = require('../../lib/direction-stack');
    jest.spyOn(dirStack, 'synthesize').mockReturnValue('DIRECTION CONTENT');

    jest.spyOn(fs.promises, 'readFile').mockResolvedValue('MEMORY CONTENT' as any);

    const db = require('../../db/index');
    jest.spyOn(db, 'query').mockImplementation(async (..._args: unknown[]) => []);

    // Act
    await request(app)
      .post('/api/pipeline/quick-run')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-qr', brief: 'Add a login page' });

    expect(mockChatComplete).toHaveBeenCalledTimes(1);
    const prompt: string = mockChatComplete.mock.calls[0][0][0].content;

    // Skills block absent
    expect(prompt).not.toContain('=== INSTALLED SKILLS ===');

    // Other blocks still present
    expect(prompt).toContain('=== DIRECTION STACK ===');
    expect(prompt).toContain('=== MEMORY.md ===');
  });

  test('(5) all context missing — prompt is instructions only', async () => {
    // Arrange: no direction, no MEMORY.md, no skills
    const dirStack = require('../../lib/direction-stack');
    jest.spyOn(dirStack, 'synthesize').mockReturnValue('');

    const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    jest.spyOn(fs.promises, 'readFile').mockRejectedValue(enoentError);

    const db = require('../../db/index');
    jest.spyOn(db, 'query').mockImplementation(async (..._args: unknown[]) => []);

    // Act
    await request(app)
      .post('/api/pipeline/quick-run')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-qr', brief: 'Add a login page' });

    expect(mockChatComplete).toHaveBeenCalledTimes(1);
    const prompt: string = mockChatComplete.mock.calls[0][0][0].content;

    // No context blocks at all
    expect(prompt).not.toContain('=== DIRECTION STACK ===');
    expect(prompt).not.toContain('=== MEMORY.md ===');
    expect(prompt).not.toContain('=== INSTALLED SKILLS ===');

    // Prompt starts directly with instructions
    expect(prompt.trimStart()).toMatch(/^=== INSTRUCTIONS: READ THIS FIRST ===/);
  });

  test('(6) acceptance criteria prompt uses no fixed numeric cap', async () => {
    // Arrange: minimal context — just verify instructions text
    const dirStack = require('../../lib/direction-stack');
    jest.spyOn(dirStack, 'synthesize').mockReturnValue('');

    const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    jest.spyOn(fs.promises, 'readFile').mockRejectedValue(enoentError);

    const db = require('../../db/index');
    jest.spyOn(db, 'query').mockImplementation(async () => []);

    // Act
    await request(app)
      .post('/api/pipeline/quick-run')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-qr', brief: 'Add a login page' });

    expect(mockChatComplete).toHaveBeenCalledTimes(1);
    const prompt: string = mockChatComplete.mock.calls[0][0][0].content;

    // Must not state a max acceptance-criteria cap
    expect(prompt).toContain('use as many as needed for completeness, with no fixed target count');
  });
});
