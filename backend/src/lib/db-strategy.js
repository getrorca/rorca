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
import { buildSslConfig, detectCloudProvider, query } from '../db/index';
const DEFAULT_NATIVE_PORT = 5433;
const DOCKER_PORT = 5432;
const DB_MODE_FILENAME = 'db-mode';
const BYOP_DATABASE_URL_FILENAME = 'database-url';
const EMPTY_EXTENSIONS = {
    age: false,
    vector: false,
    pgcrypto: false,
};
const CONTROL_CHARACTER_REGEX = /[\u0000-\u001F\u007F]/;
let cachedNativePort = null;
function createValidationError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}
function getRorcaHome() {
    return path.join(os.homedir(), '.rorca');
}
function getDbModePath() {
    return path.join(getRorcaHome(), DB_MODE_FILENAME);
}
function getPersistedByopDatabaseUrlPath() {
    return path.join(getRorcaHome(), BYOP_DATABASE_URL_FILENAME);
}
function parseDatabaseUrl(databaseUrl) {
    try {
        return new URL(databaseUrl);
    }
    catch {
        return null;
    }
}
function parseDatabaseHost(databaseUrl) {
    return parseDatabaseUrl(databaseUrl)?.hostname.toLowerCase() ?? null;
}
function parseDatabasePort(databaseUrl) {
    const url = parseDatabaseUrl(databaseUrl);
    if (!url)
        return null;
    if (!url.port)
        return 5432;
    const parsed = Number.parseInt(url.port, 10);
    return Number.isFinite(parsed) ? parsed : null;
}
function parseDatabaseName(databaseUrl) {
    const url = parseDatabaseUrl(databaseUrl);
    if (!url)
        return null;
    return url.pathname.replace(/^\//, '') || null;
}
function isTestDatabaseName(databaseName) {
    return typeof databaseName === 'string' && databaseName.endsWith('_test');
}
function preserveDatabaseName(databaseUrl, databaseName) {
    const url = parseDatabaseUrl(databaseUrl);
    if (!url)
        return databaseUrl;
    url.pathname = `/${databaseName}`;
    return url.toString();
}
function isRemoteHost(host) {
    if (!host)
        return false;
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
}
function readDbModeFile() {
    try {
        const value = fs.readFileSync(getDbModePath(), 'utf8').trim().toLowerCase();
        return value === 'docker' || value === 'native' || value === 'byop'
            ? value
            : null;
    }
    catch {
        return null;
    }
}
function getCliSourceCandidates() {
    return [
        path.join(__dirname, '..', '..', '..', 'bin', 'rorca.ts'),
        path.join(__dirname, '..', '..', '..', 'bin', 'rorca.js'),
    ];
}
function extractManagedPgPort(source) {
    const match = source.match(/const MANAGED_PG_PORT = (\d+);/);
    return match ? parseInt(match[1], 10) : null;
}
function resolveNativePort() {
    if (cachedNativePort !== null)
        return cachedNativePort;
    for (const candidate of getCliSourceCandidates()) {
        try {
            const content = fs.readFileSync(candidate, 'utf8');
            const parsed = extractManagedPgPort(content);
            if (parsed) {
                cachedNativePort = parsed;
                return parsed;
            }
        }
        catch {
            continue;
        }
    }
    cachedNativePort = DEFAULT_NATIVE_PORT;
    return cachedNativePort;
}
function resolveDatabaseProvider(mode, databaseUrl) {
    if (mode === 'docker')
        return 'docker-postgres';
    if (mode === 'native')
        return 'native-postgres';
    return detectCloudProvider(databaseUrl || undefined);
}
function deriveGraphMode(connected, extensions) {
    if (!connected)
        return 'disabled';
    return extensions.age ? 'full' : 'lite';
}
function providerLabel(provider) {
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
function buildWarnings(input) {
    const warnings = [];
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
        }
        else if (input.dbMode === 'native') {
            warnings.push('Native mode is running in lite graph mode because Apache AGE is not installed locally.');
        }
        else {
            warnings.push(`${providerLabel(input.provider)} is connected without Apache AGE; Rorca will stay in lite graph mode.`);
        }
    }
    if (!input.extensions.vector) {
        warnings.push('pgvector is not installed; embedding-backed retrieval may be limited.');
    }
    return warnings;
}
function normalizeExtensions(extensionStatus) {
    return {
        age: extensionStatus?.age === true,
        vector: extensionStatus?.vector === true,
        pgcrypto: extensionStatus?.pgcrypto === true,
    };
}
export function redactDatabaseUrl(databaseUrl) {
    const url = parseDatabaseUrl(databaseUrl);
    if (!url)
        return null;
    return `${url.protocol}//${url.host}${url.pathname}`;
}
export function getRedactedDatabaseConnection(databaseUrl) {
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
export function readPersistedByopDatabaseUrl() {
    try {
        const value = fs.readFileSync(getPersistedByopDatabaseUrlPath(), 'utf8').trim();
        return value || null;
    }
    catch {
        return null;
    }
}
export function clearPersistedByopDatabaseUrl() {
    try {
        fs.unlinkSync(getPersistedByopDatabaseUrlPath());
    }
    catch {
        // Ignore missing file and cleanup failures here — callers are switching away from BYOP.
    }
}
export function validateByopDatabaseUrl(databaseUrl) {
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
export function setPersistedByopDatabaseUrl(databaseUrl) {
    const { normalizedUrl } = validateByopDatabaseUrl(databaseUrl);
    const rorcaHome = getRorcaHome();
    fs.mkdirSync(rorcaHome, { recursive: true });
    const byopPath = getPersistedByopDatabaseUrlPath();
    fs.writeFileSync(byopPath, `${normalizedUrl}\n`, { mode: 0o600 });
    fs.chmodSync(byopPath, 0o600);
}
function getEffectiveDatabaseUrl(mode, env = process.env) {
    const current = env.DATABASE_URL?.trim() || '';
    if (mode === 'byop') {
        return readPersistedByopDatabaseUrl() || current;
    }
    return current || getDbConnectionString(mode);
}
export function buildDatabaseCapability(input) {
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
    const provider = input.provider ?? resolveDatabaseProvider(dbMode, rawDatabaseUrl);
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
async function detectDatabaseCapabilityInputs() {
    const dbMode = detectDbMode();
    const databaseUrl = getEffectiveDatabaseUrl(dbMode);
    try {
        const rows = await query("SELECT extname FROM pg_extension WHERE extname IN ('age', 'vector', 'pgcrypto') ORDER BY extname");
        const extensions = rows.reduce((acc, row) => {
            if (row.extname === 'age')
                acc.age = true;
            if (row.extname === 'vector')
                acc.vector = true;
            if (row.extname === 'pgcrypto')
                acc.pgcrypto = true;
            return acc;
        }, { ...EMPTY_EXTENSIONS });
        return {
            connected: true,
            extensionStatus: extensions,
            databaseUrl,
        };
    }
    catch {
        return {
            connected: false,
            extensionStatus: { ...EMPTY_EXTENSIONS },
            databaseUrl,
        };
    }
}
export async function getDatabaseCapability(input) {
    if (input && (input.connected !== undefined
        || input.dbMode !== undefined
        || input.provider !== undefined
        || input.extensionStatus !== undefined
        || input.databaseUrl !== undefined)) {
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
export function buildDatabaseCapabilityFromHealth(health) {
    return buildDatabaseCapability({
        connected: health.ok,
        provider: health.provider,
        extensionStatus: health.extensionStatus,
    });
}
export function detectDbMode() {
    const persistedMode = readDbModeFile();
    if (persistedMode === 'docker' || persistedMode === 'native') {
        return persistedMode;
    }
    if (persistedMode === 'byop') {
        const persistedByopUrl = readPersistedByopDatabaseUrl();
        if (persistedByopUrl)
            return 'byop';
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
    if (localPort === DOCKER_PORT)
        return 'docker';
    if (localPort === resolveNativePort())
        return 'native';
    return 'native';
}
export function setDbMode(mode) {
    const rorcaHome = getRorcaHome();
    fs.mkdirSync(rorcaHome, { recursive: true });
    const dbModePath = getDbModePath();
    fs.writeFileSync(dbModePath, `${mode}\n`, { mode: 0o600 });
    fs.chmodSync(dbModePath, 0o600);
    if (mode !== 'byop') {
        clearPersistedByopDatabaseUrl();
    }
}
export function getDbConnectionString(mode) {
    if (mode === 'docker') {
        return `postgres://rorca:rorca@localhost:${DOCKER_PORT}/rorca`;
    }
    if (mode === 'byop') {
        return readPersistedByopDatabaseUrl() || process.env.DATABASE_URL || '';
    }
    return `postgres://rorca:rorca@localhost:${resolveNativePort()}/rorca`;
}
export function applySelectedDbModeEnvironment(env = process.env) {
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
        databaseUrl = preserveDatabaseName(databaseUrl, currentDatabaseName);
    }
    const changed = current !== databaseUrl;
    env.DATABASE_URL = databaseUrl;
    return { mode, databaseUrl, changed };
}
export async function validateByopConnection(databaseUrl) {
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
        let pgVersion = null;
        try {
            const versionRow = await pool.query('SELECT version()');
            pgVersion = versionRow.rows[0]?.version ?? null;
        }
        catch {
            throw createValidationError('DATABASE_UNREACHABLE', `Could not connect to ${connection.host ?? 'the PostgreSQL server'} using the supplied DATABASE_URL.`);
        }
        let connectionLimit = null;
        try {
            const limitRow = await pool.query('SHOW max_connections');
            const parsed = Number.parseInt(limitRow.rows[0]?.max_connections ?? '', 10);
            connectionLimit = Number.isFinite(parsed) ? parsed : null;
        }
        catch {
            connectionLimit = null;
        }
        let extensions = { ...EMPTY_EXTENSIONS };
        try {
            const extRows = await pool.query("SELECT extname FROM pg_extension WHERE extname IN ('age', 'vector', 'pgcrypto') ORDER BY extname");
            extensions = extRows.rows.reduce((acc, row) => {
                if (row.extname === 'age')
                    acc.age = true;
                if (row.extname === 'vector')
                    acc.vector = true;
                if (row.extname === 'pgcrypto')
                    acc.pgcrypto = true;
                return acc;
            }, { ...EMPTY_EXTENSIONS });
        }
        catch {
            throw createValidationError('EXTENSION_CHECK_FAILED', 'Connected successfully, but could not verify required PostgreSQL extensions for BYOP mode.');
        }
        if (!extensions.vector) {
            throw createValidationError('PGVECTOR_REQUIRED', 'The selected PostgreSQL database must have the pgvector extension installed before Rorca can use BYOP mode.');
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
    }
    finally {
        await pool.end().catch(() => { });
    }
}
export function formatDbModeBootstrapLog(input) {
    const display = input.databaseUrl
        ? (redactDatabaseUrl(input.databaseUrl) ?? '(redacted unavailable)')
        : '(not configured)';
    return `[db-mode] Using ${input.mode} database ${display}`;
}
export async function isAgeAvailable() {
    const capability = await getDatabaseCapability();
    return capability.extensions.age;
}
