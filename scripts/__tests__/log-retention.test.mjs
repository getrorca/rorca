// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { rotateLogFile } from '../lib/log-retention.mjs';

const NOW = new Date('2026-07-14T12:00:00.000Z');
const POLICY = { maxBytes: 8, maxArchives: 2, maxAgeMs: 24 * 60 * 60 * 1000 };

async function fixture() {
  return mkdtemp(path.join(os.tmpdir(), 'rorca-log-retention-'));
}

test('rotates an oversized regular log and remains idempotent below the bound', async () => {
  const directory = await fixture();
  const source = path.join(directory, 'backend.stdout.log');
  await writeFile(source, '0123456789ABCDEF', { mode: 0o600 });

  const first = await rotateLogFile(source, { policy: POLICY, now: NOW });
  assert.equal(first.status, 'rotated');
  assert.equal(await readFile(first.archive, 'utf8'), '01234567');
  assert.equal(await readFile(source, 'utf8'), '89ABCDEF');

  const second = await rotateLogFile(source, { policy: POLICY, now: NOW });
  assert.equal(second.status, 'within_limit');
  const archives = (await readdir(directory)).filter((name) => name.startsWith('backend.stdout.log.20'));
  assert.equal(archives.length, 1);
});

test('recovers after an archived-before-compact crash and preserves later writes', async () => {
  const directory = await fixture();
  const source = path.join(directory, 'worker.stderr.log');
  await writeFile(source, 'captured-content', { mode: 0o600 });

  await assert.rejects(
    rotateLogFile(source, {
      policy: POLICY,
      now: NOW,
      fault(stage) {
        assert.equal(stage, 'after_archive');
        throw new Error('simulated crash');
      },
    }),
    /simulated crash/,
  );
  await writeFile(source, 'captured-contenttail', { mode: 0o600 });

  const recovered = await rotateLogFile(source, { policy: POLICY, now: NOW });
  assert.equal(recovered.recovery?.recovered, true);
  assert.equal(recovered.recovery?.reason, 'completed_archived_rotation');
  assert.equal(await readFile(source, 'utf8'), 'tail');
  assert.equal(await readFile(recovered.recovery ? path.join(directory, 'worker.stderr.log.20260714T120000Z') : '', 'utf8'), 'captured');
});

test('prunes archives by count and age even when the active file is small', async () => {
  const directory = await fixture();
  const source = path.join(directory, 'service.log');
  await writeFile(source, 'ok');
  const archiveNames = [
    'service.log.20260714T110000Z',
    'service.log.20260714T100000Z',
    'service.log.20260712T100000Z',
  ];
  for (let index = 0; index < archiveNames.length; index += 1) {
    const archive = path.join(directory, archiveNames[index]);
    await writeFile(archive, String(index));
    const ageHours = index === 2 ? 48 : index + 1;
    const date = new Date(NOW.getTime() - ageHours * 60 * 60 * 1000);
    await utimes(archive, date, date);
  }

  const result = await rotateLogFile(source, { policy: POLICY, now: NOW });
  assert.equal(result.status, 'within_limit');
  assert.equal(result.retention.removed, 1);
  const remaining = (await readdir(directory)).filter((name) => name.startsWith('service.log.20'));
  assert.deepEqual(remaining.sort(), archiveNames.slice(0, 2).sort());
});

test('refuses symlinks instead of rotating a path outside the managed root', async () => {
  const directory = await fixture();
  const target = path.join(directory, 'target.log');
  const source = path.join(directory, 'backend.stdout.log');
  await writeFile(target, '0123456789ABCDEF');
  await symlink(target, source);

  const result = await rotateLogFile(source, { policy: POLICY, now: NOW });
  assert.deepEqual({ status: result.status, reason: result.reason }, {
    status: 'blocked',
    reason: 'not_regular_file',
  });
  assert.equal(await readFile(target, 'utf8'), '0123456789ABCDEF');
});
