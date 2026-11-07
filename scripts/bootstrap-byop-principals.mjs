#!/usr/bin/env node
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Provision the split-principal topology on a Bring-Your-Own-Postgres database.
 *
 * Rorca's migrations require three distinct non-privileged LOGIN roles
 * (migration, runtime, canonical writer) plus the `authenticated`/`anon`
 * compatibility roles, exactly like the bundled Docker Postgres does at
 * `docker/postgres/bootstrap-roles.sh`. Hosted databases (Supabase, Neon,
 * Railway, self-hosted) never run that Docker entrypoint, so a first-time BYOP
 * user hits:
 *
 *   requires a distinct existing non-privileged RORCA_RUNTIME_DATABASE_USER
 *
 * and cannot start Rorca at all with only the connection string the onboarding
 * wizard collects. This command closes that gap: it reads the single BYOP
 * DATABASE_URL, generates three random role passwords, creates the roles
 * idempotently, and writes the resulting configuration to
 * `~/.rorca/byop-principals.env` (mode 0600) so the operator can export it.
 *
 * Nothing is written into the repository.
 *
 * Usage:
 *   node scripts/bootstrap-byop-principals.mjs --url "postgres://…" [--env-file <path>] [--print-only]
 *   node scripts/bootstrap-byop-principals.mjs            # reads ~/.rorca/database-url
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOTSTRAP_SCRIPT = path.join(repoRoot, 'docker', 'postgres', 'bootstrap-roles.sh');

const ROLE_ENV = [
  ['RORCA_MIGRATION_DATABASE_USER', 'rorca_migrator'],
  ['RORCA_RUNTIME_DATABASE_USER', 'rorca_runtime'],
  ['RORCA_CANONICAL_WRITER_DATABASE_USER', 'rorca_canonical_writer'],
];

function fail(message) {
  console.error(`bootstrap-byop-principals: ${message}`);
  process.exit(64);
}

function parseArgs(argv) {
  const options = { url: '', envFile: '', printOnly: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--url': options.url = argv[++i] ?? ''; break;
      case '--env-file': options.envFile = argv[++i] ?? ''; break;
      case '--print-only': options.printOnly = true; break;
      case '--help':
      case '-h': options.help = true; break;
      default: fail(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function defaultPersistedUrl() {
  return path.join(os.homedir(), '.rorca', 'database-url');
}

function readPersistedUrl() {
  const file = defaultPersistedUrl();
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8').trim();
}

function parseConnection(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    fail('the connection string is not a valid URL');
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) fail('the connection string must be a postgres:// URL');
  const database = parsed.pathname.replace(/^\//, '');
  if (!parsed.hostname) fail('the connection string is missing a hostname');
  if (!database) fail('the connection string is missing a database name');
  // libpq defaults a missing username to the OS user for local connections, and
  // Rorca's own native-mode connection behaves the same way. Mirror that instead
  // of rejecting an otherwise valid local URL.
  const osUser = process.env.PGUSER?.trim() || os.userInfo().username;
  const username = parsed.username ? decodeURIComponent(parsed.username) : osUser;
  const sslmode = parsed.searchParams.get('sslmode');
  return {
    host: parsed.hostname,
    port: parsed.port || '5432',
    user: username,
    password: decodeURIComponent(parsed.password),
    database,
    sslmode,
  };
}

function randomPassword() {
  return crypto.randomBytes(18).toString('base64url');
}

function buildUrl({ host, port, user, password, database, sslmode }) {
  // Preserve the caller's TLS choice. Rorca only enables TLS when the URL says
  // sslmode=require|verify-full (or PGSSLMODE does), so silently dropping it would
  // break hosted providers, while forcing it would break a local non-TLS probe.
  const query = sslmode ? `?${new URLSearchParams({ sslmode })}` : '';
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}${query}`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    return;
  }

  const url = options.url || process.env.RORCA_DATABASE_URL || process.env.DATABASE_URL || readPersistedUrl();
  if (!url) {
    fail('no connection string: pass --url, set RORCA_DATABASE_URL, or save one to ~/.rorca/database-url');
  }

  const connection = parseConnection(url);
  if (connection.sslmode === 'disable') {
    fail('sslmode=disable is rejected: hosted Postgres connections must use SSL/TLS');
  }
  if (!fs.existsSync(BOOTSTRAP_SCRIPT)) {
    fail(`bootstrap script not found at ${BOOTSTRAP_SCRIPT}`);
  }

  const passwords = Object.fromEntries(ROLE_ENV.map(([envName]) => [envName, randomPassword()]));

  if (options.printOnly) {
    console.log('# --print-only: no database changes were made');
    for (const [envName, role] of ROLE_ENV) {
      console.log(`${envName}=${role}`);
    }
    return;
  }

  // A local/trust-authenticated URL carries no password. bootstrap-roles.sh
  // requires the variable to be non-empty, and any value satisfies trust auth,
  // so pass an explicit sentinel instead of failing a legitimate local setup.
  const bootstrapPassword = connection.password || 'trust-auth-no-password';
  if (!connection.password) {
    console.log('  i no password in the URL: assuming local trust authentication');
  }
  const env = {
    ...process.env,
    POSTGRES_HOST: connection.host,
    POSTGRES_PORT: connection.port,
    POSTGRES_DB: connection.database,
    POSTGRES_BOOTSTRAP_USER: connection.user,
    POSTGRES_BOOTSTRAP_PASSWORD: bootstrapPassword,
  };
  for (const [envName, role] of ROLE_ENV) {
    env[envName] = role;
    env[`${envName}_PASSWORD`] = passwords[envName];
  }
  // The bundled script expects RORCA_<X>_DATABASE_PASSWORD naming.
  env.RORCA_MIGRATION_DATABASE_PASSWORD = passwords.RORCA_MIGRATION_DATABASE_USER;
  env.RORCA_RUNTIME_DATABASE_PASSWORD = passwords.RORCA_RUNTIME_DATABASE_USER;
  env.RORCA_CANONICAL_WRITER_DATABASE_PASSWORD = passwords.RORCA_CANONICAL_WRITER_DATABASE_USER;

  try {
    execFileSync('sh', [BOOTSTRAP_SCRIPT], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const stderr = error?.stderr?.toString?.() ?? '';
    const stdout = error?.stdout?.toString?.() ?? '';
    fail(
      'could not provision the split-principal roles. The connection user needs CREATE ROLE '
      + `(Supabase: connect as the \`postgres\` role).\n${stdout}${stderr}`.trim(),
    );
  }

  // pg-boss creates its own schema at boss.start() using the runtime connection,
  // which has no CREATE on the database by design. The Docker deployment solves
  // this by letting the migration owner (the database owner) create the schema
  // while the app runs with RORCA_PGBOSS_PREAPPLIED=true. Mirror that exactly so
  // BYOP keeps the same privilege boundary instead of granting database-wide CREATE.
  const schemaEnv = {
    ...process.env,
    PGPASSWORD: bootstrapPassword,
  };
  try {
    execFileSync(
      'psql',
      [
        '--no-psqlrc', '--set', 'ON_ERROR_STOP=1',
        '--host', connection.host, '--port', connection.port,
        '--username', connection.user, '--dbname', connection.database,
        '--command',
        'CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION rorca_migrator; '
          + 'ALTER SCHEMA pgboss OWNER TO rorca_migrator; '
          + 'GRANT USAGE, CREATE ON SCHEMA pgboss TO rorca_runtime;',
      ],
      { env: schemaEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    const stderr = error?.stderr?.toString?.() ?? '';
    fail(`could not reserve the pgboss schema for the runtime role.\n${stderr}`.trim());
  }

  // Two profiles, exactly like the Docker topology: the migration owner's
  // credential reaches only the one-shot migrate process, never the API/worker.
  const envFile = options.envFile || path.join(os.homedir(), '.rorca', 'byop-principals.env');
  const migrateEnvFile = options.envFile
    ? `${options.envFile}.migrate`
    : path.join(os.homedir(), '.rorca', 'byop-migrate.env');
  fs.mkdirSync(path.dirname(envFile), { recursive: true });

  const serverLines = [
    '# Generated by scripts/bootstrap-byop-principals.mjs — keep this file private.',
    '# Runtime profile for the API/worker. Contains NO migration-owner credential.',
    `#   set -a; . ${envFile}; set +a`,
    '',
    'RORCA_RUNTIME_DATABASE_USER=rorca_runtime',
    'RORCA_CANONICAL_WRITER_DATABASE_USER=rorca_canonical_writer',
    `DATABASE_URL=${buildUrl({ ...connection, user: 'rorca_runtime', password: passwords.RORCA_RUNTIME_DATABASE_USER })}`,
    `RORCA_CANONICAL_WRITER_DATABASE_URL=${buildUrl({ ...connection, user: 'rorca_canonical_writer', password: passwords.RORCA_CANONICAL_WRITER_DATABASE_USER })}`,
    'RORCA_PGBOSS_PREAPPLIED=true',
    // Migrations are applied out-of-band by the migration profile, exactly like
    // the Docker db-migrate service; the runtime process must not attempt them.
    'RORCA_MIGRATIONS_PREAPPLIED=true',
    '',
  ];
  const migrateLines = [
    '# Generated by scripts/bootstrap-byop-principals.mjs — keep this file private.',
    '# One-shot migration profile. Do not export this into the API/worker process.',
    `#   set -a; . ${migrateEnvFile}; set +a`,
    '',
    'RORCA_RUNTIME_DATABASE_USER=rorca_runtime',
    'RORCA_CANONICAL_WRITER_DATABASE_USER=rorca_canonical_writer',
    `DATABASE_URL=${buildUrl({ ...connection, user: 'rorca_migrator', password: passwords.RORCA_MIGRATION_DATABASE_USER })}`,
    '',
  ];

  for (const [file, lines] of [[envFile, serverLines], [migrateEnvFile, migrateLines]]) {
    fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }

  console.log('Split-principal roles provisioned on the BYOP database.');
  console.log(`Roles: ${ROLE_ENV.map(([, role]) => role).join(', ')} (+ authenticated, anon)`);
  console.log(`Runtime profile: ${envFile} (0600, no migration credential)`);
  console.log(`Migration profile: ${migrateEnvFile} (0600, one-shot only)`);
  console.log('');
  console.log('1) Apply migrations once, as the migration owner:');
  console.log(`   set -a; . ${migrateEnvFile}; set +a`);
  console.log('   (cd backend && npx tsx src/db/pg-index.ts && npx tsx src/db/pg-boss-install.ts)');
  console.log('');
  console.log('2) Start Rorca with the runtime profile:');
  console.log(`   set -a; . ${envFile}; set +a`);
  console.log('   RORCA_DB_MODE=byop npm run dev:server');

  void passwords;
}

main();
