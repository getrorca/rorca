/// <reference types="node" />
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 *
 * Guard test for the Context Intelligence Platform canonical design doc (US-001).
 *
 * This locks the four acceptance criteria of US-001 in place as a regression
 * fixture: the design doc must keep covering the five subsystems, must keep
 * stating the four source-of-truth boundaries, must keep excluding the named
 * adapters, and must keep a wave map that lists every story in the spec. If a
 * later story rewrites the architecture, it has to update this doc (and this
 * test) deliberately rather than silently drifting away from the contract.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
// src/__tests__ -> src -> repo root
const repoRoot = path.resolve(testDir, '../..');
const docPath = path.join(repoRoot, 'docs', 'context-intelligence-platform.md');

const doc = fs.readFileSync(docPath, 'utf8');
const lower = doc.toLowerCase();

describe('Context Intelligence Platform design doc (US-001)', () => {
  it('exists and is non-trivial', () => {
    expect(doc.length).toBeGreaterThan(2000);
  });

  // AC1: covers the five subsystems.
  it('covers all five subsystems', () => {
    const subsystems = [
      'Hilo Hydration',
      'Retrieval / Ranking',
      'Context Composition',
      'Capture Sidecar',
      'Candidate Governance',
    ];
    for (const subsystem of subsystems) {
      expect(doc).toContain(subsystem);
    }
  });

  // AC2: states the four source-of-truth boundaries.
  it('states the Hilo graph is rebuildable codegraph data', () => {
    expect(lower).toContain('rebuildable codegraph data');
  });

  it('states the Rorca DB stores durable reviewed state', () => {
    expect(lower).toContain('durable, reviewed state');
    expect(lower).toContain('system of record');
  });

  it('states the local queue is an offline buffer', () => {
    expect(lower).toContain('offline buffer');
  });

  it('states Redis is cache-only', () => {
    expect(lower).toContain('redis is cache-only');
  });

  // AC3: explicitly excludes the named adapters.
  it('explicitly excludes Hermes, DuckBrain, GitHub, Linear, and Slack/Sentry/incident adapters', () => {
    expect(doc).toContain('Excluded Adapters');
    for (const adapter of ['Hermes', 'DuckBrain', 'GitHub', 'Linear', 'Slack', 'Sentry', 'incident']) {
      expect(doc).toContain(adapter);
    }
  });

  // AC4: includes a wave map listing every story in the spec with shared contracts.
  it('includes a wave map covering every story US-001..US-042', () => {
    expect(doc).toContain('Wave Map');
    expect(doc).toContain('Shared Contracts');
    for (let i = 1; i <= 42; i += 1) {
      const id = `US-${String(i).padStart(3, '0')}`;
      expect(doc, `wave map / doc is missing ${id}`).toContain(id);
    }
  });

  it('identifies the critical path', () => {
    expect(doc).toContain('Critical Path');
    // The critical path must begin at the design doc and end at final validation.
    expect(doc).toContain('US-001 → US-002');
    expect(doc).toContain('US-040 → US-042');
  });
});
