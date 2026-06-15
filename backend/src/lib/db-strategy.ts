/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { queryOne } from '../db/index.js';

export type DbMode = 'native' | 'docker' | 'byop';

const DEFAULT_NATIVE_PORT = 5433;
const DOCKER_PORT = 5432;
const DB_MODE_FILENAME = 'db-mode';

interface ExtensionRow {
  present: number;
}

let cachedNativePort: number | null = null;

function getRorcaHome(): string {
  return path.join(os.homedir(), '.rorca');
}

function getDbModePath(): string {
  return path.join(getRorcaHome(), DB_MODE_FILENAME);
}

function parseDatabaseUrl(databaseUrl: string): URL | null {
  try {
    return new URL(databaseUrl);
  } catch {
    return null;
  }
}

function parseDatabaseHost(databaseUrl: string): string | null {
  return parseDatabaseUrl(databaseUrl)?.hostname.toLowerCase() ?? null;
}

function parseDatabasePort(databaseUrl: string): number | null {
  const url = parseDatabaseUrl(databaseUrl);
  if (!url) return null;
  if (!url.port) return 5432;
  const parsed = Number.parseInt(url.port, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDatabaseName(databaseUrl: string): string | null {
  const url = parseDatabaseUrl(databaseUrl);
  if (!url) return null;
  return url.pathname.replace(/^\//, '') || null;
}

function isTestDatabaseName(databaseName: string | null): boolean {
  return typeof databaseName === 'string' && databaseName.endsWith('_test');
}

function preserveDatabaseName(databaseUrl: string, databaseName: string): string {
  const url = parseDatabaseUrl(databaseUrl);
  if (!url) return databaseUrl;
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function isRemoteHost(host: string | null): boolean {
  if (!host) return false;
  return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
}

function readDbModeFile(): DbMode | null {
  try {
    const value = fs.readFileSync(getDbModePath(), 'utf8').trim().toLowerCase();
    return value === 'docker' || value === 'native' || value === 'byop'
      ? value
      : null;
  } catch {
    return null;
  }
}

function getCliSourceCandidates(): string[] {
  return [
    path.join(__dirname, '..', '..', '..', 'bin', 'rorca.ts'),
    path.join(__dirname, '..', '..', '..', 'bin', 'rorca.js'),
  ];
}

function extractManagedPgPort(source: string): number | null {
  const match = source.match(/const MANAGED_PG_PORT = (\d+);/);
  return match ? parseInt(match[1], 10) : null;
}

function resolveNativePort(): number {
  if (cachedNativePort !== null) return cachedNativePort;
  for (const candidate of getCliSourceCandidates()) {
    try {
      const content = fs.readFileSync(candidate, 'utf8');
      const parsed = extractManagedPgPort(content);
      if (parsed) {
        cachedNativePort = parsed;
        return parsed;
      }
    } catch {
      continue;
    }
  }
  cachedNativePort = DEFAULT_NATIVE_PORT;
  return cachedNativePort;
}

export function detectDbMode(): DbMode {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl && isRemoteHost(parseDatabaseHost(databaseUrl))) {
    return 'byop';
  }

  const persistedMode = readDbModeFile();
  if (persistedMode === 'docker' || persistedMode === 'native') {
    return persistedMode;
  }

  const localPort = databaseUrl ? parseDatabasePort(databaseUrl) : null;
  if (localPort === DOCKER_PORT) return 'docker';
  if (localPort === resolveNativePort()) return 'native';

  return 'native';
}

export function setDbMode(mode: DbMode): void {
  const rorcaHome = getRorcaHome();
  fs.mkdirSync(rorcaHome, { recursive: true });
  const dbModePath = getDbModePath();
  fs.writeFileSync(dbModePath, `${mode}\n`, { mode: 0o600 });
  fs.chmodSync(dbModePath, 0o600);
}

export function getDbConnectionString(mode: DbMode): string {
  if (mode === 'docker') {
    return `postgres://rorca:rorca@localhost:${DOCKER_PORT}/rorca`;
  }
  if (mode === 'byop') {
    return process.env.DATABASE_URL || '';
  }
  return `postgres://rorca:rorca@localhost:${resolveNativePort()}/rorca`;
}

export function applySelectedDbModeEnvironment(env: NodeJS.ProcessEnv = process.env): {
  mode: DbMode;
  databaseUrl: string;
  changed: boolean;
} {
  const mode = detectDbMode();
  const current = env.DATABASE_URL?.trim() || '';
  const currentDatabaseName = parseDatabaseName(current);

  if (mode === 'byop') {
    return {
      mode,
      databaseUrl: current,
      changed: false,
    };
  }

  let databaseUrl = getDbConnectionString(mode);
  if (isTestDatabaseName(currentDatabaseName)) {
    databaseUrl = preserveDatabaseName(databaseUrl, currentDatabaseName!);
  }

  const changed = current !== databaseUrl;
  env.DATABASE_URL = databaseUrl;

  return { mode, databaseUrl, changed };
}

export async function isAgeAvailable(): Promise<boolean> {
  const row = await queryOne<ExtensionRow>(
    `SELECT 1 AS present
     FROM pg_extension e
     JOIN pg_proc p ON p.proname = 'cypher'
     JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'ag_catalog'
     WHERE e.extname = 'age'
     LIMIT 1`
  );
  return row?.present === 1;
}
