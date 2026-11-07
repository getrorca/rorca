/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  approvalRequired, bountyApprovalTargetHash, consumeBountyApproval,
  issueBountyApproval, previewBountyApproval, revokeBountyApproval,
  type BountyApprovalReceipt, type BountyApprovalStore,
} from '../bounty-approvals';

const H = `sha256:${'a'.repeat(64)}`;
class Store implements BountyApprovalStore {
  rows = new Map<string, BountyApprovalReceipt>();
  async put(row: BountyApprovalReceipt) { this.rows.set(row.receiptId, row); }
  async get(id: string) { return this.rows.get(id); }
  async consume(id: string, at: string) { const row = this.rows.get(id); if (!row || row.consumedAt || row.revokedAt) return false; row.consumedAt = at; return true; }
  async revoke(id: string, at: string) { const row = this.rows.get(id); if (!row || row.consumedAt || row.revokedAt) return false; row.revokedAt = at; return true; }
}
const now = new Date('2026-08-01T00:00:00.000Z');
const target = () => previewBountyApproval({ workspaceId: 'ws-1', programId: 'p-1', missionId: 'm-1', action: 'mission.launch', subjectHash: H, policyHash: H, expectedRevision: 2, requesterId: 'requester' }, now);
const event = (targetHash: string, actorId = 'approver') => ({ eventId: '00000000-0000-4000-8000-000000000001', targetHash, decision: 'approve' as const, actor: { id: actorId, role: 'provider_admin' as const, kind: 'provider_human' as const }, signedAt: now.toISOString(), signature: 'provider-signature' });
const verifier = { verifyExact: async () => true };

async function issued(store = new Store()) {
  const approvalTarget = target();
  const receipt = await issueBountyApproval({ target: approvalTarget, event: event(bountyApprovalTargetHash(approvalTarget)), verifier, store, now });
  return { store, approvalTarget, receipt };
}

test('exact target consumes once and changed/cross-workspace targets reject', async () => {
  const first = await issued();
  await assert.rejects(consumeBountyApproval({ receiptId: first.receipt.receiptId, expectedTarget: { ...first.approvalTarget, expectedRevision: 3 }, store: first.store, now }));
  await assert.rejects(consumeBountyApproval({ receiptId: first.receipt.receiptId, expectedTarget: { ...first.approvalTarget, workspaceId: 'ws-2' }, store: first.store, now }));
  await consumeBountyApproval({ receiptId: first.receipt.receiptId, expectedTarget: first.approvalTarget, store: first.store, now });
  await assert.rejects(consumeBountyApproval({ receiptId: first.receipt.receiptId, expectedTarget: first.approvalTarget, store: first.store, now }));
});

test('expiry and revocation deny consumption', async () => {
  const expired = await issued();
  await assert.rejects(consumeBountyApproval({ receiptId: expired.receipt.receiptId, expectedTarget: expired.approvalTarget, store: expired.store, now: new Date('2026-08-01T00:06:00Z') }));
  const revoked = await issued();
  await revokeBountyApproval(revoked.receipt.receiptId, revoked.store, now);
  await assert.rejects(consumeBountyApproval({ receiptId: revoked.receipt.receiptId, expectedTarget: revoked.approvalTarget, store: revoked.store, now }));
});

test('relay requires exact signed provider-human event and distinct authorized actor', async () => {
  const approvalTarget = target();
  const store = new Store();
  await assert.rejects(issueBountyApproval({ target: approvalTarget, event: event(H), verifier, store, now }));
  await assert.rejects(issueBountyApproval({ target: approvalTarget, event: event(bountyApprovalTargetHash(approvalTarget), 'requester'), verifier, store, now }));
  await assert.rejects(issueBountyApproval({ target: approvalTarget, event: event(bountyApprovalTargetHash(approvalTarget)), verifier: { verifyExact: async () => false }, store, now }));
});

test('safe reducing and denial actions never require approval', () => {
  for (const action of ['mission.stop', 'budget.reduce', 'program.reject', 'finding.reject', 'mission.quarantine']) assert.equal(approvalRequired(action), false);
  assert.equal(approvalRequired('finding.admit', false), false);
  assert.equal(approvalRequired('mission.launch'), true);
});
