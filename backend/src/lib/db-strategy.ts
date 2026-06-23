/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Pool } from 'pg';
import { buildSslConfig, detectCloudProvider, query, type CloudProvider, type DbHealthResult } from '../db/index';

export type DbMode = 'native' | 'docker' | 'byop';
export type DatabaseProvider = 'native-postgres' | 'docker-postgres' | CloudProvider;
export type GraphMode = 'full' | 'lite' | 'disabled';
export type DatabaseSelectionValidationCode =
  | 'INVALID_DATABASE_URL'
  | 'DATABASE_UNREACHABLE'
  | 'EXTENSION_CHECK_FAILED'
  | 'PGVECTOR_REQUIRED';

export interface DatabaseSelectionValidationError extends Error {
  code: DatabaseSelectionValidationCode;
}

export interface DatabaseExtensions {
  age: boolean;
  vector: boolean;
  pgcrypto: boolean;
}

export interface RedactedDatabaseConnection {
  url: string | null;
  host: string | null;
  port: number | null;
  database: string | null;
  local: boolean;
}

export interface DatabaseCapability {
  dbMode: DbMode;
  provider: DatabaseProvider;
  extensions: DatabaseExtensions;
  graphMode: GraphMode;
  warnings: string[];
  connection: RedactedDatabaseConnection;
  connected: boolean;
}

export interface ByopConnectionValidationResult {
  normalizedUrl: string;
  provider: DatabaseProvider;
  connection: RedactedDatabaseConnection;
  extensions: DatabaseExtensions;
  pgVersion: string | null;
  connectionLimit: number | null;
  warnings: string[];
}

export interface DatabaseModeSetupGuide {
  mode: DbMode;
  label: string;
  summary: string;
  startupGuide: string[];
  graphExpectation: 'full' | 'lite';
  graphSummary: string;
  tradeoffs: string[];
  bestFor: string[];
}

export interface GraphModeGuide {
  mode: 'full' | 'lite';
  label: string;
  summary: string;
  tradeoffs: string[];
  bestFor: string[];
}

export interface DatabaseSetupGuidance {
  selectedMode: DbMode;
  byopConfigured: boolean;
  selectionPersistsAcrossSessions: boolean;
  selectionNote: string;
  validationFlow: string;
  byop: {
    secretSafeInput: string;
    validationChecks: string[];
    examples: string[];
  };
  modes: DatabaseModeSetupGuide[];
  graphModes: GraphModeGuide[];
}

const DEFAULT_NATIVE_PORT = 5433;
const DOCKER_PORT = 5432;
const DB_MODE_FILENAME = 'db-mode';
const BYOP_DATABASE_URL_FILENAME = 'database-url';
const EMPTY_EXTENSIONS: DatabaseExtensions = {
  age: false,
  vector: false,
  pgcrypto: false,
};
const CONTROL_CHARACTER_REGEX = /[\u0000-\u001F\u007F]/;

interface ExtensionRow {
  extname: string;
}

let cachedNativePort: number | null = null;

function createValidationError(code: DatabaseSelectionValidationCode, message: string): DatabaseSelectionValidationError {
  const error = new Error(message) as DatabaseSelectionValidationError;
  error.code = code;
  return error;
}

function getRorcaHome(): string {
  return path.join(os.homedir(), '.rorca');
}

function getDbModePath(): string {
  return path.join(getRorcaHome(), DB_MODE_FILENAME);
}

function getPersistedByopDatabaseUrlPath(): string {
  return path.join(getRorcaHome(), BYOP_DATABASE_URL_FILENAME);
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

function resolveDatabaseProvider(mode: DbMode, databaseUrl: string): DatabaseProvider {
  if (mode === 'docker') return 'docker-postgres';
  if (mode === 'native') return 'native-postgres';
  return detectCloudProvider(databaseUrl || undefined);
}

function deriveGraphMode(connected: boolean, extensions: DatabaseExtensions): GraphMode {
  if (!connected) return 'disabled';
  return extensions.age ? 'full' : 'lite';
}

function providerLabel(provider: DatabaseProvider): string {
  switch (provider) {
    case 'docker-postgres':
      return 'Docker Postgres';
    case 'native-postgres':
      return 'native Postgres';
    case 'self-hosted':
      return 'self-hosted Postgres';
    case 'supabase':
      return 'Supabase Postgres';
    case 'neon':
      return 'Neon Postgres';
    case 'railway':
      return 'Railway Postgres';
    default:
      return provider;
  }
}

function buildWarnings(input: {
  dbMode: DbMode;
  provider: DatabaseProvider;
  connected: boolean;
  extensions: DatabaseExtensions;
  rawDatabaseUrl: string;
  connection: RedactedDatabaseConnection;
}): string[] {
  const warnings: string[] = [];

  if (input.rawDatabaseUrl && !input.connection.url) {
    warnings.push('DATABASE_URL could not be parsed; connection metadata is partially unavailable.');
  }

  if (!input.connected) {
    warnings.push('Database connectivity is unavailable; graph features are disabled until the database is reachable.');
    return warnings;
  }

  if (!input.extensions.age) {
    if (input.dbMode === 'docker') {
      warnings.push('Docker mode is connected without Apache AGE; rerun `rorca db start` or recreate the extension for full graph support.');
    } else if (input.dbMode === 'native') {
      warnings.push('Native mode is running in lite graph mode because Apache AGE is not installed locally.');
    } else {
      warnings.push(`${providerLabel(input.provider)} is connected without Apache AGE; Rorca will stay in lite graph mode.`);
    }
  }

  if (!input.extensions.vector) {
    warnings.push('pgvector is not installed; embedding-backed retrieval may be limited.');
  }

  return warnings;
}

function normalizeExtensions(extensionStatus?: Partial<DatabaseExtensions> | null): DatabaseExtensions {
  return {
    age: extensionStatus?.age === true,
    vector: extensionStatus?.vector === true,
    pgcrypto: extensionStatus?.pgcrypto === true,
  };
}

export function redactDatabaseUrl(databaseUrl: string): string | null {
  const url = parseDatabaseUrl(databaseUrl);
  if (!url) return null;
  return `${url.protocol}//${url.host}${url.pathname}`;
}

export function getRedactedDatabaseConnection(databaseUrl: string): RedactedDatabaseConnection {
  const url = parseDatabaseUrl(databaseUrl);
  const host = url?.hostname ?? null;
  const port = url?.port ? Number.parseInt(url.port, 10) : (url ? 5432 : null);
  return {
    url: redactDatabaseUrl(databaseUrl),
    host,
    port: Number.isFinite(port) ? port : null,
    database: url?.pathname.replace(/^\//, '') || null,
    local: !isRemoteHost(host),
  };
}

export function readPersistedByopDatabaseUrl(): string | null {
  try {
    const value = fs.readFileSync(getPersistedByopDatabaseUrlPath(), 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

export function clearPersistedByopDatabaseUrl(): void {
  try {
    fs.unlinkSync(getPersistedByopDatabaseUrlPath());
  } catch {
    // Ignore missing file and cleanup failures here — callers are switching away from BYOP.
  }
}

export function validateByopDatabaseUrl(databaseUrl: string): {
  normalizedUrl: string;
  provider: DatabaseProvider;
  connection: RedactedDatabaseConnection;
} {
  const trimmed = databaseUrl.trim();
  if (!trimmed) {
    throw createValidationError('INVALID_DATABASE_URL', 'DATABASE_URL is required for BYOP mode.');
  }
  if (CONTROL_CHARACTER_REGEX.test(trimmed)) {
    throw createValidationError('INVALID_DATABASE_URL', 'DATABASE_URL contains unsupported control characters.');
  }

  const parsed = parseDatabaseUrl(trimmed);
  if (!parsed) {
    throw createValidationError('INVALID_DATABASE_URL', 'DATABASE_URL must be a valid postgres:// or postgresql:// connection string.');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw createValidationError('INVALID_DATABASE_URL', 'DATABASE_URL must use the postgres:// or postgresql:// protocol.');
  }
  if (!parsed.hostname) {
    throw createValidationError('INVALID_DATABASE_URL', 'DATABASE_URL must include a hostname.');
  }
  if (!parsed.pathname || parsed.pathname === '/') {
    throw createValidationError('INVALID_DATABASE_URL', 'DATABASE_URL must include a database name.');
  }

  const sslMode = parsed.searchParams.get('sslmode')?.toLowerCase();
  if (sslMode === 'disable') {
    throw createValidationError('INVALID_DATABASE_URL', 'DATABASE_URL must not disable SSL/TLS with sslmode=disable.');
  }

  const normalizedUrl = parsed.toString();
  return {
    normalizedUrl,
    provider: detectCloudProvider(normalizedUrl),
    connection: getRedactedDatabaseConnection(normalizedUrl),
  };
}

export function setPersistedByopDatabaseUrl(databaseUrl: string): void {
  const { normalizedUrl } = validateByopDatabaseUrl(databaseUrl);
  const rorcaHome = getRorcaHome();
  fs.mkdirSync(rorcaHome, { recursive: true });
  const byopPath = getPersistedByopDatabaseUrlPath();
  fs.writeFileSync(byopPath, `${normalizedUrl}\n`, { mode: 0o600 });
  fs.chmodSync(byopPath, 0o600);
}

function getEffectiveDatabaseUrl(mode: DbMode, env: NodeJS.ProcessEnv = process.env): string {
  const current = env.DATABASE_URL?.trim() || '';
  if (mode === 'byop') {
    return readPersistedByopDatabaseUrl() || current;
  }
  return current || getDbConnectionString(mode);
}

export function buildDatabaseCapability(input: {
  connected: boolean;
  dbMode?: DbMode;
  provider?: DatabaseProvider | CloudProvider;
  extensionStatus?: Partial<DatabaseExtensions> | null;
  databaseUrl?: string;
}): DatabaseCapability {
  const dbMode = input.dbMode ?? detectDbMode();
  const rawDatabaseUrl = input.databaseUrl ?? getEffectiveDatabaseUrl(dbMode);
  const connection = rawDatabaseUrl
    ? getRedactedDatabaseConnection(rawDatabaseUrl)
    : {
        url: null,
        host: null,
        port: null,
        database: null,
        local: dbMode !== 'byop',
      };
  const provider = (input.provider as DatabaseProvider | undefined) ?? resolveDatabaseProvider(dbMode, rawDatabaseUrl);
  const extensions = normalizeExtensions(input.extensionStatus);

  return {
    dbMode,
    provider,
    extensions,
    graphMode: deriveGraphMode(input.connected, extensions),
    warnings: buildWarnings({
      dbMode,
      provider,
      connected: input.connected,
      extensions,
      rawDatabaseUrl,
      connection,
    }),
    connection,
    connected: input.connected,
  };
}

async function detectDatabaseCapabilityInputs(): Promise<{
  connected: boolean;
  extensionStatus: DatabaseExtensions;
  databaseUrl: string;
}> {
  const dbMode = detectDbMode();
  const databaseUrl = getEffectiveDatabaseUrl(dbMode);

  try {
    const rows = await query<ExtensionRow>(
      "SELECT extname FROM pg_extension WHERE extname IN ('age', 'vector', 'pgcrypto') ORDER BY extname"
    );
    const extensions = rows.reduce<DatabaseExtensions>((acc, row) => {
      if (row.extname === 'age') acc.age = true;
      if (row.extname === 'vector') acc.vector = true;
      if (row.extname === 'pgcrypto') acc.pgcrypto = true;
      return acc;
    }, { ...EMPTY_EXTENSIONS });

    return {
      connected: true,
      extensionStatus: extensions,
      databaseUrl,
    };
  } catch {
    return {
      connected: false,
      extensionStatus: { ...EMPTY_EXTENSIONS },
      databaseUrl,
    };
  }
}

export async function getDatabaseCapability(input?: {
  connected?: boolean;
  dbMode?: DbMode;
  provider?: DatabaseProvider | CloudProvider;
  extensionStatus?: Partial<DatabaseExtensions> | null;
  databaseUrl?: string;
}): Promise<DatabaseCapability> {
  if (input && (
    input.connected !== undefined
    || input.dbMode !== undefined
    || input.provider !== undefined
    || input.extensionStatus !== undefined
    || input.databaseUrl !== undefined
  )) {
    return buildDatabaseCapability({
      connected: input.connected ?? false,
      dbMode: input.dbMode,
      provider: input.provider,
      extensionStatus: input.extensionStatus,
      databaseUrl: input.databaseUrl,
    });
  }

  const detected = await detectDatabaseCapabilityInputs();
  return buildDatabaseCapability({
    connected: detected.connected,
    extensionStatus: detected.extensionStatus,
    databaseUrl: detected.databaseUrl,
  });
}

export function buildDatabaseCapabilityFromHealth(health: Pick<DbHealthResult, 'ok' | 'provider' | 'extensionStatus'>): DatabaseCapability {
  return buildDatabaseCapability({
    connected: health.ok,
    provider: health.provider,
    extensionStatus: health.extensionStatus,
  });
}

export function detectDbMode(): DbMode {
  const persistedMode = readDbModeFile();
  if (persistedMode === 'docker' || persistedMode === 'native') {
    return persistedMode;
  }
  if (persistedMode === 'byop') {
    const persistedByopUrl = readPersistedByopDatabaseUrl();
    if (persistedByopUrl) return 'byop';
    const envDatabaseUrl = process.env.DATABASE_URL?.trim();
    if (envDatabaseUrl && isRemoteHost(parseDatabaseHost(envDatabaseUrl))) {
      return 'byop';
    }
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl && isRemoteHost(parseDatabaseHost(databaseUrl))) {
    return 'byop';
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
  if (mode !== 'byop') {
    clearPersistedByopDatabaseUrl();
  }
}

export function getDbConnectionString(mode: DbMode): string {
  if (mode === 'docker') {
    return `postgres://rorca:rorca@localhost:${DOCKER_PORT}/rorca`;
  }
  if (mode === 'byop') {
    return readPersistedByopDatabaseUrl() || process.env.DATABASE_URL || '';
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
    const databaseUrl = readPersistedByopDatabaseUrl() || current;
    const changed = current !== databaseUrl;
    if (databaseUrl) {
      env.DATABASE_URL = databaseUrl;
    }
    return {
      mode,
      databaseUrl,
      changed,
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

export async function validateByopConnection(databaseUrl: string): Promise<ByopConnectionValidationResult> {
  const { normalizedUrl, provider, connection } = validateByopDatabaseUrl(databaseUrl);
  const ssl = buildSslConfig(normalizedUrl);
  const pool = new Pool({
    connectionString: normalizedUrl,
    max: 1,
    min: 0,
    idleTimeoutMillis: 1_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    ...(ssl ? { ssl } : {}),
  });

  try {
    let pgVersion: string | null = null;
    try {
      const versionRow = await pool.query<{ version: string }>('SELECT version()');
      pgVersion = versionRow.rows[0]?.version ?? null;
    } catch {
      throw createValidationError(
        'DATABASE_UNREACHABLE',
        `Could not connect to ${connection.host ?? 'the PostgreSQL server'} using the supplied DATABASE_URL.`
      );
    }

    let connectionLimit: number | null = null;
    try {
      const limitRow = await pool.query<{ max_connections: string }>('SHOW max_connections');
      const parsed = Number.parseInt(limitRow.rows[0]?.max_connections ?? '', 10);
      connectionLimit = Number.isFinite(parsed) ? parsed : null;
    } catch {
      connectionLimit = null;
    }

    let extensions = { ...EMPTY_EXTENSIONS };
    try {
      const extRows = await pool.query<ExtensionRow>(
        "SELECT extname FROM pg_extension WHERE extname IN ('age', 'vector', 'pgcrypto') ORDER BY extname"
      );
      extensions = extRows.rows.reduce<DatabaseExtensions>((acc, row) => {
        if (row.extname === 'age') acc.age = true;
        if (row.extname === 'vector') acc.vector = true;
        if (row.extname === 'pgcrypto') acc.pgcrypto = true;
        return acc;
      }, { ...EMPTY_EXTENSIONS });
    } catch {
      throw createValidationError(
        'EXTENSION_CHECK_FAILED',
        'Connected successfully, but could not verify required PostgreSQL extensions for BYOP mode.'
      );
    }

    if (!extensions.vector) {
      throw createValidationError(
        'PGVECTOR_REQUIRED',
        'The selected PostgreSQL database must have the pgvector extension installed before Rorca can use BYOP mode.'
      );
    }

    return {
      normalizedUrl,
      provider,
      connection,
      extensions,
      pgVersion,
      connectionLimit,
      warnings: buildWarnings({
        dbMode: 'byop',
        provider,
        connected: true,
        extensions,
        rawDatabaseUrl: normalizedUrl,
        connection,
      }),
    };
  } finally {
    await pool.end().catch(() => {});
  }
}

export function buildDatabaseSetupGuidance(selectedMode: DbMode = detectDbMode()): DatabaseSetupGuidance {
  return {
    selectedMode,
    byopConfigured: Boolean(readPersistedByopDatabaseUrl()),
    selectionPersistsAcrossSessions: true,
    selectionNote: 'Your database mode choice is saved for the next startup/session before Rorca bootstraps a local database or validates a hosted connection.',
    validationFlow: 'Native and Docker selections save immediately. BYOP only runs connection validation when you explicitly save a DATABASE_URL.',
    byop: {
      secretSafeInput: 'Paste the full DATABASE_URL in the secure BYOP field. Rorca stores it outside your repo and only shows redacted host/database details later.',
      validationChecks: [
        'Reachable PostgreSQL connection over SSL/TLS',
        'Valid database name and hostname',
        'pgvector extension installed',
      ],
      examples: ['Supabase', 'Neon', 'Railway', 'self-hosted Postgres'],
    },
    modes: [
      {
        mode: 'native',
        label: 'Local / native Postgres',
        summary: 'Use a Postgres instance you run directly on your machine.',
        startupGuide: [
          'Install or start local PostgreSQL on your machine.',
          `Point it at the standard Rorca connection on localhost:${resolveNativePort()} or update your local setup to match.`,
          'Use this when you want the lightest local setup and are okay with Graph Lite unless AGE is installed manually.',
        ],
        graphExpectation: 'lite',
        graphSummary: 'Usually starts in Graph Lite. Full Graph is available only if Apache AGE is installed locally.',
        tradeoffs: [
          'Fastest path for local dev when you already have Postgres.',
          'No Docker dependency.',
          'Manual Apache AGE setup is required for Full Graph.',
        ],
        bestFor: ['Existing local Postgres users', 'Minimal local tooling', 'Quick first install'],
      },
      {
        mode: 'docker',
        label: 'Docker Postgres with AGE',
        summary: 'Run the recommended containerized Postgres stack with Apache AGE support.',
        startupGuide: [
          'Make sure Docker Desktop or another Docker runtime is running.',
          'Run `rorca db start` to provision the managed Docker Postgres with AGE.',
          'Use this when you want the smoothest path to Full Graph features with fewer manual database steps.',
        ],
        graphExpectation: 'full',
        graphSummary: 'Best default for Full Graph because AGE ships with the Docker path.',
        tradeoffs: [
          'Best Full Graph experience.',
          'Requires Docker and local container resources.',
          'Slightly heavier than native/local Postgres.',
        ],
        bestFor: ['Recommended default', 'Knowledge graph demos', 'Users who want AGE without manual installs'],
      },
      {
        mode: 'byop',
        label: 'Bring your own Postgres',
        summary: 'Connect a hosted Postgres instance such as Supabase or Neon.',
        startupGuide: [
          'Create or choose a hosted Postgres database (for example Supabase or Neon).',
          'Copy the full postgres:// or postgresql:// connection string with SSL enabled.',
          'Paste it into the secure DATABASE_URL field and validate it before saving.',
        ],
        graphExpectation: 'lite',
        graphSummary: 'Usually runs in Graph Lite unless your hosted Postgres already has Apache AGE installed.',
        tradeoffs: [
          'Best for cloud-hosted or shared environments.',
          'Requires secret-safe connection handling.',
          'pgvector is required and Apache AGE is optional for Full Graph.',
        ],
        bestFor: ['Supabase / Neon projects', 'Hosted environments', 'Teams reusing an existing Postgres'],
      },
    ],
    graphModes: [
      {
        mode: 'full',
        label: 'Full Graph',
        summary: 'AGE-backed graph traversal, richer graph admin views, and the best graph tooling experience.',
        tradeoffs: [
          'Requires Apache AGE on the selected Postgres instance.',
          'Best fit for Docker mode or a custom local/hosted Postgres with AGE already installed.',
        ],
        bestFor: ['Knowledge graph exploration', 'Graph-backed admin tools', 'AGE-enabled Postgres setups'],
      },
      {
        mode: 'lite',
        label: 'Graph Lite',
        summary: 'Keeps knowledge, relevance, and memory workflows usable with relational/semantic fallbacks when AGE is unavailable.',
        tradeoffs: [
          'No AGE-backed graph traversal or full graph visualisation features.',
          'Great compatibility mode for native/local or hosted Postgres without AGE.',
        ],
        bestFor: ['Fast onboarding', 'Hosted Postgres without AGE', 'Users who want fewer setup dependencies'],
      },
    ],
  };
}

export function formatDbModeBootstrapLog(input: { mode: DbMode; databaseUrl: string }): string {
  const display = input.databaseUrl
    ? (redactDatabaseUrl(input.databaseUrl) ?? '(redacted unavailable)')
    : '(not configured)';
  return `[db-mode] Using ${input.mode} database ${display}`;
}

export async function isAgeAvailable(): Promise<boolean> {
  const capability = await getDatabaseCapability();
  return capability.extensions.age;
}
