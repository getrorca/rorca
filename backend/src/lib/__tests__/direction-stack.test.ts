import { synthesize } from '../direction-stack';

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
