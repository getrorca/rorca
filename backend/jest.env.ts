/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * jest.env.ts — Per-worker environment setup
 *
 * Runs before each test file (setupFiles). Sets DATABASE_URL so the
 * db/index.ts pool connects to the test database.
 *
 * IMPORTANT: We derive the test DB URL from DATABASE_URL by appending _test
 * to the database name. This ensures tests always hit a separate database
 * on the same server, regardless of which port or credentials are configured.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_NATIVE_PORT = 5433;
const DOCKER_PORT = 5432;

function getDbModePath() {
  return path.join(os.homedir(), '.rorca', 'db-mode');
}

function readDbModeFile() {
  try {
    const value = fs.readFileSync(getDbModePath(), 'utf8').trim().toLowerCase();
    return value === 'docker' || value === 'native' || value === 'byop' ? value : null;
  } catch {
    return null;
  }
}

function resolveNativePort() {
  const candidates = [
    path.join(__dirname, '..', 'bin', 'rorca.ts'),
    path.join(__dirname, '..', 'bin', 'rorca.js'),
  ];
  for (const candidate of candidates) {
    try {
      const content = fs.readFileSync(candidate, 'utf8');
      const match = content.match(/const MANAGED_PG_PORT = (\d+);/);
      if (match) return parseInt(match[1], 10);
    } catch {}
  }
  return DEFAULT_NATIVE_PORT;
}

function deriveSelectedBaseUrl(): string {
  if (process.env.DATABASE_URL_TEST) return process.env.DATABASE_URL_TEST;

  const current = process.env.DATABASE_URL || 'postgres://rorca:rorca@localhost:5433/rorca';
  try {
    const parsed = new URL(current);
    const host = parsed.hostname.toLowerCase();
    const isRemote = host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
    if (isRemote) return current;
  } catch {
    return current;
  }

  const mode = readDbModeFile();
  if (mode === 'docker') return `postgres://rorca:rorca@localhost:${DOCKER_PORT}/rorca`;
  if (mode === 'native' || mode === null) return `postgres://rorca:rorca@localhost:${resolveNativePort()}/rorca`;
  return current;
}

const baseUrl = (() => {
  const prodUrl = deriveSelectedBaseUrl();
  try {
    const parsed = new URL(prodUrl);
    const dbName = parsed.pathname.slice(1); // strip leading /
    if (!dbName.endsWith('_test')) {
      parsed.pathname = `/${dbName}_test`;
    }
    return parsed.toString();
  } catch {
    return 'postgres://rorca:rorca@localhost:5433/rorca_test';
  }
})();

process.env.DATABASE_URL = baseUrl;
process.env.NODE_ENV = 'test';

try {
  const parsed = new URL(baseUrl);
  process.env.PGHOST = parsed.hostname;
  process.env.PGPORT = parsed.port || '5432';
  process.env.PGUSER = decodeURIComponent(parsed.username || 'rorca');
  process.env.PGPASSWORD = decodeURIComponent(parsed.password || 'rorca');
  process.env.PGDATABASE = parsed.pathname.slice(1);
} catch {
  process.env.PGDATABASE = 'rorca_test';
}

// Limit pool size in tests: each jest.resetModules() + require('../../server') creates a new
// pg Pool. With 54 tests in pipeline.test.ts, PG_POOL_SIZE=1 keeps total connections ~60,
// safely under PostgreSQL's default max_connections=100.
process.env.PG_POOL_SIZE = '1';
process.env.JEST_SKIP_RUNTIME_MIGRATIONS = 'true';
