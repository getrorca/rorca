/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
export const TEST_DATABASE_SUFFIX = '_test';
const DEFAULT_LOCAL_ENV_PATH = path.join(os.homedir(), '.rorca', 'test-db.env');
export function databaseNameFromUrl(databaseUrl) {
    let parsed;
    try {
        parsed = new URL(databaseUrl);
    }
    catch {
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
export function assertTestDatabaseName(database, source = 'database') {
    if (!database.endsWith(TEST_DATABASE_SUFFIX)) {
        throw new Error(`[test-db-safety] Refusing ${source} "${database || '(unknown)'}": name does not end in "${TEST_DATABASE_SUFFIX}"`);
    }
    return database;
}
export function assertTestDatabaseUrl(databaseUrl, source = 'test database URL') {
    return assertTestDatabaseName(databaseNameFromUrl(databaseUrl), source);
}
function parseEnvFile(content) {
    const values = {};
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#'))
            continue;
        const separator = line.indexOf('=');
        if (separator <= 0)
            continue;
        const key = line.slice(0, separator).trim();
        let value = line.slice(separator + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"'))
            || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        values[key] = value;
    }
    return values;
}
function readLocalTestDatabaseUrl(env) {
    const envPath = env.RORCA_TEST_DB_ENV_FILE || DEFAULT_LOCAL_ENV_PATH;
    if (!fs.existsSync(envPath))
        return undefined;
    const mode = fs.statSync(envPath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
        throw new Error(`[test-db-safety] Refusing insecure credential file ${envPath}; run chmod 600`);
    }
    const values = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
    return values.RORCA_TEST_DATABASE_URL || values.DATABASE_URL_TEST;
}
/**
 * Resolve one immutable test URL. Production DATABASE_URL is intentionally
 * ignored: a test target must be explicit or come from the local 0600 file.
 */
export function resolveTestDatabaseUrl(env = process.env) {
    const databaseUrl = env.RORCA_TEST_DATABASE_URL
        || readLocalTestDatabaseUrl(env)
        || env.DATABASE_URL_TEST;
    if (!databaseUrl) {
        throw new Error('[test-db-safety] No dedicated test database configured. Set RORCA_TEST_DATABASE_URL, '
            + 'DATABASE_URL_TEST, or create ~/.rorca/test-db.env with mode 0600.');
    }
    assertTestDatabaseUrl(databaseUrl);
    return databaseUrl;
}
/** Verify server truth immediately before any destructive test operation. */
export async function assertConnectedTestDatabase(client, expectedUrl) {
    const expectedDatabase = assertTestDatabaseUrl(expectedUrl);
    const expectedUser = decodeURIComponent(new URL(expectedUrl).username);
    const result = await client.query(`SELECT current_database() AS database,
            current_user AS user,
            pg_get_userbyid(datdba) AS owner
       FROM pg_database
      WHERE datname = current_database()`);
    const database = result.rows[0]?.database || '';
    const user = result.rows[0]?.user || '';
    const owner = result.rows[0]?.owner || '';
    assertTestDatabaseName(database, 'connected database');
    if (database !== expectedDatabase) {
        throw new Error(`[test-db-safety] Refusing connected database "${database}": expected "${expectedDatabase}"`);
    }
    if (!expectedUser || user !== expectedUser) {
        throw new Error(`[test-db-safety] Refusing connected role "${user || '(unknown)'}": expected dedicated role "${expectedUser || '(missing)'}"`);
    }
    if (owner !== user) {
        throw new Error(`[test-db-safety] Refusing database owner "${owner || '(unknown)'}": dedicated role "${user}" must own "${database}"`);
    }
    return { database, user, owner };
}
