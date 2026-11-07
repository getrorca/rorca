/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'crypto';
import * as fs from 'fs';
import type { Server } from 'http';
import * as os from 'os';
import * as path from 'path';
import { once } from 'events';
import type { Express } from 'express';
import request from 'supertest';
import { execute } from '../../db/index';
import { getAuthToken } from './helpers/auth-helper';

jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

const adminEmail = `backup-admin-${crypto.randomUUID()}@test.rorca.local`;
const userEmail = `backup-user-${crypto.randomUUID()}@test.rorca.local`;
let server: Server;
let tmpDir: string;
let backupDir: string;
let fakePgDumpArgsFile: string;
let adminToken: string;
let userToken: string;
let previousAuthRequired: string | undefined;
let previousBackupDir: string | undefined;
let previousPgDumpBin: string | undefined;
let previousArgsFile: string | undefined;
let previousGate: string | undefined;


function api() {
  return request(server);
}

beforeAll(async () => {
  previousAuthRequired = process.env.AUTH_REQUIRED;
  previousBackupDir = process.env.BACKUP_DIR;
  previousPgDumpBin = process.env.PG_DUMP_BIN;
  previousArgsFile = process.env.FAKE_PG_DUMP_ARGS_FILE;
  previousGate = process.env.FAKE_PG_DUMP_GATE;


  process.env.NODE_ENV = 'test';
  process.env.AUTH_REQUIRED = 'true';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-backup-test-'));
  backupDir = path.join(tmpDir, 'backups');
  fakePgDumpArgsFile = path.join(tmpDir, 'pg-dump-args.json');
  const fakePgDump = path.join(tmpDir, 'fake-pg-dump.cjs');
  fs.writeFileSync(fakePgDump, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--file');
if (outputIndex < 0 || !args[outputIndex + 1]) process.exit(2);
const path = require('path');
const writeBackup = () => {
  fs.writeFileSync(process.env.FAKE_PG_DUMP_ARGS_FILE, JSON.stringify({
    args,
    connection: {
      host: process.env.PGHOST,
      port: process.env.PGPORT,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
    },
  }));
  fs.writeFileSync(args[outputIndex + 1], 'fake-custom-format-backup');
};
const gate = process.env.FAKE_PG_DUMP_GATE;
if (gate) {
  const watcher = fs.watch(path.dirname(gate), (_event, filename) => {
    if (String(filename) === path.basename(gate) && fs.existsSync(gate)) {
      watcher.close();
      writeBackup();
    }
  });
  fs.writeFileSync(gate + '.started', 'ready');
} else {
  writeBackup();
}

`);
  fs.chmodSync(fakePgDump, 0o700);
  process.env.BACKUP_DIR = backupDir;
  process.env.PG_DUMP_BIN = fakePgDump;
  process.env.FAKE_PG_DUMP_ARGS_FILE = fakePgDumpArgsFile;

  const serverModule = require('../../server');
  const app = serverModule.default as Express;
  adminToken = await getAuthToken(app, {
    email: adminEmail,
    authId: crypto.randomUUID(),
    role: 'admin',
  });
  userToken = await getAuthToken(app, {
    email: userEmail,
    authId: crypto.randomUUID(),
    role: 'user',
  });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
});

beforeEach(() => {
  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.rmSync(fakePgDumpArgsFile, { force: true });
  delete process.env.FAKE_PG_DUMP_GATE;

});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await execute('DELETE FROM users WHERE email = ANY($1::text[])', [[adminEmail, userEmail]]);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (previousAuthRequired === undefined) delete process.env.AUTH_REQUIRED;
  else process.env.AUTH_REQUIRED = previousAuthRequired;
  if (previousBackupDir === undefined) delete process.env.BACKUP_DIR;
  else process.env.BACKUP_DIR = previousBackupDir;
  if (previousPgDumpBin === undefined) delete process.env.PG_DUMP_BIN;
  else process.env.PG_DUMP_BIN = previousPgDumpBin;
  if (previousArgsFile === undefined) delete process.env.FAKE_PG_DUMP_ARGS_FILE;
  else process.env.FAKE_PG_DUMP_ARGS_FILE = previousArgsFile;
  if (previousGate === undefined) delete process.env.FAKE_PG_DUMP_GATE;
  else process.env.FAKE_PG_DUMP_GATE = previousGate;

});

describe('POST /api/admin/backup', () => {
  it('creates a PostgreSQL custom-format backup without placing the database URL in argv', async () => {
    const res = await api()
      .post('/api/admin/backup')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(201);
    expect(res.body.backup.filename).toMatch(/^rorca-backup-.*\.sql$/);
    expect(res.body.backup.size).toBeGreaterThan(0);
    expect(res.body.pruned).toBe(0);
    expect(fs.readdirSync(backupDir)).toEqual([res.body.backup.filename]);

    const invocation = JSON.parse(fs.readFileSync(fakePgDumpArgsFile, 'utf8')) as {
      args: string[];
      connection: { host: string; port: string; user: string; password: string; database: string };
    };
    expect(invocation.args).toEqual(['--format=custom', '--file', path.join(backupDir, res.body.backup.filename)]);
    expect(invocation.args.some(arg => /^postgres(?:ql)?:\/\//.test(arg))).toBe(false);
    const databaseUrl = new URL(process.env.DATABASE_URL!);
    expect(invocation.connection).toEqual({
      host: databaseUrl.hostname,
      port: databaseUrl.port || '5432',
      user: decodeURIComponent(databaseUrl.username),
      password: decodeURIComponent(databaseUrl.password),
      database: decodeURIComponent(databaseUrl.pathname.replace(/^\//, '')),
    });
  });

  it('coalesces concurrent backup requests into one pg_dump process', async () => {
    const gatePath = path.join(tmpDir, 'backup-gate');
    const startedPath = `${gatePath}.started`;
    process.env.FAKE_PG_DUMP_GATE = gatePath;
    const watcher = fs.watch(tmpDir);
    const started = new Promise<void>((resolve, reject) => {
      const onChange = (_event: string, filename: string | Buffer | null) => {
        if (String(filename) !== path.basename(startedPath) || !fs.existsSync(startedPath)) return;
        watcher.off('change', onChange);
        resolve();
      };
      watcher.on('change', onChange);
      watcher.once('error', reject);
    });

    const first = api().post('/api/admin/backup').set('Authorization', `Bearer ${adminToken}`).then((response) => response);
    await started;
    const second = api().post('/api/admin/backup').set('Authorization', `Bearer ${adminToken}`).then((response) => response);
    fs.writeFileSync(gatePath, 'release');
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    watcher.close();

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    expect(secondResponse.body.backup.filename).toBe(firstResponse.body.backup.filename);
    expect(fs.readdirSync(backupDir)).toEqual([firstResponse.body.backup.filename]);
  });

  it('creates multiple backups with unique names', async () => {
    expect((await api().post('/api/admin/backup').set('Authorization', `Bearer ${adminToken}`)).status).toBe(201);
    expect((await api().post('/api/admin/backup').set('Authorization', `Bearer ${adminToken}`)).status).toBe(201);

    expect(fs.readdirSync(backupDir)).toHaveLength(2);
  });
});

describe('GET /api/admin/backups', () => {
  it('returns an empty inventory when no backups exist', async () => {
    const res = await api().get('/api/admin/backups').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.backups).toEqual([]);
  });

  it('lists backups newest first with portable modification timestamps', async () => {
    await api().post('/api/admin/backup').set('Authorization', `Bearer ${adminToken}`);
    await new Promise(resolve => setTimeout(resolve, 10));
    await api().post('/api/admin/backup').set('Authorization', `Bearer ${adminToken}`);

    const res = await api().get('/api/admin/backups').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.backups).toHaveLength(2);
    expect(res.body.backups[0].filename).toMatch(/^rorca-backup-.*\.sql$/);
    expect(res.body.backups[0].size).toBeGreaterThan(0);
    expect(Date.parse(res.body.backups[0].createdAt)).not.toBeNaN();
    expect(res.body.backups[0].createdAt >= res.body.backups[1].createdAt).toBe(true);
  });
});

describe('backup retention', () => {
  it('prunes backups whose portable modification time is older than 30 days', async () => {
    fs.mkdirSync(backupDir, { recursive: true });
    const oldFile = path.join(backupDir, 'rorca-backup-old.sql');
    fs.writeFileSync(oldFile, 'old-backup');
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, oldDate, oldDate);

    const res = await api().post('/api/admin/backup').set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(201);
    expect(res.body.pruned).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.readdirSync(backupDir)).toEqual([res.body.backup.filename]);
  });
});

describe('admin authority', () => {
  it('rejects unauthenticated backup reads and writes', async () => {
    expect((await api().post('/api/admin/backup')).status).toBe(401);
    expect((await api().get('/api/admin/backups')).status).toBe(401);
  });

  it('rejects authenticated non-admin backup reads and writes before any file effect', async () => {
    expect((await api().post('/api/admin/backup').set('Authorization', `Bearer ${userToken}`)).status).toBe(403);
    expect((await api().get('/api/admin/backups').set('Authorization', `Bearer ${userToken}`)).status).toBe(403);
    expect(fs.existsSync(backupDir)).toBe(false);
  });
});
