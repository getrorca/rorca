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
import {
  BOUNTY_CONTROLLER_RECEIPT_MODE,
  BOUNTY_PRESENTATION_CONTRACT_VERSION,
  BOUNTY_PRESENTATION_FORBIDDEN_CAPABILITIES,
  BOUNTY_PRESENTATION_OPERATION_IDS,
  buildBountyPresentationContract,
} from '../bounty-presentation-contract';
import { getMcpToolDefinitions, getPublishedMcpTools } from '../mcp-http';
import { safeParseTaskManifest } from '../task-manifest';
import { swaggerSpec } from '../swagger';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', name), 'utf8'));
const paths = (swaggerSpec as { paths: Record<string, Record<string, Record<string, unknown>>> }).paths;
const openApiOperation = paths['/api/contracts/bounty-presentation']?.get;
const definitions = getMcpToolDefinitions(swaggerSpec as never);
const presentationTool = definitions.find((entry) => entry.capturedPath === '/api/contracts/bounty-presentation');

const openApiSnapshot = {
  contractVersion: BOUNTY_PRESENTATION_CONTRACT_VERSION,
  method: 'GET',
  path: '/api/contracts/bounty-presentation',
  operationId: openApiOperation?.operationId,
  tier: openApiOperation?.['x-rorca-tier'],
  idempotent: openApiOperation?.['x-rorca-idempotent'],
  responseSchemaVersion: ((openApiOperation?.responses as any)?.['200']?.content?.['application/json']?.schema?.properties?.schemaVersion?.enum ?? [])[0],
};
const mcpSnapshot = {
  contractVersion: BOUNTY_PRESENTATION_CONTRACT_VERSION,
  toolName: presentationTool?.toolName,
  method: presentationTool?.capturedMethod,
  path: presentationTool?.capturedPath,
  openApiTier: presentationTool?.capturedOperation['x-rorca-tier'],
  requiredParams: [],
  inputProperties: Object.keys(presentationTool?.zodShape ?? {}).sort(),
};

test('OpenAPI and generated MCP snapshots expose one bounded read-only presentation tool', () => {
  assert.deepEqual(openApiSnapshot, fixture('bounty-presentation-openapi.snapshot.json'));
  assert.deepEqual(mcpSnapshot, fixture('bounty-presentation-mcp.snapshot.json'));
  assert.ok(presentationTool);
  assert.equal(presentationTool.capturedOperation['x-rorca-tier'], 'auth');
});

test('OpenAPI input constraints survive generated MCP and published Pi discovery schemas', () => {
  const schema = {
    type: 'object', additionalProperties: false, required: ['missionId', 'expectedEpoch'],
    properties: {
      missionId: { type: 'string', format: 'uuid', minLength: 8, maxLength: 64 },
      expectedEpoch: { type: 'integer', minimum: 1, maximum: 99 },
      decision: { type: 'string', enum: ['approve', 'deny'] },
    },
  };
  const synthetic = { paths: { '/api/example': { post: {
    operationId: 'example', summary: 'Example', 'x-rorca-tier': 'auth',
    'x-rorca-rationale': 'Schema parity fixture.',
    requestBody: { required: true, content: { 'application/json': { schema } } },
    responses: { 200: { description: 'Exact receipt' } },
  } } } };
  const generated = getMcpToolDefinitions(synthetic as never)[0];
  assert.ok(generated);
  assert.equal(generated.zodShape.missionId.safeParse('not-a-uuid').success, false);
  assert.equal(generated.zodShape.expectedEpoch.safeParse(0).success, false);
  assert.equal(generated.zodShape.expectedEpoch.safeParse(2.5).success, false);
  assert.deepEqual(getPublishedMcpTools(synthetic as never)[0]?.inputSchema, schema.properties);
});

test('presentation contract derives schemas, tiers, reason codes, and exact receipts from REST', () => {
  const contract = buildBountyPresentationContract(swaggerSpec as never);
  assert.equal(contract.schemaVersion, BOUNTY_PRESENTATION_CONTRACT_VERSION);
  assert.equal(contract.controllerReceiptMode, BOUNTY_CONTROLLER_RECEIPT_MODE);
  assert.deepEqual(contract.operations.map((entry) => entry.operationId), [...BOUNTY_PRESENTATION_OPERATION_IDS]);
  for (const operation of contract.operations) {
    assert.equal(operation.tier, 'admin');
    assert.equal(operation.mcpCallable, false);
    assert.equal(operation.receiptMode, BOUNTY_CONTROLLER_RECEIPT_MODE);
    assert.equal(operation.reasonCodes['409'], 'CONFLICT');
    assert.ok(Object.keys(operation.responses).length > 0);
    const rest = paths[operation.path]?.[operation.method.toLowerCase()];
    assert.deepEqual(operation.input, { parameters: rest.parameters ?? [], requestBody: rest.requestBody ?? null });
    assert.deepEqual(operation.responses, rest.responses);
  }
});

test('Hermes fixture presents state, blockers and approval target and only relays an exact signed human event', () => {
  const hermes = fixture('hermes-bounty-presentation-client.json') as any;
  assert.equal(hermes.schemaVersion, BOUNTY_PRESENTATION_CONTRACT_VERSION);
  assert.deepEqual(hermes.roles, ['read', 'preview', 'present', 'exact-human-relay']);
  assert.equal(hermes.statePresentation.state, 'held');
  assert.ok(hermes.blockers.every((entry: any) => typeof entry.reasonCode === 'string'));
  assert.equal(hermes.approvalTarget.version, 'bounty.approval.v1');
  assert.equal(hermes.relayedHumanEvent.schemaVersion, 'provider-human-event.v1');
  assert.equal(hermes.relayedHumanEvent.normalizedCommandHash, hermes.approvalTarget.targetHash);
  assert.equal(hermes.controllerReceipt.targetEffectsSent, false);
  assert.deepEqual(hermes.directAccess, []);
  assert.deepEqual(hermes.forbiddenCapabilities, [...BOUNTY_PRESENTATION_FORBIDDEN_CAPABILITIES]);
});

test('no bounty MCP tool exposes URL/browser/broker/credential/callback/command/schedule/submission authority', () => {
  const bountyTools = definitions.filter((entry) => entry.capturedPath.includes('bounty'));
  assert.deepEqual(bountyTools.map((entry) => entry.toolName), ['rorca_contracts_bounty_presentation']);
  const serialized = JSON.stringify(bountyTools.map((entry) => ({ name: entry.toolName, shape: Object.keys(entry.zodShape) }))).toLowerCase();
  for (const forbidden of ['url', 'browser', 'broker', 'credential', 'callback', 'command', 'schedule', 'submission']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('TaskManifest stays software-repair-only across the bounty presentation version', () => {
  const base = fixture('hermes-task-manifest.json') as Record<string, unknown>;
  assert.equal(safeParseTaskManifest({ ...base, workType: 'bounty-target-work' }).success, false);
  assert.equal(safeParseTaskManifest({ ...base, missionId: 'mission-1' }).success, false);
  const routed = structuredClone(base) as any;
  routed.routeDecision.route = 'bounty.target-broker';
  assert.equal(safeParseTaskManifest(routed).success, false);
});

test('version handshake pins REST/MCP/Pi/Hermes presentation versions and boundaries', () => {
  const source = fs.readFileSync(path.resolve(here, '../../routes/version.ts'), 'utf8');
  for (const value of [
    "contractVersion: 'bounty.presentation.v1'",
    "endpoint: '/api/contracts/bounty-presentation'",
    "source: 'rest-openapi'",
    "controllerReceiptMode: 'exact-rest-json-no-rewrite'",
    "humanAuthorityVersion: 'provider-human-event.v1'",
    "hermesRoles: ['read', 'preview', 'present', 'exact-human-relay']",
  ]) assert.match(source, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
