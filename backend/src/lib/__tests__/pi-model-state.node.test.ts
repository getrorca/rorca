/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { copyPiModelState } from '../pi-model-state';

test('watchdog retry atomically refreshes isolated Pi auth from the host snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-auth-refresh-'));
  const sourceAgent = path.join(root, 'host-agent');
  const isolatedAgent = path.join(root, 'isolated-agent');
  fs.mkdirSync(sourceAgent);
  fs.mkdirSync(isolatedAgent);
  try {
    fs.writeFileSync(path.join(sourceAgent, 'auth.json'), '{"token":"attempt-1"}\n', { mode: 0o600 });
    fs.writeFileSync(path.join(sourceAgent, 'models.json'), '{"version":1}\n', { mode: 0o600 });
    copyPiModelState(sourceAgent, isolatedAgent);
    assert.match(fs.readFileSync(path.join(isolatedAgent, 'auth.json'), 'utf8'), /attempt-1/);

    fs.writeFileSync(path.join(sourceAgent, 'auth.json'), '{"token":"attempt-2"}\n', { mode: 0o600 });
    fs.writeFileSync(path.join(sourceAgent, 'models.json'), '{"version":2}\n', { mode: 0o600 });
    copyPiModelState(sourceAgent, isolatedAgent);

    assert.match(fs.readFileSync(path.join(isolatedAgent, 'auth.json'), 'utf8'), /attempt-2/);
    assert.equal(fs.statSync(path.join(isolatedAgent, 'auth.json')).mode & 0o077, 0);
    assert.match(fs.readFileSync(path.join(isolatedAgent, 'models.json'), 'utf8'), /"version":1/);
    assert.deepEqual(fs.readdirSync(isolatedAgent).filter(name => name.endsWith('.tmp')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('auth refresh rejects a substituted isolated credential symlink', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-auth-symlink-'));
  const sourceAgent = path.join(root, 'host-agent');
  const isolatedAgent = path.join(root, 'isolated-agent');
  fs.mkdirSync(sourceAgent);
  fs.mkdirSync(isolatedAgent);
  fs.writeFileSync(path.join(sourceAgent, 'auth.json'), '{"token":"fresh"}\n');
  fs.symlinkSync(path.join(sourceAgent, 'auth.json'), path.join(isolatedAgent, 'auth.json'));
  try {
    assert.throws(() => copyPiModelState(sourceAgent, isolatedAgent), /regular non-symbolic file/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
