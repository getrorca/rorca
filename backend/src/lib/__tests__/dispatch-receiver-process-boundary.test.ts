/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import {
  assertDispatchReceiverConfiguration,
  authRequired,
  INTERNAL_SERVICE_TOKEN,
} from '../auth-utils';

const backendRoot = path.resolve(__dirname, '../../..');
const repositoryRoot = path.resolve(backendRoot, '..');
const RECEIVER_TOKEN = `receiver-process-test-${'r'.repeat(40)}`;
const INTERNAL_TOKEN = `internal-process-test-${'i'.repeat(40)}`;
const originalEnvironment = { ...process.env };

function productionEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    RORCA_INTERNAL_SERVICE_TOKEN: INTERNAL_TOKEN,
    RORCA_DB_MODE: 'byop',
    RORCA_AGENT: 'claude',
    RORCA_DISABLE_BACKGROUND_RUNTIME: 'true',
    RORCA_SERVE_MCP: 'false',
    NO_COLOR: '1',
    HOME: path.join(os.tmpdir(), 'rorca-dispatch-receiver-process-boundary-home'),
    ...overrides,
  };
  delete environment.RORCA_DISPATCH_RECEIVER_TOKEN;
  delete environment.JEST_WORKER_ID;
  return environment;
}

function childOutput(child: { stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream }): { read(): string } {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  return { read: () => `${stdout}\n${stderr}`.trim() };
}

afterEach(() => {
  process.env = { ...originalEnvironment };
});

test('receiver configuration has no ambient fallback and production API validation fails closed', () => {
  delete process.env.RORCA_DISPATCH_RECEIVER_TOKEN;
  expect(() => assertDispatchReceiverConfiguration()).toThrow('RORCA_DISPATCH_RECEIVER_TOKEN is required in production');

  process.env.RORCA_DISPATCH_RECEIVER_TOKEN = 'short';
  expect(() => assertDispatchReceiverConfiguration()).toThrow('independent unpredictable secret of at least 32 bytes');

  process.env.RORCA_DISPATCH_RECEIVER_TOKEN = INTERNAL_SERVICE_TOKEN;
  expect(() => assertDispatchReceiverConfiguration()).toThrow('independent unpredictable secret of at least 32 bytes');

  process.env.RORCA_DISPATCH_RECEIVER_TOKEN = RECEIVER_TOKEN;
  expect(() => assertDispatchReceiverConfiguration()).not.toThrow();
});

test('generic authentication remains available without resolving malformed receiver-only configuration', async () => {
  process.env.AUTH_REQUIRED = 'false';
  process.env.RORCA_DISPATCH_RECEIVER_TOKEN = 'malformed-receiver-configuration';
  const app = express();
  app.use(authRequired);
  app.get('/generic', (req, res) => res.json({ principalId: req.user?.id }));

  const response = await request(app).get('/generic');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ principalId: 'local-admin' });
});

test('production API startup performs the explicit receiver configuration assertion', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: backendRoot,
    env: productionEnvironment({ DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused' }),
    encoding: 'utf8',
    timeout: 30_000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(output).toContain('RORCA_DISPATCH_RECEIVER_TOKEN is required in production');
  expect(output).toContain('assertDispatchReceiverConfiguration');
});

test('production worker starts through scheduler imports without receiver-only authority', async () => {
  const sockets = new Set<Socket>();
  let acceptConnection: (() => void) | undefined;
  const connected = new Promise<void>((resolve) => { acceptConnection = resolve; });
  const sink = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    acceptConnection?.();
    acceptConnection = undefined;
  });
  sink.listen(0, '127.0.0.1');
  await once(sink, 'listening');
  const address = sink.address();
  if (!address || typeof address === 'string') throw new Error('TCP sink did not bind an ephemeral port');

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], {
    cwd: backendRoot,
    env: productionEnvironment({
      DATABASE_URL: `postgres://runtime:unused@127.0.0.1:${address.port}/rorca?connect_timeout=10`,
      RORCA_MIGRATIONS_PREAPPLIED: 'true',
      RORCA_PGBOSS_PREAPPLIED: 'true',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = childOutput(child);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const closed = new Promise<void>((resolve) => { child.once('close', () => resolve()); });
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timeoutHandle = setTimeout(() => resolve('timeout'), 20_000);
  });

  try {
    const outcome = await Promise.race([
      connected.then(() => 'connected' as const),
      exited.then((value) => ({ exited: value } as const)),
      timeout,
    ]);
    if (outcome === 'timeout') throw new Error(`worker did not reach database startup\n${output.read()}`);
    if (typeof outcome === 'object') {
      throw new Error(`worker exited before database startup (${JSON.stringify(outcome.exited)})\n${output.read()}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(child.exitCode).toBeNull();
    expect(output.read()).not.toContain('RORCA_DISPATCH_RECEIVER_TOKEN');
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => { sink.close(() => resolve()); });
  }
}, 30_000);

test('receiver comparison remains structurally confined to the exact acceptance branch', () => {
  const authSource = readFileSync(path.join(repositoryRoot, 'backend/src/lib/auth-utils.ts'), 'utf8');
  const exactBranch = authSource.indexOf('if (dispatchReceiverAcceptancePath(req))');
  const comparison = authSource.indexOf('sameDispatchReceiverToken(bearerToken)', exactBranch);
  const genericServiceBranch = authSource.indexOf('const claimsServiceIdentity', exactBranch);

  expect(authSource).not.toContain('export const DISPATCH_RECEIVER_TOKEN');
  expect(authSource.match(/resolveDispatchReceiverTokenForAcceptance\(/g)).toHaveLength(2);
  expect(exactBranch).toBeGreaterThan(0);
  expect(comparison).toBeGreaterThan(exactBranch);
  expect(comparison).toBeLessThan(genericServiceBranch);
  expect(authSource.indexOf('sameDispatchReceiverToken(bearerToken)', comparison + 1)).toBe(-1);
});
