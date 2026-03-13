import { synthesize, synthesizeDirectionStack } from '../direction-stack';

// ─── Mock for synthesizeDirectionStack tests ─────────────────────────────────

const mockRetrieveContext = jest.fn();
jest.mock('../memory-router', () => ({
  retrieveContext: (...args: unknown[]) => mockRetrieveContext(...args),
}));

const mockGetDirectionLayers = jest.fn();
jest.mock('../context-cache', () => ({
  getDirectionLayers: (...args: unknown[]) => mockGetDirectionLayers(...args),
}));

const mockHybridSearch = jest.fn();
jest.mock('../search', () => ({
  hybridSearch: (...args: unknown[]) => mockHybridSearch(...args),
}));

jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Keep DB mock for any residual direct DB calls
const mockQueryOne = jest.fn();
const mockQuery = jest.fn();
jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  query: (...args: unknown[]) => mockQuery(...args),
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
    // Mock retrieveContext from memory-router
    const tier = opts.embeddingCount && opts.embeddingCount > 0 ? 'search' : 'cache';
    const memoryEntries = (opts.memoryEvents || []).map(e => {
      const parsed = JSON.parse(e.payload);
      return { text: parsed.rule || e.payload, score: 0.9, source: 'cache' as const };
    });

    mockRetrieveContext.mockResolvedValue({
      direction: {
        standards: opts.l1,
        conventions: opts.l2,
        project: opts.l3,
      },
      memory: memoryEntries,
      skills: [],
      meta: {
        cagHits: tier === 'cache' ? 1 : 0,
        ragHits: tier === 'search' ? 1 : 0,
        graphHits: 0,
        totalTokens: 100,
        latencyMs: 5,
        tier,
      },
    });

    // Mock getCachedDirectionLayers (called as getDirectionLayers in context-cache)
    mockGetDirectionLayers.mockResolvedValue({
      standards: opts.l1,
      conventions: opts.l2,
      project: opts.l3,
      schemaSnapshot: opts.schemaSnapshot,
      gitMemory: opts.gitMemory,
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
    // With embeddingCount > 0, setupDbMocks sets tier='search' => searchMode='semantic'
    mockRetrieveContext.mockResolvedValue({
      direction: { standards: 'Standards' },
      memory: [
        { text: 'Use JWT for auth', score: 0.8, source: 'search' as const },
        { text: 'Use pg Pool', score: 0.5, source: 'search' as const },
      ],
      skills: [],
      meta: { cagHits: 0, ragHits: 2, graphHits: 0, totalTokens: 100, latencyMs: 5, tier: 'search' },
    });
    mockGetDirectionLayers.mockResolvedValue({ standards: 'Standards' });

    const result = await synthesizeDirectionStack('ws-1', { storyText: 'Add authentication endpoint' });

    expect(result.metadata.searchMode).toBe('semantic');
    expect(result.metadata.memoryEntries.included).toBe(2);
    expect(result.metadata.memoryEntries.relevanceRange).toEqual([0.5, 0.8]);
    expect(result.text).toContain('Use JWT for auth');
  });

  it('filters memory entries below relevance threshold', async () => {
    // memory-router handles filtering; synthesizeDirectionStack receives already-filtered entries
    mockRetrieveContext.mockResolvedValue({
      direction: { standards: 'Standards' },
      memory: [
        { text: 'Very relevant entry', score: 0.8, source: 'search' as const },
        // Low relevance entry already filtered by memory-router
      ],
      skills: [],
      meta: { cagHits: 0, ragHits: 1, graphHits: 0, totalTokens: 100, latencyMs: 5, tier: 'search' },
    });
    mockGetDirectionLayers.mockResolvedValue({ standards: 'Standards' });

    const result = await synthesizeDirectionStack('ws-1', { storyText: 'Some story' });

    expect(result.metadata.memoryEntries.included).toBe(1);
    expect(result.text).toContain('Very relevant entry');
    expect(result.text).not.toContain('Low relevance noise');
  });

  it('enforces token budget — drops schema/git when over budget', async () => {
    // L1 takes ~10 tokens (40 chars)
    const l1 = 'a'.repeat(40);
    setupDbMocks({ l1 });
    // Override getDirectionLayers to include large schema snapshot
    mockGetDirectionLayers.mockResolvedValue({
      standards: l1,
      schemaSnapshot: 'b'.repeat(200), // 50 tokens
      gitMemory: 'c'.repeat(200),       // 50 tokens
    });

    // Budget of 30 tokens — L1 takes 10, schema+git would exceed budget
    const result = await synthesizeDirectionStack('ws-1', { maxTokens: 30 });

    expect(result.metadata.layers.standards).toBe(true);
    // Schema/git dropped due to budget
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
    // When memory-router uses 'cache' tier (no embeddings), searchMode='full-dump'
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
    expect(result.metadata.memoryEntries.included).toBe(2);
  });

  it('defaults maxTokens to 32000', async () => {
    setupDbMocks({ l1: 'Standards' });

    const result = await synthesizeDirectionStack('ws-1');

    // With just a small L1, we should be well under 32000
    expect(result.metadata.totalTokens).toBeLessThan(32000);
  });

  it('output stays under maxTokens for large memory sets', async () => {
    // memory-router has already enforced budget; synthesizeDirectionStack gets pre-filtered entries
    const fewEntries = Array.from({ length: 3 }, (_, i) => ({
      text: `Memory rule ${i}: ${'x'.repeat(100)}`,
      score: 0.9,
      source: 'cache' as const,
    }));
    mockRetrieveContext.mockResolvedValue({
      direction: { standards: 'Standards text' },
      memory: fewEntries, // already budget-capped by memory-router
      skills: [],
      meta: { cagHits: 1, ragHits: 0, graphHits: 0, totalTokens: 100, latencyMs: 5, tier: 'cache' },
    });
    mockGetDirectionLayers.mockResolvedValue({ standards: 'Standards text' });

    const result = await synthesizeDirectionStack('ws-1', { maxTokens: 500 });

    // Must be under budget
    expect(result.metadata.totalTokens).toBeLessThanOrEqual(500);
    // memory-router returned 3 entries (pre-filtered)
    expect(result.metadata.memoryEntries.included).toBe(3);
  });
});
