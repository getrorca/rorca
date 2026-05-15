/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { queryOne } from '../db';
const DEFAULT_NATIVE_PORT = 5433;
const DOCKER_PORT = 5432;
const DB_MODE_FILENAME = 'db-mode';
let cachedNativePort = null;
function getRorcaHome() {
    return path.join(os.homedir(), '.rorca');
}
function getDbModePath() {
    return path.join(getRorcaHome(), DB_MODE_FILENAME);
}
function parseDatabaseHost(databaseUrl) {
    try {
        return new URL(databaseUrl).hostname.toLowerCase();
    }
    catch {
        return null;
    }
}
function isRemoteHost(host) {
    if (!host)
        return false;
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
}
function readDbModeFile() {
    try {
        return fs.readFileSync(getDbModePath(), 'utf8').trim().toLowerCase();
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
export function detectDbMode() {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (databaseUrl && isRemoteHost(parseDatabaseHost(databaseUrl))) {
        return 'byop';
    }
    return readDbModeFile() === 'docker' ? 'docker' : 'native';
}
export function setDbMode(mode) {
    const rorcaHome = getRorcaHome();
    fs.mkdirSync(rorcaHome, { recursive: true });
    const dbModePath = getDbModePath();
    fs.writeFileSync(dbModePath, `${mode}\n`, { mode: 0o600 });
    fs.chmodSync(dbModePath, 0o600);
}
export function getDbConnectionString(mode) {
    if (mode === 'docker') {
        return `postgres://rorca:rorca@localhost:${DOCKER_PORT}/rorca`;
    }
    if (mode === 'byop') {
        return process.env.DATABASE_URL || '';
    }
    return `postgres://rorca:rorca@localhost:${resolveNativePort()}/rorca`;
}
export async function isAgeAvailable() {
    if (detectDbMode() === 'native')
        return false;
    const row = await queryOne("SELECT 1 AS present FROM pg_extension WHERE extname = 'age'");
    return row?.present === 1;
}
