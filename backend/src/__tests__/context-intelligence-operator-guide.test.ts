/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * context-intelligence-operator-guide.test.ts — US-041 documentation regression
 * fixture.
 *
 * This is a pure-filesystem test (no DB, no network): it guards
 * `docs/context-intelligence-operator-guide.md` so a future change cannot
 * silently delete it or strip the topics US-041's acceptance criteria require.
 * Each assertion maps to an acceptance criterion:
 *
 *   - Hilo graph-only configuration + grounded spec creation flow
 *   - rorca-capture remember / ingest / hooks / queue / daemon
 *   - tools must use APIs and never direct DB writes
 *   - security: redaction, ignores, regulated review defaults, limits,
 *     source-of-truth boundaries
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const GUIDE_PATH = path.join(REPO_ROOT, 'docs', 'context-intelligence-operator-guide.md');
const CONTRACT_PATH = path.join(REPO_ROOT, 'docs', 'context-intelligence-platform.md');

describe('US-041 — Context Intelligence operator/security guide', () => {
  let guide: string;

  beforeAll(() => {
    guide = fs.readFileSync(GUIDE_PATH, 'utf8');
  });

  it('exists and is non-trivial', () => {
    expect(guide.length).toBeGreaterThan(2000);
    expect(guide).toMatch(/^# Context Intelligence Platform/m);
  });

  it('covers Hilo graph-only configuration', () => {
    expect(guide).toMatch(/graph-only/i);
    // The defining negatives of graph-only: no FUSE, no xattr, no watcher, no remote backend.
    expect(guide).toMatch(/no FUSE/i);
    expect(guide).toMatch(/inotify|file-watch|watcher/i);
    expect(guide).toMatch(/no remote backend/i);
    // Config surface operators actually use.
    expect(guide).toContain('HILO_BIN');
    expect(guide).toContain('RORCA_HILO_ENABLED');
  });

  it('documents the Hilo fork strategy', () => {
    expect(guide).toMatch(/fork/i);
    expect(guide).toMatch(/pinned/i);
  });

  it('covers hydration, preview, and grounded spec creation', () => {
    expect(guide).toMatch(/hydrat/i);
    expect(guide).toContain('/api/workspaces/:workspaceId/hydration');
    expect(guide).toMatch(/preview/i);
    expect(guide).toContain('/api/context/retrieve');
    expect(guide).toMatch(/grounded/i);
    expect(guide).toContain('SpecContextBundle');
  });

  it('covers rorca-capture remember / ingest / hooks / queue / daemon', () => {
    expect(guide).toMatch(/remember/i);
    expect(guide).toContain('rorca capture ingest-commit');
    expect(guide).toContain('rorca capture ingest-git');
    expect(guide).toContain('rorca capture flush');
    expect(guide).toContain('git-hook');
    expect(guide).toContain('.rorca-capture-queue.jsonl');
    expect(guide).toContain('npm run reconcile');
    expect(guide).toMatch(/daemon/i);
  });

  it('states tools must use APIs and never direct DB writes', () => {
    expect(guide).toMatch(/never\s+writes?\s+to\s+the\s+Rorca\s+DB\s+directly/i);
    expect(guide).toMatch(/never\b.*direct\s+DB\s+writes/i);
  });

  it('covers redaction with concrete secret classes', () => {
    expect(guide).toContain('redactSecrets');
    expect(guide).toMatch(/private key/i);
    expect(guide).toMatch(/database (connection|url)/i);
    expect(guide).toContain('[REDACTED]');
  });

  it('covers ignore rules', () => {
    expect(guide).toContain('.rorca-captureignore');
    expect(guide).toContain('DEFAULT_IGNORE_PATTERNS');
  });

  it('covers regulated review defaults (governance gate)', () => {
    expect(guide).toMatch(/governance gate is\s+\*?\*?absolute/i);
    expect(guide).toMatch(/PENDING/);
    expect(guide).toMatch(/approv/i);
    // Captured items default to the lowest trust tiers.
    expect(guide).toMatch(/captured|unverified/);
  });

  it('covers limits', () => {
    expect(guide).toContain('context-limits.ts');
    expect(guide).toMatch(/concurrency/i);
    expect(guide).toMatch(/env-overridable/i);
  });

  it('covers source-of-truth boundaries', () => {
    expect(guide).toMatch(/source-of-truth/i);
    expect(guide).toMatch(/system of record/i);
    expect(guide).toMatch(/rebuildable/i);
    expect(guide).toMatch(/offline buffer/i);
    expect(guide).toMatch(/cache only|cache-only/i);
  });

  it('has a troubleshooting section', () => {
    expect(guide).toMatch(/##\s*8\.?\s*Troubleshooting/i);
  });

  it('is linked from the canonical platform contract doc', () => {
    const contract = fs.readFileSync(CONTRACT_PATH, 'utf8');
    expect(contract).toContain('docs/context-intelligence-operator-guide.md');
  });
});
