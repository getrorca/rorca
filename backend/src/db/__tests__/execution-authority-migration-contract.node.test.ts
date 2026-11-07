/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { checkDuplicatePrefixes } from '../pg-index';

const migrationDirectory = join(__dirname, '..', 'pg-migrations');
const migrationFile = '20260821120000_execution_authority_core.sql';
const migrationSql = readFileSync(join(migrationDirectory, migrationFile), 'utf8');
const repositorySql = readFileSync(join(__dirname, '..', 'execution-authority.ts'), 'utf8');
const fixtureSql = readFileSync(join(__dirname, 'fixtures', 'execution-authority-populated-upgrade.sql'), 'utf8');
const runnerSql = readFileSync(join(__dirname, '..', 'pg-index.ts'), 'utf8');
const executableMigrationSql = migrationSql.replace(/--[^\n]*/g, '');

const authorityTables = [
  'operation_intents',
  'authority_requests',
  'authority_decisions',
  'authority_grants',
  'credential_leases',
  'execution_attempts',
  'execution_receipts',
  'execution_authority_bindings',
] as const;

function tableDefinition(table: string): string {
  const start = migrationSql.indexOf(`CREATE TABLE rorca.${table}`);
  assert.notEqual(start, -1, `missing ${table}`);
  const end = migrationSql.indexOf('\n);', start);
  assert.notEqual(end, -1, `unterminated ${table}`);
  return migrationSql.slice(start, end + 3);
}

describe('REA-001 migration contract', () => {
  it('uses the next unique canonical migration version and creates all eight versioned records', () => {
    const files = readdirSync(migrationDirectory).filter((file) => file.endsWith('.sql'));
    assert.doesNotThrow(() => checkDuplicatePrefixes(files));
    assert.equal(files.filter((file) => file.startsWith('20260821120000_')).length, 1);
    for (const table of authorityTables) {
      const definition = tableDefinition(table);
      assert.match(definition, /schema_version TEXT NOT NULL/);
      assert.match(definition, /rorca\.execution-authority\.v1/);
      assert.match(definition, /workspace_id TEXT NOT NULL/);
      assert.match(definition, /created_at TIMESTAMPTZ NOT NULL/);
    }
  });

  it('contains no executable pgboss management or ad hoc rollback SQL', () => {
    assert.doesNotMatch(executableMigrationSql, /\bpgboss\b/i);
    assert.doesNotMatch(executableMigrationSql, /\b(?:DROP TABLE|DROP SCHEMA|TRUNCATE)\b/i);
    assert.doesNotMatch(executableMigrationSql, /\b(?:BEGIN|COMMIT|ROLLBACK)\s*;/i);
  });

  it('binds secret-bearing records to references and fingerprints without credential byte columns', () => {
    for (const table of ['execution_authority_bindings', 'authority_grants', 'credential_leases', 'execution_receipts']) {
      const definition = tableDefinition(table);
      assert.match(definition, /secret_reference TEXT NOT NULL/);
      assert.match(definition, /secret_fingerprint TEXT NOT NULL/);
      assert.match(definition, /provider_resource_id TEXT NOT NULL/);
      assert.doesNotMatch(definition, /\b(?:credential|secret|token)_(?:value|bytes|plaintext|ciphertext)\b/i);
      assert.doesNotMatch(definition, /\bBYTEA\b/i);
    }
    const requestContract = repositorySql.slice(
      repositorySql.indexOf('export interface AuthorityRequestRecord'),
      repositorySql.indexOf('export interface AuthorityDecisionRecord'),
    );
    const decisionContract = repositorySql.slice(
      repositorySql.indexOf('export interface AuthorityDecisionRecord'),
      repositorySql.indexOf('export interface AuthorityGrantRecord'),
    );
    assert.doesNotMatch(requestContract, /credential|secretValue|token/i);
    assert.doesNotMatch(decisionContract, /credential|secretValue|token/i);
  });

  it('declares database guards for exact transitions, one-use limits, fencing, and settled receipt immutability', () => {
    assert.match(migrationSql, /UNIQUE \(workspace_id, idempotency_key\)/);
    assert.match(migrationSql, /uses_consumed >= 0 AND uses_consumed <= maximum_uses/);
    assert.match(tableDefinition('credential_leases'), /UNIQUE \(workspace_id, idempotency_key\)/);
    assert.match(migrationSql, /Stale or duplicate execution fencing generation/);
    assert.match(migrationSql, /Illegal authority request transition/);
    assert.match(migrationSql, /expires_at >= created_at/);
    assert.match(migrationSql, /Execution attempt settlement requires an append-only receipt/);
    assert.match(migrationSql, /WHERE id = NEW\.run_id AND workspace_id = NEW\.workspace_id/);
    assert.match(migrationSql, /NEW\.expires_at > authority_request\.expires_at/);
    assert.match(migrationSql, /status IN \('prepared', 'active'\) AND uses_consumed < maximum_uses/);
    assert.match(migrationSql, /BEFORE UPDATE OR DELETE ON rorca\.execution_receipts/);
    assert.match(migrationSql, /retention_class TEXT NOT NULL/);
    assert.match(migrationSql, /retained_until TIMESTAMPTZ/);
  });

  it('ships a populated fixture that depends only on pre-authority tables', () => {
    assert.match(fixtureSql, /INSERT INTO rorca\.workspaces/);
    assert.match(fixtureSql, /INSERT INTO rorca\.pipeline_runs/);
    for (const table of authorityTables) assert.doesNotMatch(fixtureSql, new RegExp(`INSERT INTO rorca\\.${table}`));
  });

  it('inherits atomic install and marker rollback from the canonical migration runner', () => {
    const begin = runnerSql.indexOf("await client.query('BEGIN')");
    const body = runnerSql.indexOf('await client.query(sql)', begin);
    const marker = runnerSql.indexOf('await persistMigrationMarker(version, file, false)', body);
    const commit = runnerSql.indexOf("await client.query('COMMIT')", marker);
    const rollback = runnerSql.indexOf("await client.query('ROLLBACK')", commit);
    assert.ok(begin >= 0 && body > begin && marker > body && commit > marker && rollback > commit);
  });
});
