/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  computeHydrationCounts,
  computeNodeCounts,
  normalizeEdge,
  normalizeHiloOutput,
  normalizeNode,
  parseHiloLine,
  readHiloLines,
} from '../hilo-normalizer';

// ════════════════════════════════════════════════════════════════════════════
// Fixture helpers
// ════════════════════════════════════════════════════════════════════════════

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'hilo');

function setupFixtureDir(fixtureName: string): { dir: string; sourcePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hilo-norm-${fixtureName}-`));
  const sourcePath = path.join(FIXTURE_DIR, `${fixtureName}.jsonl`);
  const destPath = path.join(dir, 'edges.jsonl');
  fs.copyFileSync(sourcePath, destPath);
  return { dir, sourcePath };
}

function cleanupFixtureDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
}

// ════════════════════════════════════════════════════════════════════════════
// parseHiloLine
// ════════════════════════════════════════════════════════════════════════════

describe('parseHiloLine', () => {
  it('parses a valid edge line', () => {
    const line = JSON.stringify({
      type: 'edge',
      from: 'src/a.ts',
      to: 'src/b.ts',
      relation: 'imports',
      weight: 2,
    });
    const entry = parseHiloLine(line)!;
    expect(entry).not.toBeNull();
    expect(entry.type).toBe('edge');
    if (entry.type === 'edge') {
      expect(entry.from).toBe('src/a.ts');
      expect(entry.to).toBe('src/b.ts');
      expect(entry.relation).toBe('imports');
      expect(entry.weight).toBe(2);
    }
  });

  it('parses an edge line without optional weight', () => {
    const line = JSON.stringify({
      type: 'edge',
      from: 'src/a.ts',
      to: 'src/b.ts',
      relation: 'imports',
    });
    const entry = parseHiloLine(line)!;
    expect(entry).not.toBeNull();
    expect(entry.type).toBe('edge');
    if (entry.type === 'edge') {
      expect(entry.weight).toBeUndefined();
    }
  });

  it('parses a valid node line', () => {
    const line = JSON.stringify({
      type: 'node',
      path: 'src/a.ts',
      role: 'source',
      language: 'typescript',
      contentHash: 'abc123',
    });
    const entry = parseHiloLine(line)!;
    expect(entry).not.toBeNull();
    expect(entry.type).toBe('node');
    if (entry.type === 'node') {
      expect(entry.path).toBe('src/a.ts');
      expect(entry.role).toBe('source');
      expect(entry.language).toBe('typescript');
      expect(entry.contentHash).toBe('abc123');
    }
  });

  it('parses a node line without optional classification data (partial hydration)', () => {
    const line = JSON.stringify({
      type: 'node',
      path: 'src/b.ts',
    });
    const entry = parseHiloLine(line)!;
    expect(entry).not.toBeNull();
    expect(entry.type).toBe('node');
    if (entry.type === 'node') {
      expect(entry.path).toBe('src/b.ts');
      expect(entry.role).toBeUndefined();
      expect(entry.language).toBeUndefined();
      expect(entry.contentHash).toBeUndefined();
    }
  });

  it('returns null for unparseable JSON', () => {
    expect(parseHiloLine('{ not valid json')).toBeNull();
    expect(parseHiloLine('')).toBeNull();
  });

  it('returns null for non-object JSON', () => {
    expect(parseHiloLine('42')).toBeNull();
    expect(parseHiloLine('"a string"')).toBeNull();
    expect(parseHiloLine('null')).toBeNull();
  });

  it('returns null for object without a string type', () => {
    expect(parseHiloLine('{"foo":"bar"}')).toBeNull();
    expect(parseHiloLine('{"type":42}')).toBeNull();
  });

  it('returns null for edge without from/to/relation strings', () => {
    expect(parseHiloLine('{"type":"edge","from":"a","to":"b"}')).toBeNull();
    expect(parseHiloLine('{"type":"edge","from":"a","relation":"imports"}')).toBeNull();
  });

  it('returns null for node without string path', () => {
    expect(parseHiloLine('{"type":"node"}')).toBeNull();
    expect(parseHiloLine('{"type":"node","path":42}')).toBeNull();
  });

  it('returns null for unknown entry type', () => {
    expect(parseHiloLine('{"type":"unknown"}')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// normalizeEdge
// ════════════════════════════════════════════════════════════════════════════

describe('normalizeEdge', () => {
  it('normalizes a valid imports edge', () => {
    const edge = normalizeEdge({
      type: 'edge',
      from: 'src/a.ts',
      to: 'src/b.ts',
      relation: 'imports',
      weight: 3,
    });
    expect(edge).not.toBeNull();
    expect(edge!.from).toBe('src/a.ts');
    expect(edge!.to).toBe('src/b.ts');
    expect(edge!.relation).toBe('imports');
    expect(edge!.weight).toBe(3);
    expect(edge!.schemaVersion).toBe('v1');
  });

  it('normalizes an edge without weight (optional field)', () => {
    const edge = normalizeEdge({
      type: 'edge',
      from: 'src/a.ts',
      to: 'src/b.ts',
      relation: 'imports',
    });
    expect(edge).not.toBeNull();
    expect(edge!.weight).toBeUndefined();
  });

  it('normalizes imported_by, tests, and tested_by relations', () => {
    for (const rel of ['imported_by', 'tests', 'tested_by', 'sibling', 'contains', 'references']) {
      const edge = normalizeEdge({
        type: 'edge',
        from: 'src/a.ts',
        to: 'src/b.ts',
        relation: rel,
      });
      expect(edge).not.toBeNull();
      expect(edge!.relation).toBe(rel);
    }
  });

  it('returns null for an unmappable/unknown relation', () => {
    const edge = normalizeEdge({
      type: 'edge',
      from: 'src/a.ts',
      to: 'src/b.ts',
      relation: 'inherits',
    });
    // The normalizer passes unknown relations through; the shared schema rejects.
    expect(edge).toBeNull();
  });

  it('returns null for invalid paths (absolute)', () => {
    const edge = normalizeEdge({
      type: 'edge',
      from: '/absolute/src/a.ts',
      to: 'src/b.ts',
      relation: 'imports',
    });
    expect(edge).toBeNull();
  });

  it('returns null for paths with ".." traversal', () => {
    const edge = normalizeEdge({
      type: 'edge',
      from: 'src/a.ts',
      to: '../outside/b.ts',
      relation: 'imports',
    });
    expect(edge).toBeNull();
  });

  it('returns null for negative weight', () => {
    const edge = normalizeEdge({
      type: 'edge',
      from: 'src/a.ts',
      to: 'src/b.ts',
      relation: 'imports',
      weight: -1,
    });
    expect(edge).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// normalizeNode
// ════════════════════════════════════════════════════════════════════════════

describe('normalizeNode', () => {
  it('normalizes a fully-specified node', () => {
    const node = normalizeNode({
      type: 'node',
      path: 'src/utils/helper.ts',
      role: 'source',
      language: 'typescript',
      contentHash: 'abc123',
    });
    expect(node).not.toBeNull();
    expect(node!.path).toBe('src/utils/helper.ts');
    expect(node!.role).toBe('source');
    expect(node!.language).toBe('typescript');
    expect(node!.contentHash).toBe('abc123');
    expect(node!.importsCount).toBe(0);
    expect(node!.importedByCount).toBe(0);
    expect(node!.testsCount).toBe(0);
    expect(node!.testedByCount).toBe(0);
    expect(node!.schemaVersion).toBe('v1');
  });

  it('normalizes a node with missing optional classification (partial hydration)', () => {
    const node = normalizeNode({
      type: 'node',
      path: 'src/minimal.ts',
    });
    expect(node).not.toBeNull();
    expect(node!.path).toBe('src/minimal.ts');
    expect(node!.role).toBe('unknown');
    expect(node!.language).toBeUndefined();
    expect(node!.contentHash).toBeUndefined();
  });

  it('normalizes known role values', () => {
    for (const role of ['source', 'test', 'config', 'doc', 'entrypoint', 'fixture', 'generated']) {
      const node = normalizeNode({ type: 'node', path: 'src/f.ts', role });
      expect(node!.role).toBe(role);
    }
  });

  it('maps unknown/garbled role values to "unknown"', () => {
    const node = normalizeNode({ type: 'node', path: 'src/f.ts', role: 'DEITY' });
    expect(node!.role).toBe('unknown');
  });

  it('maps empty role to "unknown"', () => {
    const node = normalizeNode({ type: 'node', path: 'src/f.ts', role: '' });
    expect(node!.role).toBe('unknown');
  });

  it('maps undefined role to "unknown"', () => {
    const node = normalizeNode({ type: 'node', path: 'src/f.ts' });
    expect(node!.role).toBe('unknown');
  });

  it('returns null for invalid path (absolute)', () => {
    const node = normalizeNode({ type: 'node', path: '/absolute/path.ts' });
    expect(node).toBeNull();
  });

  it('returns null for path with ".." traversal', () => {
    const node = normalizeNode({ type: 'node', path: '../outside/file.ts' });
    expect(node).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// computeNodeCounts
// ════════════════════════════════════════════════════════════════════════════

describe('computeNodeCounts', () => {
  it('computes import and test counts from outgoing/incoming maps', () => {
    const outgoing = new Map<string, string[]>([
      ['src/a.ts', ['imports', 'imports', 'tests']],
      ['src/b.ts', ['imports']],
    ]);
    const incoming = new Map<string, string[]>([
      ['src/a.ts', ['imports', 'tests', 'tests']],
      ['src/b.ts', ['imports', 'imports', 'imported_by']],
    ]);

    const countsA = computeNodeCounts('src/a.ts', outgoing, incoming);
    expect(countsA.importsCount).toBe(2);
    expect(countsA.testsCount).toBe(1);
    expect(countsA.importedByCount).toBe(1);
    expect(countsA.testedByCount).toBe(2);

    const countsB = computeNodeCounts('src/b.ts', outgoing, incoming);
    expect(countsB.importsCount).toBe(1);
    expect(countsB.testsCount).toBe(0);
    expect(countsB.importedByCount).toBe(2);
    expect(countsB.testedByCount).toBe(0);
  });

  it('handles a node with no edges', () => {
    const outgoing = new Map<string, string[]>();
    const incoming = new Map<string, string[]>();
    const counts = computeNodeCounts('src/empty.ts', outgoing, incoming);
    expect(counts.importsCount).toBe(0);
    expect(counts.testsCount).toBe(0);
    expect(counts.importedByCount).toBe(0);
    expect(counts.testedByCount).toBe(0);
    expect(counts.relationCounts).toBeUndefined();
  });

  it('collects non-import/test relations in relationCounts', () => {
    const outgoing = new Map<string, string[]>([
      ['src/a.ts', ['references', 'contains', 'references', 'sibling']],
    ]);
    const incoming = new Map<string, string[]>([
      ['src/a.ts', ['tested_by', 'references']],
    ]);

    const counts = computeNodeCounts('src/a.ts', outgoing, incoming);
    expect(counts.relationCounts).toEqual({
      references: 3,
      contains: 1,
      sibling: 1,
      tested_by: 1,
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// computeHydrationCounts
// ════════════════════════════════════════════════════════════════════════════

describe('computeHydrationCounts', () => {
  it('produces aggregate counts from nodes and edges', () => {
    const nodes = [
      { schemaVersion: 'v1' as const, path: 'a.ts', role: 'source' as const, importsCount: 2, importedByCount: 0, testsCount: 0, testedByCount: 0 },
      { schemaVersion: 'v1' as const, path: 'b.ts', role: 'test' as const, importsCount: 0, importedByCount: 0, testsCount: 1, testedByCount: 0 },
      { schemaVersion: 'v1' as const, path: 'c.ts', role: 'source' as const, importsCount: 0, importedByCount: 3, testsCount: 0, testedByCount: 0 },
    ];
    const edges = [
      { schemaVersion: 'v1' as const, from: 'a.ts', to: 'b.ts', relation: 'imports' as const },
      { schemaVersion: 'v1' as const, from: 'a.ts', to: 'c.ts', relation: 'imports' as const },
      { schemaVersion: 'v1' as const, from: 'b.ts', to: 'c.ts', relation: 'tests' as const },
      { schemaVersion: 'v1' as const, from: 'c.ts', to: 'a.ts', relation: 'imported_by' as const },
    ];
    const counts = computeHydrationCounts(nodes, edges);
    expect(counts.files).toBe(3);
    expect(counts.nodes).toBe(3);
    expect(counts.edges).toBe(4);
    expect(counts.imports).toBe(2);
    expect(counts.reverseImporters).toBe(1);
    expect(counts.tests).toBe(1);
    expect(counts.testedBy).toBe(0);
    expect(counts.roles).toBe(2); // source + test
  });
});

// ════════════════════════════════════════════════════════════════════════════
// readHiloLines
// ════════════════════════════════════════════════════════════════════════════

describe('readHiloLines', () => {
  it('returns empty array when no edges.jsonl exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo-norm-empty-'));
    try {
      const lines = readHiloLines(dir);
      expect(lines).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('splits lines and skips empties', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo-norm-lines-'));
    const sourcePath = path.join(FIXTURE_DIR, 'typescript-imports.jsonl');
    const destPath = path.join(dir, 'edges.jsonl');
    fs.copyFileSync(sourcePath, destPath);
    try {
      const lines = readHiloLines(dir);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toBe('');
        // Each line should be valid JSON
        expect(() => JSON.parse(line)).not.toThrow();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// normalizeHiloOutput — fixture tests
// ════════════════════════════════════════════════════════════════════════════

describe('normalizeHiloOutput — TypeScript imports fixture', () => {
  let dir: string;

  beforeAll(() => {
    const setup = setupFixtureDir('typescript-imports');
    dir = setup.dir;
  });

  afterAll(() => {
    cleanupFixtureDir(dir);
  });

  it('parses edges.jsonl and produces normalized nodes and edges', () => {
    const result = normalizeHiloOutput({ outputDir: dir });

    expect(result.nodes.length).toBe(7);
    expect(result.edges.length).toBe(7);

    // Verify roles are normalized
    const roles = new Set(result.nodes.map((n) => n.role));
    expect(roles.has('entrypoint')).toBe(true);
    expect(roles.has('source')).toBe(true);
    expect(roles.has('config')).toBe(true);

    // Verify languages
    const languages = new Set(result.nodes.map((n) => n.language).filter(Boolean));
    expect(languages.has('typescript')).toBe(true);
    expect(languages.has('css')).toBe(true);

    // Verify all edges are imports
    for (const edge of result.edges) {
      expect(edge.relation).toBe('imports');
    }

    // Verify counts
    expect(result.counts.imports).toBe(7);
    expect(result.counts.edges).toBe(7);
    expect(result.counts.files).toBe(7);

    // Verify index.ts has correct import counts (imports 3 files, imported by 0)
    const indexNode = result.nodes.find((n) => n.path === 'src/index.ts');
    expect(indexNode).toBeDefined();
    expect(indexNode!.importsCount).toBe(3);
    expect(indexNode!.importedByCount).toBe(0);

    // Verify apiFetch.ts is imported by multiple files
    const apiFetch = result.nodes.find((n) => n.path === 'src/lib/apiFetch.ts');
    expect(apiFetch).toBeDefined();
    expect(apiFetch!.importedByCount).toBeGreaterThan(0);

    // No ignored lines expected
    expect(result.ignoredLines).toBe(0);
  });
});

describe('normalizeHiloOutput — Go/Python imports fixture', () => {
  let dir: string;

  beforeAll(() => {
    const setup = setupFixtureDir('go-python-imports');
    dir = setup.dir;
  });

  afterAll(() => {
    cleanupFixtureDir(dir);
  });

  it('normalizes Go package imports and Python module imports', () => {
    const result = normalizeHiloOutput({ outputDir: dir });

    expect(result.nodes.length).toBe(9);
    expect(result.edges.length).toBe(8);

    // Verify Go nodes
    const goNodes = result.nodes.filter(
      (n) => n.language === 'go',
    );
    expect(goNodes.length).toBe(5);
    const goEntrypoint = goNodes.find((n) => n.path === 'cmd/server/main.go');
    expect(goEntrypoint).toBeDefined();
    expect(goEntrypoint!.role).toBe('entrypoint');
    expect(goEntrypoint!.importsCount).toBe(2);

    // Verify Python nodes
    const pyNodes = result.nodes.filter(
      (n) => n.language === 'python',
    );
    expect(pyNodes.length).toBe(4);
    const pyServer = pyNodes.find((n) => n.path === 'src/server.py');
    expect(pyServer).toBeDefined();
    expect(pyServer!.role).toBe('entrypoint');
    expect(pyServer!.importsCount).toBe(3);

    // No ignored lines expected
    expect(result.ignoredLines).toBe(0);
  });
});

describe('normalizeHiloOutput — Test relationships fixture', () => {
  let dir: string;

  beforeAll(() => {
    const setup = setupFixtureDir('test-relationships');
    dir = setup.dir;
  });

  afterAll(() => {
    cleanupFixtureDir(dir);
  });

  it('normalizes test relationships, imports, and references', () => {
    const result = normalizeHiloOutput({ outputDir: dir });

    expect(result.nodes.length).toBe(10);
    expect(result.edges.length).toBe(10);

    // Verify test edges
    const testEdges = result.edges.filter((e) => e.relation === 'tests');
    expect(testEdges.length).toBe(5);

    // Verify import edges
    const importEdges = result.edges.filter((e) => e.relation === 'imports');
    expect(importEdges.length).toBe(4);

    // Verify references edge
    const refEdges = result.edges.filter((e) => e.relation === 'references');
    expect(refEdges.length).toBe(1);

    // Verify counts
    expect(result.counts.tests).toBe(5);
    expect(result.counts.imports).toBe(4);

    // Files under test should have testedByCount > 0
    const apiFetch = result.nodes.find((n) => n.path === 'src/lib/apiFetch.ts');
    expect(apiFetch).toBeDefined();
    expect(apiFetch!.testedByCount).toBeGreaterThan(0);
    expect(apiFetch!.role).toBe('source');

    // Test files should have testsCount > 0
    const apiFetchTest = result.nodes.find((n) => n.path === 'src/lib/__tests__/apiFetch.test.ts');
    expect(apiFetchTest).toBeDefined();
    expect(apiFetchTest!.testsCount).toBeGreaterThan(0);
    expect(apiFetchTest!.role).toBe('test');

    // Go test convention: http_test.go tests http.go
    const goHandler = result.nodes.find((n) => n.path === 'pkg/handlers/http.go');
    expect(goHandler).toBeDefined();
    expect(goHandler!.testedByCount).toBe(1);

    // Python test convention: test_helpers.py tests helpers.py
    const pyHelper = result.nodes.find((n) => n.path === 'src/utils/helpers.py');
    expect(pyHelper).toBeDefined();
    expect(pyHelper!.testedByCount).toBe(1);

    // No ignored lines expected
    expect(result.ignoredLines).toBe(0);
  });

  it('produces relationCounts for nodes with non-standard relations', () => {
    const result = normalizeHiloOutput({ outputDir: dir });

    // helpers.py has a 'references' outgoing edge
    const pyHelper = result.nodes.find((n) => n.path === 'src/utils/helpers.py');
    expect(pyHelper).toBeDefined();
    expect(pyHelper!.relationCounts).toBeDefined();
    expect(pyHelper!.relationCounts!.references).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// normalizeHiloOutput — edge cases
// ════════════════════════════════════════════════════════════════════════════

describe('normalizeHiloOutput — edge cases', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo-norm-edge-'));
  });

  afterEach(() => {
    cleanupFixtureDir(dir);
  });

  it('returns empty graph when edges.jsonl is absent', () => {
    const result = normalizeHiloOutput({ outputDir: dir });
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.counts.files).toBe(0);
    expect(result.ignoredLines).toBe(0);
  });

  it('returns empty graph for an empty edges.jsonl', () => {
    fs.writeFileSync(path.join(dir, 'edges.jsonl'), '');
    const result = normalizeHiloOutput({ outputDir: dir });
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it('counts ignored lines for malformed JSON', () => {
    const content = [
      '{"type":"edge","from":"a.ts","to":"b.ts","relation":"imports"}',
      'not valid json at all',
      '{"type":"edge","from":"b.ts","to":"c.ts","relation":"imports"}',
      '{"type":"unknown","path":"x.ts"}',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'edges.jsonl'), content);
    const result = normalizeHiloOutput({ outputDir: dir });
    expect(result.edges.length).toBe(2); // 2 valid edges
    expect(result.ignoredLines).toBe(2); // 2 malformed/invalid lines
  });

  it('handles edges with missing optional classification data (partial hydration)', () => {
    // Edges without node entries — nodes should be synthesized with role='unknown'
    const content = [
      '{"type":"edge","from":"src/foo.ts","to":"src/bar.ts","relation":"imports"}',
      '{"type":"edge","from":"src/bar.ts","to":"src/baz.ts","relation":"imports"}',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'edges.jsonl'), content);
    const result = normalizeHiloOutput({ outputDir: dir });

    // Should have 3 synthetic nodes (not 0) — partial hydration
    expect(result.nodes.length).toBe(3);
    expect(result.edges.length).toBe(2);

    // All synthetic nodes should have role='unknown'
    for (const node of result.nodes) {
      expect(node.role).toBe('unknown');
      expect(node.language).toBeUndefined();
    }

    // Counts should still be correct
    const foo = result.nodes.find((n) => n.path === 'src/foo.ts');
    expect(foo!.importsCount).toBe(1);
    expect(foo!.importedByCount).toBe(0);

    const bar = result.nodes.find((n) => n.path === 'src/bar.ts');
    expect(bar!.importsCount).toBe(1);
    expect(bar!.importedByCount).toBe(1);
  });

  it('handles mixed edges — some valid, some rejected by shared schema', () => {
    const content = [
      '{"type":"edge","from":"src/a.ts","to":"src/b.ts","relation":"imports"}',
      '{"type":"edge","from":"/absolute/bad.ts","to":"src/b.ts","relation":"imports"}',
      '{"type":"edge","from":"src/c.ts","to":"../escape.ts","relation":"imports"}',
      '{"type":"edge","from":"src/d.ts","to":"src/e.ts","relation":"imports"}',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'edges.jsonl'), content);
    const result = normalizeHiloOutput({ outputDir: dir });

    // 2 valid edges survive, 2 are rejected
    expect(result.edges.length).toBe(2);
    expect(result.ignoredLines).toBe(2);
    expect(result.nodes.length).toBeGreaterThanOrEqual(3); // a, b, d, e from valid edges
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Graph-only constraint
// ════════════════════════════════════════════════════════════════════════════

describe('hilo-normalizer — graph-only constraint (no FUSE / xattr / inotify)', () => {
  it('introduces no filesystem-trigger or remote-backend dependency', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'hilo-normalizer.ts'), 'utf-8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const forbidden of [/\bfuse\b/i, /xattr/i, /inotify/i, /chokidar/i, /fs\.watch\b/i, /\.watch\(/]) {
      expect(code).not.toMatch(forbidden);
    }
  });
});
