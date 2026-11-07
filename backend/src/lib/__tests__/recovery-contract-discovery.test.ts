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
import SwaggerParser from '@apidevtools/swagger-parser';

test('recovery contracts are discoverable with correct REST/MCP authority', async () => {
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
  expect(spec.paths['/api/admin/recovery/spec-workflows/v1/{workflowRunId}']?.get).toMatchObject({
    'x-rorca-tier':'admin','x-rorca-mcp':false,
    responses:{'200':{content:{'application/json':{schema:{$ref:'#/components/schemas/ExactPostSaveWorkflowInspectionV1'}}}}},
  });
  expect(spec.paths['/api/admin/recovery/spec-workflows/v1/{workflowRunId}/stages/{stageKey}/reconcile']?.post).toMatchObject({
    'x-rorca-tier':'admin','x-rorca-mcp':false,
    requestBody:{content:{'application/json':{schema:{$ref:'#/components/schemas/ExactPostSaveWorkflowReconciliationRequestV1'}}}},
    responses:{'200':{content:{'application/json':{schema:{$ref:'#/components/schemas/ExactPostSaveWorkflowReconciliationResultV1'}}}},'409':{content:{'application/json':{schema:{$ref:'#/components/schemas/Error'}}}}},
  });
  const schemas=spec.components.schemas;
  const isolated={openapi:'3.0.3',info:{title:'Exact recovery v1',version:'1.0.0'},paths:{
    '/api/admin/recovery/spec-workflows/v1/{workflowRunId}':spec.paths['/api/admin/recovery/spec-workflows/v1/{workflowRunId}'],
    '/api/admin/recovery/spec-workflows/v1/{workflowRunId}/stages/{stageKey}/reconcile':spec.paths['/api/admin/recovery/spec-workflows/v1/{workflowRunId}/stages/{stageKey}/reconcile'],
  },components:{schemas:{Error:schemas.Error,ExactPostSaveWorkflowInspectionV1:schemas.ExactPostSaveWorkflowInspectionV1,ExactPostSaveWorkflowReconciliationRequestV1:schemas.ExactPostSaveWorkflowReconciliationRequestV1,ExactPostSaveWorkflowReconciliationResultV1:schemas.ExactPostSaveWorkflowReconciliationResultV1}}};
  await expect(SwaggerParser.validate(JSON.parse(JSON.stringify(isolated)))).resolves.toBeDefined();

  const definitions = getMcpToolDefinitions(spec);
  const toolNames = definitions.map((definition) => definition.toolName);
  for(const name of ['rorca_specs_repair_batch','rorca_specs_by_specId_repair','rorca_specs_by_specId_workflow_stages_by_stageKey_retry']){
    const definition=definitions.find(candidate=>candidate.toolName===name);
    expect(definition?.zodShape).toHaveProperty('dryRun');
    expect(definition?.zodShape).toHaveProperty('idempotencyKey');
    expect(definition?.zodShape.dryRun.safeParse(undefined).success).toBe(false);
  }
  expect(toolNames).toContain('rorca_pipeline_telemetry');
  expect(toolNames).not.toContain('rorca_admin_recovery_checkpoints_attestation');
  expect(toolNames).not.toContain('rorca_admin_recovery_checkpoints_reconcile');
  expect(toolNames).not.toContain('rorca_repair_checkpoints_reconcile');
  expect(toolNames.some((name)=>name.includes('spec_workflows'))).toBe(false);
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
