/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-040: Context Pipeline E2E Test
 *
 * End-to-end test covering the hydrate → retrieve → compose → context preview
 * pipeline using the external fixture repo (test/fixtures/external-repo/).
 *
 * Acceptance criteria:
 * - Hydrate: Extractor reads fixture repo files and extracts context.
 * - Retrieve: Memory router retrieves seeded memories from the test DB.
 * - Compose: Context composer produces a valid SpecContextBundle with provenance.
 * - Preview: Context summary output is parseable and contains expected sections.
 */

import * as fs from 'fs';
import * as path from 'path';

import { composeContext, hashBrief, type ComposeContextInput, type ComposerFeed } from '../../lib/context-composer';
import { BUNDLE_SECTIONS } from '../../lib/context-bundle-contracts';
import { parseMemoryFile, type MemoryEntry } from '../../lib/memory-ledger';
import { estimateTokens } from '../../lib/context-composer';

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

const FIXTURE_REPO = path.join(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'external-repo');

function loadFixtureFile(relativePath: string): string {
  return fs.readFileSync(path.join(FIXTURE_REPO, relativePath), 'utf8');
}

function loadMemoryEntries(): MemoryEntry[] {
  try {
    const content = loadFixtureFile('.rorca/MEMORY.md');
    return parseMemoryFile(content);
  } catch {
    return [];
  }
}

/** Build a ComposerFeed from fixture repo artifacts. */
function buildFixtureFeed(): ComposerFeed {
  const memories = loadMemoryEntries().map((m) => ({
    text: `> Rule: ${m.rule}\n> Context: ${m.context}`,
    id: `memory-${m.source}-${m.date}`,
    source: 'reviewed' as const,
    confidence: 0.9,
  }));

  return {
    memories,
    docs: [
      {
        path: 'docs/api.md',
        content: loadFixtureFile('docs/api.md'),
        reason: 'API documentation from retrieval',
      },
      {
        path: 'docs/architecture.md',
        content: loadFixtureFile('docs/architecture.md'),
        reason: 'Architecture decisions from retrieval',
      },
    ],
    sourceFiles: [
      {
        path: 'src/lib/apiFetch.ts',
        content: loadFixtureFile('src/lib/apiFetch.ts'),
        reason: 'Source file matched by retrieval',
      },
      {
        path: 'src/lib/errors.ts',
        content: loadFixtureFile('src/lib/errors.ts'),
        reason: 'Source file matched by retrieval',
      },
      {
        path: 'src/lib/db.ts',
        content: loadFixtureFile('src/lib/db.ts'),
        reason: 'Source file matched by retrieval',
      },
    ],
    tests: [
      {
        path: 'tests/apiFetch.test.ts',
        content: loadFixtureFile('tests/apiFetch.test.ts'),
        reason: 'Test file from retrieval',
      },
      {
        path: 'tests/errors.test.ts',
        content: loadFixtureFile('tests/errors.test.ts'),
        reason: 'Test file from retrieval',
      },
    ],
    graphStats: {
      nodeCount: 15,
      edgeCount: 11,
      lastHydrated: '2026-06-28T12:00:00.000Z',
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

describe('US-040 Context Pipeline E2E', () => {
  let workspaceId: string;

  beforeAll(() => {
    workspaceId = 'ws-e2e-pipeline-' + Date.now();
  });

  // ── Acceptance Criterion: hydrate → retrieve → compose ────────────────

  describe('hydrate → retrieve → compose', () => {
    it('reads fixture repo files (hydrate simulation)', () => {
      // Verify fixture repo exists and has expected files
      expect(fs.existsSync(FIXTURE_REPO)).toBe(true);
      expect(fs.existsSync(path.join(FIXTURE_REPO, 'src', 'lib', 'apiFetch.ts'))).toBe(true);
      expect(fs.existsSync(path.join(FIXTURE_REPO, 'docs', 'architecture.md'))).toBe(true);
      expect(fs.existsSync(path.join(FIXTURE_REPO, '.rorca', 'hilo-edges.jsonl'))).toBe(true);

      // Verify fixture files are non-empty
      const apiFetchContent = loadFixtureFile('src/lib/apiFetch.ts');
      expect(apiFetchContent.length).toBeGreaterThan(100);
      expect(apiFetchContent).toContain('apiFetch');

      const errorsContent = loadFixtureFile('src/lib/errors.ts');
      expect(errorsContent).toContain('AppError');
      expect(errorsContent).toContain('ValidationError');

      const apiDocs = loadFixtureFile('docs/api.md');
      expect(apiDocs).toContain('API Documentation');
    });

    it('parses fixture .rorca/MEMORY.md into structured entries (retrieval)', () => {
      const entries = loadMemoryEntries();
      expect(entries.length).toBeGreaterThanOrEqual(1);

      // Entries should have all required fields
      for (const entry of entries) {
        expect(entry.date).toBeDefined();
        expect(entry.category).toBeDefined();
        expect(entry.title).toBeDefined();
        expect(entry.rule).toBeDefined();
        expect(entry.context).toBeDefined();
        expect(entry.source).toBeDefined();
      }

      // Verify at least one known entry
      const architectureEntry = entries.find((e) => e.category === 'Architecture');
      expect(architectureEntry).toBeDefined();
      expect(architectureEntry!.rule).toContain('TypeScript');
      expect(architectureEntry!.source).toBe('US-040-e2e-fixtures');
    });

    it('composes a valid SpecContextBundle from fixture feed (compose)', () => {
      const input: ComposeContextInput = {
        workspaceId,
        brief: 'Add JWT authentication to the demo project API',
        annotations: ['security', 'auth'],
        budget: 8000,
        freshnessPolicy: 'relaxed',
        includeGraph: true,
        referenceTimestamp: '2026-06-28T12:00:00.000Z',
      };

      const feed = buildFixtureFeed();
      const result = composeContext(input, feed);
      const bundle = result.bundle;

      // Bundle shape validation
      expect(bundle.schemaVersion).toBe('v1');
      expect(bundle.workspaceId).toBe(workspaceId);
      expect(bundle.briefHash).toBe(hashBrief(input.brief, input.annotations));
      expect(bundle.createdAt).toBe('2026-06-28T12:00:00.000Z');

      // All sections present in order
      const sectionNames = bundle.sections.map((s) => s.section);
      expect(sectionNames).toEqual([...BUNDLE_SECTIONS]);

      // Every section has budget metadata
      for (const section of bundle.sections) {
        expect(typeof section.tokenBudget).toBe('number');
        expect(typeof section.tokensUsed).toBe('number');
      }
    });

    it('composed bundle includes all expected content sections', () => {
      const feed = buildFixtureFeed();
      const result = composeContext(
        { workspaceId, brief: 'Test brief for section validation' },
        feed,
      );
      const bundle = result.bundle;

      // Directions section contains the brief
      const dirSection = bundle.sections.find((s) => s.section === 'directions')!;
      expect(dirSection.items.length).toBeGreaterThan(0);
      expect(dirSection.items.some((i) => i.content.includes('Test brief'))).toBe(true);

      // Memories section has fixture entries
      const memSection = bundle.sections.find((s) => s.section === 'memories')!;
      expect(memSection.items.length).toBeGreaterThan(0);
      expect(memSection.items.some((i) => i.content.includes('apiFetch'))).toBe(true);

      // Docs section has fixture docs
      const docSection = bundle.sections.find((s) => s.section === 'docs')!;
      expect(docSection.items.length).toBeGreaterThan(0);
      expect(docSection.items.some((i) => i.content.includes('API Documentation'))).toBe(true);

      // Source files section
      const srcSection = bundle.sections.find((s) => s.section === 'sourceFiles')!;
      expect(srcSection.items.length).toBeGreaterThan(0);
      expect(srcSection.items.some((i) => i.content.includes('apiFetch'))).toBe(true);

      // Tests section
      const testSection = bundle.sections.find((s) => s.section === 'tests')!;
      expect(testSection.items.length).toBeGreaterThan(0);
      expect(testSection.items.some((i) => i.content.includes('apiFetch.test'))).toBe(true);
    });

    it('every bundle item carries provenance metadata', () => {
      const feed = buildFixtureFeed();
      const result = composeContext(
        { workspaceId, brief: 'Test provenance', includeGraph: true },
        feed,
      );

      for (const section of result.bundle.sections) {
        for (const item of section.items) {
          expect(item.provenance).toBeDefined();
          expect(item.provenance.source).toBeDefined();
          expect(item.provenance.ref).toBeDefined();
          expect(item.provenance.ref.length).toBeGreaterThan(0);
          expect(item.provenance.trust).toBeDefined();
        }
      }
    });

    it('composer is deterministic for identical inputs', () => {
      const input: ComposeContextInput = {
        workspaceId,
        brief: 'Determinism test',
        referenceTimestamp: '2026-06-28T12:00:00.000Z',
      };
      const feed = buildFixtureFeed();

      const result1 = composeContext(input, feed);
      const result2 = composeContext(input, feed);

      expect(result1.briefHash).toBe(result2.briefHash);
      expect(result1.bundle.totalTokens).toBe(result2.bundle.totalTokens);
      expect(result1.bundle.degraded).toBe(result2.bundle.degraded);

      for (let i = 0; i < BUNDLE_SECTIONS.length; i++) {
        expect(result1.bundle.sections[i].section).toBe(result2.bundle.sections[i].section);
        expect(result1.bundle.sections[i].items.length).toBe(result2.bundle.sections[i].items.length);
      }
    });

    it('bundle degrades cleanly when Hilo graph is absent', () => {
      const feed = buildFixtureFeed();
      // Remove graph data
      delete feed.graphStats;

      const result = composeContext(
        { workspaceId, brief: 'No graph test', includeGraph: true },
        feed,
      );

      expect(result.bundle.degraded).toBe(true);
      const graphSection = result.bundle.sections.find((s) => s.section === 'graphSummary')!;
      expect(graphSection.items.length).toBe(0);
    });

    it('bundle is not degraded when graph data is present', () => {
      const feed = buildFixtureFeed();
      const result = composeContext(
        { workspaceId, brief: 'Full graph test', includeGraph: true },
        feed,
      );

      expect(result.bundle.degraded).toBe(false);
      const graphSection = result.bundle.sections.find((s) => s.section === 'graphSummary')!;
      expect(graphSection.items.length).toBeGreaterThan(0);
    });
  });

  // ── Acceptance Criterion: context preview / spec context summary ────────

  describe('context preview and spec context summary', () => {
    it('composer emits ContextSummary-compatible metadata', () => {
      const input: ComposeContextInput = {
        workspaceId,
        brief: 'Preview generation test',
        referenceTimestamp: '2026-06-28T12:00:00.000Z',
      };
      const feed = buildFixtureFeed();
      const result = composeContext(input, feed);
      const summary = result.contextSummary;

      expect(summary).toBeDefined();
      expect(summary.workspaceId).toBe(workspaceId);
      expect(summary.estimatedTokens).toBeDefined();
      expect(summary.estimatedTokens!).toBeGreaterThan(0);
      expect(summary.directionLayers).toBeDefined();
      expect(summary.briefHash).toBeDefined();
      expect(summary.composedAt).toBe('2026-06-28T12:00:00.000Z');
    });

    it('context summary includes memory count', () => {
      const feed = buildFixtureFeed();
      const result = composeContext(
        { workspaceId, brief: 'Memory count test' },
        feed,
      );

      expect(result.contextSummary.memoryEntries).toBeDefined();
      expect(result.contextSummary.memoryEntries!).toBeGreaterThan(0);
    });

    it('context summary direction layers contain the brief', () => {
      const brief = 'Add integration tests for the Go HTTP handlers';
      const result = composeContext(
        { workspaceId, brief, referenceTimestamp: '2026-06-28T12:00:00.000Z' },
        buildFixtureFeed(),
      );

      expect(result.contextSummary.directionLayers?.l1).toBeDefined();
      expect(result.contextSummary.directionLayers!.l1!).toContain(brief);
      expect(typeof result.contextSummary.directionLayers!.l1!).toBe('string');
    });

    it('token budget is distributed across sections', () => {
      const feed = buildFixtureFeed();
      const result = composeContext(
        { workspaceId, brief: 'Budget distribution test', budget: 4000 },
        feed,
      );

      // Total tokens should not exceed budget
      expect(result.bundle.totalTokens!).toBeLessThanOrEqual(4000);

      // At least directions and memories should have tokens
      const dirSection = result.bundle.sections.find((s) => s.section === 'directions')!;
      expect(dirSection.tokensUsed).toBeGreaterThan(0);

      const memSection = result.bundle.sections.find((s) => s.section === 'memories')!;
      expect(memSection.tokensUsed).toBeGreaterThan(0);
    });

    it('branch diff section is included when diff data is present', () => {
      const feed = buildFixtureFeed();
      const result = composeContext(
        { workspaceId, brief: 'Diff test', includeGraph: true },
        feed,
      );

      const diffSection = result.bundle.sections.find((s) => s.section === 'branchDiff')!;
      expect(diffSection).toBeDefined();
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty memory feed gracefully', () => {
      const feed: ComposerFeed = {
        docs: [
          {
            path: 'docs/api.md',
            content: loadFixtureFile('docs/api.md'),
            reason: 'Only doc available',
          },
        ],
      };

      const result = composeContext(
        { workspaceId, brief: 'Empty memory test' },
        feed,
      );

      expect(result.bundle.sections.length).toBe(BUNDLE_SECTIONS.length);
      const memSection = result.bundle.sections.find((s) => s.section === 'memories')!;
      expect(memSection.items.length).toBe(0);
    });

    it('handles extremely long brief text', () => {
      const longBrief = 'A'.repeat(10000);
      const result = composeContext(
        { workspaceId, brief: longBrief },
        buildFixtureFeed(),
      );

      expect(result.bundle.briefHash).toBeDefined();
      expect(result.bundle.briefHash.length).toBe(16);
    });

    it('briefHash changes for different annotations', () => {
      const hash1 = hashBrief('Same brief', ['tag-a']);
      const hash2 = hashBrief('Same brief', ['tag-b']);
      expect(hash1).not.toBe(hash2);
    });

    it('excludes noisy/long memory entries', () => {
      const longContent = 'x'.repeat(5000);
      const feed = buildFixtureFeed();
      feed.memories!.push({
        text: longContent,
        id: 'noisy-memory',
      });

      const result = composeContext(
        { workspaceId, brief: 'Noise exclusion test' },
        feed,
      );

      const memSection = result.bundle.sections.find((s) => s.section === 'memories')!;
      const hasNoisy = memSection.items.some((i) => i.content === longContent);
      expect(hasNoisy).toBe(false);
    });

    it('token estimation is consistent', () => {
      const text = 'Hello world, this is a test for token estimation.';
      const est1 = estimateTokens(text);
      const est2 = estimateTokens(text);
      expect(est1).toBe(est2);
      expect(est1).toBeGreaterThan(0);
      expect(estimateTokens('')).toBe(0);
    });
  });

  // ── Fixture Hilo edges ─────────────────────────────────────────────────

  describe('Hilo edge fixture', () => {
    it('Hilo edges JSONL is parseable and contains expected relations', () => {
      const edgesPath = path.join(FIXTURE_REPO, '.rorca', 'hilo-edges.jsonl');
      expect(fs.existsSync(edgesPath)).toBe(true);

      const lines = fs.readFileSync(edgesPath, 'utf8').trim().split('\n');
      expect(lines.length).toBeGreaterThan(0);

      const nodes = lines.filter((l) => {
        try {
          const obj = JSON.parse(l);
          return obj.type === 'node';
        } catch {
          return false;
        }
      });

      const edges = lines.filter((l) => {
        try {
          const obj = JSON.parse(l);
          return obj.type === 'edge';
        } catch {
          return false;
        }
      });

      expect(nodes.length).toBeGreaterThanOrEqual(10);
      expect(edges.length).toBeGreaterThanOrEqual(5);

      // Verify test relationships
      const testEdges = lines.filter((l) => l.includes('"tests"'));
      expect(testEdges.length).toBeGreaterThanOrEqual(3);
    });

    it('Hilo fixture includes all fixture source files', () => {
      const edgesPath = path.join(FIXTURE_REPO, '.rorca', 'hilo-edges.jsonl');
      const content = fs.readFileSync(edgesPath, 'utf8');

      const expectedPaths = [
        'src/lib/apiFetch.ts',
        'src/lib/errors.ts',
        'src/lib/db.ts',
        'src/handlers/http.go',
        'src/utils/helpers.py',
        'index.py',
      ];

      for (const p of expectedPaths) {
        expect(content).toContain(p);
      }
    });

    it('Hilo fixture includes documentation nodes', () => {
      const edgesPath = path.join(FIXTURE_REPO, '.rorca', 'hilo-edges.jsonl');
      const content = fs.readFileSync(edgesPath, 'utf8');

      expect(content).toContain('CLAUDE.md');
      expect(content).toContain('AGENTS.md');
      expect(content).toContain('README.md');
      expect(content).toContain('docs/api.md');
      expect(content).toContain('docs/architecture.md');
    });
  });
});
