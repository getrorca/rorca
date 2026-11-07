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
const bootstrapRoles = read('docker/postgres/bootstrap-roles.sh');
const productionEnvExample = read('deploy/env.production.example');

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
  expect(initSql).toContain('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public');
  expect(initSql.indexOf('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public'))
    .toBeLessThan(initSql.indexOf('SET search_path = ag_catalog'));
  expect(initSql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|COPY)\b/i);
  expect(initSql).not.toMatch(/pgboss\s*\./i);
});

test('split-role bootstrap repairs AGE on existing volumes before constrained migrations', () => {
  expect(bootstrapRoles).toContain('CREATE EXTENSION IF NOT EXISTS age');
  expect(bootstrapRoles).toContain('GRANT USAGE ON SCHEMA ag_catalog');
  expect(bootstrapRoles).toContain('GRANT SELECT ON ag_catalog.ag_graph, ag_catalog.ag_label');
});

test('Apache AGE PG16 1.5.0 is reproducibly built for both image architectures without runtime build dependencies', () => {
  expect(postgresDockerfile).toContain('FROM pgvector/pgvector:pg16 AS age-builder');
  expect(postgresDockerfile).toContain('ARG APACHE_AGE_COMMIT=0048900f372d4dfd5c236f78b8a8453bcdbb458e');
  expect(postgresDockerfile).toContain('ARG APACHE_AGE_SOURCE_SHA256=bc2836b3588178b123095b4c8cf9398ad6174f571bcd975bbb844ffdebd2709a');
  expect(postgresDockerfile).toContain('https://codeload.github.com/apache/age/tar.gz/${APACHE_AGE_COMMIT}');
  expect(postgresDockerfile).toContain("--proto '=https' --tlsv1.2");
  expect(postgresDockerfile).toContain('sha256sum --check --strict');
  expect(postgresDockerfile).toContain('amd64:*x86-64*|arm64:*aarch64*');
  expect(postgresDockerfile).toContain('age--1.5.0.sql');
  expect(postgresDockerfile).toContain("default_version = '1.5.0'");
  expect(postgresDockerfile).toContain("! ldd /usr/lib/postgresql/16/lib/age.so | grep -q 'not found'");
  expect(postgresDockerfile).toContain('COPY --from=age-builder');
  expect(postgresDockerfile.match(/^FROM pgvector\/pgvector:pg16/gm)).toHaveLength(2);
  const runtimeStage = postgresDockerfile.slice(postgresDockerfile.lastIndexOf('FROM pgvector/pgvector:pg16'));
  expect(runtimeStage).not.toMatch(/apt-get\s+install|postgresql-16-age/);
  expect(runtimeStage).toContain('for package in build-essential bison flex postgresql-server-dev-16');
  expect(runtimeStage).toContain("-f='${db:Status-Abbrev}'");
  expect(runtimeStage).toContain("test \"$status\" != 'ii '");
  expect(postgresDockerfile).not.toContain('GIT_SSL_NO_VERIFY');
  expect(postgresDockerfile).not.toMatch(/git\s+clone|--branch\s+release\//);
});

test('AGE image preserves dirty-cluster extversion and application migrations do not attempt a version transition', () => {
  expect(postgresDockerfile).not.toContain('age--1.6.0.sql');
  const migrationDir = path.join(root, 'backend/src/db/pg-migrations');
  const migrationSql = fs.readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => fs.readFileSync(path.join(migrationDir, name), 'utf8'))
    .join('\n');
  expect(migrationSql).not.toMatch(/ALTER\s+EXTENSION\s+age\s+UPDATE/i);
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

test('production env example has unique assignments and preserves the private operator port', () => {
  const assignments = productionEnvExample.split(/\r?\n/)
    .filter(line => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map(line => line.slice(0, line.indexOf('=')));
  expect(new Set(assignments).size).toBe(assignments.length);
  expect(productionEnvExample).toMatch(/^RORCA_BIND_ADDRESS=127\.0\.0\.1$/m);
  expect(productionEnvExample.match(/^RORCA_PORT=3030$/gm)).toHaveLength(1);
  expect(productionEnvExample).not.toMatch(/^RORCA_PORT=443$/m);
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
