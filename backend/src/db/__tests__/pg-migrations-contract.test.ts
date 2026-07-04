/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'pg-migrations');

function migrationFiles(): string[] {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

describe('pg migration contract (US-042)', () => {
  it('keeps pgboss schema ownership delegated to pg-boss runtime', () => {
    const forbiddenExecutableReferences: Array<{ file: string; matched: string }> = [];

    for (const file of migrationFiles()) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const executableSql = stripSqlComments(sql);
      const match = executableSql.match(/\bpgboss\s*\.|\bCREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?pgboss\b|\bALTER\s+SCHEMA\s+pgboss\b|\bDROP\s+SCHEMA\s+(?:IF\s+EXISTS\s+)?pgboss\b/i);
      if (match) forbiddenExecutableReferences.push({ file, matched: match[0] });
    }

    expect(forbiddenExecutableReferences).toEqual([]);
  });

  it('keeps migration versions unique so schema_migrations verification stays deterministic', () => {
    const versions = new Map<string, string[]>();
    for (const file of migrationFiles()) {
      const match = file.match(/^(\d{3}|\d{14})_/);
      expect(match).not.toBeNull();
      const version = match![1];
      const files = versions.get(version) ?? [];
      files.push(file);
      versions.set(version, files);
    }

    const duplicates = Array.from(versions.entries())
      .filter(([, files]) => files.length > 1)
      .map(([version, files]) => ({ version, files }));

    expect(duplicates).toEqual([]);
  });
});
