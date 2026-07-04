/// <reference types="node" />
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 *
 * US-041 documentation regression guard.
 *
 * This pure-filesystem Vitest suite keeps the operator and security docs aligned
 * with the Context Intelligence rollout contract without touching the backend or
 * a live database.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');
const guidePath = path.join(repoRoot, 'docs', 'context-intelligence-operator-guide.md');
const securityModelPath = path.join(repoRoot, 'docs', 'SECURITY-MODEL.md');

const guide = fs.readFileSync(guidePath, 'utf8');
const securityModel = fs.readFileSync(securityModelPath, 'utf8');
const combinedDocs = `${guide}\n${securityModel}`;

describe('Context Intelligence operator/security docs (US-041)', () => {
  it('cover Hilo graph-only configuration and grounded spec creation', () => {
    expect(guide).toContain('graph-only');
    expect(guide).toMatch(/no FUSE/i);
    expect(guide).toMatch(/no extended attributes|no xattr/i);
    expect(guide).toMatch(/no inotify|no file-watch|no watcher/i);
    expect(guide).toMatch(/no remote backend/i);
    expect(guide).toContain('HILO_BIN');
    expect(guide).toContain('RORCA_HILO_ENABLED');
    expect(guide).toContain('RORCA_HILO_OUTPUT_DIR');
    expect(guide).toContain('RORCA_HILO_TIMEOUT_MS');
    expect(guide).toContain('GET /api/workspaces/:workspaceId/hydration');
    expect(guide).toContain('POST /api/context/retrieve');
    expect(guide).toContain('SpecContextBundle');
    expect(guide).toContain('POST /api/specs/persist');
  });

  it('cover rorca-capture remember, ingest, hooks, queue, and daemon operations', () => {
    expect(guide).toMatch(/"Remember" is the product verb/i);
    expect(guide).toContain('POST /api/context-events');
    expect(guide).toContain('POST /api/candidates');
    expect(guide).toContain('rorca-capture');
    expect(guide).toContain('rorca capture ingest-commit');
    expect(guide).toContain('rorca capture ingest-git');
    expect(guide).toContain('rorca capture flush');
    expect(guide).toContain('git-hook');
    expect(guide).toContain('.rorca-capture-queue.jsonl');
    expect(guide).toContain('npm run reconcile');
    expect(guide).toMatch(/daemon/i);
  });

  it('state external tools must use APIs and never direct DB writes', () => {
    expect(combinedDocs).toMatch(/tools must use the \*\*APIs\*\*/i);
    expect(combinedDocs).toMatch(/must use Rorca APIs/i);
    expect(combinedDocs).toMatch(/never\*?\*? write directly to PostgreSQL/i);
    expect(combinedDocs).toMatch(/never\b.*direct DB writes/i);
  });

  it('cover security defaults for redaction, ignores, regulated review, limits, and boundaries', () => {
    expect(securityModel).toContain('redactSecrets()');
    expect(securityModel).toContain('[REDACTED]');
    expect(securityModel).toContain('DEFAULT_IGNORE_PATTERNS');
    expect(securityModel).toContain('.rorca-captureignore');
    expect(securityModel).toContain('PENDING `memory_candidate`');
    expect(securityModel).toMatch(/captured.*unverified/i);
    expect(securityModel).toContain('context-limits.ts');
    expect(securityModel).toMatch(/Source-of-truth boundaries/i);
    expect(securityModel).toMatch(/Hilo graph is rebuildable graph-only codegraph data/i);
    expect(securityModel).toMatch(/PostgreSQL is the only durable system of\s+record/i);
    expect(securityModel).toMatch(/local JSONL capture queue is an offline buffer/i);
    expect(securityModel).toMatch(/Redis is a\s+cache/i);
  });
});
