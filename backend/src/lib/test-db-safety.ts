import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const TEST_DATABASE_SUFFIX = '_test';
const DEFAULT_LOCAL_ENV_PATH = path.join(os.homedir(), '.rorca', 'test-db.env');

interface Queryable {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface ConnectedTestDatabase {
  database: string;
  user: string;
}

export function databaseNameFromUrl(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('[test-db-safety] Test database URL is not a valid URL');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('[test-db-safety] Test database URL must use postgres:// or postgresql://');
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!database || database.includes('/')) {
    throw new Error('[test-db-safety] Test database URL must name exactly one database');
  }
  return database;
}

export function assertTestDatabaseName(database: string, source = 'database'): string {
  if (!database.endsWith(TEST_DATABASE_SUFFIX)) {
    throw new Error(
      `[test-db-safety] Refusing ${source} "${database || '(unknown)'}": name does not end in "${TEST_DATABASE_SUFFIX}"`,
    );
  }
  return database;
}

export function assertTestDatabaseUrl(databaseUrl: string, source = 'test database URL'): string {
  return assertTestDatabaseName(databaseNameFromUrl(databaseUrl), source);
}

function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function readLocalTestDatabaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const envPath = env.RORCA_TEST_DB_ENV_FILE || DEFAULT_LOCAL_ENV_PATH;
  if (!fs.existsSync(envPath)) return undefined;

  const mode = fs.statSync(envPath).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `[test-db-safety] Refusing insecure credential file ${envPath}; run chmod 600`,
    );
  }

  const values = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  return values.RORCA_TEST_DATABASE_URL || values.DATABASE_URL_TEST;
}

/**
 * Resolve one immutable test URL. Production DATABASE_URL is intentionally
 * ignored: a test target must be explicit or come from the local 0600 file.
 */
export function resolveTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const databaseUrl = env.RORCA_TEST_DATABASE_URL
    || readLocalTestDatabaseUrl(env)
    || env.DATABASE_URL_TEST;

  if (!databaseUrl) {
    throw new Error(
      '[test-db-safety] No dedicated test database configured. Set RORCA_TEST_DATABASE_URL, '
      + 'DATABASE_URL_TEST, or create ~/.rorca/test-db.env with mode 0600.',
    );
  }

  assertTestDatabaseUrl(databaseUrl);
  return databaseUrl;
}

/** Verify server truth immediately before any destructive test operation. */
export async function assertConnectedTestDatabase(
  client: Queryable,
  expectedUrl: string,
): Promise<ConnectedTestDatabase> {
  const expectedDatabase = assertTestDatabaseUrl(expectedUrl);
  const result = await client.query<{ database: string; user: string }>(
    'SELECT current_database() AS database, current_user AS user',
  );
  const database = result.rows[0]?.database || '';
  const user = result.rows[0]?.user || '';

  assertTestDatabaseName(database, 'connected database');
  if (database !== expectedDatabase) {
    throw new Error(
      `[test-db-safety] Refusing connected database "${database}": expected "${expectedDatabase}"`,
    );
  }

  return { database, user };
}
