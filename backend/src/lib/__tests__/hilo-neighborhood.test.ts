/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_FILES,
  expandNeighborhood,
  type GraphEdge,
  type GraphFileNode,
  type GraphRelation,
} from '../hilo-neighborhood';

// ════════════════════════════════════════════════════════════════════════════
// Fixture helpers
// ════════════════════════════════════════════════════════════════════════════

/** Build a minimal GraphFileNode. */
function node(
  path: string,
  role: GraphFileNode['role'] = 'source',
  language?: string,
): GraphFileNode {
  return {
    schemaVersion: 'v1',
    path,
    role,
    language,
    importsCount: 0,
    importedByCount: 0,
    testsCount: 0,
    testedByCount: 0,
  };
}

/** Build a GraphEdge. */
function edge(from: string, to: string, relation: GraphRelation, weight?: number): GraphEdge {
  return { schemaVersion: 'v1', from, to, relation, weight };
}

/** Simple fixture: A → B → C import chain */
const simpleImportGraph = {
  nodes: [
    node('src/a.ts', 'entrypoint', 'typescript'),
    node('src/b.ts', 'source', 'typescript'),
    node('src/c.ts', 'source', 'typescript'),
    node('src/d.ts', 'source', 'typescript'),
  ],
  edges: [
    edge('src/a.ts', 'src/b.ts', 'imports'),
    edge('src/b.ts', 'src/c.ts', 'imports'),
    edge('src/a.ts', 'src/d.ts', 'imports'),
  ],
};

/** Test-relationship fixture */
const testGraph = {
  nodes: [
    node('src/lib/apiFetch.ts', 'source', 'typescript'),
    node('src/lib/__tests__/apiFetch.test.ts', 'test', 'typescript'),
    node('src/lib/errors.ts', 'source', 'typescript'),
    node('src/lib/__tests__/errors.test.ts', 'test', 'typescript'),
    node('src/components/Shell.tsx', 'entrypoint', 'typescript'),
  ],
  edges: [
    edge('src/lib/__tests__/apiFetch.test.ts', 'src/lib/apiFetch.ts', 'tests'),
    edge('src/lib/__tests__/errors.test.ts', 'src/lib/errors.ts', 'tests'),
    edge('src/components/Shell.tsx', 'src/lib/apiFetch.ts', 'imports'),
    edge('src/lib/apiFetch.ts', 'src/lib/errors.ts', 'imports'),
    edge('src/lib/__tests__/apiFetch.test.ts', 'src/lib/errors.ts', 'imports'),
  ],
};

/** Branching graph fixture: hub with multiple spokes */
const branchingGraph = {
  nodes: [
    node('src/index.ts', 'entrypoint', 'typescript'),
    node('src/lib/apiFetch.ts', 'source', 'typescript'),
    node('src/lib/errors.ts', 'source', 'typescript'),
    node('src/components/Shell.tsx', 'source', 'typescript'),
    node('src/components/Sidebar.tsx', 'source', 'typescript'),
    node('src/styles/tokens.css', 'source', 'css'),
    node('vite.config.ts', 'config', 'typescript'),
  ],
  edges: [
    edge('src/index.ts', 'src/lib/apiFetch.ts', 'imports'),
    edge('src/index.ts', 'src/components/Shell.tsx', 'imports'),
    edge('src/index.ts', 'src/components/Sidebar.tsx', 'imports'),
    edge('src/components/Shell.tsx', 'src/lib/apiFetch.ts', 'imports'),
    edge('src/components/Sidebar.tsx', 'src/lib/errors.ts', 'imports'),
    edge('src/components/Shell.tsx', 'src/styles/tokens.css', 'imports'),
    edge('src/lib/errors.ts', 'src/lib/apiFetch.ts', 'imports'),
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════════════

describe('hilo-neighborhood — one-hop expansion', () => {
  it('expands a single seed one hop through imports', () => {
    const result = expandNeighborhood({
      nodes: simpleImportGraph.nodes,
      edges: simpleImportGraph.edges,
      options: { seeds: ['src/a.ts'], maxDepth: 1 },
    });

    // a.ts (seed) + b.ts + d.ts = 3 files
    expect(result.files).toHaveLength(3);
    expect(result.seedCount).toBe(1);
    // b.ts at depth 1 has further outgoing edges (→ c.ts) not explored,
    // so depthLimitReached should be true.
    expect(result.degradation.depthLimitReached).toBe(true);
    expect(result.degradation.fileLimitReached).toBe(false);

    // Seeds at depth 0
    const seedFile = result.files.find((f) => f.path === 'src/a.ts');
    expect(seedFile).toBeDefined();
    expect(seedFile!.depth).toBe(0);
    expect(seedFile!.sourceSeed).toBe('src/a.ts');
    expect(seedFile!.pathProvenance).toEqual(['src/a.ts']);
    expect(seedFile!.role).toBe('entrypoint');

    // Direct imports at depth 1
    const bFile = result.files.find((f) => f.path === 'src/b.ts');
    expect(bFile).toBeDefined();
    expect(bFile!.depth).toBe(1);
    expect(bFile!.sourceSeed).toBe('src/a.ts');
    expect(bFile!.relation).toBe('imports');
    expect(bFile!.pathProvenance).toEqual(['src/a.ts', 'src/b.ts']);
    expect(bFile!.role).toBe('source');
    expect(bFile!.language).toBe('typescript');

    const dFile = result.files.find((f) => f.path === 'src/d.ts');
    expect(dFile).toBeDefined();
    expect(dFile!.depth).toBe(1);
    expect(dFile!.relation).toBe('imports');
  });

  it('includes relation type in every expanded file', () => {
    const result = expandNeighborhood({
      nodes: simpleImportGraph.nodes,
      edges: simpleImportGraph.edges,
      options: { seeds: ['src/a.ts'], maxDepth: 2 },
    });

    for (const file of result.files) {
      if (file.depth === 0) continue; // seeds have placeholder 'references'
      expect(file.relation).toBeDefined();
      expect(file.relation.length).toBeGreaterThan(0);
    }
  });

  it('includes path provenance (ordered chain) for every expanded file', () => {
    const result = expandNeighborhood({
      nodes: simpleImportGraph.nodes,
      edges: simpleImportGraph.edges,
      options: { seeds: ['src/a.ts'], maxDepth: 2 },
    });

    for (const file of result.files) {
      expect(file.pathProvenance).toBeDefined();
      expect(file.pathProvenance.length).toBe(file.depth + 1);
      // First element is the source seed
      expect(file.pathProvenance[0]).toBe(file.sourceSeed);
      // Last element is the file itself
      expect(file.pathProvenance[file.pathProvenance.length - 1]).toBe(file.path);
    }
  });

  it('includes source seed for tracking which seed originated the expansion', () => {
    const result = expandNeighborhood({
      nodes: simpleImportGraph.nodes,
      edges: simpleImportGraph.edges,
      options: { seeds: ['src/a.ts'], maxDepth: 2 },
    });

    for (const file of result.files) {
      expect(file.sourceSeed).toBe('src/a.ts');
    }
  });
});

describe('hilo-neighborhood — multi-hop expansion', () => {
  it('expands through multiple hops (depth 2)', () => {
    const result = expandNeighborhood({
      nodes: simpleImportGraph.nodes,
      edges: simpleImportGraph.edges,
      options: { seeds: ['src/a.ts'], maxDepth: 2 },
    });

    // a.ts → b.ts (depth 1) → c.ts (depth 2), also a.ts → d.ts (depth 1)
    expect(result.files).toHaveLength(4);

    // c.ts should be at depth 2
    const cFile = result.files.find((f) => f.path === 'src/c.ts');
    expect(cFile).toBeDefined();
    expect(cFile!.depth).toBe(2);
    expect(cFile!.pathProvenance).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(cFile!.relation).toBe('imports');
  });

  it('expands through multiple hops (depth 3)', () => {
    // Build a chain: a → b → c → d
    const chain = {
      nodes: [
        node('a.ts'),
        node('b.ts'),
        node('c.ts'),
        node('d.ts'),
        node('e.ts'),
      ],
      edges: [
        edge('a.ts', 'b.ts', 'imports'),
        edge('b.ts', 'c.ts', 'imports'),
        edge('c.ts', 'd.ts', 'imports'),
        edge('d.ts', 'e.ts', 'imports'),
      ],
    };

    const result = expandNeighborhood({
      nodes: chain.nodes,
      edges: chain.edges,
      options: { seeds: ['a.ts'], maxDepth: 3 },
    });

    expect(result.files).toHaveLength(4); // a, b, c, d (e at depth 4 — out of bounds)
    const dFile = result.files.find((f) => f.path === 'd.ts');
    expect(dFile).toBeDefined();
    expect(dFile!.depth).toBe(3);
    expect(dFile!.pathProvenance).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);

    // e.ts should not be included
    expect(result.files.find((f) => f.path === 'e.ts')).toBeUndefined();
  });

  it('expands from multiple seeds with independent provenance', () => {
    const result = expandNeighborhood({
      nodes: simpleImportGraph.nodes,
      edges: simpleImportGraph.edges,
      options: { seeds: ['src/a.ts', 'src/b.ts'], maxDepth: 1 },
    });

    // Seeds: a, b. From a → b, d. From b → c. Total unique: a, b, c, d = 4
    expect(result.files).toHaveLength(4);
    expect(result.seedCount).toBe(2);

    // b.ts should appear as a seed from the second entry, and as an expansion from a.ts
    // Since it's visited first as seed (depth 0), it should only appear once
    const bFiles = result.files.filter((f) => f.path === 'src/b.ts');
    expect(bFiles).toHaveLength(1); // deduplicated
    expect(bFiles[0].depth).toBe(0); // first encounter was as seed
    expect(bFiles[0].sourceSeed).toBe('src/b.ts');

    // c.ts is reached from b.ts as seed
    const cFile = result.files.find((f) => f.path === 'src/c.ts');
    expect(cFile).toBeDefined();
    expect(cFile!.sourceSeed).toBe('src/b.ts');
    expect(cFile!.depth).toBe(1);
  });
});

describe('hilo-neighborhood — test relationships', () => {
  it('expands through tests relations', () => {
    const result = expandNeighborhood({
      nodes: testGraph.nodes,
      edges: testGraph.edges,
      options: { seeds: ['src/lib/apiFetch.ts'], maxDepth: 1 },
    });

    // apiFetch.ts (seed) + its test file (tested_by) + errors.ts (imports)
    // The edge: apiFetch.test.ts → apiFetch.ts (relation: 'tests')
    // From apiFetch.ts perspective, apiFetch.test.ts is 'tested_by'
    expect(result.files.length).toBeGreaterThanOrEqual(2);

    const testFile = result.files.find(
      (f) => f.path === 'src/lib/__tests__/apiFetch.test.ts',
    );
    expect(testFile).toBeDefined();
    expect(testFile!.depth).toBe(1);
    expect(testFile!.relation).toBe('tested_by');
    expect(testFile!.role).toBe('test');
  });

  it('expands from a test file to find tested source files', () => {
    const result = expandNeighborhood({
      nodes: testGraph.nodes,
      edges: testGraph.edges,
      options: { seeds: ['src/lib/__tests__/apiFetch.test.ts'], maxDepth: 1 },
    });

    // The test file tests apiFetch.ts and imports errors.ts
    const sourceFile = result.files.find(
      (f) => f.path === 'src/lib/apiFetch.ts',
    );
    expect(sourceFile).toBeDefined();
    expect(sourceFile!.depth).toBe(1);
    expect(sourceFile!.relation).toBe('tests');

    const importFile = result.files.find(
      (f) => f.path === 'src/lib/errors.ts',
    );
    expect(importFile).toBeDefined();
    expect(importFile!.depth).toBe(1);
    expect(importFile!.relation).toBe('imports');
  });

  it('finds both tested_by and imported_by through reverse edges', () => {
    const result = expandNeighborhood({
      nodes: testGraph.nodes,
      edges: testGraph.edges,
      options: { seeds: ['src/lib/errors.ts'], maxDepth: 1 },
    });

    // errors.ts is imported by apiFetch.test.ts and apiFetch.ts, tested by errors.test.ts
    const testFiles = result.files.filter((f) => f.role === 'test');
    expect(testFiles.length).toBeGreaterThanOrEqual(1);

    const apiTestFile = result.files.find(
      (f) => f.path === 'src/lib/__tests__/apiFetch.test.ts',
    );
    expect(apiTestFile).toBeDefined();
    // apiFetch.test.ts imports errors.ts, so from errors.ts perspective it's imported_by
    expect(apiTestFile!.relation).toBe('imported_by');
  });
});

describe('hilo-neighborhood — relation filtering', () => {
  it('filters to only specified relation types', () => {
    const result = expandNeighborhood({
      nodes: testGraph.nodes,
      edges: testGraph.edges,
      options: {
        seeds: ['src/lib/apiFetch.ts'],
        maxDepth: 2,
        relationFilter: ['tests', 'tested_by'],
      },
    });

    // Only test-related files should be included (besides the seed)
    for (const file of result.files) {
      if (file.depth === 0) continue;
      expect(['tests', 'tested_by']).toContain(file.relation);
    }
  });

  it('filters imports only', () => {
    const result = expandNeighborhood({
      nodes: testGraph.nodes,
      edges: testGraph.edges,
      options: {
        seeds: ['src/lib/__tests__/apiFetch.test.ts'],
        maxDepth: 2,
        relationFilter: ['imports'],
      },
    });

    for (const file of result.files) {
      if (file.depth === 0) continue;
      expect(file.relation).toBe('imports');
    }
  });
});

describe('hilo-neighborhood — max-depth enforcement', () => {
  it('respects maxDepth=1 and does not traverse beyond', () => {
    const result = expandNeighborhood({
      nodes: simpleImportGraph.nodes,
      edges: simpleImportGraph.edges,
      options: { seeds: ['src/a.ts'], maxDepth: 1 },
    });

    // c.ts is at depth 2 (a → b → c), should not be included
    const cFile = result.files.find((f) => f.path === 'src/c.ts');
    expect(cFile).toBeUndefined();

    // All files should be at depth <= 1
    for (const file of result.files) {
      expect(file.depth).toBeLessThanOrEqual(1);
    }
  });

  it('reports depthLimitReached when deeper relations exist', () => {
    const result = expandNeighborhood({
      nodes: simpleImportGraph.nodes,
      edges: simpleImportGraph.edges,
      options: { seeds: ['src/a.ts'], maxDepth: 1 },
    });

    // b.ts has further imports (c.ts), so depth limit was reached
    expect(result.degradation.depthLimitReached).toBe(true);
    expect(result.degradation.summary).toContain('depth limit');
  });

  it('does not flag depthLimitReached when no deeper relations exist', () => {
    // Use a truly isolated node with no edges at all (not even incoming).
    const isolatedGraph = {
      nodes: [node('orphan.ts', 'source')],
      edges: [],
    };
    const result = expandNeighborhood({
      nodes: isolatedGraph.nodes,
      edges: isolatedGraph.edges,
      options: { seeds: ['orphan.ts'], maxDepth: 2 },
    });

    // orphan.ts has no edges in either direction, so no depth limit is reached
    expect(result.degradation.depthLimitReached).toBe(false);
  });

  it('clamps maxDepth to hard limit', () => {
    const result = expandNeighborhood({
      nodes: simpleImportGraph.nodes,
      edges: simpleImportGraph.edges,
      options: { seeds: ['src/a.ts'], maxDepth: 999 },
    });

    // Depth should be clamped to MAX_DEPTH_HARD_LIMIT (10)
    expect(result.files.length).toBeLessThanOrEqual(simpleImportGraph.nodes.length);
    for (const file of result.files) {
      expect(file.depth).toBeLessThanOrEqual(10);
    }
  });
});

describe('hilo-neighborhood — max-files enforcement', () => {
  it('respects maxFiles and truncates results', () => {
    const result = expandNeighborhood({
      nodes: branchingGraph.nodes,
      edges: branchingGraph.edges,
      options: { seeds: ['src/index.ts'], maxDepth: 5, maxFiles: 3 },
    });

    expect(result.files.length).toBeLessThanOrEqual(3);
    expect(result.degradation.fileLimitReached).toBe(true);
    expect(result.degradation.summary).toContain('file limit');
  });

  it('includes all files when under the maxFiles limit', () => {
    const result = expandNeighborhood({
      nodes: simpleImportGraph.nodes,
      edges: simpleImportGraph.edges,
      options: { seeds: ['src/a.ts'], maxDepth: 2, maxFiles: 100 },
    });

    expect(result.degradation.fileLimitReached).toBe(false);
    expect(result.files.length).toBe(4); // all reachable files
  });

  it('clamps maxFiles to hard limit', () => {
    const result = expandNeighborhood({
      nodes: simpleImportGraph.nodes,
      edges: simpleImportGraph.edges,
      options: { seeds: ['src/a.ts'], maxDepth: 5, maxFiles: 99999 },
    });

    // Should complete without issues — hard limit is 500
    expect(result.files.length).toBeLessThanOrEqual(simpleImportGraph.nodes.length);
    expect(result.degradation.fileLimitReached).toBe(false);
  });
});

describe('hilo-neighborhood — stale/unavailable fallback', () => {
  it('returns seeds only when Hilo is unavailable (no edges, no nodes)', () => {
    const result = expandNeighborhood({
      nodes: [],
      edges: [],
      options: { seeds: ['src/a.ts', 'src/b.ts'], maxDepth: 2 },
      staleness: { hiloStale: false, hiloUnavailable: true },
    });

    expect(result.degradation.hiloUnavailable).toBe(true);
    expect(result.degradation.summary).toContain('unavailable');
    // Only seeds should be present
    expect(result.files.length).toBeLessThanOrEqual(2);
    for (const file of result.files) {
      expect(file.depth).toBe(0);
    }
  });

  it('returns seeds only when graph is completely empty', () => {
    const result = expandNeighborhood({
      nodes: [],
      edges: [],
      options: { seeds: ['src/app.ts'], maxDepth: 2 },
    });

    expect(result.degradation.hiloUnavailable).toBe(true);
    expect(result.degradation.summary).toContain('unavailable');
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('src/app.ts');
    expect(result.files[0].depth).toBe(0);
  });

  it('proceeds with expansion when Hilo is stale (partial context)', () => {
    const result = expandNeighborhood({
      nodes: simpleImportGraph.nodes,
      edges: simpleImportGraph.edges,
      options: { seeds: ['src/a.ts'], maxDepth: 1 },
      staleness: { hiloStale: true, hiloUnavailable: false },
    });

    // Should still expand — stale is a degradation flag, not a blocker
    expect(result.files.length).toBe(3);
    expect(result.degradation.hiloStale).toBe(true);
    expect(result.degradation.hiloUnavailable).toBe(false);
    expect(result.degradation.summary).toContain('stale');
  });

  it('propagates stale+unavailable flags simultaneously', () => {
    const result = expandNeighborhood({
      nodes: [],
      edges: [],
      options: { seeds: ['src/x.ts'], maxDepth: 2 },
      staleness: { hiloStale: true, hiloUnavailable: true },
    });

    expect(result.degradation.hiloStale).toBe(true);
    expect(result.degradation.hiloUnavailable).toBe(true);
    expect(result.degradation.summary).toContain('stale');
    expect(result.degradation.summary).toContain('unavailable');
  });

  it('returns role=unknown for seeds when no node data is available', () => {
    const result = expandNeighborhood({
      nodes: [],
      edges: [],
      options: { seeds: ['src/ghost.ts'], maxDepth: 2 },
    });

    expect(result.files[0].role).toBe('unknown');
    expect(result.files[0].language).toBeUndefined();
  });
});

describe('hilo-neighborhood — seeding & filtering', () => {
  it('filters out empty and non-string seeds', () => {
    const result = expandNeighborhood({
      nodes: simpleImportGraph.nodes,
      edges: simpleImportGraph.edges,
      options: {
        seeds: ['src/a.ts', '', '  ', 'src/b.ts'],
        maxDepth: 1,
      },
    });

    // Only a.ts and b.ts should be seeds
    const seeds = result.files.filter((f) => f.depth === 0);
    expect(seeds).toHaveLength(2);
    expect(result.seedCount).toBe(2);
  });

  it('deduplicates seeds', () => {
    const result = expandNeighborhood({
      nodes: simpleImportGraph.nodes,
      edges: simpleImportGraph.edges,
      options: {
        seeds: ['src/a.ts', 'src/a.ts', 'src/a.ts'],
        maxDepth: 1,
      },
    });

    expect(result.seedCount).toBe(1);
  });

  it('handles empty seeds gracefully', () => {
    const result = expandNeighborhood({
      nodes: simpleImportGraph.nodes,
      edges: simpleImportGraph.edges,
      options: { seeds: [], maxDepth: 2 },
    });

    expect(result.files).toHaveLength(0);
    expect(result.seedCount).toBe(0);
    expect(result.totalVisited).toBe(0);
    expect(result.degradation.hiloUnavailable).toBe(false); // graph itself is not empty
  });
});

describe('hilo-neighborhood — edge cases', () => {
  it('handles seeds with no edges gracefully', () => {
    const result = expandNeighborhood({
      nodes: [
        node('orphan.ts', 'source'),
      ],
      edges: [],
      options: { seeds: ['orphan.ts'], maxDepth: 2 },
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('orphan.ts');
    expect(result.files[0].depth).toBe(0);
    expect(result.degradation.depthLimitReached).toBe(false);
  });

  it('handles a graph with only incoming edges to a seed', () => {
    // File B has an edge TO the seed (seed is imported by B)
    // From the seed's perspective, B is an importer (imported_by relation)
    const graph = {
      nodes: [
        node('src/lib/util.ts', 'source'),
        node('src/app.ts', 'entrypoint'),
      ],
      edges: [
        edge('src/app.ts', 'src/lib/util.ts', 'imports'),
      ],
    };

    const result = expandNeighborhood({
      nodes: graph.nodes,
      edges: graph.edges,
      options: { seeds: ['src/lib/util.ts'], maxDepth: 1 },
    });

    // util.ts is imported by app.ts
    const appFile = result.files.find((f) => f.path === 'src/app.ts');
    expect(appFile).toBeDefined();
    expect(appFile!.relation).toBe('imported_by');
    expect(appFile!.depth).toBe(1);
  });

  it('avoids cycles (BFS visited set)', () => {
    // a → b → a (cycle)
    const cyclicGraph = {
      nodes: [
        node('a.ts'),
        node('b.ts'),
      ],
      edges: [
        edge('a.ts', 'b.ts', 'imports'),
        edge('b.ts', 'a.ts', 'imports'),
      ],
    };

    const result = expandNeighborhood({
      nodes: cyclicGraph.nodes,
      edges: cyclicGraph.edges,
      options: { seeds: ['a.ts'], maxDepth: 10 },
    });

    // Should only have 2 unique files (a and b), not infinite cycling
    expect(result.files).toHaveLength(2);
    expect(result.totalVisited).toBe(2);
  });

  it('handles self-loops', () => {
    const selfLoopGraph = {
      nodes: [node('self.ts')],
      edges: [edge('self.ts', 'self.ts', 'references')],
    };

    const result = expandNeighborhood({
      nodes: selfLoopGraph.nodes,
      edges: selfLoopGraph.edges,
      options: { seeds: ['self.ts'], maxDepth: 5 },
    });

    // Self-loop should be visited once
    expect(result.files).toHaveLength(1);
    expect(result.totalVisited).toBe(1);
  });

  it('sorts results by depth then path', () => {
    const result = expandNeighborhood({
      nodes: branchingGraph.nodes,
      edges: branchingGraph.edges,
      options: { seeds: ['src/index.ts'], maxDepth: 3 },
    });

    let prevDepth = 0;
    let prevPath = '';
    for (const file of result.files) {
      if (file.depth < prevDepth) {
        // Should not happen — depth should be non-decreasing
        throw new Error(`Results not sorted: depth ${file.depth} came after depth ${prevDepth}`);
      }
      if (file.depth === prevDepth) {
        expect(file.path.localeCompare(prevPath)).toBeGreaterThanOrEqual(0);
      }
      prevDepth = file.depth;
      prevPath = file.path;
    }
  });
});

describe('hilo-neighborhood — defaults', () => {
  it('uses DEFAULT_MAX_DEPTH=2 and DEFAULT_MAX_FILES=50 when not specified', () => {
    const result = expandNeighborhood({
      nodes: simpleImportGraph.nodes,
      edges: simpleImportGraph.edges,
      options: { seeds: ['src/a.ts'] },
    });

    expect(result.files.length).toBeLessThanOrEqual(DEFAULT_MAX_FILES);
    for (const file of result.files) {
      expect(file.depth).toBeLessThanOrEqual(DEFAULT_MAX_DEPTH);
    }
  });
});

describe('hilo-neighborhood — provenance completeness', () => {
  it('pathProvenance is always non-empty and starts with sourceSeed', () => {
    const result = expandNeighborhood({
      nodes: branchingGraph.nodes,
      edges: branchingGraph.edges,
      options: { seeds: ['src/index.ts'], maxDepth: 3 },
    });

    for (const file of result.files) {
      expect(file.pathProvenance.length).toBeGreaterThan(0);
      expect(file.pathProvenance[0]).toBe(file.sourceSeed);
      expect(file.pathProvenance[file.pathProvenance.length - 1]).toBe(file.path);
    }
  });

  it('multi-hop provenance shows complete chain', () => {
    // Build: a → b → c → d → e
    const chain = {
      nodes: [
        node('a.ts'),
        node('b.ts'),
        node('c.ts'),
        node('d.ts'),
        node('e.ts'),
      ],
      edges: [
        edge('a.ts', 'b.ts', 'imports'),
        edge('b.ts', 'c.ts', 'imports'),
        edge('c.ts', 'd.ts', 'imports'),
        edge('d.ts', 'e.ts', 'imports'),
      ],
    };

    const result = expandNeighborhood({
      nodes: chain.nodes,
      edges: chain.edges,
      options: { seeds: ['a.ts'], maxDepth: 4 },
    });

    const eFile = result.files.find((f) => f.path === 'e.ts');
    expect(eFile).toBeDefined();
    expect(eFile!.depth).toBe(4);
    expect(eFile!.pathProvenance).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);
    expect(eFile!.sourceSeed).toBe('a.ts');
    expect(eFile!.relation).toBe('imports');
  });
});

describe('hilo-neighborhood — graph-only constraint', () => {
  it('uses only in-memory graph data — no FUSE, xattr, inotify, or remote backend', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'hilo-neighborhood.ts'),
      'utf-8',
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const forbidden of [/\bfuse\b/i, /xattr/i, /inotify/i, /chokidar/i, /fs\.watch\b/i, /\.watch\(/]) {
      expect(code).not.toMatch(forbidden);
    }
  });
});
