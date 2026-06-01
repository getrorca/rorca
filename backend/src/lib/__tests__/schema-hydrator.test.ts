/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hydrateSchema } from '../schema-hydrator';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-hydrator-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeMigration(dir: string, filename: string, content: string) {
  const migDir = path.join(dir, 'backend', 'src', 'db', 'migrations');
  fs.mkdirSync(migDir, { recursive: true });
  fs.writeFileSync(path.join(migDir, filename), content, 'utf8');
}

test('extracts CREATE TABLE blocks from multiple migration files', () => {
  const sql1 = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT REFERENCES users(id),
  title TEXT NOT NULL
);
`;
  const sql2 = `
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER REFERENCES posts(id),
  body TEXT NOT NULL
);
`;
  writeMigration(tmpDir, '001_init.sql', sql1);
  writeMigration(tmpDir, '002_comments.sql', sql2);

  const result = hydrateSchema(tmpDir);

  expect(result.tableNames).toEqual(['users', 'posts', 'comments']);
  expect(result.fileCount).toBe(2);
  expect(result.snapshot).toContain('users');
  expect(result.snapshot).toContain('posts');
  expect(result.snapshot).toContain('comments');
  expect(result.snapshot).toContain('-- Source: 001_init.sql');
  expect(result.snapshot).toContain('-- Source: 002_comments.sql');
  expect(result.migrationDir).toBe(
    path.join(tmpDir, 'backend', 'src', 'db', 'migrations')
  );
});

test('deduplicates table names (first file wins)', () => {
  const sql1 = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT
);
`;
  const sql2 = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT
);
`;
  writeMigration(tmpDir, '001_init.sql', sql1);
  writeMigration(tmpDir, '002_redo.sql', sql2);

  const result = hydrateSchema(tmpDir);

  expect(result.tableNames).toEqual(['users']);
  // Should keep the first file's version (no email column)
  expect(result.snapshot).toContain('-- Source: 001_init.sql');
  expect(result.snapshot).not.toContain('-- Source: 002_redo.sql');
});

test('returns empty result when no migrations directory found', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-empty-'));
  try {
    const result = hydrateSchema(emptyDir);

    expect(result.snapshot).toBe('');
    expect(result.tableNames).toEqual([]);
    expect(result.fileCount).toBe(0);
    expect(result.migrationDir).toBe('');
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('handles IF NOT EXISTS in table name extraction', () => {
  const sql = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  balance REAL DEFAULT 0
);
`;
  writeMigration(tmpDir, '001_init.sql', sql);

  const result = hydrateSchema(tmpDir);

  expect(result.tableNames).toEqual(['accounts']);
  expect(result.fileCount).toBe(1);
});

test('handles multi-line CREATE TABLE with nested parens', () => {
  const sql = `
CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  amount REAL NOT NULL CHECK(amount > 0),
  status TEXT NOT NULL CHECK(status IN ('pending','done','failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
  writeMigration(tmpDir, '001_init.sql', sql);

  const result = hydrateSchema(tmpDir);

  expect(result.tableNames).toEqual(['transactions']);
  expect(result.snapshot).toContain('CHECK(amount > 0)');
  expect(result.snapshot).toContain("CHECK(status IN ('pending','done','failed'))");
});

test('falls back to alternative migration directories', () => {
  // Use plain migrations/ dir instead of backend/src/db/migrations/
  const migDir = path.join(tmpDir, 'migrations');
  fs.mkdirSync(migDir, { recursive: true });
  fs.writeFileSync(
    path.join(migDir, '001_init.sql'),
    'CREATE TABLE items (id TEXT PRIMARY KEY);',
    'utf8'
  );

  const result = hydrateSchema(tmpDir);

  expect(result.tableNames).toEqual(['items']);
  expect(result.migrationDir).toBe(migDir);
});
