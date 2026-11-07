/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  gitMapStep,
  gitReduceStep,
  getLatestHash,
  GitChunkSummary,
} from '../git-hydrator';

// Mock simple-git
const mockCheckIsRepo = jest.fn();
const mockRaw = jest.fn();
jest.mock('simple-git', () => {
  return jest.fn(() => ({
    checkIsRepo: mockCheckIsRepo,
    raw: mockRaw,
  }));
});

// Mock llm-client
jest.mock('../llm-client', () => ({
  chatComplete: jest.fn(),
}));
import { chatComplete } from '../llm-client';
const mockChatComplete = chatComplete as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

// --- gitMapStep tests ---

test('gitMapStep returns summaries for a valid git repo', async () => {
  mockCheckIsRepo.mockResolvedValue(true);
  mockRaw.mockImplementation((args: string[]) => {
    if (args[0] === 'log' && args.includes('--oneline')) {
      return Promise.resolve('abc123 feat: add auth\ndef456 fix: bug');
    }
    // --stat call
    return Promise.resolve('abc123 feat: add auth\n 1 file changed');
  });
  mockChatComplete.mockResolvedValue({ text: '- Switched from JWT to session auth', usage: { inputTokens: 0, outputTokens: 0 } });

  const result = await gitMapStep({ workspacePath: '/tmp/fake' });

  expect(result).toHaveLength(1);
  expect(result[0].fromHash).toBe('def456');
  expect(result[0].toHash).toBe('abc123');
  expect(result[0].commitCount).toBe(2);
  expect(result[0].summary).toBe('- Switched from JWT to session auth');
});

test('gitMapStep throws when not a git repo', async () => {
  mockCheckIsRepo.mockResolvedValue(false);

  await expect(
    gitMapStep({ workspacePath: '/not/a/repo' })
  ).rejects.toThrow('Not a git repository: /not/a/repo');
});

test('gitMapStep returns [] when no commits', async () => {
  mockCheckIsRepo.mockResolvedValue(true);
  mockRaw.mockResolvedValue('');

  const result = await gitMapStep({ workspacePath: '/tmp/fake' });
  expect(result).toEqual([]);
});

test('gitMapStep passes fromHash to log args', async () => {
  mockCheckIsRepo.mockResolvedValue(true);
  mockRaw.mockImplementation((args: string[]) => {
    if (args[0] === 'log' && args.includes('--oneline')) {
      return Promise.resolve('abc123 feat: new stuff');
    }
    return Promise.resolve('abc123 feat: new stuff\n 1 file changed');
  });
  mockChatComplete.mockResolvedValue({ text: 'No significant architectural changes in this chunk.', usage: { inputTokens: 0, outputTokens: 0 } });

  await gitMapStep({ workspacePath: '/tmp/fake', fromHash: 'prev123' });

  // Verify log was called with the hash range
  expect(mockRaw).toHaveBeenCalledWith(
    expect.arrayContaining(['prev123..HEAD'])
  );
});

test('gitMapStep processes chunks with concurrency limit', async () => {
  mockCheckIsRepo.mockResolvedValue(true);
  // Return 6 commits so with chunkSize=2 we get 3 chunks
  mockRaw.mockImplementation((args: string[]) => {
    if (args[0] === 'log' && args.includes('--oneline')) {
      return Promise.resolve(
        'a1 c1\na2 c2\na3 c3\na4 c4\na5 c5\na6 c6'
      );
    }
    return Promise.resolve('stat output');
  });
  mockChatComplete.mockResolvedValue({ text: 'bullet point', usage: { inputTokens: 0, outputTokens: 0 } });

  const result = await gitMapStep({
    workspacePath: '/tmp/fake',
    chunkSize: 2,
    concurrency: 2,
  });

  expect(result).toHaveLength(3);
  // chatComplete called 3 times (one per chunk)
  expect(mockChatComplete).toHaveBeenCalledTimes(3);
});

// --- getLatestHash tests ---

test('getLatestHash returns null for empty array', () => {
  expect(getLatestHash([])).toBeNull();
});

test('getLatestHash returns last summary toHash', () => {
  const summaries: GitChunkSummary[] = [
    { fromHash: 'a', toHash: 'b', commitCount: 5, summary: 'x' },
    { fromHash: 'c', toHash: 'd', commitCount: 3, summary: 'y' },
  ];
  expect(getLatestHash(summaries)).toBe('d');
});

// --- gitReduceStep tests ---

test('gitReduceStep returns empty string when no summaries', async () => {
  const result = await gitReduceStep({
    summaries: [],
    workspaceLabel: 'TestProject',
  });
  expect(result).toBe('');
  expect(mockChatComplete).not.toHaveBeenCalled();
});

test('gitReduceStep filters "no significant" summaries', async () => {
  const summaries: GitChunkSummary[] = [
    {
      fromHash: 'a',
      toHash: 'b',
      commitCount: 10,
      summary: 'No significant architectural changes in this chunk.',
    },
    {
      fromHash: 'c',
      toHash: 'd',
      commitCount: 5,
      summary: 'no significant changes here',
    },
  ];

  const result = await gitReduceStep({
    summaries,
    workspaceLabel: 'TestProject',
  });

  expect(result).toBe('# No significant architectural patterns detected.');
  expect(mockChatComplete).not.toHaveBeenCalled();
});

test('gitReduceStep calls LLM with meaningful summaries and returns YAML', async () => {
  const summaries: GitChunkSummary[] = [
    {
      fromHash: 'a',
      toHash: 'b',
      commitCount: 10,
      summary: '- Switched from Prisma to raw SQL\n- Added workspace isolation',
    },
    {
      fromHash: 'c',
      toHash: 'd',
      commitCount: 5,
      summary: 'No significant architectural changes in this chunk.',
    },
    {
      fromHash: 'e',
      toHash: 'f',
      commitCount: 8,
      summary: '- Multiple timezone bug fixes\n- Adopted Zustand for state',
    },
  ];

  const mockYaml = `architectural_decisions:
  - description: Switched from Prisma to raw SQL
    evidence: multiple migration files
conventions:
  - rule: Use parseISO for date handling`;
  mockChatComplete.mockResolvedValue({ text: mockYaml, usage: { inputTokens: 0, outputTokens: 0 } });

  const result = await gitReduceStep({
    summaries,
    workspaceLabel: 'CashflowAI',
  });

  expect(result).toBe(mockYaml);
  // Only 2 meaningful summaries (the "no significant" one filtered out)
  expect(mockChatComplete).toHaveBeenCalledTimes(1);
  const callArgs = mockChatComplete.mock.calls[0];
  expect(callArgs[0][0].content).toContain('CashflowAI');
  expect(callArgs[0][0].content).toContain('Chunk 1');
  expect(callArgs[0][0].content).toContain('Chunk 2');
  expect(callArgs[0][0].content).not.toContain('Chunk 3');
});

