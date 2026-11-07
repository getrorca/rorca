import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts', 'rorca-managed-services.mjs');

test('render carries a verified absolute PI_BIN into managed services', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'rorca-services-pi-bin-'));
  const fakePi = path.join(home, 'trusted-pi');
  writeFileSync(fakePi, '#!/bin/sh\nexit 0\n');
  chmodSync(fakePi, 0o755);

  try {
    const result = spawnSync(process.execPath, [script, 'render', '--service', 'backend', '--root', root], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, PI_BIN: fakePi },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const label = `com.rorca.backend.${path.basename(root).toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
    const plist = readFileSync(path.join(home, 'Library', 'LaunchAgents', `${label}.plist`), 'utf8');
    assert.match(plist, /<key>PI_BIN<\/key>/);
    assert.match(plist, new RegExp(realpathSync(fakePi).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
