/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { queryOne } from '../db/index';
import { ConflictError, ForbiddenError, ValidationError } from './errors';
import { retryHash } from './retry-governance';
import { stableWalJson } from './trusted-wal';

export const PROVIDER_HUMAN_EVENT_VERSION = 'provider-human-event.v1' as const;
export type ProviderHumanPurpose =
  | 'authoring_plan_confirmation'
  | 'spec_set_approval'
  | 'retry_approval'
  | 'lifecycle_decision'
  | 'task_manifest_dispatch'
  | 'run_closeout_reconciliation';

export const ProviderHumanEventSchema = z.object({
  schemaVersion: z.literal(PROVIDER_HUMAN_EVENT_VERSION),
  issuerId: z.string().trim().min(1).max(128),
  keyId: z.string().trim().min(1).max(128),
  provider: z.string().trim().min(1).max(64),
  providerTenantId: z.string().trim().min(1).max(256),
  actorId: z.string().trim().min(1).max(256),
  conversationId: z.string().trim().min(1).max(512),
  threadId: z.string().trim().min(1).max(512),
  messageId: z.string().trim().min(1).max(512),
  occurredAt: z.string().datetime(),
  normalizedCommandHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  ingressIdempotencyKey: z.string().trim().min(8).max(512),
  signature: z.string().trim().min(40).max(1024),
}).strict();

export type ProviderHumanEvent = z.infer<typeof ProviderHumanEventSchema>;

interface IssuerBinding {
  issuerId: string;
  keyId: string;
  publicKeyPem: string;
  provider: string;
  providerTenantId: string;
  workspaceId: string;
  /** Explicit external principals permitted to authorize workspace-owner repairs. */
  ownerActorIds: string[];
}

function issuerBindings(): IssuerBinding[] {
  const raw = String(process.env.RORCA_PROVIDER_HUMAN_ISSUERS_JSON ?? '').trim();
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('RORCA_PROVIDER_HUMAN_ISSUERS_JSON is required for provider-human authority');
    }
    return [];
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('RORCA_PROVIDER_HUMAN_ISSUERS_JSON must be an array');
  return parsed.map((value) => {
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('provider-human issuer binding is invalid');
    const row = value as Record<string, unknown>;
    const required = {
      issuerId: String(row.issuerId ?? ''), keyId: String(row.keyId ?? ''),
      publicKeyPem: String(row.publicKeyPem ?? ''), provider: String(row.provider ?? ''),
      providerTenantId: String(row.providerTenantId ?? ''), workspaceId: String(row.workspaceId ?? ''),
    };
    if (Object.values(required).some((item) => !item)) throw new Error('provider-human issuer binding is incomplete');
    const rawOwnerActorIds = row.ownerActorIds;
    if (rawOwnerActorIds !== undefined && !Array.isArray(rawOwnerActorIds)) {
      throw new Error('provider-human ownerActorIds must be an array');
    }
    const ownerActorIds = (rawOwnerActorIds ?? []).map((actorId) => String(actorId).trim());
    if (ownerActorIds.length > 100
      || ownerActorIds.some((actorId) => !actorId || actorId.length > 256)
      || new Set(ownerActorIds).size !== ownerActorIds.length) {
      throw new Error('provider-human ownerActorIds is invalid');
    }
    return { ...required, ownerActorIds };

  });
}

export function assertProviderTenantWorkspaceBinding(input: { provider: string; providerTenantId: string; workspaceId: string }): void {
  const bindings = issuerBindings();
  if (bindings.some((binding) => binding.provider === input.provider
    && binding.providerTenantId === input.providerTenantId
    && binding.workspaceId === input.workspaceId)) return;
  if (process.env.NODE_ENV !== 'production' && bindings.length === 0) return;
  throw new ForbiddenError('Provider tenant is not authorized for this Rorca workspace');
}

function unsignedEvent(event: ProviderHumanEvent): Omit<ProviderHumanEvent, 'signature'> {
  const { signature: _signature, ...unsigned } = event;
  return unsigned;
}

export function providerHumanActionHash(input: unknown): string {
  return retryHash(input);
}

export async function verifyAndPersistProviderHumanAuthority(input: {
  workspaceId: string;
  purpose: ProviderHumanPurpose;
  targetHash: string;
  event: ProviderHumanEvent;
  requesterActorId?: string | null;
  requireDistinctActor?: boolean;
  /** Require actorId to be explicitly listed as an owner on the exact issuer/workspace binding. */
  requireWorkspaceOwner?: boolean;
  now?: Date;
}): Promise<{ receiptId: string; replayed: boolean; actorId: string }> {
  const event = ProviderHumanEventSchema.parse(input.event);
  if (!/^sha256:[a-f0-9]{64}$/.test(input.targetHash)) throw new ValidationError('Provider-human target hash is invalid');
  if (event.normalizedCommandHash !== input.targetHash) {
    throw new ForbiddenError('Provider-human action does not match the exact canonical target');
  }
  if (input.requireDistinctActor && input.requesterActorId && event.actorId === input.requesterActorId) {
    throw new ForbiddenError('This approval requires a distinct human approver');
  }
  const binding = issuerBindings().find((candidate) =>
    candidate.issuerId === event.issuerId
    && candidate.keyId === event.keyId
    && candidate.provider === event.provider
    && candidate.providerTenantId === event.providerTenantId
    && candidate.workspaceId === input.workspaceId);
  if (!binding) throw new ForbiddenError('Provider-human issuer/tenant/workspace binding is not authorized');
  if (input.requireWorkspaceOwner && !binding.ownerActorIds.includes(event.actorId)) {
    throw new ForbiddenError('Provider-human actor is not a configured owner for this workspace');
  }
  const publicKey = crypto.createPublicKey(binding.publicKeyPem);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new ForbiddenError('Provider-human issuer key must be Ed25519');
  const message = Buffer.from(stableWalJson(unsignedEvent(event)), 'utf8');
  let signature: Buffer;
  try { signature = Buffer.from(event.signature, 'base64url'); }
  catch { throw new ForbiddenError('Provider-human signature is malformed'); }
  if (!crypto.verify(null, message, publicKey, signature)) {
    throw new ForbiddenError('Provider-human signature verification failed');
  }
  const keyFingerprint = `sha256:${crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')}`;
  const attestationHash = retryHash(event);
  const existing = await queryOne<{
    id: string; target_hash: string; purpose: string; actor_id: string;
    attestation_hash: string; workspace_owner_verified: boolean;
    requester_actor_id: string | null;
  }>(
    `SELECT id, target_hash, purpose, actor_id, attestation_hash,
            workspace_owner_verified, requester_actor_id
     FROM provider_human_authority_receipts
     WHERE issuer_id = $1 AND message_id = $2`,
    [event.issuerId, event.messageId],
  );
  if (existing) {
    if (existing.target_hash !== input.targetHash || existing.purpose !== input.purpose
      || existing.actor_id !== event.actorId || existing.attestation_hash !== attestationHash
      || existing.requester_actor_id !== (input.requesterActorId ?? null)
      || (input.requireWorkspaceOwner && existing.workspace_owner_verified !== true)) {
      throw new ConflictError('Provider-human message was already used for a different authority target');
    }
    return { receiptId: existing.id, replayed: true, actorId: existing.actor_id };
  }
  const now = input.now ?? new Date();
  const occurredAt = Date.parse(event.occurredAt);
  if (!Number.isFinite(occurredAt) || Math.abs(now.getTime() - occurredAt) > 10 * 60_000) {
    throw new ForbiddenError('Provider-human event is outside the freshness window');
  }
  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO provider_human_authority_receipts (
       workspace_id, purpose, target_hash, issuer_id, key_id, key_fingerprint,
       provider, provider_tenant_id, actor_id, conversation_id, thread_id,
       message_id, occurred_at, normalized_command_hash, ingress_idempotency_key,
       attestation_hash, requester_actor_id, workspace_owner_verified
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING id`,
    [input.workspaceId, input.purpose, input.targetHash, event.issuerId, event.keyId,
      keyFingerprint, event.provider, event.providerTenantId, event.actorId,
      event.conversationId, event.threadId, event.messageId, event.occurredAt,
      event.normalizedCommandHash, event.ingressIdempotencyKey, attestationHash,
      input.requesterActorId ?? null, input.requireWorkspaceOwner === true],
  );
  if (!inserted) throw new ConflictError('Provider-human authority receipt was not persisted');
  return { receiptId: inserted.id, replayed: false, actorId: event.actorId };
}
