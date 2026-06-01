/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Tests for webhook-handlers.ts exported functions:
 * - extractStoryIds()
 * - extractStoryIdsFromCommit()
 * - handlePullRequestMerge()
 * - handlePush()
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { query, execute } from '../../db/index';
jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

jest.mock('../../lib/github-checks', () => ({
  evaluatePrAndPostCheck: jest.fn().mockResolvedValue(undefined),
}));

let tmpDir: string;
let workspaceId: string;

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

  jest.mock('../../lib/github-checks', () => ({
    evaluatePrAndPostCheck: jest.fn().mockResolvedValue(undefined),
  }));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-webhook-handlers-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

  // Initialize DB by requiring it
workspaceId = 'ws-webhook-handlers-' + Date.now();
  await execute(`INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [workspaceId,
    'Webhook Handlers Test',
    tmpDir,]);
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

// ─── extractStoryIds ───────────────────────────────────────────────────────

describe('extractStoryIds', () => {
  test('extracts story IDs from feat(US-XXX) title pattern', () => {
    const { extractStoryIds } = require('../webhook-handlers');
    const ids = extractStoryIds('feat(US-001): add login page', 'main');
    expect(ids).toContain('US-001');
  });

  test('extracts multiple story IDs from title', () => {
    const { extractStoryIds } = require('../webhook-handlers');
    const ids = extractStoryIds('feat(US-001, US-002): refactor auth', 'main');
    expect(ids).toContain('US-001');
    expect(ids).toContain('US-002');
  });

  test('extracts story ID from feat/US-XXX-slug branch name', () => {
    const { extractStoryIds } = require('../webhook-handlers');
    const ids = extractStoryIds('some commit', 'feat/US-003-add-login-page');
    expect(ids).toContain('US-003');
  });

  test('returns empty array when no story IDs found', () => {
    const { extractStoryIds } = require('../webhook-handlers');
    const ids = extractStoryIds('chore: update deps', 'main');
    expect(ids).toEqual([]);
  });

  test('is case-insensitive for US- pattern', () => {
    const { extractStoryIds } = require('../webhook-handlers');
    const ids = extractStoryIds('feat(us-004): test', 'main');
    expect(ids).toContain('US-004');
  });
});

// ─── extractStoryIdsFromCommit ─────────────────────────────────────────────

describe('extractStoryIdsFromCommit', () => {
  test('extracts story ID from feat(US-XXX): commit message', () => {
    const { extractStoryIdsFromCommit } = require('../webhook-handlers');
    const ids = extractStoryIdsFromCommit('feat(US-005): implement profile page');
    expect(ids).toContain('US-005');
  });

  test('extracts story ID from bare US-XXX in commit message', () => {
    const { extractStoryIdsFromCommit } = require('../webhook-handlers');
    const ids = extractStoryIdsFromCommit('Implements US-006 per spec');
    expect(ids).toContain('US-006');
  });

  test('returns empty array for commit with no story IDs', () => {
    const { extractStoryIdsFromCommit } = require('../webhook-handlers');
    const ids = extractStoryIdsFromCommit('fix: typo in README');
    expect(ids).toEqual([]);
  });
});

// ─── handlePush ───────────────────────────────────────────────────────────

describe('handlePush', () => {
  test('inserts story_commits records for commits with story IDs', async () => {
    // Create a spec file that includes US-007
    const approvedDir = path.join(tmpDir, 'forge', 'specs', 'approved');
    fs.mkdirSync(approvedDir, { recursive: true });
    const specId = 'test-push-spec';
    fs.writeFileSync(
      path.join(approvedDir, `${specId}.json`),
      JSON.stringify({
        title: specId,
        userStories: [{ id: 'US-007', title: 'Push test story', passes: false }],
      }),
    );

    const { handlePush } = require('../webhook-handlers');

    const payload = {
      commits: [
        {
          id: 'abc123def456',
          message: 'feat(US-007): implement push story',
          author: { name: 'Test Author' },
        },
      ],
      repository: { full_name: 'acme/repo' },
    };

    await handlePush(payload, 'push', workspaceId);

    const commits = await query(`SELECT * FROM story_commits WHERE commit_sha = 'abc123def456'`) as any[];
    expect(commits.length).toBeGreaterThanOrEqual(1);
    expect(commits[0].story_id).toBe('US-007');
  });

  test('does not insert records for commits without story IDs', async () => {
    const { handlePush } = require('../webhook-handlers');

    const payload = {
      commits: [
        {
          id: 'zzzyyy111222',
          message: 'chore: update dependencies',
          author: { name: 'Test Author' },
        },
      ],
      repository: { full_name: 'acme/repo' },
    };

    await handlePush(payload, 'push', workspaceId);

    const commits = await query(`SELECT * FROM story_commits WHERE commit_sha = 'zzzyyy111222'`) as any[];
    expect(commits).toHaveLength(0);
  });
});

// ─── handlePullRequestMerge ───────────────────────────────────────────────

describe('handlePullRequestMerge', () => {
  test('marks story as passed in spec JSON when PR is merged', async () => {
    const approvedDir = path.join(tmpDir, 'forge', 'specs', 'approved');
    fs.mkdirSync(approvedDir, { recursive: true });
    const specId = 'test-pr-merge-spec';
    const specPath = path.join(approvedDir, `${specId}.json`);
    fs.writeFileSync(
      specPath,
      JSON.stringify({
        title: specId,
        userStories: [{ id: 'US-008', title: 'PR merge story', passes: false }],
      }),
    );

    const { handlePullRequestMerge } = require('../webhook-handlers');

    const payload = {
      action: 'closed',
      pull_request: {
        merged: true,
        title: 'feat(US-008): implement PR merge story',
        head: { ref: 'feat/US-008-implement-pr-merge-story' },
        merge_commit_sha: 'merge123abc',
      },
      repository: { full_name: 'acme/repo' },
    };

    await handlePullRequestMerge(payload, 'pull_request', workspaceId);

    const updatedSpec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
    const story = updatedSpec.userStories.find((s: any) => s.id === 'US-008');
    expect(story?.passes).toBe(true);
  });

  test('does not modify spec when PR is not merged', async () => {
    const approvedDir = path.join(tmpDir, 'forge', 'specs', 'approved');
    fs.mkdirSync(approvedDir, { recursive: true });
    const specId = 'test-pr-closed-spec';
    const specPath = path.join(approvedDir, `${specId}.json`);
    const originalSpec = {
      title: specId,
      userStories: [{ id: 'US-009', title: 'Closed PR story', passes: false }],
    };
    fs.writeFileSync(specPath, JSON.stringify(originalSpec));

    const { handlePullRequestMerge } = require('../webhook-handlers');

    const payload = {
      action: 'closed',
      pull_request: {
        merged: false, // not merged, just closed
        title: 'feat(US-009): work in progress',
        head: { ref: 'feat/US-009-wip' },
        merge_commit_sha: null,
      },
      repository: { full_name: 'acme/repo' },
    };

    await handlePullRequestMerge(payload, 'pull_request', workspaceId);

    const updatedSpec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
    const story = updatedSpec.userStories.find((s: any) => s.id === 'US-009');
    expect(story?.passes).toBe(false);
  });
});
