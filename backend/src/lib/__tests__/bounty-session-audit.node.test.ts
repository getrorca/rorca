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
  isLegalBountyActivityTransition,
  rankBountyAlerts,
  redactBountyPayload,
  type BountyActivityChannel,
  type BountyAlertProjection,
} from '../bounty-session-audit';

const root = process.cwd().endsWith(`${path.sep}backend`) ? process.cwd() : path.join(process.cwd(), 'backend');
const source = fs.readFileSync(path.join(root, 'src/lib/bounty-session-audit.ts'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'src/db/pg-migrations/20260803170000_bounty_auditable_sessions.sql'), 'utf8');
const route = fs.readFileSync(path.join(root, 'src/routes/bounty-sessions.ts'), 'utf8');
const server = fs.readFileSync(path.join(root, 'src/server.ts'), 'utf8');

test('redaction removes nested credential keys and inline secret forms deterministically', () => {
  const payload = {
    authorization: 'Bearer should-never-survive',
    nested: {
      password: 'hunter2',
      command: 'curl -H "Authorization: Bearer abc.def.ghi" https://target.test/?access_token=raw-secret',
      safe: 'finding title',
    },
    values: ['github_pat_abcdefghijklmnopqrstuvwxyz', 'AKIAIOSFODNN7EXAMPLE'],
  };
  const first = redactBountyPayload(payload);
  const second = redactBountyPayload(payload);
  assert.deepEqual(first, second);
  const encoded = JSON.stringify(first);
  for (const secret of ['should-never-survive', 'hunter2', 'abc.def.ghi', 'raw-secret', 'github_pat_', 'AKIAIOSFODNN7EXAMPLE']) assert.doesNotMatch(encoded, new RegExp(secret));
  assert.match(encoded, /finding title/);
  assert.match(encoded, /\[REDACTED\]/);
});

test('five stable artifact channels expose only their explicit legal lifecycle edges', () => {
  const starts: Array<[BountyActivityChannel, string]> = [
    ['note','active'], ['lead','candidate'], ['primitive','candidate'], ['finding','draft'], ['draft','drafting'],
  ];
  for (const [channel, state] of starts) assert.equal(isLegalBountyActivityTransition(channel, null, state), true, channel);
  assert.equal(isLegalBountyActivityTransition('lead', 'candidate', 'investigating'), true);
  assert.equal(isLegalBountyActivityTransition('finding', 'validating', 'false-positive'), true);
  assert.equal(isLegalBountyActivityTransition('finding', 'validating', 'oracle'), true);
  assert.equal(isLegalBountyActivityTransition('draft', 'approved', 'submitted'), true);
  assert.equal(isLegalBountyActivityTransition('lead', 'candidate', 'promoted'), false);
  assert.equal(isLegalBountyActivityTransition('finding', 'draft', 'reported'), false);
  assert.equal(isLegalBountyActivityTransition('draft', 'rejected', 'submitted'), false);
  assert.match(migration, /artifact_id UUID NOT NULL/);
  assert.match(migration, /bounty_activity_projection_legal_transition/);
});

test('resumable cursor contract is exclusive, ascending, immutable, and projection-separated', () => {
  assert.match(source, /cursor>\$3[\s\S]+ORDER BY cursor ASC LIMIT \$4/);
  assert.match(source, /nextCursor: events\.at\(-1\)\?\.cursor \?\? afterCursor/);
  assert.match(migration, /UNIQUE \(workspace_id, mission_id, cursor\)/);
  assert.match(migration, /bounty_authoritative_events_immutable/);
  assert.match(migration, /CREATE TABLE bounty_authoritative_session_events/);
  assert.match(migration, /CREATE TABLE bounty_activity_projections/);
  assert.match(migration, /REFERENCES bounty_authoritative_session_events\(workspace_id, mission_id, cursor\)/);
  assert.doesNotMatch(migration.match(/CREATE TABLE bounty_authoritative_session_events[\s\S]*?\);/)![0], /current_state|triage_state/);
});

test('nudges bind every required identity and have no authority-widening envelope', () => {
  const table = migration.match(/CREATE TABLE bounty_checkpoint_nudges[\s\S]*?\n\);/)![0];
  for (const field of ['operator_id','mission_id','mission_epoch','worker_id','checkpoint_id','text_hash','expires_at']) assert.match(table, new RegExp(field));
  for (const forbidden of ['scope','capability','budget','credential','tool']) assert.doesNotMatch(table, new RegExp(`\\b${forbidden}\\b`));
  assert.match(source, /row\.state !== 'active' \|\| Number\(row\.epoch\) !== input\.missionEpoch/);
  assert.match(source, /process_mission !== input\.missionId/);
  assert.match(source, /checkpoint_mission !== input\.missionId/);
  assert.match(migration, /bounty_checkpoint_nudges_immutable/);
  assert.match(route, /NudgeSchema = z\.object\([\s\S]+?\)\.strict\(\)/);
});

test('telemetry makes every required dimension and exceptional metric first-class', () => {
  for (const dimension of ['mission_id','worker_id','phase','activity','skill','model']) assert.match(migration, new RegExp(dimension));
  for (const metric of ['input_tokens','output_tokens','reasoning_tokens','context_tokens','cache_hits','cache_hit_tokens','tool_calls','effect_calls','requests','callbacks','wall_time_ms','cost_microusd','auth_loop_requests','auth_loop_cost_microusd','false_positive_outcomes','oracle_outcomes','high_confidence_alerts']) assert.match(migration, new RegExp(metric));
  assert.match(source, /GROUP BY worker_id,phase,activity,skill,model/);
  assert.match(migration, /bounty_activity_telemetry_immutable/);
});

test('50 alerts/day remain redacted and deterministically useful for triage', () => {
  const alerts: BountyAlertProjection[] = Array.from({ length: 50 }, (_, index) => ({
    alertId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    sourceCursor: index + 1,
    confidence: ((index * 37) % 100) / 100,
    severity: (['low','medium','high','critical'] as const)[index % 4]!,
    triageState: 'new',
    summary: JSON.stringify(redactBountyPayload({ summary: `alert ${index}`, apiKey: `secret-${index}` })),
  }));
  const ranked = rankBountyAlerts(alerts);
  assert.equal(ranked.length, 50);
  assert.equal(new Set(ranked.map((alert) => alert.alertId)).size, 50);
  assert.equal(new Set(ranked.map((alert) => alert.sourceCursor)).size, 50);
  assert.ok(ranked.every((alert, index) => index === 0 || ranked[index - 1]!.confidence >= alert.confidence));
  assert.ok(ranked.every((alert) => !alert.summary.includes('secret-') && alert.summary.includes('[REDACTED]')));
  assert.match(migration, /bounty_alert_triage_queue_idx/);
  assert.match(source, /confidence[\s\S]+severityRank[\s\S]+sourceCursor[\s\S]+alertId/);
});

test('operator APIs are admin-only, non-MCP, and mounted for Hermes/operator consumers', () => {
  assert.match(route, /req\.authSource !== 'bearer'/);
  assert.equal((route.match(/x-rorca-tier: admin/g) ?? []).length, 9);
  assert.equal((route.match(/x-rorca-mcp: false/g) ?? []).length, 9);
  assert.match(server, /\/api\/admin\/bounty\/sessions', bountySessionsRouter/);
});
