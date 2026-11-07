#!/usr/bin/env node
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * One-command Bring-Your-Own-Postgres (BYOP) verification.
 *
 * Proves that Rorca can run against a hosted Postgres — Supabase, Neon, Railway,
 * or anything else — using only a single connection string:
 *
 *   1. reachability + TLS + pgvector check
 *   2. split-principal role bootstrap (scripts/bootstrap-byop-principals.mjs)
 *   3. one-shot migrations + pg-boss install under the migration profile
 *   4. boot the backend under the runtime profile
 *   5. assert /api/health reports dbMode=byop, the expected graph mode, and pgvector
 *   6. shut everything down and print a report
 *
 * The connection string is NEVER printed and never written into the repository;
 * generated profiles live under ~/.rorca at mode 0600.
 *
 * Usage:
 *   node scripts/verify-byop.mjs                          # reads ~/.rorca/test-supabase-url
 *   node scripts/verify-byop.mjs --url-file <path>
 *   RORCA_BYOP_URL='postgres://…' node scripts/verify-byop.mjs
 *   node scripts/verify-byop.mjs --keep-profiles          # do not delete the 0600 profiles
 *   node scripts/verify-byop.mjs --mode native --expect-graph lite
 *   node scripts/verify-byop.mjs --mode docker --expect-graph full
 */

import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOTSTRAP = path.join(repoRoot, 'scripts', 'bootstrap-byop-principals.mjs');
const SERVER_ENTRY = path.join(repoRoot, 'backend', 'src', 'server.ts');
const TSX = path.join(repoRoot, 'backend', 'node_modules', '.bin', 'tsx');

const REPORT = [];
function step(name, detail = '') {
  REPORT.push({ name, detail });
  console.log(`\n▶ ${name}${detail ? ` — ${detail}` : ''}`);
}
function ok(message) { console.log(`  ✓ ${message}`); }
function fail(message) {
  console.error(`  ✗ ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    urlFile: path.join(os.homedir(), '.rorca', 'test-supabase-url'),
    keepProfiles: false,
    port: Number(process.env.RORCA_VERIFY_PORT || 0) || 0,
    mode: process.env.RORCA_VERIFY_MODE || 'byop',
    expectGraph: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url-file') options.urlFile = argv[++i] ?? options.urlFile;
    else if (arg === '--keep-profiles') options.keepProfiles = true;
    else if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg === '--mode') options.mode = String(argv[++i] || '').trim();
    else if (arg === '--expect-graph') options.expectGraph = String(argv[++i] || '').trim();
    else if (arg === '--help' || arg === '-h') options.help = true;
    else fail(`unknown argument: ${arg}`);
  }
  return options;
}

function readTargetUrl(options) {
  const fromEnv = process.env.RORCA_BYOP_URL?.trim();
  if (fromEnv) return { url: fromEnv, source: 'RORCA_BYOP_URL' };
  if (!fs.existsSync(options.urlFile)) {
    fail(
      `no connection string.\n`
      + `    Expected a Supabase/Neon "session pooler" URI at ${options.urlFile} (chmod 600),\n`
      + `    or pass --url-file <path>, or set RORCA_BYOP_URL.`,
    );
  }
  const url = fs.readFileSync(options.urlFile, 'utf8').trim();
  if (!url) fail(`${options.urlFile} is empty`);
  const mode = fs.statSync(options.urlFile).mode & 0o777;
  if (mode & 0o077) console.warn(`  ! ${options.urlFile} is mode ${mode.toString(8)}; use chmod 600`);
  return { url, source: options.urlFile };
}

function describe(url) {
  const parsed = new URL(url);
  return {
    parsed,
    host: parsed.hostname,
    port: parsed.port || '5432',
    database: parsed.pathname.replace(/^\//, '') || '(none)',
    user: parsed.username ? decodeURIComponent(parsed.username) : (process.env.PGUSER || os.userInfo().username),
    sslmode: parsed.searchParams.get('sslmode') || '(unset)',
    isPooler: /\.pooler\.supabase\.com$/.test(parsed.hostname),
    isSupabase: /supabase\.(com|co)$/.test(parsed.hostname),
  };
}

function tcpProbe(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: Number(port) });
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(4000) });
      const raw = await response.text();
      let body = null;
      try { body = JSON.parse(raw); } catch { body = null; }
      if (response.status === 200 && body) return body;
      // Express answers non-JSON (HTML) until the health router is mounted; that is
      // "still starting", not a failure worth aborting on.
      last = body
        ? `HTTP ${response.status} (db_connected=${body.db_connected})`
        : `HTTP ${response.status} (non-JSON response — backend still starting)`;
    } catch (error) {
      last = error?.message ?? 'error';
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  fail(`backend never became healthy: ${last}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    return;
  }

  if (!['byop', 'native', 'docker'].includes(options.mode)) {
    fail(`--mode must be one of byop, native, docker (got "${options.mode}")`);
  }
  const expectedGraph = options.expectGraph
    || (options.mode === 'docker' ? 'full' : 'lite');

  const { url, source } = readTargetUrl(options);
  const target = describe(url);

  step('Target', `mode=${options.mode} from ${source}`);
  console.log(`  host=${target.host} port=${target.port} database=${target.database}`);
  console.log(`  user=${target.user} sslmode=${target.sslmode} pooler=${target.isPooler}`);
  if (target.user === 'postgres' || target.user.startsWith('postgres.')) {
    console.log('  ! connecting as the database owner; that is required for the one-time role bootstrap');
  }
  if (target.sslmode !== 'require' && target.sslmode !== 'verify-full') {
    console.log('  ! no sslmode=require: Rorca will not enable TLS for this URL');
  }

  step('TCP reachability');
  const reachable = await tcpProbe(target.host, target.port);
  if (!reachable) {
    fail(
      `${target.host}:${target.port} is unreachable.\n`
      + `    Free-plan Supabase direct connections are IPv6-only. Use the "Session pooler"\n`
      + `    string from Connect (aws-<n>-<region>.pooler.supabase.com:5432).`,
    );
  }
  ok(`${target.host}:${target.port} accepting connections`);

  step('Required extensions');
  {
    // pgvector is mandatory. On a hosted provider it is usually installed with
    // one statement; without it the migration chain fails with
    // `type "vector" does not exist`, which is the single most common first-run
    // failure. pgcrypto backs the digest helpers.
    const require = createRequire(path.join(repoRoot, 'backend', 'package.json'));
    const { Client } = require('pg');
    const client = new Client({ connectionString: url, ssl: /sslmode=(require|verify-full)/.test(url) ? { rejectUnauthorized: false } : undefined });
    await client.connect();
    try {
      for (const extension of ['vector', 'pgcrypto']) {
        const present = await client.query('SELECT 1 FROM pg_extension WHERE extname = $1', [extension]);
        if (present.rowCount > 0) { ok(`${extension} already installed`); continue; }
        await client.query(`CREATE EXTENSION IF NOT EXISTS ${extension}`);
        ok(`${extension} installed`);
      }
    } finally {
      await client.end().catch(() => {});
    }
  }

  step('Split-principal bootstrap');
  execFileSync(process.execPath, [BOOTSTRAP, '--url', url], { stdio: ['ignore', 'inherit', 'inherit'] });
  ok('roles provisioned; profiles written under ~/.rorca (0600)');

  const serverProfile = path.join(os.homedir(), '.rorca', 'byop-principals.env');
  const migrateProfile = path.join(os.homedir(), '.rorca', 'byop-migrate.env');
  const readEnvFile = (file) => Object.fromEntries(
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );

  step('Migrations (migration profile)');
  const migrateEnv = { ...process.env, ...readEnvFile(migrateProfile) };
  execFileSync(TSX, ['src/db/pg-index.ts'], { cwd: path.join(repoRoot, 'backend'), env: migrateEnv, stdio: ['ignore', 'inherit', 'inherit'] });
  execFileSync(TSX, ['src/db/pg-boss-install.ts'], { cwd: path.join(repoRoot, 'backend'), env: migrateEnv, stdio: ['ignore', 'inherit', 'inherit'] });
  ok('schema and pg-boss transport ready');

  step('Backend under the runtime profile');
  const port = options.port || 3400 + Math.floor(Math.random() * 200);
  const serverEnv = {
    ...process.env,
    ...readEnvFile(serverProfile),
    RORCA_DB_MODE: options.mode,
    ...(options.mode === 'docker' ? { RORCA_DOCKER_PORT: target.port } : {}),
    PORT: String(port),
    RORCA_BIND_HOST: '127.0.0.1',
    RORCA_DISABLE_BACKGROUND_RUNTIME: 'true',
  };
  const child = spawn(TSX, [SERVER_ENTRY], {
    cwd: path.join(repoRoot, 'backend'),
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk.toString(); });
  child.stderr.on('data', (chunk) => { log += chunk.toString(); });

  try {
    const health = await waitForHealth(port, 180_000);
    ok(`healthy on 127.0.0.1:${port}`);
    const capability = health.databaseCapability ?? {};
    const summary = {
      status: health.status,
      dbMode: health.dbMode,
      graphMode: health.graphMode,
      pgvectorReady: health.pgvectorReady,
      dbConnected: health.db_connected,
      provider: capability.provider,
      extensions: capability.extensions,
    };
    console.log('\n  /api/health:');
    for (const [key, value] of Object.entries(summary)) {
      console.log(`    ${key}: ${JSON.stringify(value)}`);
    }
    for (const warning of health.graphWarnings ?? []) {
      console.log(`    warning: ${warning}`);
    }

    const problems = [];
    if (summary.dbMode !== options.mode) problems.push(`dbMode=${summary.dbMode} (expected ${options.mode})`);
    if (summary.dbConnected !== true) problems.push('db_connected is false');
    if (summary.pgvectorReady !== true) problems.push('pgvectorReady is false (CREATE EXTENSION vector required)');
    if (!['lite', 'full'].includes(String(summary.graphMode))) problems.push(`graphMode=${summary.graphMode}`);
    if (summary.graphMode !== expectedGraph) problems.push(`graphMode=${summary.graphMode} (expected ${expectedGraph})`);
    if (problems.length > 0) fail(`health contract not satisfied: ${problems.join('; ')}`);

    step('Result');
    ok(`${options.mode} verified: dbMode=${summary.dbMode}, graphMode=${summary.graphMode}, pgvector=true, provider=${summary.provider}`);
  } catch (error) {
    const tail = log.split('\n').filter(Boolean).slice(-15).join('\n');
    console.error('\n  backend log tail:\n' + tail);
    throw error;
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    child.kill('SIGKILL');
    if (!options.keepProfiles) {
      for (const file of [serverProfile, migrateProfile]) {
        try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
      }
    }
  }
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}`);
  process.exit(1);
});
