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

const root = path.join(process.cwd(), 'src');
const lane = fs.readFileSync(path.join(root, 'lib/bounty-isolated-worker-lane.ts'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'lib/bounty-isolated-runtime.ts'), 'utf8');
const controller = fs.readFileSync(path.join(root, 'lib/bounty-controller.ts'), 'utf8');
const ordinaryWorker = fs.readFileSync(path.join(root, 'worker.ts'), 'utf8');
const queues = fs.readFileSync(path.join(root, 'lib/pg-boss.ts'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'db/pg-migrations/20260803130000_bounty_isolated_worker_runtime.sql'), 'utf8');

test('proposal jobs use a separate fixed queue and always create a fresh bwrap launch', () => {
  assert.ok(lane.indexOf("createQueue(BOUNTY_ISOLATED_PROPOSAL_QUEUE)") < lane.indexOf("boss.work<unknown>(BOUNTY_ISOLATED_PROPOSAL_QUEUE"));
  assert.match(lane, /batchSize: 1/);
  assert.match(lane, /const proposal = await launch\(/);
  assert.match(lane, /await options\.persistProposal\(job, proposal\)/);
  assert.match(queues, /createQueue\('bounty:isolated-proposal'\)/);
  assert.doesNotMatch(ordinaryWorker, /bounty-isolated|isolated-proposal|registerIsolatedBountyProposalLane/);
});

test('worker runtime has no ambient host integration or ordinary coding surfaces', () => {
  assert.match(runtime, /env: \{\}/);
  assert.match(runtime, /'--unshare-net'/);
  assert.match(runtime, /'--ro-bind-data'/);
  assert.doesNotMatch(runtime, /DATABASE_URL|apiFetch|MCP|CDP|playwright|chrome|git\s|CLAUDE|OPENAI_API_KEY|ANTHROPIC_API_KEY/);
  assert.doesNotMatch(runtime, /shell:\s*true|stdio:\s*'inherit'/);
});

test('database stores immutable assignments and proposal-only output without authority admission', () => {
  for (const fragment of [
    'CREATE TABLE bounty_worker_runtime_assignments', 'CREATE TABLE bounty_worker_proposals',
    "disposition = 'proposal-only'", "authority_effect = 'none'", 'evidence_admission = FALSE',
    'finding_admission = FALSE', 'bounty_worker_runtime_assignments_immutable', 'bounty_worker_proposals_immutable',
    "'bounty:isolated-proposal'",
  ]) assert.ok(migration.includes(fragment), fragment);
  assert.doesNotMatch(migration, /CREATE\s+(?:UNLOGGED\s+)?TABLE\s+pgboss/i);
  assert.match(controller, /persistBountyWorkerProposal/);
  const proposalStart = controller.indexOf('export async function persistBountyWorkerProposal');
  const proposalEnd = controller.indexOf('// ─── Bounded REST Controller facade', proposalStart);
  const proposalPersistence = controller.slice(proposalStart, proposalEnd);
  assert.match(proposalPersistence, /INSERT INTO bounty_worker_proposals/);
  assert.doesNotMatch(proposalPersistence, /(?:INSERT INTO|UPDATE|DELETE FROM) bounty_(?:missions|findings|evidence|approvals|attempts|work_packages)/i);
});
