/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const postgresDockerfile = read('docker/postgres/Dockerfile');
const postgresDockerignore = read('docker/postgres/.dockerignore');
const rootDockerignore = read('.dockerignore');
const rootGitignore = read('.gitignore');
const compose = read('docker-compose.yml');
const ovhIngress = read('deploy/ovh/github-webhook-traefik.dynamic.yml');
const initSql = read('docker/postgres/init.sql');

function trackedPaths(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

test('fresh PostgreSQL image initializes extensions only and cannot copy a seed', () => {
  expect(postgresDockerfile).toContain('FROM pgvector/pgvector:pg16');
  expect(postgresDockerfile).toContain('COPY init.sql /docker-entrypoint-initdb.d/010-extensions.sql');
  expect(postgresDockerfile).not.toMatch(/seed|\.sql\.gz|COPY\s+\.\s/i);

  expect(initSql).toContain('CREATE EXTENSION IF NOT EXISTS vector');
  expect(initSql).toContain('CREATE EXTENSION IF NOT EXISTS age');
  expect(initSql).toContain('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  expect(initSql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|COPY)\b/i);
  expect(initSql).not.toMatch(/pgboss\s*\./i);
});

test('Apache AGE is exact-version pinned and package-integrity verified without disabled TLS', () => {
  expect(postgresDockerfile).toMatch(/ARG APACHE_AGE_PACKAGE_VERSION=\d+\.\d+\.\d+-[^\s]+/);
  expect(postgresDockerfile).toContain('"postgresql-16-age=${APACHE_AGE_PACKAGE_VERSION}"');
  expect(postgresDockerfile).toContain("dpkg-query -W -f='${Version}' postgresql-16-age");
  expect(postgresDockerfile).not.toContain('GIT_SSL_NO_VERIFY');
  expect(postgresDockerfile).not.toMatch(/git\s+clone|--branch\s+release\//);
});

test('PostgreSQL and root image contexts reject database exports and archives', () => {
  expect(postgresDockerignore.trim().split(/\r?\n/)).toEqual(expect.arrayContaining([
    '**',
    '!Dockerfile',
    '!init.sql',
  ]));
  for (const pattern of ['**/backups/**', 'docker/postgres/seed*', '**/*.dump', '**/*.sql.gz', '**/*.tar.gz', '**/*.zip']) {
    expect(rootDockerignore).toContain(pattern);
  }
  for (const pattern of ['**/backups/', 'docker/postgres/seed*', '*.dump', '*.sql.gz', '*.tar.gz', '*.zip']) {
    expect(rootGitignore).toContain(pattern);
  }
  expect(compose).toMatch(/db:\s*[\s\S]*?build:\s*[\s\S]*?context:\s*docker\/postgres/);
});

test('tracked source contains no database export, seed, backup directory, or compressed archive', () => {
  const forbidden = trackedPaths().filter((trackedPath) => (
    trackedPath.startsWith('backend/backups/')
    || /^docker\/postgres\/seed/i.test(trackedPath)
    || /\.(?:dump|pgdump|backup|bak|sql\.(?:gz|bz2|xz)|tar|tar\.(?:gz|bz2|xz)|tgz|zip|7z|rar)$/i.test(trackedPath)
  ));
  expect(forbidden).toEqual([]);
});

test('Compose keeps the operator API/UI private and exposes only the exact signed webhook route', () => {
  expect(compose).toContain('AUTH_REQUIRED: "false"');
  expect(compose).toContain('${RORCA_BIND_ADDRESS:-127.0.0.1}:${RORCA_PORT:-3030}:3030');
  expect(compose).toContain('traefik.enable=false');
  expect(compose).not.toContain('traefik.http.routers.rorca.rule');

  const exactRule = 'Host(`hooks.rorca.ai`) && Path(`/api/webhooks/github`) && Method(`POST`)';
  expect(ovhIngress.match(new RegExp(exactRule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(2);
  expect(ovhIngress).not.toMatch(/PathPrefix/);
  expect(ovhIngress).toContain('maxRequestBodyBytes: 1048576');
});

test('application migrations never mutate the pg-boss-owned schema', () => {
  const migrationDir = path.join(root, 'backend/src/db/pg-migrations');
  const offenders = fs.readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql'))
    .filter((name) => {
      const sql = fs.readFileSync(path.join(migrationDir, name), 'utf8')
        .replace(/--.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      return /pgboss\s*\./i.test(sql);
    });
  expect(offenders).toEqual([]);
});
