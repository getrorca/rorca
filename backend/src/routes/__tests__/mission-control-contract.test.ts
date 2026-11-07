/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import fs from 'node:fs';
import path from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import { z } from 'zod';
import {
  FederatedAcquireRequestSchema, FederatedActivityRequestSchema, FederatedCancellationAcknowledgementSchema,
  FederatedDiscoveryRequestSchema, FederatedEventRequestSchema, FederatedPlanChangeRequestSchema,
  FederatedRecoveryRequestSchema, FederatedReleaseRequestSchema, FederatedRenewRequestSchema,
  FederatedResultProposalSchema, FederatedWorkPackageReadRequestSchema,
} from '../../lib/federated-runtime-contracts';
import { swaggerSpec } from '../../lib/swagger';
import { missionControlMutationIdempotencyPaths, missionControlReadResponseSchemas, missionControlRequestSchemas,
  missionControlResponseSchemas, missionControlRuntimeHeaderPaths } from '../mission-control';
const source = fs.readFileSync(path.resolve(__dirname, '../mission-control.ts'), 'utf8');

test('mission-control API exposes bounded auth reads and MCP-excluded admin/runtime mutations', () => {
  for (const route of ['/missions', '/runs/:runId', '/compat/context-epoch', '/events', '/evidence', '/cancellations/:cancellationId',
    '/managed-executor/capabilities','/managed-executor/quota-reservations','/managed-executor/generations']) expect(source).toContain(`router.get('${route}'`);
  for (const route of ['/missions/compile', '/work-packages/revisions', '/leases/acquire', '/leases/:leaseId/renew',
    '/runtime/checkpoints', '/runtime/events', '/runtime/evidence', '/runtime/plan-change-proposals', '/plan-change-proposals/review', '/closeout/evaluate',
    '/cancellations/request', '/runtime/cancellations/acknowledge', '/context/policy-definitions',
    '/context/policy-activations', '/runtime/retrieval-receipts', '/runtime/context-bundles', '/runtime/context-deltas',
    '/context/retry-budgets', '/runtime/retries/claim', '/runtime/retries/settle', '/runtime/dispatches/authorize', '/runtime/dispatches/consume',
    '/internal/dispatch-outbox/claim', '/internal/dispatch-outbox/authorize-send', '/internal/dispatch-outbox/accept', '/internal/dispatch-outbox/settle', '/compat/context-epoch-retirement/evaluate', '/evidence', '/events', '/leases/:leaseId/release']) expect(source).toContain(`router.post('${route}'`);
  expect(source.match(/x-rorca-tier: auth/g)).toHaveLength(9);
  expect(source.match(/x-rorca-tier: admin/g)).toHaveLength(30);
  expect(source).not.toContain('x-rorca-public-api: true');
});

test('every mutation uses strict schemas, typed services, and durable idempotency where applicable', () => {
  expect(source).toContain("req.headers['idempotency-key']");
  expect(source).toContain('validateBody(MissionRequestSchema)');
  expect(source).toContain('validateBody(ExecutionLeaseV1Schema)');
  expect(source).toContain('validateBody(ContextCheckpointV1Schema)');
  expect(source).toContain('validateBody(RuntimeEventV1Schema)');
  expect(source).toContain('validateBody(EvidenceEnvelopeV1Schema)');
  expect(source).toContain('validateBody(PlanChangeProposalV1Schema)');
  expect(source).toContain('validateBody(CloseoutEvaluationV1Schema)');
  expect(source).toContain('validateBody(CancellationV1Schema)');
  expect(source).toContain('validateBody(ContextPolicyActivationV1Schema)');
  expect(source).toContain('validateBody(RetrievalReceiptV1Schema)');
  expect(source).toContain('validateBody(ContextBundleV1Schema)');
  expect(source).toContain('validateBody(DeltaRequestSchema)');
  expect(source).not.toContain('DeltaVerificationSchema');
  expect(source).not.toContain('req.body.verification');
  expect(source).toContain('validateBody(ContinuationDispatchV1Schema)');
  expect(source).not.toMatch(/res\.status\([^)]*\)\.json\(\{\s*error/);
});

test('every mission-control OpenAPI operation has machine-bound request/response/error schemas', () => {
  const paths = (swaggerSpec as { paths?: Record<string, Record<string, any>> }).paths ?? {};
  const governed = Object.entries(paths).filter(([apiPath]) => apiPath.startsWith('/api/mission-control/v1/'));
  expect(governed.length).toBeGreaterThan(20);
  for (const [, methods] of governed) for (const [method, operation] of Object.entries(methods)) {
    if (method === 'post') expect(operation.requestBody?.content?.['application/json']?.schema).toBeDefined();
    expect(operation.responses?.['200']?.content?.['application/json']?.schema).toBeDefined();
    expect(operation.responses?.['422']?.content?.['application/json']?.schema?.$ref).toBe('#/components/schemas/Error');
  }
  const components = (swaggerSpec as any).components.schemas;
  const canonicalJsonSchema = (schema: z.ZodType) => { const value = z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' }) as any;
    delete value.$schema; return value; };
  for (const [apiPath, methods] of governed) for (const [method, operation] of Object.entries(methods)) {
    const responseRef = operation.responses['200'].content['application/json'].schema.$ref;
    expect(responseRef).toMatch(/^#\/components\/schemas\/MissionControl/);
    const expectedResponse=method==='post'?missionControlResponseSchemas[apiPath]:missionControlReadResponseSchemas[apiPath];
    expect(components[responseRef.split('/').pop()]).toEqual(canonicalJsonSchema(expectedResponse!));
    if(method==='post'){
      const requestRef = operation.requestBody.content['application/json'].schema.$ref;
      expect(requestRef).toMatch(/^#\/components\/schemas\/MissionControl/);
      expect(components[requestRef.split('/').pop()]).toEqual(canonicalJsonSchema(missionControlRequestSchemas[apiPath]!));
      const headers=new Map((operation.parameters??[]).filter((p:any)=>p.in==='header').map((p:any)=>[p.name,p]));
      if(missionControlMutationIdempotencyPaths.has(apiPath))expect(headers.get('Idempotency-Key')).toMatchObject({required:true});
      if(missionControlRuntimeHeaderPaths.has(apiPath))expect(headers.get('X-Rorca-Runtime-Id')).toMatchObject({required:true});
    }
  }
});

test('all federated routes are registered with exact request/response and wire-header contracts', () => {
  const federationRequests: Record<string, z.ZodType> = {
    '/api/mission-control/v1/federation/discover': FederatedDiscoveryRequestSchema,
    '/api/mission-control/v1/federation/acquire': FederatedAcquireRequestSchema,
    '/api/mission-control/v1/federation/work-package/read': FederatedWorkPackageReadRequestSchema,
    '/api/mission-control/v1/federation/leases/renew': FederatedRenewRequestSchema,
    '/api/mission-control/v1/federation/leases/release': FederatedReleaseRequestSchema,
    '/api/mission-control/v1/federation/events': FederatedEventRequestSchema,
    '/api/mission-control/v1/federation/activity': FederatedActivityRequestSchema,
    '/api/mission-control/v1/federation/results/propose': FederatedResultProposalSchema,
    '/api/mission-control/v1/federation/cancellations/acknowledge': FederatedCancellationAcknowledgementSchema,
    '/api/mission-control/v1/federation/plan-changes/propose': FederatedPlanChangeRequestSchema,
    '/api/mission-control/v1/federation/recover': FederatedRecoveryRequestSchema,
  };
  const idempotent: Record<string, true> = {
    '/api/mission-control/v1/federation/acquire': true,
    '/api/mission-control/v1/federation/leases/renew': true,
    '/api/mission-control/v1/federation/leases/release': true,
    '/api/mission-control/v1/federation/events': true,
    '/api/mission-control/v1/federation/activity': true,
    '/api/mission-control/v1/federation/results/propose': true,
    '/api/mission-control/v1/federation/cancellations/acknowledge': true,
    '/api/mission-control/v1/federation/plan-changes/propose': true,
    '/api/mission-control/v1/federation/recover': true,
  };
  const parameterSchema = z.object({
    in: z.string().optional(), name: z.string(), required: z.boolean().optional(),
  }).passthrough();
  const document = z.object({ paths: z.record(z.string(), z.object({
    post: z.object({ parameters: z.array(parameterSchema).optional() }).passthrough().optional(),
  }).passthrough()).optional() }).passthrough().parse(swaggerSpec);
  const paths = document.paths ?? {};
  for (const [apiPath, requestSchema] of Object.entries(federationRequests)) {
    expect(missionControlRequestSchemas[apiPath]).toBe(requestSchema);
    expect(missionControlResponseSchemas[apiPath]).toBeDefined();
    expect(missionControlRuntimeHeaderPaths).toContain(apiPath);
    const requiresIdempotency = idempotent[apiPath] === true;
    expect(missionControlMutationIdempotencyPaths.has(apiPath)).toBe(requiresIdempotency);
    const operation = paths[apiPath]?.post;
    expect(operation).toBeDefined();
    const headers = Object.fromEntries((operation?.parameters ?? [])
      .filter((parameter) => parameter.in === 'header').map((parameter) => [parameter.name, parameter]));
    expect(headers['X-Rorca-Runtime-Id']).toMatchObject({ required: true });
    expect(headers['Idempotency-Key'] !== undefined).toBe(requiresIdempotency);
  }
});

test('the complete emitted surface is validator-conformant OpenAPI 3.1 with an explicit JSON Schema dialect', async () => {
  const source = swaggerSpec as any;
  expect(source.openapi).toBe('3.1.0');
  expect(source.jsonSchemaDialect).toBe('https://json-schema.org/draft/2020-12/schema');
  await expect(SwaggerParser.validate(source)).resolves.toBeDefined();
});

test('runtime ingress requires internal service identity and exact runtime header', () => {
  expect(source).toContain("[INTERNAL_SERVICE_USER_ID, 'rorca-hermes-service'].includes(req.user.id)");
  expect(source).toContain("req.headers['x-rorca-runtime-id']");
  expect(source).toContain('claimed !== runtimeId');
});

test('epoch surface is one deprecated read, writes no authority, and records bounded telemetry', () => {
  expect(source).toContain("router.get('/compat/context-epoch'");
  expect(source).not.toMatch(/router\.(?:post|put|patch)\('\/compat\/context-epoch'/);
  expect(source).toContain('contextEpochProjectionId(projectionFields)');
  expect(source).toContain('FROM continuation_dispatches');
  expect(source).toContain("dispatch?.dispatchId ?? 'not_applicable'");
  expect(source).toContain('projectionOnly: true, authoritative: false');
  expect(source).toContain('INSERT INTO context_epoch_projection_reads');
  expect(source).toContain("router.use('/compat/context-epoch', requireWorkspaceMember()");
  expect(source).toContain('INSERT INTO context_epoch_write_rejections');
  expect(source).toContain("authoritative: false, attempt, lease:lease??null, closeout:closeout??null");
  expect(source).toContain("closeout: 'non_authoritative_eligibility'");
});
