/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';
import { swaggerSpec } from '../swagger';
import { getMcpToolDefinitions } from '../mcp-http';

test('recovery contracts are discoverable with correct REST/MCP authority', () => {
  const spec = swaggerSpec as any;
  expect(spec.paths['/api/pipeline/telemetry']?.get).toMatchObject({
    'x-rorca-tier': 'public', 'x-rorca-public-api': true,
  });
  expect(spec.paths['/api/pipeline/telemetry']?.get.responses['200'].content['application/json'].schema.required)
    .toEqual(expect.arrayContaining(['contractVersion', 'observedAt', 'runs']));
  expect(spec.paths['/api/admin/recovery/checkpoints/attestation']?.get).toMatchObject({
    'x-rorca-tier': 'admin', 'x-rorca-mcp': false,
  });
  expect(spec.paths['/api/admin/recovery/checkpoints/reconcile']?.post).toMatchObject({
    'x-rorca-tier': 'admin', 'x-rorca-mcp': false,
  });

  const toolNames = getMcpToolDefinitions(spec).map((definition) => definition.toolName);
  expect(toolNames).toContain('rorca_pipeline_telemetry');
  expect(toolNames).not.toContain('rorca_admin_recovery_checkpoints_attestation');
  expect(toolNames).not.toContain('rorca_admin_recovery_checkpoints_reconcile');
  expect(toolNames).not.toContain('rorca_repair_checkpoints_reconcile');
});

test('trusted checkpoint evidence is produced before pass and immutable in PostgreSQL', () => {
  const engine = fs.readFileSync(path.join(process.cwd(), 'src/lib/execution-engine.ts'), 'utf8');
  const finalize = engine.slice(
    engine.indexOf('async function finalizeIntegratedStoryPass'),
    engine.indexOf('async function recordStoryMergeConflict'),
  );
  expect(finalize).toContain('recordIntegratedCheckpointAttestation(config, workspaceId, pending, integratedHead)');
  expect(finalize.indexOf('recordIntegratedCheckpointAttestation')).toBeLessThan(finalize.indexOf('markStoryPassed'));

  const migration = fs.readFileSync(
    path.join(process.cwd(), 'src/db/pg-migrations/20260715141000_checkpoint_attestation_immutability.sql'),
    'utf8',
  );
  expect(migration).toContain('uq_checkpoint_attestation_identity');
  expect(migration).toContain('BEFORE UPDATE OR DELETE ON checkpoint_validation_attestations');
  expect(migration).toContain('only one-way revocation is permitted');
});
