/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '../errors';
import { swaggerSpec } from '../swagger';
import { getMcpToolDefinitions } from '../mcp-http';
import { BOUNTY_TARGET_EFFECT_EXTERNAL_OPERATIONS, redactBountyRawValue } from '../bounty-controller';
import bountyRouter, { BOUNTY_REST_OPERATION_MATRIX } from '../../routes/bounty';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const routeSource = fs.readFileSync(path.join(src, 'routes/bounty.ts'), 'utf8');
const controllerSource = fs.readFileSync(path.join(src, 'lib/bounty-controller.ts'), 'utf8');
const restControllerSource = controllerSource.split('// ─── Bounded REST Controller facade (BBM-025) ───')[1] ?? '';
const serverSource = fs.readFileSync(path.join(src, 'server.ts'), 'utf8');
const migration = fs.readFileSync(path.join(src, 'db/pg-migrations/20260803200000_bounty_rest_controller.sql'), 'utf8');

const bountyOpenApi = Object.entries((swaggerSpec as { paths?: Record<string, Record<string, Record<string, unknown>>> }).paths ?? {})
  .filter(([route]) => route.startsWith('/api/bounty/'))
  .flatMap(([route, methods]) => Object.entries(methods).map(([method, operation]) => ({ route, method: method.toUpperCase(), operation })));

test('operation matrix is complete, unique, human-purposeful, and denies MCP/Pi/Hermes', () => {
  assert.equal(BOUNTY_REST_OPERATION_MATRIX.length, 15);
  assert.equal(new Set(BOUNTY_REST_OPERATION_MATRIX.map((entry) => entry.operationId)).size, 15);
  for (const entry of BOUNTY_REST_OPERATION_MATRIX) {
    assert.equal(entry.tier, 'admin');
    assert.equal(entry.mcp, false); assert.equal(entry.pi, false); assert.equal(entry.hermes, false);
    assert.ok(entry.purpose.length > 10); assert.ok(entry.rawDataPolicy.length > 5);
  }
  assert.equal(BOUNTY_TARGET_EFFECT_EXTERNAL_OPERATIONS.length, 0);
  const bountyOperationIds = new Set(BOUNTY_REST_OPERATION_MATRIX.map((entry) => entry.operationId));
  assert.equal(getMcpToolDefinitions(swaggerSpec as never).filter((tool) => bountyOperationIds.has(tool.operationId)).length, 0);
});

test('every dedicated REST route has OpenAPI schema, operation ID, tier, rationale, and no MCP exposure', () => {
  assert.equal(bountyOpenApi.length, BOUNTY_REST_OPERATION_MATRIX.length);
  for (const entry of BOUNTY_REST_OPERATION_MATRIX) {
    const operation = bountyOpenApi.find(({ route, method }) => route === entry.path && method === entry.method)?.operation;
    assert.ok(operation, `${entry.method} ${entry.path}`);
    assert.equal(operation.operationId, entry.operationId);
    assert.equal(operation['x-rorca-tier'], 'admin');
    assert.equal(operation['x-rorca-mcp'], false);
    assert.equal(operation['x-rorca-idempotent'], true);
    assert.equal(typeof operation['x-rorca-rationale'], 'string');
    assert.ok(String(operation['x-rorca-rationale']).length > 20);
    assert.ok(operation.responses && typeof operation.responses === 'object');
    if (entry.method === 'POST') assert.ok(operation.requestBody && operation.parameters);
  }
});

test('auth, CSRF, and plan gates precede the dedicated router and internal/Hermes identities fail route auth', () => {
  const mount = serverSource.indexOf("app.use('/api/bounty', bountyRouter)");
  assert.ok(serverSource.indexOf('app.use(authRequired)') < mount);
  assert.ok(serverSource.indexOf('app.use(csrfProtection)') < mount);
  assert.ok(serverSource.indexOf('app.use(planGate())') < mount);
  assert.match(routeSource, /req\.authSource !== 'bearer'/);
  assert.match(routeSource, /req\.user\.role !== 'admin'/);
  assert.doesNotMatch(routeSource, /x-rorca-native-api:\s*true/);
});

test('unauthenticated, internal-service, malformed, and missing-idempotency requests fail before Controller I/O', async () => {
  // Invoke Express layers directly because the autonomous sandbox forbids listen(2).
  const mountedRouter = typeof bountyRouter === 'function'
    ? bountyRouter
    : (bountyRouter as unknown as { default: RequestHandler }).default;
  type Layer = { handle: RequestHandler; route?: { path: string; stack: Layer[] } };
  const stack = (mountedRouter as unknown as { stack: Layer[] }).stack;
  const auth = stack[0].handle;
  const invokeAuth = (authSource?: 'bearer' | 'internal'): unknown => {
    let failure: unknown;
    const req = { authSource, user: authSource ? { id: 'admin-1', email: 'admin@example.test', supabaseId: 'auth-1', role: 'admin' } : undefined } as Request;
    auth(req, {} as Response, ((error?: unknown) => { failure = error; }) as NextFunction);
    return failure;
  };
  assert.equal((invokeAuth() as AppError).statusCode, 401);
  assert.equal((invokeAuth('internal') as AppError).statusCode, 401);

  const invokeRoute = async (path: string, req: Partial<Request>): Promise<number> => {
    const layer = stack.find((candidate) => candidate.route?.path === path);
    assert.ok(layer?.route);
    let status = 200;
    const res = { status(code: number) { status = code; return this; }, json() { return this; } } as unknown as Response;
    await layer.route.stack.at(-1)!.handle(req as Request, res, (() => undefined) as NextFunction);
    return status;
  };
  assert.equal(await invokeRoute('/admissions', { body: { unexpected: true } }), 400);
  const validAdmission = {
    workspaceId: 'workspace-1', programId: '11111111-1111-4111-8111-111111111111', programName: 'Program', policyRevision: 1,
    scope: { allowedOrigins: ['https://example.test'], prohibitedActions: [], maxRequests: 10, expiresAt: '2099-01-01T00:00:00.000Z' },
  };
  assert.equal(await invokeRoute('/admissions', { body: validAdmission, user: { id: 'admin-1', email: 'admin@example.test', supabaseId: 'auth-1', role: 'admin' }, header: () => undefined }), 400);
  delete process.env.RORCA_BOUNTY_RAW_CAPABILITY_SHA256;
  assert.equal(await invokeRoute('/missions/:missionId/evidence', {
    body: {}, params: { missionId: '22222222-2222-4222-8222-222222222222' },
    query: { workspaceId: 'workspace-1', programId: validAdmission.programId, raw: 'true' },
    user: { id: 'admin-1', email: 'admin@example.test', supabaseId: 'auth-1', role: 'admin' }, header: () => undefined,
  }), 503);
});

test('feature-disabled, malformed, cross-workspace, and replay paths fail closed with AppError handling', () => {
  assert.match(restControllerSource, /resolveBountyFeaturePolicy/);
  assert.match(restControllerSource, /throw new BountyFeatureDisabledError/);
  assert.ok((restControllerSource.match(/await assertEnabled\(\)/g) ?? []).length >= 9);
  assert.match(routeSource, /\.strict\(\)/);
  assert.match(routeSource, /throw new ValidationError/);
  assert.match(routeSource, /handleRouteError/);
  assert.match(restControllerSource, /p\.workspace_id=\$1 AND p\.id=\$2 AND m\.id=\$3/);
  assert.match(restControllerSource, /Idempotency key was used with a different bounty Controller command/);
  assert.match(restControllerSource, /pg_advisory_xact_lock/);
  assert.match(migration, /UNIQUE \(workspace_id, idempotency_key\)/);
});

test('list operations use bounded pagination and default evidence/draft projections omit raw data', () => {
  assert.match(restControllerSource, /paginateQuery<T>/);
  assert.match(routeSource, /maxLimit: 100/);
  assert.match(restControllerSource, /includeRaw \? 'x\.id,x\.evidence_identity/);
  assert.match(restControllerSource, /includeRaw\s*\? `x\.id,x\.finding_id/);
  assert.match(routeSource, /RORCA_BOUNTY_RAW_CAPABILITY_SHA256/);
  assert.match(routeSource, /Separate raw bounty inspection authority is required/);
});

test('credential-shaped fields stay redacted recursively even during raw inspection', () => {
  assert.deepEqual(redactBountyRawValue({
    ok: 'visible', password: 'pw', nested: { token: 't', finding: 'visible', cookies: 'c' }, rows: [{ authorization: 'a' }],
  }), {
    ok: 'visible', password: '[REDACTED]', nested: { token: '[REDACTED]', finding: 'visible', cookies: '[REDACTED]' }, rows: [{ authorization: '[REDACTED]' }],
  });
});

test('release review and mission launch cannot submit or send target effects', () => {
  assert.match(restControllerSource, /submissionReady: false, submitted: false/);
  assert.match(restControllerSource, /verifyLocalFixtureProviderApproval\(command\.approvalTarget, command\.providerHumanApproval\)/);
  assert.match(restControllerSource, /admission\.policy_contract_hash !== approval\.target\.policyContractHash/);
  assert.match(restControllerSource, /approvalTargetHash !== approval\.targetHash/);
  assert.match(restControllerSource, /INSERT INTO bounty_local_fixture_launch_approvals/);
  assert.match(routeSource, /policyContractHash: HashSchema/);
  assert.match(restControllerSource, /targetEffectsSent: false/);
  assert.doesNotMatch(restControllerSource, /INSERT INTO bounty_report_releases/i);
  assert.doesNotMatch(restControllerSource, /boss\.send|fetch\(|axios|child_process|spawn\(/i);
  assert.doesNotMatch(routeSource, /operationId:\s*\w*(?:submit|publish|effect|credential)/i);
  assert.doesNotMatch(migration, /CREATE TABLE bounty_(?:target_effect|submission|credential|ipc)/i);
});

test('database authority facts are append-only and remain application schema only', () => {
  for (const table of ['bounty_program_admissions', 'bounty_controller_api_receipts', 'bounty_draft_release_reviews']) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.equal((migration.match(/EXECUTE FUNCTION bounty_reject_append_only_mutation/g) ?? []).length, 3);
  assert.doesNotMatch(migration, /pgboss\./i);
});
