/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Unit tests for US-017 context-excerpts.ts — Safe excerpts and token budget allocator.
 *
 * Validates the acceptance criteria:
 *   - Max bytes/tokens per file and total bundle budget are enforced
 *   - Excerpts include path, reason, relation/provenance, line ranges where available
 *   - Secret redaction runs before persistence/composition
 *   - Tests cover large files, matched excerpts, docs, tests, redaction, budget exhaustion
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';


import {
  allocateBudgets,
  buildExcerptBundle,
  estimateTokens,
  extractLineRanges,
  readFileExcerpt,
  summarizeBundle,
} from '../context-excerpts';
import type {
  Excerpt,
  ExcerptBundle,
  LineRange,
  SectionBudget,
} from '../context-excerpts';
import type { RankedRetrievalCandidate } from '../retrieval-pipeline';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCandidate(overrides: Partial<RankedRetrievalCandidate> = {}): RankedRetrievalCandidate {
  return {
    id: 'test-file.ts',
    key: 'test-file.ts',
    text: 'function hello() { return "world"; }',
    title: 'Test File',
    origin: 'search',
    baseScore: 0.85,
    matchType: 'semantic',
    tokenCount: 8,
    canonicalKey: 'file:test-workspace::test-file.ts',
    lexicalScore: 0.5,
    semanticScore: 0.85,
    graphScore: 0.3,
    freshnessScore: 0.7,
    confidenceScore: 0.8,
    fileOverlapScore: 0.0,
    validatorScore: 0.5,
    historicalScore: 0.3,
    fileRoleScore: 0.0,
    fileSizeGeneratedScore: 0.0,
    semanticRankScore: 0.85,
    finalScore: 0.78,
    preRerankPosition: null,
    rerankedBy: 'semantic',
    decision: 'keep',
    conflictsWith: [],
    reasons: ['semantic match on "hello"'],
    scoring: {
      schemaVersion: 'v2',
      score: 0.78,
      bounded: true,
      deterministic: true,
      tieBreak: {
        canonicalKey: 'file:test-workspace::test-file.ts',
        sourceStoryKey: null,
        storySlug: null,
        candidateId: 'test-file.ts',
      },
      breakdown: {
        directGraphProximity: {
          score: 0.3,
          hops: 2,
          proximityUnavailable: false,
          nodeType: 'file',
          signalCount: 1,
          scopeValid: true,
        },
        scopeStrength: {
          score: 0.5,
          workspace: 1,
          spec: 0,
          story: 0,
          file: 0.5,
          workspaceKey: 'workspace:test-workspace',
          specKey: null,
          storyKey: null,
          fileKeys: [],
        },
        recency: { score: 0.7 },
        pinnedStatus: { score: 0 },
        provenanceConfidence: {
          score: 0.8,
          confidence: 'high',
          sourceType: 'manual',
          source: 'wal',
        },
        retrievalSignal: { score: 0.85, base: 0.85, lexical: 0.5, semantic: 0.85 },
        skillAlignment: { score: 0, matchedSkills: [] },
        historicalUsefulness: { score: 0.3, feedbackKey: 'none' },
        fileRoleBoost: { score: 0.01, roles: ['source'], capped: false },
        fileSizeGenerated: { score: 0, sizeScore: 0, generatedScore: 0 },
        diversityPenalty: { score: 0, comparedTo: null, similarity: 0 },
        echoChamberPenalty: { score: 0, comparedTo: null, similarity: 0 },
        repetitionPenalty: { score: 0, comparedTo: null, similarity: 0 },
        duplicationPenalty: { score: 0, comparedTo: null, similarity: 0 },
      },
      ontology: {
        applied: false,
        stale: false,
        suppressed: false,
        conflict: false,
        reasons: [],
      },
      validation: { valid: true, issues: [] },
      rerank: {
        requestedGraphScoreWeight: 0,
        appliedGraphScoreWeight: 0,
        semanticRankScore: 0.85,
        blendedScore: 0.85,
        preRerankPosition: null,
        finalPosition: null,
        rerankedBy: 'semantic',
      },
    },
    ...overrides,
  };
}

function withTempWorkspace(): [string, () => void] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-excerpts-test-'));
  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  };
  return [dir, cleanup];
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS: estimateTokens
// ════════════════════════════════════════════════════════════════════════════

describe('estimateTokens', () => {
  it('returns 0 for empty text', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('returns ceil of 4-char heuristic', () => {
    expect(estimateTokens('abcd')).toBe(1); // exactly 4 chars = 1 token
    expect(estimateTokens('abcde')).toBe(2); // 5 chars → ceil(1.25) = 2
  });

  it('handles large text', () => {
    const text = 'x'.repeat(4000);
    expect(estimateTokens(text)).toBe(1000); // 4000/4 = 1000
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TESTS: extractLineRanges
// ════════════════════════════════════════════════════════════════════════════

describe('extractLineRanges', () => {
  const content = [
    '// Header comment',
    'import { something } from "./module";',
    '',
    '/** JSDoc for hello */',
    'export function hello() {',
    '  return "world";',
    '}',
    '',
    'export function goodbye() {',
    '  return "moon";',
    '}',
  ].join('\n');

  it('returns empty for empty content', () => {
    expect(extractLineRanges('', 'hello function')).toEqual([]);
  });

  it('returns empty for empty candidate text', () => {
    expect(extractLineRanges(content, '')).toEqual([]);
  });

  it('finds lines containing keywords from candidate text', () => {
    const ranges = extractLineRanges(content, 'hello world function');
    expect(ranges.length).toBeGreaterThan(0);
    // "hello" is on line 5, "world" on line 6, "function" on line 5 and 9
    expect(ranges.some((r: LineRange) => r.start <= 5 && r.end >= 6)).toBe(true);
  });

  it('respects maxRanges', () => {
    const ranges = extractLineRanges(content, 'hello world function', { maxRanges: 1 });
    expect(ranges.length).toBe(1);
  });

  it('respects contextLines', () => {
    const ranges = extractLineRanges(content, 'hello', { contextLines: 1 });
    expect(ranges.length).toBeGreaterThan(0);
    // With contextLines=1, range around line 5 should be lines 4-6
    const mainRange = ranges[0];
    expect(mainRange.start).toBeLessThanOrEqual(5);
    expect(mainRange.end).toBeGreaterThanOrEqual(5);
    expect(mainRange.end - mainRange.start).toBeLessThanOrEqual(3); // ±1 context
  });

  it('merges overlapping ranges', () => {
    const content = [
      'import a from "./a";', // line 1
      'import b from "./b";', // line 2
      'import c from "./c";', // line 3
      'import d from "./d";', // line 4
      'import e from "./e";', // line 5
    ].join('\n');
    const ranges = extractLineRanges(content, 'import a c d', { contextLines: 1 });
    // lines 1-5 all match "import" — should merge into one range
    expect(ranges.length).toBe(1);
    expect(ranges[0].start).toBe(1);
    expect(ranges[0].end).toBe(5);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TESTS: readFileExcerpt
// ════════════════════════════════════════════════════════════════════════════

describe('readFileExcerpt', () => {
  it('reads head of file bounded by maxBytes', () => {
    const [workspaceRoot, cleanup] = withTempWorkspace();
    try {
      // Write a large file (100KB)
      const largeContent = 'A'.repeat(100 * 1024);
      fs.writeFileSync(path.join(workspaceRoot, 'large.ts'), largeContent);

      const excerpt = readFileExcerpt(workspaceRoot, 'large.ts', { maxBytes: 1024 });
      expect(excerpt).toContain('large.ts');
      expect(Buffer.byteLength(excerpt, 'utf8')).toBeLessThanOrEqual(1024 + 200); // header overhead
      expect(excerpt).toContain('[TRUNCATED]');
    } finally {
      cleanup();
    }
  });

  it('handles specific line ranges', () => {
    const [workspaceRoot, cleanup] = withTempWorkspace();
    try {
      const content = [
        'line1: hello',
        'line2: world',
        'line3: foo',
        'line4: bar',
        'line5: baz',
      ].join('\n');
      fs.writeFileSync(path.join(workspaceRoot, 'lines.ts'), content);

      const excerpt = readFileExcerpt(workspaceRoot, 'lines.ts', {
        lineRanges: [{ start: 2, end: 4 }],
      });

      expect(excerpt).toContain('Lines 2-4');
      expect(excerpt).toContain('line2: world');
      expect(excerpt).toContain('line3: foo');
      expect(excerpt).toContain('line4: bar');
      expect(excerpt).not.toContain('line1: hello');
      expect(excerpt).not.toContain('line5: baz');
    } finally {
      cleanup();
    }
  });

  it('handles missing files gracefully', () => {
    const [workspaceRoot, cleanup] = withTempWorkspace();
    try {
      const excerpt = readFileExcerpt(workspaceRoot, 'missing.ts');
      expect(excerpt).toContain('File not found: missing.ts');
    } finally {
      cleanup();
    }
  });

  it('handles directories gracefully', () => {
    const [workspaceRoot, cleanup] = withTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspaceRoot, 'adir'));
      const excerpt = readFileExcerpt(workspaceRoot, 'adir');
      expect(excerpt).toContain('Directory: adir');
    } finally {
      cleanup();
    }
  });

  it('respects byte-level truncation', () => {
    const [workspaceRoot, cleanup] = withTempWorkspace();
    try {
      const content = 'x'.repeat(2000);
      fs.writeFileSync(path.join(workspaceRoot, 'small.ts'), content);

      const excerpt = readFileExcerpt(workspaceRoot, 'small.ts', { maxBytes: 500 });
      const excerptBytes = Buffer.byteLength(excerpt, 'utf8');
      expect(excerptBytes).toBeLessThanOrEqual(700); // header + some content
    } finally {
      cleanup();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TESTS: allocateBudgets
// ════════════════════════════════════════════════════════════════════════════

describe('allocateBudgets', () => {
  it('distributes budget by weight', () => {
    const { allocations, totalAllocated } = allocateBudgets(
      [],
      10000,
      { files: 0.5, tests: 0.3, docs: 0.2 },
    );

    expect(allocations.get('files')).toBe(5000);
    expect(allocations.get('tests')).toBe(3000);
    expect(allocations.get('docs')).toBe(2000);
    expect(totalAllocated).toBe(10000);
  });

  it('normalizes weights that do not sum to 1', () => {
    const { allocations } = allocateBudgets([], 10000, { files: 1, tests: 1 });
    // Normalized: files=0.5, tests=0.5
    expect(allocations.get('files')).toBe(5000);
    expect(allocations.get('tests')).toBe(5000);
  });

  it('handles empty weights', () => {
    const { allocations, totalAllocated } = allocateBudgets([], 10000, {});
    expect(totalAllocated).toBe(0);
    expect(allocations.size).toBe(0);
  });

  it('handles default weights', () => {
    const { allocations } = allocateBudgets([], 10000);
    expect(allocations.get('directions')).toBe(500); // 5%
    expect(allocations.get('files')).toBe(3500); // 35%
    expect(allocations.get('memories')).toBe(2500); // 25%
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TESTS: buildExcerptBundle — acceptance criteria coverage
// ════════════════════════════════════════════════════════════════════════════

describe('buildExcerptBundle', () => {
  it('enforces total bundle token budget', async () => {
    const [workspaceRoot, cleanup] = withTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
      // Write content that's about 1250 chars → ~312 tokens each
      const content = '// ' + 'x'.repeat(1246);
      fs.writeFileSync(path.join(workspaceRoot, 'src/app.ts'), content);
      fs.writeFileSync(path.join(workspaceRoot, 'src/util.ts'), content);

      const candidates = [
        makeCandidate({
          id: 'src/app.ts',
          canonicalKey: 'file:w::src/app.ts',
          text: 'application entrypoint',
          finalScore: 0.9,
          tokenCount: 312,
          scoring: {
            ...makeCandidate().scoring,
            score: 0.9,
          },
        }),
        makeCandidate({
          id: 'src/util.ts',
          canonicalKey: 'file:w::src/util.ts',
          text: 'utility functions',
          finalScore: 0.7,
          tokenCount: 312,
          scoring: {
            ...makeCandidate().scoring,
            score: 0.7,
          },
        }),
      ] as any[];

      // Budget fits about 1 file (400 tokens, one 312-token file fits)
      const bundle = await buildExcerptBundle({
        candidates,
        workspaceRoot,
        totalTokenBudget: 400,
        maxBytesPerExcerpt: 32 * 1024,
        maxExcerpts: 10,
      });

      expect(bundle.totalTokenBudget).toBe(400);
      expect(bundle.totalTokensUsed).toBeLessThanOrEqual(400);
      // Verify that some candidates went to sections and some were dropped
      const totalExcerpts = bundle.sections.reduce(
        (sum: number, s: SectionBudget) => sum + s.excerpts.length,
        0,
      );
      // The total of kept + dropped should equal input count
      expect(totalExcerpts + bundle.dropped.length).toBe(candidates.length);
      // At least one was dropped (budget too small for both)
      expect(bundle.dropped.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  it('enforces max bytes per file', async () => {
    const [workspaceRoot, cleanup] = withTempWorkspace();
    try {
      const largeContent = 'function x() {\n' + '  // ' + 'z'.repeat(20000) + '\n}\n';
      fs.writeFileSync(path.join(workspaceRoot, 'large.ts'), largeContent);

      const candidate = makeCandidate({
        id: 'large.ts',
        canonicalKey: 'file:w::large.ts',
        text: 'large function file',
        finalScore: 0.95,
      }) as any;

      const bundle = await buildExcerptBundle({
        candidates: [candidate],
        workspaceRoot,
        totalTokenBudget: 100000,
        maxBytesPerExcerpt: 512, // force small excerpt
        maxExcerpts: 10,
      });

      const allExcerpts = bundle.sections.flatMap((s: SectionBudget) => s.excerpts);
      for (const excerpt of allExcerpts) {
        // The redacted content should be bounded to maxBytes + header overhead
        expect(excerpt.byteLengthAfterRedaction).toBeLessThanOrEqual(1024);
      }
    } finally {
      cleanup();
    }
  });

  it('excerpts include path, reason, relation/provenance', async () => {
    const [workspaceRoot, cleanup] = withTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(workspaceRoot, 'src/main.ts'),
        'export function main() { return 1; }',
      );

      const candidate = makeCandidate({
        id: 'src/main.ts',
        canonicalKey: 'file:w::src/main.ts',
        text: 'main entry point function',
        finalScore: 0.9,
        graphRelationship: 'TOUCHES',
        sourceType: 'graph',
        scoring: {
          ...makeCandidate().scoring,
          breakdown: {
            ...makeCandidate().scoring.breakdown,
            provenanceConfidence: {
              score: 0.9,
              confidence: 'high',
              sourceType: 'graph',
              source: 'hilo',
            },
          },
        },
      }) as any;

      const bundle = await buildExcerptBundle({
        candidates: [candidate],
        workspaceRoot,
        totalTokenBudget: 10000,
      });

      const allExcerpts = bundle.sections.flatMap((s: SectionBudget) => s.excerpts);
      expect(allExcerpts.length).toBeGreaterThan(0);

      const excerpt = allExcerpts[0];
      // Path is included
      expect(excerpt.path).toBe('src/main.ts');
      // Reason is included
      expect(excerpt.reason.length).toBeGreaterThan(0);
      expect(excerpt.reason).toContain('semantic_match');
      // Provenance includes relation and source type
      expect(excerpt.provenance.relation).toBe('TOUCHES');
      expect(excerpt.provenance.sourceType).toBe('graph');
      expect(excerpt.provenance.confidence).toBe('high');
    } finally {
      cleanup();
    }
  });

  it('line ranges are included when available', async () => {
    const [workspaceRoot, cleanup] = withTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
      const content = [
        '// header',
        'import { something } from "./mod";',
        '',
        '/** This is the main function */',
        'export function main() {',
        '  return computeResult(42);',
        '}',
        '',
        'function computeResult(n: number) {',
        '  return n * 2;',
        '}',
      ].join('\n');
      fs.writeFileSync(path.join(workspaceRoot, 'src/main.ts'), content);

      // Candidate text has keywords matching "main" and "computeResult"
      const candidate = makeCandidate({
        id: 'src/main.ts',
        text: 'main function computeResult computes the answer',
        finalScore: 0.95,
      }) as any;

      const bundle = await buildExcerptBundle({
        candidates: [candidate],
        workspaceRoot,
        totalTokenBudget: 10000,
        includeLineRanges: true,
      });

      const allExcerpts = bundle.sections.flatMap((s: SectionBudget) => s.excerpts);
      expect(allExcerpts.length).toBeGreaterThan(0);
      const excerpt = allExcerpts[0];

      // Should have line ranges around the matching keywords
      if (excerpt.lineRanges && excerpt.lineRanges.length > 0) {
        const ranges = excerpt.lineRanges;
        // "main" is on line 5, "computeResult" on line 9
        expect(ranges.some((r: LineRange) => r.start <= 5 && r.end >= 5)).toBe(true);
      }
    } finally {
      cleanup();
    }
  });

  it('redacts secrets before output', async () => {
    const [workspaceRoot, cleanup] = withTempWorkspace();
    try {
      const contentWithSecret = `
        const API_KEY = "sk-ant-secret1234567890abcdef";
        const password = "super-secret-password";
        function foo() { return 1; }
      `;
      fs.writeFileSync(path.join(workspaceRoot, 'config.ts'), contentWithSecret);

      const candidate = makeCandidate({
        id: 'config.ts',
        text: 'configuration with API keys',
        finalScore: 0.8,
      }) as any;

      const bundle = await buildExcerptBundle({
        candidates: [candidate],
        workspaceRoot,
        totalTokenBudget: 10000,
      });

      const allExcerpts = bundle.sections.flatMap((s: SectionBudget) => s.excerpts);
      expect(allExcerpts.length).toBeGreaterThan(0);

      const excerpt = allExcerpts[0];
      // Secrets should be redacted
      expect(excerpt.content).toContain('[REDACTED]');
      expect(excerpt.content).not.toContain('sk-ant-secret1234567890abcdef');
      expect(excerpt.content).not.toContain('super-secret-password');
    } finally {
      cleanup();
    }
  });

  it('handles docs (README.md) as doc category', async () => {
    const [workspaceRoot, cleanup] = withTempWorkspace();
    try {
      fs.writeFileSync(
        path.join(workspaceRoot, 'README.md'),
        '# My Project\n\nThis is the documentation.\n',
      );

      const candidate = makeCandidate({
        id: 'README.md',
        text: 'project documentation overview',
        finalScore: 0.7,
      }) as any;

      const bundle = await buildExcerptBundle({
        candidates: [candidate],
        workspaceRoot,
        totalTokenBudget: 10000,
      });

      const allExcerpts = bundle.sections.flatMap((s: SectionBudget) => s.excerpts);
      expect(allExcerpts.length).toBeGreaterThan(0);
      expect(allExcerpts[0].category).toBe('doc');
      expect(allExcerpts[0].content).toContain('My Project');
    } finally {
      cleanup();
    }
  });

  it('handles test files as test category', async () => {
    const [workspaceRoot, cleanup] = withTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspaceRoot, 'src', '__tests__'), { recursive: true });
      fs.writeFileSync(
        path.join(workspaceRoot, 'src/__tests__/app.test.ts'),
        'describe("app", () => { it("works", () => {}); });',
      );

      const candidate = makeCandidate({
        id: 'src/__tests__/app.test.ts',
        text: 'application test suite',
        finalScore: 0.6,
      }) as any;

      const bundle = await buildExcerptBundle({
        candidates: [candidate],
        workspaceRoot,
        totalTokenBudget: 10000,
      });

      const allExcerpts = bundle.sections.flatMap((s: SectionBudget) => s.excerpts);
      expect(allExcerpts.length).toBeGreaterThan(0);
      expect(allExcerpts[0].category).toBe('test');
    } finally {
      cleanup();
    }
  });

  it('reports budget exhaustion in summary', async () => {
    const [workspaceRoot, cleanup] = withTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
      const content = '// ' + 'a'.repeat(10000);
      const candidates: RankedRetrievalCandidate[] = [];
      for (let i = 0; i < 10; i++) {
        const filePath = `src/file_${i}.ts`;
        fs.writeFileSync(path.join(workspaceRoot, filePath), content);
        candidates.push(makeCandidate({
          id: filePath,
          text: `file number ${i}`,
          finalScore: 1.0 - i * 0.05,
          tokenCount: 2500,
        }) as any);
      }

      // Budget fits only ~4 files (10000 / 2500 = 4)
      const bundle = await buildExcerptBundle({
        candidates,
        workspaceRoot,
        totalTokenBudget: 10000,
        maxBytesPerExcerpt: 32 * 1024,
      });

      expect(bundle.budgetExhausted).toBe(true);
      expect(bundle.dropped.length).toBeGreaterThan(0);

      const summary = summarizeBundle(bundle);
      expect(summary).toContain('EXHAUSTED');
      expect(summary).toContain('Dropped');
      expect(summary).toContain('10000 tokens'); // total budget
    } finally {
      cleanup();
    }
  });

  it('handles memory (non-file) candidates', async () => {
    const [workspaceRoot, cleanup] = withTempWorkspace();
    try {
      const candidate = makeCandidate({
        id: 'memory:workspace::mem-001',
        canonicalKey: 'memory:workspace::mem-001',
        text: 'Always use async/await for DB calls',
        category: 'memory',
        finalScore: 0.85,
        sourceType: 'manual',
        graphRelationship: 'ABOUT',
      }) as any;

      const bundle = await buildExcerptBundle({
        candidates: [candidate],
        workspaceRoot,
        totalTokenBudget: 10000,
      });

      const allExcerpts = bundle.sections.flatMap((s: SectionBudget) => s.excerpts);
      expect(allExcerpts.length).toBeGreaterThan(0);
      const excerpt = allExcerpts[0];
      expect(excerpt.category).toBe('memory');
      expect(excerpt.content).toContain('async/await');
    } finally {
      cleanup();
    }
  });

  it('handles empty candidate list gracefully', async () => {
    const [workspaceRoot, cleanup] = withTempWorkspace();
    try {
      const bundle = await buildExcerptBundle({
        candidates: [],
        workspaceRoot,
        totalTokenBudget: 10000,
      });

      expect(bundle.sections.length).toBeGreaterThanOrEqual(0);
      expect(bundle.totalTokensUsed).toBe(0);
      expect(bundle.dropped.length).toBe(0);
      expect(bundle.budgetExhausted).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('assigns entries to correct sections based on category', async () => {
    const [workspaceRoot, cleanup] = withTempWorkspace();
    try {
      // Create files with different roles
      fs.mkdirSync(path.join(workspaceRoot, 'src', '__tests__'), { recursive: true });
      fs.writeFileSync(path.join(workspaceRoot, 'AGENTS.md'), '# Agents doc\n');
      fs.writeFileSync(path.join(workspaceRoot, 'src/app.ts'), '// app\n');
      fs.writeFileSync(path.join(workspaceRoot, 'src/__tests__/app.test.ts'), '// test\n');

      const candidates = [
        makeCandidate({ id: 'AGENTS.md', text: 'governance rules', finalScore: 0.9 }) as any,
        makeCandidate({ id: 'src/app.ts', text: 'app entrypoint', finalScore: 0.85 }) as any,
        makeCandidate({
          id: 'src/__tests__/app.test.ts',
          text: 'tests for app',
          finalScore: 0.7,
        }) as any,
      ];

      const bundle = await buildExcerptBundle({
        candidates,
        workspaceRoot,
        totalTokenBudget: 10000,
        sectionBudgetWeights: { docs: 0.3, files: 0.5, tests: 0.2 },
      });

      // Categories should be reflected in excerpts
      const allExcerpts = bundle.sections.flatMap((s: SectionBudget) => s.excerpts);
      const categories = allExcerpts.map((e: Excerpt) => e.category);
      expect(categories).toContain('doc');
      expect(categories).toContain('file');
      expect(categories).toContain('test');
    } finally {
      cleanup();
    }
  });

  it('drops lowest-scoring candidates first under budget pressure', async () => {
    const [workspaceRoot, cleanup] = withTempWorkspace();
    try {
      fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
      const content = '// ' + 'x'.repeat(8000); // ~2000 tokens each
      const candidates: RankedRetrievalCandidate[] = [];
      for (let i = 0; i < 5; i++) {
        const filePath = `src/file_${i}.ts`;
        fs.writeFileSync(path.join(workspaceRoot, filePath), content);
        candidates.push(makeCandidate({
          id: filePath,
          text: `source file ${i}`,
          finalScore: 0.9 - i * 0.1, // decreasing scores
        }) as any);
      }

      // Budget enough for ~2 files
      const bundle = await buildExcerptBundle({
        candidates,
        workspaceRoot,
        totalTokenBudget: 5000,
        maxBytesPerExcerpt: 32 * 1024,
      });

      // Check that dropped candidates have lower scores than kept ones
      const allExcerpts = bundle.sections.flatMap((s: SectionBudget) => s.excerpts);
      const keptScores = allExcerpts.map((e: Excerpt) => e.score);
      const droppedScores = bundle.dropped.map((d: { score: number }) => d.score);

      if (droppedScores.length > 0 && keptScores.length > 0) {
        const lowestKept = Math.min(...keptScores);
        const highestDropped = Math.max(...droppedScores);
        expect(lowestKept).toBeGreaterThanOrEqual(highestDropped);
      }
    } finally {
      cleanup();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TESTS: summarizeBundle
// ════════════════════════════════════════════════════════════════════════════

describe('summarizeBundle', () => {
  it('includes total budget, usage, sections, and drops', () => {
    const bundle: ExcerptBundle = {
      sections: [
        {
          section: 'files',
          tokenBudget: 5000,
          tokensUsed: 2500,
          tokensRemaining: 2500,
          excerpts: [
            {
              path: 'src/app.ts',
              reason: ['semantic_match'],
              provenance: { relation: 'TOUCHES', sourceType: 'graph', confidence: 'high' },
              content: '// redacted content',
              byteLength: 100,
              byteLengthAfterRedaction: 100,
              estimatedTokens: 25,
              score: 0.9,
              category: 'file',
            },
          ],
        },
      ],
      totalTokensUsed: 2500,
      totalTokenBudget: 5000,
      dropped: [
        {
          path: 'src/lowscore.ts',
          reason: 'Budget exhausted',
          score: 0.2,
          estimatedTokens: 1000,
        },
      ],
      budgetExhausted: true,
    };

    const summary = summarizeBundle(bundle);
    expect(summary).toContain('5000 tokens');
    expect(summary).toContain('2500 tokens');
    expect(summary).toContain('EXHAUSTED');
    expect(summary).toContain('src/app.ts');
    expect(summary).toContain('src/lowscore.ts');
    expect(summary).toContain('semantic_match');
  });
});
