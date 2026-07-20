/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PTY_BYTE_CLASSES, safePtyTelemetryLabels, safePtyTelemetryMeasurements } from '../context-safety';
import {
  getPtyFeatureControls,
  PTY_FEATURE_ENV,
} from '../pty-feature-flags';

const migration = fs.readFileSync(path.resolve(__dirname, '../../db/pg-migrations/20260719090000_pty_recovery_operations.sql'), 'utf8');
const operations = fs.readFileSync(path.resolve(__dirname, '../pty-operations.ts'), 'utf8');
const pipeline = fs.readFileSync(path.resolve(__dirname, '../../routes/pipeline.ts'), 'utf8');
const runbook = fs.readFileSync(path.resolve(__dirname, '../../../../docs/pty-recovery-operations.md'), 'utf8');

describe('PTY recovery operations contract', () => {
  test('uses only the closed, content-free byte class labels', () => {
    expect(PTY_BYTE_CLASSES).toEqual(['observed', 'archived', 'transcripted', 'compacted', 'dropped', 'unrecoverable']);
    expect(safePtyTelemetryLabels('archived', 'archive')).toEqual({ byte_class: 'archived', component: 'archive' });
    expect(safePtyTelemetryMeasurements({ bytes: 12, ok: true, path: '/private/repo', prompt: 'secret' }))
      .toEqual({ bytes: 12, ok: true });
  });

  test('reads three independent controls at call time', () => {
    const prior = Object.fromEntries(Object.values(PTY_FEATURE_ENV).map(name => [name, process.env[name]]));
    try {
      process.env[PTY_FEATURE_ENV.structuredPi] = 'true';
      delete process.env[PTY_FEATURE_ENV.checkpointCompaction];
      process.env[PTY_FEATURE_ENV.generationReader] = '1';
      expect(getPtyFeatureControls()).toEqual({ structuredPi: false, checkpointCompaction: true, generationReader: false });
      delete process.env[PTY_FEATURE_ENV.structuredPi];
      expect(getPtyFeatureControls().structuredPi).toBe(true);
    } finally {
      for (const name of Object.values(PTY_FEATURE_ENV)) {
        const value = prior[name];
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });

  test('migration and every independent prune enforce completion, reference, and active-generation guards', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS pty_recovery_schema_state');
    expect(migration).toContain("mutation_state IN ('ready', 'blocked')");
    expect(migration).not.toMatch(/pgboss\./i);
    expect((operations.match(/completed_at IS NOT NULL AND NOT (?:artifact\.|segment\.)?referenced_by_manifest/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect((operations.match(/generation\.is_active = FALSE/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(operations).toContain("throw new UnprocessableError(");
    expect(operations).toContain("'PTY_RECOVERY_SCHEMA_UNSUPPORTED'");
  });

  test('rollback is legacy-reader-only and cannot delete evidence', () => {
    const simulation = operations.slice(operations.indexOf('export async function simulatePtyLegacyRollback'));
    expect(simulation).toContain('mutationPerformed: false');
    expect(simulation).toContain("readerAfterRollback: 'legacy'");
    expect(simulation).not.toMatch(/\b(?:DELETE|DROP|TRUNCATE)\b/);
    expect(pipeline).toContain("'generation-reader-disabled'");
    expect(pipeline).not.toContain('pty_generation_token: health.generationToken');
  });

  test('runbook covers operations and rejects cap-only mitigation', () => {
    for (const phrase of [
      'Capacity planning', 'Recommended alerts', 'Archive download', 'Checkpoint repair',
      'blank terminal', 'Rollout order', 'Rollback order', 'temporary mitigation',
    ]) expect(runbook.toLowerCase()).toContain(phrase.toLowerCase());
    expect(runbook).toContain('do **not** restart the backend or worker');
  });
});
