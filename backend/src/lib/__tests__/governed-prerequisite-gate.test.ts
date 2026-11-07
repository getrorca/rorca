/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ROR24_SOURCE_SHA,
  verifyWave2Prerequisites,
  Wave2DispatchTargetSchema,
} from '../governed-prerequisite-gate';
import { TaskManifestSourceSchema } from '../task-manifest';

const repositoryRoot = path.resolve(__dirname, '../../../..');
const evidenceRoot = path.join(repositoryRoot, 'docs/implementation/evidence/ror24-adr-0001-v1');
const envelope = JSON.parse(fs.readFileSync(path.join(evidenceRoot, 'acceptance-envelope.json'), 'utf8')) as Record<string, unknown>;
const packet = JSON.parse(fs.readFileSync(path.join(evidenceRoot, 'wave2-source-gate-packet.json'), 'utf8')) as Record<string, unknown>;
const snapshotBytes = fs.readFileSync(path.join(evidenceRoot, 'linear-acceptance-snapshot.json'));
const acceptedAdrBytes = execFileSync('git', [
  'show', `${ROR24_SOURCE_SHA}:docs/architecture/adr/0001-governed-execution-authority.md`,
], { cwd: repositoryRoot });

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function verify(overrides: Partial<Parameters<typeof verifyWave2Prerequisites>[0]> = {}) {
  return verifyWave2Prerequisites({
    acceptanceEnvelope: clone(envelope), acceptanceSnapshotBytes: Buffer.from(snapshotBytes),
    acceptedAdrBytes: Buffer.from(acceptedAdrBytes), sourceGatePacket: clone(packet),
    ...overrides,
  });
}

function expectReason(operation: () => unknown, reason: string): void {
  expect(operation).toThrow(expect.objectContaining({
    code: 'WAVE2_PREREQUISITE_BLOCKED', details: { reason, retryable: false },
  }));
}

test('accepts only the exact accepted ROR-24 and independently approved Wave 1 source packet', () => {
  expect(verify()).toEqual(expect.objectContaining({
    decision: 'accepted', gateFor: 'ROR-23', implementationAuthority: 'isolated_source_only',
    executionAuthority: 'none', mergeAuthority: 'none', deploymentAuthority: 'none',
    acceptedAdr: expect.objectContaining({ sourceSha: ROR24_SOURCE_SHA }),
    acceptedWave1: expect.objectContaining({ verdict: 'APPROVED_FOR_FINAL_WAVE1_PREFLIGHT' }),
  }));
});

test.each([
  ['pending', (candidate: any) => { candidate.decision.status = 'pending'; }, 'PENDING_ACCEPTANCE'],
  ['changed after observation', (candidate: any) => { candidate.linear.issueUpdatedAt = '2026-07-29T18:00:00.000Z'; }, 'STALE_ACCEPTANCE'],
  ['duplicate exclusions', (candidate: any) => { candidate.scope.excluded.push(candidate.scope.excluded[0]); }, 'DUPLICATE_EVIDENCE'],
  ['wrong team', (candidate: any) => { candidate.linear.teamId = '11111111-1111-4111-8111-111111111111'; }, 'WRONG_TEAM'],
  ['wrong source SHA', (candidate: any) => { candidate.artifact.sourceSha = 'f'.repeat(40); }, 'WRONG_SOURCE_SHA'],
  ['cross workspace', (candidate: any) => { candidate.linear.workspaceSlug = 'other'; }, 'CROSS_WORKSPACE'],
  ['self asserted actor', (candidate: any) => { candidate.linear.actor.authorityClass = 'agent_observation'; }, 'SELF_ASSERTED_AUTHORITY'],
] as const)('rejects %s before any mutation', (_label, mutate, reason) => {
  const candidate = clone(envelope);
  mutate(candidate);
  expectReason(() => verify({ acceptanceEnvelope: candidate }), reason);
});

test('rejects missing/unavailable, changed snapshot, changed artifact, and changed Wave 1 evidence', () => {
  expectReason(() => verify({ acceptanceEnvelope: null }), 'MISSING_EVIDENCE');
  expectReason(() => verify({ acceptanceSnapshotBytes: Buffer.concat([snapshotBytes, Buffer.from(' ')]) }), 'SNAPSHOT_HASH_MISMATCH');
  expectReason(() => verify({ acceptedAdrBytes: Buffer.concat([acceptedAdrBytes, Buffer.from(' ')]) }), 'ARTIFACT_HASH_MISMATCH');

  const changedSource = clone(packet) as any;
  changedSource.wave1.sourceSha = 'f'.repeat(40);
  expectReason(() => verify({ sourceGatePacket: changedSource }), 'WAVE1_SOURCE_MISMATCH');
  const changedReview = clone(packet) as any;
  changedReview.wave1.independentReview.sha256 = 'f'.repeat(64);
  expectReason(() => verify({ sourceGatePacket: changedReview }), 'WAVE1_REVIEW_MISMATCH');
});

test('schema and verifier structurally forbid dispatching ROR-24 and protected identities', () => {
  expect(Wave2DispatchTargetSchema.safeParse({ gateFor: 'ROR-23', issueId: 'ROR-24' }).success).toBe(false);
  expect(TaskManifestSourceSchema.safeParse({ linear: { issueKey: 'ROR-24' } }).success).toBe(false);
  expect(TaskManifestSourceSchema.safeParse({ linear: { issueId: 'ROR-24' } }).success).toBe(false);
  expect(Wave2DispatchTargetSchema.parse({ gateFor: 'ROR-23', issueId: 'ROR-23' })).toEqual({ gateFor: 'ROR-23', issueId: 'ROR-23' });
  expectReason(() => verify({ requestedIssueId: 'ROR-24' }), 'ROR24_DISPATCH_FORBIDDEN');
  expectReason(() => verify({ requestedRunId: '20260316000549' }), 'PROTECTED_IDENTITY_FORBIDDEN');
  expectReason(() => verify({ requestedRunId: 20260316000550 }), 'PROTECTED_IDENTITY_FORBIDDEN');
});
