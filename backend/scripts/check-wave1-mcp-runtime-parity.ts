/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { swaggerSpec } from '../src/lib/swagger';
import { createMcpRequestHandler } from '../src/lib/mcp-http';
import {
  RORCA_JSON_BODY_LIMIT,
  RORCA_JSON_BODY_LIMIT_BYTES,
} from '../src/lib/http-body-limit';

async function main(): Promise<void> {
const selectedNames = [
  'rorca_specs_generation_context',
  'rorca_create_spec',
  'rorca_persist_spec',
] as const;

let forwardedCalls = 0;
globalThis.fetch = (async () => {
  forwardedCalls += 1;
  throw new Error('runtime parity probe must not forward malformed/no-action requests');
}) as typeof fetch;

const app = express();
app.use(express.json({ limit: RORCA_JSON_BODY_LIMIT }));
const handlers = createMcpRequestHandler(swaggerSpec as never);
app.post('/mcp', handlers.handlePost);
app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error.status ?? 500).json({ error: 'request_rejected' });
});

const list = await request(app)
  .post('/mcp')
  .set('Accept', 'application/json, text/event-stream')
  .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
assert.equal(list.status, 200);
const tools = list.body.result?.tools as Array<{
  name: string;
  inputSchema: Record<string, unknown>;
}> | undefined;
assert.ok(Array.isArray(tools), 'actual MCP tools/list response is missing');
const selected = selectedNames.map((name) => {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `actual MCP discovery missing ${name}`);
  return { name, inputSchema: tool.inputSchema };
});

const malformed = await request(app)
  .post('/mcp')
  .set('Accept', 'application/json, text/event-stream')
  .send({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'rorca_create_spec', arguments: {} },
  });
assert.equal(malformed.status, 200);
assert.ok(malformed.body.result?.isError === true || malformed.body.error,
  'missing required create-spec input must fail closed');
assert.equal(forwardedCalls, 0, 'invalid MCP request unexpectedly reached the REST adapter');

const oversize = await request(app)
  .post('/mcp')
  .set('Content-Type', 'application/json')
  .set('Accept', 'application/json, text/event-stream')
  .send(JSON.stringify({
    jsonrpc: '2.0', id: 3, method: 'tools/list',
    params: { padding: 'x'.repeat(RORCA_JSON_BODY_LIMIT_BYTES + 1) },
  }));
assert.equal(oversize.status, 413, 'production JSON/MCP body limit must reject oversized requests');
assert.equal(forwardedCalls, 0, 'oversized MCP request unexpectedly reached an action adapter');

process.stdout.write(JSON.stringify({
  schemaVersion: 'rorca.wave1-forge-mcp-parity.v1',
  bodyLimit: RORCA_JSON_BODY_LIMIT,
  bodyLimitBytes: RORCA_JSON_BODY_LIMIT_BYTES,
  tools: selected,
  noAction: {
    malformedCreateForwardedCalls: forwardedCalls,
    oversizedStatus: oversize.status,
  },
}, null, 2) + '\n');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
