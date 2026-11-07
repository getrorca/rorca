// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cli = path.resolve(import.meta.dirname, '../../bin/rorca.js');

function diagnose(t, relativePath, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-mcp-diagnostics-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config));
  const result = spawnSync(process.execPath, [cli, 'mcp', 'diagnose-clients'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: path.join(root, '.omp', 'agent'), OMP_PROFILE: '' },
  });
  assert.ifError(result.error);
  return { ...result, file };
}

const server = { type: 'http', url: 'http://127.0.0.1:3030/mcp' };

test('reports missing authentication in the project MCP config instead of claiming healthy', (t) => {
  const result = diagnose(t, '.mcp.json', { mcpServers: { rorca: server } });
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes(result.file));
  assert.match(result.stdout, /without an Authorization Bearer header/);
  assert.doesNotMatch(result.stdout, /No broken MCP/);
});

test('accepts OMP command-backed credentials without executing or printing them', (t) => {
  const command = '!echo SECRET_MUST_NOT_BE_PRINTED; exit 7';
  const result = diagnose(t, '.omp/mcp.json', { mcpServers: { rorca: { ...server, headers: { Authorization: command } } } });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No broken MCP client configs detected/);
  assert.doesNotMatch(result.stdout + result.stderr, /SECRET_MUST_NOT_BE_PRINTED/);
});

test('rejects an empty Bearer credential in an OMP user configuration', (t) => {
  const result = diagnose(t, '.omp/agent/mcp.json', { mcpServers: { rorca: { ...server, headers: { authorization: 'Bearer ' } } } });
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes(result.file));
  assert.match(result.stdout, /without an Authorization Bearer header/);
});

test('unreadable MCP configuration fails diagnostics rather than returning success', (t) => {
  const result = diagnose(t, '.omp/mcp.json', '{invalid json');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Unreadable config files/);
  assert.ok(result.stdout.includes(result.file));
});
