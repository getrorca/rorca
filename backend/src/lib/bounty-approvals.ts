/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hashBountyContract } from './bounty-contracts';

export const BOUNTY_APPROVAL_VERSION = 'bounty.approval.v1' as const;
export const BOUNTY_APPROVAL_ACTIONS = [
  'program.admit', 'mission.launch', 'capability.increase',
  'finding.admit', 'hold.resolve', 'draft.release',
] as const;
export const BOUNTY_SAFE_ACTIONS = [
  'mission.stop', 'budget.reduce', 'program.reject', 'finding.reject', 'mission.quarantine',
] as const;

type ApprovalAction = typeof BOUNTY_APPROVAL_ACTIONS[number];
type ApproverRole = 'provider_owner' | 'provider_admin' | 'program_manager' | 'security_reviewer';
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const id = z.string().trim().min(1).max(128);

export const BountyApprovalTargetSchema = z.object({
  version: z.literal(BOUNTY_APPROVAL_VERSION),
  workspaceId: id,
  programId: id,
  missionId: id.nullable(),
  action: z.enum(BOUNTY_APPROVAL_ACTIONS),
  subjectHash: hash,
  policyHash: hash,
  expectedRevision: z.number().int().nonnegative(),
  requesterId: id,
  nonce: z.string().uuid(),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
export type BountyApprovalTarget = z.infer<typeof BountyApprovalTargetSchema>;

export const ProviderHumanApprovalEventSchema = z.object({
  eventId: z.string().uuid(),
  targetHash: hash,
  decision: z.literal('approve'),
  actor: z.object({ id, role: z.enum(['provider_owner', 'provider_admin', 'program_manager', 'security_reviewer']), kind: z.literal('provider_human') }).strict(),
  signedAt: z.string().datetime({ offset: true }),
  signature: z.string().min(16).max(8192),
}).strict();
export type ProviderHumanApprovalEvent = z.infer<typeof ProviderHumanApprovalEventSchema>;

export interface BountyApprovalReceipt {
  receiptId: string;
  target: BountyApprovalTarget;
  targetHash: string;
  providerEvent: ProviderHumanApprovalEvent;
  revokedAt?: string;
  consumedAt?: string;
}

export interface BountyApprovalStore {
  put(receipt: BountyApprovalReceipt): Promise<void>;
  get(receiptId: string): Promise<BountyApprovalReceipt | undefined>;
  /** Must atomically update only when neither consumedAt nor revokedAt is set. */
  consume(receiptId: string, consumedAt: string): Promise<boolean>;
  /** Must atomically update only when consumedAt is unset. */
  revoke(receiptId: string, revokedAt: string): Promise<boolean>;
}

export interface ProviderHumanVerifier {
  /** Verify the exact serialized event with the configured provider/tenant trust root. */
  verifyExact(event: ProviderHumanApprovalEvent): Promise<boolean>;
}

const POLICY: Record<ApprovalAction, { ttlMs: number; roles: readonly ApproverRole[]; distinctActor: boolean }> = {
  'program.admit': { ttlMs: 600_000, roles: ['provider_owner', 'provider_admin'], distinctActor: true },
  'mission.launch': { ttlMs: 300_000, roles: ['provider_owner', 'provider_admin', 'program_manager'], distinctActor: true },
  'capability.increase': { ttlMs: 300_000, roles: ['provider_owner', 'provider_admin'], distinctActor: true },
  'finding.admit': { ttlMs: 600_000, roles: ['provider_admin', 'security_reviewer'], distinctActor: true },
  'hold.resolve': { ttlMs: 300_000, roles: ['provider_owner', 'provider_admin', 'security_reviewer'], distinctActor: true },
  'draft.release': { ttlMs: 300_000, roles: ['provider_owner', 'provider_admin', 'program_manager'], distinctActor: true },
};

export function approvalRequired(action: string, findingAdmissionRequired = true): boolean {
  if (BOUNTY_SAFE_ACTIONS.includes(action as never)) return false;
  if (action === 'finding.admit' && !findingAdmissionRequired) return false;
  return BOUNTY_APPROVAL_ACTIONS.includes(action as ApprovalAction);
}

export function previewBountyApproval(input: Omit<BountyApprovalTarget, 'version' | 'nonce' | 'issuedAt' | 'expiresAt'>, now = new Date()): BountyApprovalTarget {
  const policy = POLICY[input.action];
  return BountyApprovalTargetSchema.parse({
    ...input,
    version: BOUNTY_APPROVAL_VERSION,
    nonce: randomUUID(),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + policy.ttlMs).toISOString(),
  });
}

export function bountyApprovalTargetHash(target: BountyApprovalTarget): string {
  return hashBountyContract('approval-target', BountyApprovalTargetSchema.parse(target));
}

/** Hermes/service callers may relay this exact event; authority always remains the signed provider-human actor. */
export async function issueBountyApproval(input: {
  target: BountyApprovalTarget;
  event: ProviderHumanApprovalEvent;
  verifier: ProviderHumanVerifier;
  store: BountyApprovalStore;
  now?: Date;
}): Promise<BountyApprovalReceipt> {
  const now = input.now ?? new Date();
  const target = BountyApprovalTargetSchema.parse(input.target);
  const event = ProviderHumanApprovalEventSchema.parse(input.event);
  const policy = POLICY[target.action];
  if (Date.parse(target.expiresAt) <= now.getTime() || Date.parse(event.signedAt) > now.getTime()) throw new Error('approval target or event is not temporally valid');
  if (event.targetHash !== bountyApprovalTargetHash(target)) throw new Error('provider-human event targets different authority');
  if (!policy.roles.includes(event.actor.role) || (policy.distinctActor && event.actor.id === target.requesterId)) throw new Error('provider-human actor is not authorized or distinct');
  if (!await input.verifier.verifyExact(event)) throw new Error('provider-human signature is invalid');
  const receipt = { receiptId: randomUUID(), target, targetHash: event.targetHash, providerEvent: event };
  await input.store.put(receipt);
  return receipt;
}

export async function consumeBountyApproval(input: {
  receiptId: string;
  expectedTarget: BountyApprovalTarget;
  store: BountyApprovalStore;
  now?: Date;
}): Promise<BountyApprovalReceipt> {
  const now = input.now ?? new Date();
  const receipt = await input.store.get(input.receiptId);
  if (!receipt || receipt.revokedAt || receipt.consumedAt) throw new Error('approval receipt is unavailable, revoked, or consumed');
  const expectedHash = bountyApprovalTargetHash(input.expectedTarget);
  if (receipt.targetHash !== expectedHash || Date.parse(receipt.target.expiresAt) <= now.getTime()) throw new Error('approval receipt is expired or targets different authority');
  if (!await input.store.consume(receipt.receiptId, now.toISOString())) throw new Error('approval receipt was concurrently consumed or revoked');
  return { ...receipt, consumedAt: now.toISOString() };
}

export async function revokeBountyApproval(receiptId: string, store: BountyApprovalStore, now = new Date()): Promise<void> {
  if (!await store.revoke(receiptId, now.toISOString())) throw new Error('approval receipt is unknown, consumed, or already revoked');
}
