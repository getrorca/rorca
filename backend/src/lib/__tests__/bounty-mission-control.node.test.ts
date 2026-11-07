/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  resolveBountyCrashCut,
  terminateProcessGroups,
  type CrashCutBoundary,
} from '../bounty-mission-control';

const root = process.cwd().endsWith(`${path.sep}backend`) ? process.cwd() : path.join(process.cwd(), 'backend');
const source = fs.readFileSync(path.join(root, 'src/lib/bounty-mission-control.ts'), 'utf8');
const ledger = fs.readFileSync(path.join(root, 'src/lib/bounty-operation-ledger.ts'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'src/db/pg-migrations/20260803160000_bounty_mission_control.sql'), 'utf8');
const route = fs.readFileSync(path.join(root, 'src/routes/bounty-mission-control.ts'), 'utf8');
const server = fs.readFileSync(path.join(root, 'src/server.ts'), 'utf8');

test('pause, stop, kill and effect send share the mission row linearization fence', () => {
  assert.match(source, /SELECT state,epoch FROM bounty_missions[^`]+FOR UPDATE/s);
  assert.match(ledger, /FOR UPDATE OF m,o/);
  assert.match(ledger, /UPDATE bounty_operations SET state='sent' WHERE id=\$1 AND state='prepared'/);
  assert.match(source, /state='cancelled-before-send'/);
  assert.match(source, /state IN \('sent','unknown'\)/);
  assert.doesNotMatch(source, /state='prepared'.*(?:retry|pending)/i);
});

test('all required crash cuts have deterministic restart dispositions', () => {
  const boundaries: CrashCutBoundary[] = ['command', 'outbox', 'queue', 'lease', 'prepare', 'send', 'observation', 'evidence', 'completion'];
  for (const boundary of boundaries) {
    const resolution = resolveBountyCrashCut(boundary, true);
    assert.notEqual(resolution, 'resume', boundary);
    assert.ok(migration.includes(`'${boundary}'`), boundary);
  }
  assert.equal(resolveBountyCrashCut('prepare', true), 'cancel-prepared');
  assert.equal(resolveBountyCrashCut('send', true), 'hold-uncertain');
  assert.equal(resolveBountyCrashCut('observation', false), 'hold-uncertain');
  assert.equal(resolveBountyCrashCut('evidence', true), 'quarantine');
  assert.equal(resolveBountyCrashCut('completion', false), 'complete-once');
});

test('kill terminates whole process groups after bounded grace and skips exited groups', async () => {
  const calls: Array<[number, NodeJS.Signals | 0]> = [];
  let slept = 0;
  await terminateProcessGroups([401, 402, 401, 1, -2], 250, {
    signalProcessGroup: (group, signal) => {
      calls.push([group, signal]);
      if (group === 402 && signal === 0) throw new Error('exited');
    },
    sleep: async (milliseconds) => { slept += milliseconds; },
  });
  assert.equal(slept, 250);
  assert.deepEqual(calls, [
    [401, 'SIGTERM'], [402, 'SIGTERM'],
    [401, 0], [401, 'SIGKILL'], [402, 0],
  ]);
});

test('restart reconciliation never republishes or retries uncertain old-epoch effects', () => {
  assert.match(source, /cancelled_at=now\(\),cancellation_reason='restart stale epoch'/);
  assert.match(source, /holdUncertainEffects/);
  assert.match(source, /authority_epoch<>\$3/);
  assert.doesNotMatch(source, /state IN \('sent','unknown'\)[\s\S]{0,200}UPDATE bounty_operations SET state='prepared'/);
  assert.match(migration, /UNIQUE \(workspace_id, mission_id, source, source_identity\)/);
  assert.match(migration, /UNIQUE \(workspace_id, mission_id, boundary, boundary_identity\)/);
  assert.match(source, /boundary='completion'/);
  assert.match(source, /source,source_identity,presented_epoch,current_epoch/);
  assert.match(source, /UPDATE bounty_attempts SET status='succeeded'/);
  assert.match(server, /reconcileAllBountyMissionsOnRestart\(\)/);
});

test('credential-authenticated operators have a non-MCP lifecycle control endpoint', () => {
  assert.match(route, /z\.enum\(\['pause', 'resume', 'stop', 'kill'\]\)/);
  assert.match(route, /x-rorca-tier: admin/);
  assert.match(route, /x-rorca-mcp: false/);
  assert.match(route, /revokeCredentials/);
  assert.match(route, /revokeCallbacks/);
  assert.match(server, /\/api\/admin\/bounty\/missions/);
});
