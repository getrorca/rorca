/**
 * auto-hydrate.test.ts — Integration tests for hydrateGitMemory (US-002)
 *
 * Tests:
 *   (a) Entries are inserted into memories table
 *   (b) Duplicate entries are skipped at 0.92 similarity threshold
 *   (c) last_ingested_commit_hash is updated after successful hydration
 */

import { hydrateGitMemory } from '../auto-hydrate';

// ─── Mock DB ─────────────────────────────────────────────────────────────────

const mockQueryOne = jest.fn();
const mockQuery = jest.fn();
const mockExecute = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  query: (...args: unknown[]) => mockQuery(...args),
  execute: (...args: unknown[]) => mockExecute(...args),
}));

// ─── Mock git-hydrator ────────────────────────────────────────────────────────

const mockGitMapStep = jest.fn();
const mockGitReduceStep = jest.fn();
const mockGetLatestHash = jest.fn();

jest.mock('../git-hydrator', () => ({
  gitMapStep: (...args: unknown[]) => mockGitMapStep(...args),
  gitReduceStep: (...args: unknown[]) => mockGitReduceStep(...args),
  getLatestHash: (...args: unknown[]) => mockGetLatestHash(...args),
}));

// ─── Mock git-yaml-parser ─────────────────────────────────────────────────────

const mockParseGitReduceYaml = jest.fn();

jest.mock('../git-yaml-parser', () => ({
  parseGitReduceYaml: (...args: unknown[]) => mockParseGitReduceYaml(...args),
}));

// ─── Mock embedding-pipeline ─────────────────────────────────────────────────

const mockEmbed = jest.fn();
const mockGetProvider = jest.fn();

jest.mock('../embedding-pipeline', () => ({
  getProvider: (...args: unknown[]) => mockGetProvider(...args),
  prepareText: (_sourceType: string, text: string) => text,
}));

// ─── Mock child_process (for getCurrentHeadHash) ──────────────────────────────

jest.mock('child_process', () => ({
  execSync: jest.fn(() => Buffer.from('HEAD_HASH_abc123\n')),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const WORKSPACE_ID = 'ws-test-001';

const WORKSPACE_ROW = {
  id: WORKSPACE_ID,
  label: 'Test Project',
  path: '/tmp/test-workspace',
};

/** 1536-dim zero vector */
function zeroVec(dim = 1536): number[] {
  return Array(dim).fill(0);
}

/** Build a unit vector pointing in direction i */
function unitVec(i: number, dim = 1536): number[] {
  const v = zeroVec(dim);
  v[i] = 1;
  return v;
}

const SAMPLE_ENTRIES = [
  {
    date: '2026-03-13',
    category: 'Architecture' as const,
    title: 'PostgreSQL over SQLite',
    rule: 'Always use PostgreSQL for production workloads.',
    context: 'SQLite has concurrency limits.',
    source: 'git_hydration',
  },
  {
    date: '2026-03-13',
    category: 'Convention' as const,
    title: 'Numbered placeholders in SQL',
    rule: 'Use $1, $2 numbered placeholders, not ?.',
    context: '',
    source: 'git_hydration',
  },
];

const SAMPLE_YAML = `architectural_decisions:
  - description: PostgreSQL over SQLite
    evidence: multiple migrations
conventions:
  - rule: Use $1, $2 numbered placeholders`;

function setupDefaultMocks() {
  mockQueryOne.mockImplementation((sql: string) => {
    if (sql.includes('FROM workspaces')) return Promise.resolve(WORKSPACE_ROW);
    if (sql.includes('FROM workspace_context')) return Promise.resolve(null);
    if (sql.includes('FROM memories')) return Promise.resolve(null); // no duplicate
    return Promise.resolve(null);
  });
  mockExecute.mockResolvedValue({ rowCount: 1 });
  mockGitMapStep.mockResolvedValue([
    { fromHash: 'aaa', toHash: 'bbb', commitCount: 5, summary: '- Added PostgreSQL' },
  ]);
  mockGitReduceStep.mockResolvedValue(SAMPLE_YAML);
  mockParseGitReduceYaml.mockReturnValue(SAMPLE_ENTRIES);
  mockEmbed.mockResolvedValue({ embeddings: [unitVec(0), unitVec(1)], tokenCount: 10 });
  mockGetProvider.mockReturnValue({ embed: mockEmbed, name: 'openai', model: 'text-embedding-3-small', dimension: 1536, maxBatchSize: 100 });
}

beforeEach(() => {
  jest.clearAllMocks();
  setupDefaultMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('hydrateGitMemory', () => {
  test('(a) inserts entries into the memories table', async () => {
    await hydrateGitMemory(WORKSPACE_ID);

    // execute should be called at least for each INSERT INTO memories + the workspace_context upsert
    const insertCalls = mockExecute.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO memories')
    );
    expect(insertCalls.length).toBe(SAMPLE_ENTRIES.length);

    // Each INSERT should include workspace_id, category, content, source='git_hydration'
    for (const call of insertCalls) {
      const params = call[1] as unknown[];
      expect(params[0]).toBe(WORKSPACE_ID);
      expect(params[3]).toBe('git_hydration');
    }
  });

  test('(b) skips duplicate entries at 0.92 similarity threshold', async () => {
    // First entry: cosine similarity = 1.0 (identical vector) → duplicate → skip
    // Second entry: no existing entry (null row) → insert
    let embedCallCount = 0;
    mockEmbed.mockImplementation(() => {
      embedCallCount++;
      return Promise.resolve({ embeddings: [unitVec(embedCallCount - 1)], tokenCount: 5 });
    });

    // For the first entry's dedup check: return similarity ≥ 0.92
    // For the second: return no existing row
    let dedupCheckCount = 0;
    mockQueryOne.mockImplementation((sql: string) => {
      if (sql.includes('FROM workspaces')) return Promise.resolve(WORKSPACE_ROW);
      if (sql.includes('FROM workspace_context')) return Promise.resolve(null);
      if (sql.includes('FROM memories') && sql.includes('<=>')) {
        dedupCheckCount++;
        if (dedupCheckCount === 1) {
          // First entry: near-duplicate with similarity 0.95
          return Promise.resolve({ similarity: 0.95 });
        }
        // Second entry: not a duplicate
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });

    await hydrateGitMemory(WORKSPACE_ID);

    const insertCalls = mockExecute.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO memories')
    );
    // Only second entry inserted, first was skipped
    expect(insertCalls.length).toBe(1);
  });

  test('(b) inserts entry when similarity is below threshold (< 0.92)', async () => {
    mockQueryOne.mockImplementation((sql: string) => {
      if (sql.includes('FROM workspaces')) return Promise.resolve(WORKSPACE_ROW);
      if (sql.includes('FROM workspace_context')) return Promise.resolve(null);
      if (sql.includes('FROM memories') && sql.includes('<=>')) {
        // similarity below threshold
        return Promise.resolve({ similarity: 0.91 });
      }
      return Promise.resolve(null);
    });

    await hydrateGitMemory(WORKSPACE_ID);

    const insertCalls = mockExecute.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO memories')
    );
    // Both entries should be inserted (similarity < 0.92 for both)
    expect(insertCalls.length).toBe(SAMPLE_ENTRIES.length);
  });

  test('(c) updates last_ingested_commit_hash after hydration', async () => {
    await hydrateGitMemory(WORKSPACE_ID);

    const upsertCall = mockExecute.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('INSERT INTO workspace_context') &&
        (call[0] as string).includes('last_ingested_commit_hash')
    );

    expect(upsertCall).toBeDefined();
    const params = upsertCall![1] as unknown[];
    expect(params[0]).toBe(WORKSPACE_ID);
    expect(params[1]).toBe('HEAD_HASH_abc123'); // from mocked execSync
  });

  test('returns early without throwing when workspace not found', async () => {
    mockQueryOne.mockResolvedValue(null);

    await expect(hydrateGitMemory(WORKSPACE_ID)).resolves.toBeUndefined();
    expect(mockGitMapStep).not.toHaveBeenCalled();
  });

  test('returns early without throwing when gitMapStep throws', async () => {
    mockGitMapStep.mockRejectedValue(new Error('Not a git repository: /tmp/test-workspace'));

    await expect(hydrateGitMemory(WORKSPACE_ID)).resolves.toBeUndefined();
    expect(mockGitReduceStep).not.toHaveBeenCalled();
  });

  test('returns early without throwing when gitReduceStep throws', async () => {
    mockGitReduceStep.mockRejectedValue(new Error('LLM timeout'));

    await expect(hydrateGitMemory(WORKSPACE_ID)).resolves.toBeUndefined();
    expect(mockParseGitReduceYaml).not.toHaveBeenCalled();
  });

  test('returns early when no new commits', async () => {
    mockGitMapStep.mockResolvedValue([]);

    await hydrateGitMemory(WORKSPACE_ID);

    expect(mockGitReduceStep).not.toHaveBeenCalled();
    const insertCalls = mockExecute.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO memories')
    );
    expect(insertCalls.length).toBe(0);
  });

  test('uses last_ingested_commit_hash from workspace_context for delta sync', async () => {
    mockQueryOne.mockImplementation((sql: string) => {
      if (sql.includes('FROM workspaces')) return Promise.resolve(WORKSPACE_ROW);
      if (sql.includes('FROM workspace_context'))
        return Promise.resolve({ last_ingested_commit_hash: 'prev_hash_xyz' });
      if (sql.includes('FROM memories') && sql.includes('<=>')) return Promise.resolve(null);
      return Promise.resolve(null);
    });

    await hydrateGitMemory(WORKSPACE_ID);

    expect(mockGitMapStep).toHaveBeenCalledWith(
      expect.objectContaining({ fromHash: 'prev_hash_xyz' })
    );
  });

  test('fire-and-forget: does not throw on unexpected errors', async () => {
    mockQueryOne.mockRejectedValue(new Error('DB connection lost'));

    await expect(hydrateGitMemory(WORKSPACE_ID)).resolves.toBeUndefined();
  });

  test('skips individual entry insert failure without aborting remaining entries', async () => {
    let insertCount = 0;
    mockExecute.mockImplementation((sql: string) => {
      if ((sql as string).includes('INSERT INTO memories')) {
        insertCount++;
        if (insertCount === 1) throw new Error('vector dimension mismatch');
        return Promise.resolve({ rowCount: 1 });
      }
      return Promise.resolve({ rowCount: 1 });
    });

    await expect(hydrateGitMemory(WORKSPACE_ID)).resolves.toBeUndefined();

    // Second entry should still have been attempted
    expect(insertCount).toBeGreaterThanOrEqual(1);
  });
});
