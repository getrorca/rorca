/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * omp-session-store.node.test.ts — real-binary integration coverage for the
 * durable session mirror ("tee").
 *
 * Runs a BOUNDED `omp --mode rpc --profile rorca` session against the real omp
 * binary (OMP_BIN or `which omp`; skipped when absent), with the operator
 * store relocated to a temp dir via the RORCA_OMP_SESSION_STORE_ROOT env
 * override, and proves the mirror tee file is written with the run stream's
 * session events and survives process teardown.
 *
 * No model credentials are required: the session is bootstrapped with
 * new_session/get_state, a single bounded prompt (which either streams events
 * or fails with omp's clean "No API key found" response), then abort. The tee
 * mirrors every JSONL line the run stream receives, exactly like the engine's
 * omp RPC listener.
 *
 * Runner: node --import tsx --test (repo standard for *.node.test.ts files;
 * jest ignores the .node.test.ts suffix by design).
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import {
  OmpSessionStore,
  OMP_SESSION_STORE_ROOT_ENV,
} from '../omp-session-store';

/** Env vars that redirect omp's own store/session root away from $HOME. */
const STORE_REDIRECTING_ENV = [
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'OMP_PROFILE',
  'PI_PROFILE',
] as const;

function resolveOmpBinary(): string | null {
  const configured = process.env.OMP_BIN?.trim();
  if (configured) return configured;
  try {
    return execFileSync('which', ['omp'], { encoding: 'utf8', timeout: 10_000 }).trim() || null;
  } catch {
    return null;
  }
}

/** Narrow an unknown to a plain record, or null when it is not one. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>; // guarded: plain object after the typeof/array checks
}

/** Read one string field from a record, or null. */
function readStringField(container: Record<string, unknown>, key: string): string | null {
  if (key in container && typeof container[key] === 'string') return container[key];
  return null;
}

interface RpcClient {
  child: ChildProcess;
  request(command: object): Promise<Record<string, unknown>>;
  lines: string[];
  waitFor(predicate: (parsed: Record<string, unknown>) => boolean, timeoutMs: number): Promise<Record<string, unknown>>;
  end(): Promise<number | null>;
}

function startRpcClient(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): RpcClient {
  const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const lines: string[] = [];
  const listeners: Array<(parsed: Record<string, unknown>) => void> = [];
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      lines.push(line);
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = asRecord(JSON.parse(line));
      } catch {
        parsed = null;
      }
      if (parsed) {
        for (const listener of [...listeners]) listener(parsed);
      }
    }
  });

  let requestId = 0;
  const pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  const onParsed = (parsed: Record<string, unknown>): void => {
    if (parsed.type !== 'response') return;
    if (!('id' in parsed) || typeof parsed.id !== 'string') return;
    const entry = pending.get(parsed.id);
    if (!entry) return;
    pending.delete(parsed.id);
    entry.resolve(parsed);
  };
  listeners.push(onParsed);

  return {
    child,
    lines,
    request(command: object): Promise<Record<string, unknown>> {
      const id = `req_${++requestId}`;
      const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`omp RPC command timed out (${String(command.type ?? 'unknown')})`));
      }, 30_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
      return promise;
    },
    async waitFor(predicate, timeoutMs): Promise<Record<string, unknown>> {
      const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
      const timer = setTimeout(() => reject(new Error('omp RPC event wait timed out')), timeoutMs);
      const listener = (parsed: Record<string, unknown>): void => {
        if (!predicate(parsed)) return;
        clearTimeout(timer);
        const index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
        resolve(parsed);
      };
      listeners.push(listener);
      return promise;
    },
    async end(): Promise<number | null> {
      const { promise, resolve } = Promise.withResolvers<number | null>();
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* seatbelt may refuse; EOF exit already attempted */ }
        resolve(null);
      }, 15_000);
      timer.unref();
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      try { child.stdin.end(); } catch { /* already closed */ }
      return promise;
    },
  };
}

function walkJsonl(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl')) found.push(full);
    }
  };
  walk(root);
  return found;
}

describe('omp-session-store real omp RPC tee (node integration)', () => {
  test('mirrors a bounded rorca-profile RPC session into the operator store and survives', { timeout: 120_000 }, async (t) => {
    const ompBin = resolveOmpBinary();
    if (!ompBin) {
      t.skip('real omp binary not found (set OMP_BIN or install omp v17+)');
      return;
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-omp-session-store-node-'));
    const home = path.join(root, 'home');
    const work = path.join(root, 'work');
    const storeRoot = path.join(root, 'store');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(work, { recursive: true });

    const previousStoreRoot = process.env[OMP_SESSION_STORE_ROOT_ENV];
    const previousHome = process.env.HOME;
    const removedEnv = new Map<string, string | undefined>();
    for (const key of [...STORE_REDIRECTING_ENV, OMP_SESSION_STORE_ROOT_ENV]) {
      removedEnv.set(key, process.env[key]);
      delete process.env[key];
    }

    let client: RpcClient | null = null;
    t.after(() => {
      if (client?.child.exitCode === null) {
        try { client.child.kill('SIGKILL'); } catch { /* already gone */ }
      }
      fs.rmSync(root, { recursive: true, force: true });
      for (const [key, value] of removedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (previousStoreRoot === undefined) delete process.env[OMP_SESSION_STORE_ROOT_ENV];
      else process.env[OMP_SESSION_STORE_ROOT_ENV] = previousStoreRoot;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    });

    process.env[OMP_SESSION_STORE_ROOT_ENV] = storeRoot;
    process.env.HOME = home;

    // Host-side tee with a temp operator store via env override — the same
    // construction the execution engine uses, with the store relocated.
    const store = new OmpSessionStore();
    assert.equal(store.sessionsRoot, path.resolve(storeRoot));

    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of STORE_REDIRECTING_ENV) delete childEnv[key];
    delete childEnv[OMP_SESSION_STORE_ROOT_ENV];
    childEnv.HOME = home;

    client = startRpcClient(
      ompBin,
      ['--mode', 'rpc', '--profile', 'rorca', '--no-extensions', '--tools', 'read,bash,edit,write,grep,glob'],
      work,
      childEnv,
    );

    // 1. Bounded session bootstrap: ready -> new_session -> get_state.
    await client.waitFor((parsed) => parsed.type === 'ready', 20_000);
    const newSession = await client.request({ type: 'new_session' });
    assert.equal(newSession.success, true, `new_session failed: ${JSON.stringify(newSession)}`);

    const getState = await client.request({ type: 'get_state' });
    assert.equal(getState.success, true, `get_state failed: ${JSON.stringify(getState)}`);
    const stateData = asRecord(getState.data);
    assert.ok(stateData, 'get_state returned no data object');
    const sessionId = readStringField(stateData, 'sessionId');
    assert.ok(sessionId, 'get_state returned no sessionId');
    assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // 2. Materialize the durable mirror, then tee every later stream JSON
    //    line exactly once via a cursor over the raw line buffer. Lines that
    //    arrived before the session id was known are not mirrored — the
    //    engine tees only the post-materialization run stream.
    store.open(sessionId, work);
    let teeCursor = client.lines.length;
    const teeNewLines = (): void => {
      while (teeCursor < client!.lines.length) {
        const line = client!.lines[teeCursor]!;
        teeCursor += 1;
        try {
          JSON.parse(line);
          store.append(sessionId, `${line}\n`);
        } catch { /* non-JSON noise is not part of the stream contract */ }
      }
    };

    // 3. One bounded prompt: events may stream (credentials present) or omp
    //    answers a clean error (no API key in the temp home). Either outcome
    //    is a valid bounded session event for the tee.
    const promptResponse = await client.request({ type: 'prompt', message: 'Reply with exactly: OMP_RPC_TEE_OK' });
    assert.equal(promptResponse.type, 'response');
    assert.equal(promptResponse.command, 'prompt');
    teeNewLines();
    try {
      await client.waitFor((parsed) => parsed.type === 'agent_settled' || parsed.type === 'turn_end', 20_000);
    } catch {
      // No model credentials in the temp home — the provider error response
      // (success:false + "No API key found") is the expected bounded outcome.
    }
    teeNewLines();
    const abortResponse = await client.request({ type: 'abort' });
    assert.equal(abortResponse.type, 'response');
    assert.equal(abortResponse.command, 'abort');
    teeNewLines();

    // 5. Bounded teardown: close the RPC stream, wait for the child to exit,
    //    then fsync+close the mirror — the tee file must survive.
    const exitCode = await client.end();
    assert.ok(exitCode === 0 || exitCode === null, `omp RPC child exited abnormally: ${String(exitCode)}`);
    store.close(sessionId);

    // 6. Assertions on the surviving tee file.
    const files = walkJsonl(storeRoot);
    assert.equal(files.length, 1, `expected exactly one mirrored session file, found ${files.length}`);
    const filePath = files[0]!;
    assert.match(path.basename(filePath), new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z_${sessionId}\\.jsonl$`));
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    assert.ok(lines.length >= 3, `tee file should hold header + session events, got ${lines.length} lines`);

    const header = asRecord(JSON.parse(lines[0]!));
    assert.ok(header, 'tee file header is not a JSON object');
    assert.equal(header.type, 'session');
    assert.equal(header.version, 3);
    assert.equal(header.id, sessionId);
    assert.equal(header.cwd, path.resolve(work));

    const eventTypes = new Set<string>();
    for (const line of lines.slice(1)) {
      const parsed = asRecord(JSON.parse(line));
      if (parsed && 'type' in parsed && typeof parsed.type === 'string') eventTypes.add(parsed.type);
    }
    assert.ok(eventTypes.has('response'), 'tee file is missing the RPC response events');
    const hasPromptResponse = lines.some((line) => {
      const parsed = asRecord(JSON.parse(line));
      return parsed !== null && parsed.type === 'response' && parsed.command === 'prompt';
    });
    assert.ok(hasPromptResponse, 'tee file is missing the prompt response event');
    const hasAbortResponse = lines.some((line) => {
      const parsed = asRecord(JSON.parse(line));
      return parsed !== null && parsed.type === 'response' && parsed.command === 'abort';
    });
    assert.ok(hasAbortResponse, 'tee file is missing the abort response event');

    // 7. The file survives an independent re-read after full teardown (the
    //    store was closed and the child exited above; re-open from disk).
    const reread = fs.readFileSync(filePath, 'utf8');
    assert.equal(reread, content);
  });
});
