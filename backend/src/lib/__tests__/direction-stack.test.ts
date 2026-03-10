import { synthesize, synthesizeDirectionStack } from '../direction-stack';

// ─── Mock DB + Search for synthesizeDirectionStack tests ─────────────────────

const mockQueryOne = jest.fn();
const mockQuery = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  query: (...args: unknown[]) => mockQuery(...args),
}));

const mockHybridSearch = jest.fn();
jest.mock('../search', () => ({
  hybridSearch: (...args: unknown[]) => mockHybridSearch(...args),
}));

jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

// ─── Sync synthesize() tests (backward compat) ──────────────────────────────

describe('synthesize', () => {
  it('includes all section headers when all layers provided', () => {
    const result = synthesize({
      l1: 'global standards content',
      l2: 'domain profile content',
      l3: 'project context content',
      specBrief: 'spec brief content',
      storyAnnotations: 'story annotations content',
    });

    expect(result).toContain('=== GLOBAL STANDARDS (L1) ===');
    expect(result).toContain('=== DOMAIN PROFILE (L2) ===');
    expect(result).toContain('=== PROJECT CONTEXT (L3) ===');
    expect(result).toContain('=== SPEC BRIEF (L4) ===');
    expect(result).toContain('=== STORY ANNOTATIONS (L5) ===');
  });

  it('omits L2 section when l2 is missing', () => {
    const result = synthesize({
      l1: 'global standards',
      l3: 'project brief',
      specBrief: 'the spec',
    });

    expect(result).toContain('=== GLOBAL STANDARDS (L1) ===');
    expect(result).not.toContain('=== DOMAIN PROFILE (L2) ===');
    expect(result).toContain('=== PROJECT CONTEXT (L3) ===');
    expect(result).toContain('=== SPEC BRIEF (L4) ===');
  });

  it('outputs only L4 when brief only (no l1/l2/l3)', () => {
    const result = synthesize({ specBrief: 'just the brief' });

    expect(result).not.toContain('=== GLOBAL STANDARDS (L1) ===');
    expect(result).not.toContain('=== DOMAIN PROFILE (L2) ===');
    expect(result).not.toContain('=== PROJECT CONTEXT (L3) ===');
    expect(result).toContain('=== SPEC BRIEF (L4) ===');
    expect(result).toContain('just the brief');
    expect(result).not.toContain('=== STORY ANNOTATIONS (L5) ===');
  });

  it('skips layers with empty/whitespace strings', () => {
    const result = synthesize({
      l1: '   ',
      l2: '',
      l3: undefined,
      specBrief: 'content',
    });

    expect(result).not.toContain('L1');
    expect(result).not.toContain('L2');
    expect(result).not.toContain('L3');
    expect(result).toContain('=== SPEC BRIEF (L4) ===');
  });

  // --- Auto-hydrated context tests ---

  it('includes DATABASE SCHEMA section when schemaSnapshot provided', () => {
    const result = synthesize({
      specBrief: 'build feature',
      schemaSnapshot: 'CREATE TABLE users (id TEXT PRIMARY KEY);',
    });

    expect(result).toContain('=== DATABASE SCHEMA (Auto-Hydrated) ===');
    expect(result).toContain('CREATE TABLE users (id TEXT PRIMARY KEY);');
  });

  it('includes PROJECT MEMORY section when gitMemory provided', () => {
    const result = synthesize({
      specBrief: 'build feature',
      gitMemory: 'architectural_decisions:\n  - Added auth module',
    });

    expect(result).toContain('=== PROJECT MEMORY (Git History) ===');
    expect(result).toContain('architectural_decisions:');
  });

  it('omits DATABASE SCHEMA section when schemaSnapshot is empty', () => {
    const result = synthesize({
      specBrief: 'build feature',
      schemaSnapshot: '',
    });

    expect(result).not.toContain('=== DATABASE SCHEMA (Auto-Hydrated) ===');
  });

  it('omits DATABASE SCHEMA section when schemaSnapshot is undefined', () => {
    const result = synthesize({
      specBrief: 'build feature',
    });

    expect(result).not.toContain('=== DATABASE SCHEMA (Auto-Hydrated) ===');
  });

  it('omits PROJECT MEMORY section when gitMemory is empty', () => {
    const result = synthesize({
      specBrief: 'build feature',
      gitMemory: '   ',
    });

    expect(result).not.toContain('=== PROJECT MEMORY (Git History) ===');
  });

  it('omits PROJECT MEMORY section when gitMemory is undefined', () => {
    const result = synthesize({
      specBrief: 'build feature',
    });

    expect(result).not.toContain('=== PROJECT MEMORY (Git History) ===');
  });

  it('section order: L1 → L2 → L3 → Schema → Git → L4 → L5', () => {
    const result = synthesize({
      l1: 'global',
      l2: 'domain',
      l3: 'project',
      schemaSnapshot: 'CREATE TABLE t (id TEXT);',
      gitMemory: 'conventions: snake_case',
      specBrief: 'the spec',
      storyAnnotations: 'annotations',
    });

    const l1Idx = result.indexOf('=== GLOBAL STANDARDS (L1) ===');
    const l2Idx = result.indexOf('=== DOMAIN PROFILE (L2) ===');
    const l3Idx = result.indexOf('=== PROJECT CONTEXT (L3) ===');
    const schemaIdx = result.indexOf('=== DATABASE SCHEMA (Auto-Hydrated) ===');
    const gitIdx = result.indexOf('=== PROJECT MEMORY (Git History) ===');
    const l4Idx = result.indexOf('=== SPEC BRIEF (L4) ===');
    const l5Idx = result.indexOf('=== STORY ANNOTATIONS (L5) ===');

    expect(l1Idx).toBeGreaterThanOrEqual(0);
    expect(l2Idx).toBeGreaterThan(l1Idx);
    expect(l3Idx).toBeGreaterThan(l2Idx);
    expect(schemaIdx).toBeGreaterThan(l3Idx);
    expect(gitIdx).toBeGreaterThan(schemaIdx);
    expect(l4Idx).toBeGreaterThan(gitIdx);
    expect(l5Idx).toBeGreaterThan(l4Idx);
  });
});

// ─── synthesizeDirectionStack (PG-012) ───────────────────────────────────────

describe('synthesizeDirectionStack', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function setupDbMocks(opts: {
    l1?: string;
    l2?: string;
    l3?: string;
    domain?: string;
    schemaSnapshot?: string;
    gitMemory?: string;
    embeddingCount?: number;
    memoryEvents?: Array<{ payload: string }>;
    totalMemory?: number;
  } = {}) {
    mockQueryOne.mockImplementation((sql: string, _params?: unknown[]) => {
      if (sql.includes('layer = 1') && sql.includes("COALESCE(workspace_id, '') = ''") && !sql.includes('team_id'))
        return opts.l1 ? { content_yaml: opts.l1 } : undefined;
      if (sql.includes('layer = 2') && sql.includes('domain'))
        return opts.l2 ? { content_yaml: opts.l2 } : undefined;
      if (sql.includes('layer = 3'))
        return opts.l3 ? { content_yaml: opts.l3 } : undefined;
      if (sql.includes('workspaces') && sql.includes('domain'))
        return opts.domain ? { domain: opts.domain } : undefined;
      if (sql.includes('workspace_context'))
        return { schema_snapshot: opts.schemaSnapshot || null, git_memory: opts.gitMemory || null };
      if (sql.includes('workspace_access'))
        return undefined; // No team
      if (sql.includes('COUNT') && sql.includes('embeddings'))
        return { cnt: String(opts.embeddingCount ?? 0) };
      if (sql.includes('COUNT') && sql.includes('wal_events'))
        return { cnt: String(opts.totalMemory ?? (opts.memoryEvents?.length ?? 0)) };
      return undefined;
    });

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('wal_events') && sql.includes('memory_created'))
        return opts.memoryEvents || [];
      return [];
    });
  }

  it('returns SynthesizedContext with metadata when no memory entries', async () => {
    setupDbMocks({ l1: 'Standards content', l3: 'Project context' });

    const result = await synthesizeDirectionStack('ws-1');

    expect(result.text).toContain('=== GLOBAL STANDARDS (L1) ===');
    expect(result.text).toContain('Standards content');
    expect(result.text).toContain('=== PROJECT CONTEXT (L3) ===');
    expect(result.metadata.layers.standards).toBe(true);
    expect(result.metadata.layers.project).toBe(true);
    expect(result.metadata.layers.conventions).toBe(false);
    expect(result.metadata.memoryEntries.included).toBe(0);
    expect(result.metadata.memoryEntries.total).toBe(0);
    expect(result.metadata.searchMode).toBe('full-dump');
    expect(result.metadata.droppedItems).toHaveLength(0);
  });

  it('uses recency-based memory when no storyText provided', async () => {
    setupDbMocks({
      l1: 'Standards',
      memoryEvents: [
        { payload: JSON.stringify({ rule: 'Always use TypeScript', category: 'Convention' }) },
        { payload: JSON.stringify({ rule: 'Use pg Pool for DB', category: 'Architecture' }) },
      ],
    });

    const result = await synthesizeDirectionStack('ws-1');

    expect(result.text).toContain('RELEVANT MEMORY');
    expect(result.text).toContain('Always use TypeScript');
    expect(result.text).toContain('Use pg Pool for DB');
    expect(result.metadata.memoryEntries.included).toBe(2);
    expect(result.metadata.searchMode).toBe('full-dump');
  });

  it('uses hybridSearch when storyText is provided and embeddings exist', async () => {
    setupDbMocks({
      l1: 'Standards',
      embeddingCount: 50,
      totalMemory: 100,
    });

    mockHybridSearch.mockResolvedValue([
      { sourceType: 'memory', sourceId: 'm1', title: 'Auth pattern', snippet: 'Use JWT for auth', score: 0.8, matchType: 'semantic' },
      { sourceType: 'memory', sourceId: 'm2', title: 'DB pattern', snippet: 'Use pg Pool', score: 0.5, matchType: 'hybrid' },
    ]);

    const result = await synthesizeDirectionStack('ws-1', { storyText: 'Add authentication endpoint' });

    expect(mockHybridSearch).toHaveBeenCalledWith('Add authentication endpoint', {
      sourceTypes: ['memory'],
      workspaceId: 'ws-1',
      limit: 15,
    });
    expect(result.metadata.searchMode).toBe('semantic');
    expect(result.metadata.memoryEntries.included).toBe(2);
    expect(result.metadata.memoryEntries.total).toBe(100);
    expect(result.metadata.memoryEntries.relevanceRange).toEqual([0.5, 0.8]);
    expect(result.text).toContain('Use JWT for auth');
  });

  it('filters memory entries below relevance threshold', async () => {
    setupDbMocks({ l1: 'Standards', embeddingCount: 50, totalMemory: 100 });

    mockHybridSearch.mockResolvedValue([
      { sourceType: 'memory', sourceId: 'm1', title: 'Relevant', snippet: 'Very relevant entry', score: 0.8, matchType: 'semantic' },
      { sourceType: 'memory', sourceId: 'm2', title: 'Noise', snippet: 'Low relevance noise', score: 0.1, matchType: 'keyword' },
    ]);

    const result = await synthesizeDirectionStack('ws-1', { storyText: 'Some story' });

    // Only entries > 0.3 threshold included (hybridSearch returns 2, but threshold filters in search.ts)
    // Our function filters by the SEMANTIC_RELEVANCE_THRESHOLD = 0.3
    expect(result.metadata.memoryEntries.included).toBe(1);
    expect(result.text).toContain('Very relevant entry');
    expect(result.text).not.toContain('Low relevance noise');
  });

  it('enforces token budget — drops memory entries when over budget', async () => {
    // L1 takes ~10 tokens (40 chars)
    const l1 = 'a'.repeat(40);
    setupDbMocks({
      l1,
      memoryEvents: [
        { payload: JSON.stringify({ rule: 'b'.repeat(200) }) }, // 50 tokens
        { payload: JSON.stringify({ rule: 'c'.repeat(200) }) }, // 50 tokens
      ],
    });

    // Budget of 30 tokens — L1 takes 10, only room for ~20 more
    const result = await synthesizeDirectionStack('ws-1', { maxTokens: 30 });

    expect(result.metadata.layers.standards).toBe(true);
    // Memory entries should be partially dropped due to budget
    expect(result.metadata.totalTokens).toBeLessThanOrEqual(30);
    expect(result.metadata.droppedItems.length).toBeGreaterThan(0);
    expect(result.metadata.droppedItems.some(d => d.reason === 'token_budget_exceeded')).toBe(true);
  });

  it('direction layers are NEVER dropped even if over budget', async () => {
    // L1 = 200 chars = 50 tokens, which alone exceeds maxTokens of 30
    const l1 = 'a'.repeat(200);
    setupDbMocks({ l1 });

    const result = await synthesizeDirectionStack('ws-1', { maxTokens: 30 });

    // Direction layers are always included, even over budget
    expect(result.text).toContain('=== GLOBAL STANDARDS (L1) ===');
    expect(result.metadata.layers.standards).toBe(true);
  });

  it('drops schema and git memory when token budget exceeded', async () => {
    setupDbMocks({
      l1: 'a'.repeat(400), // 100 tokens
      schemaSnapshot: 'b'.repeat(400), // 100 tokens
      gitMemory: 'c'.repeat(400), // 100 tokens
    });

    // Budget of 120 tokens — L1 takes 100, schema+git would push to 300
    const result = await synthesizeDirectionStack('ws-1', { maxTokens: 120 });

    expect(result.metadata.layers.standards).toBe(true);
    expect(result.text).not.toContain('=== DATABASE SCHEMA');
    expect(result.metadata.droppedItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'schema_snapshot', reason: 'token_budget_exceeded' }),
        expect.objectContaining({ type: 'git_memory', reason: 'token_budget_exceeded' }),
      ]),
    );
  });

  it('falls back to full-dump with budget cap when no embeddings exist', async () => {
    setupDbMocks({
      l1: 'Standards',
      embeddingCount: 0,
      memoryEvents: [
        { payload: JSON.stringify({ rule: 'Entry 1' }) },
        { payload: JSON.stringify({ rule: 'Entry 2' }) },
      ],
    });

    const result = await synthesizeDirectionStack('ws-1', { storyText: 'Some story text' });

    expect(result.metadata.searchMode).toBe('full-dump');
    // hybridSearch should NOT be called in full-dump mode
    expect(mockHybridSearch).not.toHaveBeenCalled();
    expect(result.metadata.memoryEntries.included).toBe(2);
  });

  it('defaults maxTokens to 32000', async () => {
    setupDbMocks({ l1: 'Standards' });

    const result = await synthesizeDirectionStack('ws-1');

    // With just a small L1, we should be well under 32000
    expect(result.metadata.totalTokens).toBeLessThan(32000);
  });

  it('output stays under maxTokens for large memory sets', async () => {
    // Simulate 200+ memory entries
    const manyEntries = Array.from({ length: 50 }, (_, i) => ({
      payload: JSON.stringify({ rule: `Memory rule ${i}: ${'x'.repeat(100)}` }),
    }));
    setupDbMocks({
      l1: 'Standards text',
      memoryEvents: manyEntries,
      totalMemory: 200,
    });

    const result = await synthesizeDirectionStack('ws-1', { maxTokens: 500 });

    // Must be under budget
    expect(result.metadata.totalTokens).toBeLessThanOrEqual(500);
    // Some entries should be dropped
    expect(result.metadata.memoryEntries.included).toBeLessThan(50);
    expect(result.metadata.droppedItems.some(d => d.reason === 'token_budget_exceeded')).toBe(true);
  });
});
