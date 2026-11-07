/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type TraceRow = {
  requirementId: string;
  disposition: 'implemented' | 'deferred' | 'not-applicable';
  evidence?: string[];
  rationale?: string;
  reviewed?: boolean;
};

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

function requirementRows() {
  return [...read('docs/security/hackbot/requirements.md').matchAll(/^\| (HB-[A-Z]+-\d+) \| (MUST|SHOULD) \|/gm)]
    .map((match) => ({ id: match[1], level: match[2] }));
}

describe('HackBot governance documentation', () => {
  it('traces every canonical requirement exactly once with an actionable disposition', () => {
    const requirements = requirementRows();
    const trace = JSON.parse(read('docs/security/hackbot/hackbot-requirements-trace.v1.json')) as {
      schema: string;
      rows: TraceRow[];
    };

    expect(trace.schema).toBe('hackbot-requirements-trace.v1');
    expect(requirements.length).toBeGreaterThan(0);
    expect(trace.rows.map((row) => row.requirementId).sort()).toEqual(requirements.map(({ id }) => id).sort());
    expect(new Set(trace.rows.map((row) => row.requirementId)).size).toBe(trace.rows.length);

    for (const row of trace.rows) {
      expect(['implemented', 'deferred', 'not-applicable']).toContain(row.disposition);
      if (row.disposition === 'implemented') expect(row.evidence?.length).toBeGreaterThan(0);
      if (row.disposition !== 'implemented') expect(row.rationale?.trim().length).toBeGreaterThan(20);
      const requirement = requirements.find(({ id }) => id === row.requirementId);
      if (requirement?.level === 'MUST' && row.disposition === 'deferred') {
        expect(row.reviewed).toBe(true);
        expect(row.rationale).toMatch(/^Reviewed MUST:/);
      }
    }
  });

  it('gives every finite P0 invariant an owner and mandatory test', () => {
    const adr = read('docs/architecture/adr-hackbot-governed-mission-control.md');
    const p0Rows = [...adr.matchAll(/^\| (P0-[A-Z]+-\d+) \| ([^|]+) \| `([^`]+)` \| `([^`]+)` \|$/gm)];

    expect(p0Rows.length).toBe(9);
    for (const [, id, invariant, owner, test] of p0Rows) {
      expect(id).toMatch(/^P0-/);
      expect(invariant.trim()).not.toBe('');
      expect(owner).toContain('/');
      expect(test).toMatch(/\.contract$/);
    }
  });
});
