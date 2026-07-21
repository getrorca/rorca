/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { queryOne, transaction } from '../db/index';
import { INTERNAL_SERVICE_USER_ID, LOCAL_ADMIN } from './auth-utils';
import { ConflictError, ForbiddenError, ValidationError } from './errors';
import {
  retryHash,
  type RetryPreviewIdentity,
  type RetryPreviewPacket,
} from './retry-governance';

export const RETRY_HUMAN_APPROVAL_VERSION = 'rorca.retry-human-approval.v1' as const;
const APPROVAL_TTL_MS = 5 * 60_000;
const NON_PRODUCTION_SECRET = randomBytes(48).toString('base64url');

export interface RetryHumanPrincipal {
  principalType: 'authenticated_user';
  principalId: string;
  principalAuthId: string;
  principalDisplayLabel: string;
  sourceChannel: 'api';
}

const ClaimsSchema = z.object({
  schemaVersion: z.literal(RETRY_HUMAN_APPROVAL_VERSION),
  approvalId: z.string().uuid(),
  workspaceId: z.string().min(1),
  originalRunId: z.number().int().positive(),
  previewHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  packetHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  previewIdentityHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  scopeHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  rationaleHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  principalType: z.literal('authenticated_user'),
  principalId: z.string().min(1),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

export type RetryHumanApprovalClaims = z.infer<typeof ClaimsSchema>;

interface ApprovalRow {
  id: string;
  receipt_hash: string;
  workspace_id: string;
  original_run_id: number | string;
  preview_hash: string;
  packet_hash: string;
  preview_identity_hash: string;
  scope_hash: string;
  rationale_hash: string;
  principal_type: string;
  principal_id: string;
  principal_auth_id: string;
  principal_display_label: string;
  source_channel: string;
  idempotency_key: string;
  request_hash: string;
  claims: RetryHumanApprovalClaims;
  issued_at: Date | string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
  consumed_retry_run_id: number | string | null;
  consumed_idempotency_key: string | null;
  revoked_at: Date | string | null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function approvalSecret(): string {
  const configured = String(process.env.RORCA_RETRY_APPROVAL_SECRET ?? '').trim();
  if (configured) {
    if (Buffer.byteLength(configured, 'utf8') < 32) {
      throw new Error('RORCA_RETRY_APPROVAL_SECRET must contain at least 32 bytes');
    }
    return configured;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('RORCA_RETRY_APPROVAL_SECRET is required in production');
  }
  return NON_PRODUCTION_SECRET;
}

function encodeReceipt(claims: RetryHumanApprovalClaims): string {
  const payload = Buffer.from(canonical(claims), 'utf8').toString('base64url');
  const signature = createHmac('sha256', approvalSecret()).update(payload, 'utf8').digest('base64url');
  return `v1.${payload}.${signature}`;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function exactClaimsFromRow(row: ApprovalRow): RetryHumanApprovalClaims {
  const claims = ClaimsSchema.parse(row.claims);
  const expected: RetryHumanApprovalClaims = {
    schemaVersion: RETRY_HUMAN_APPROVAL_VERSION,
    approvalId: row.id,
    workspaceId: row.workspace_id,
    originalRunId: Number(row.original_run_id),
    previewHash: row.preview_hash,
    packetHash: row.packet_hash,
    previewIdentityHash: row.preview_identity_hash,
    scopeHash: row.scope_hash,
    rationaleHash: row.rationale_hash,
    principalType: 'authenticated_user',
    principalId: row.principal_id,
    issuedAt: new Date(row.issued_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
  if (!safeEqual(canonical(claims), canonical(expected))) {
    throw new ConflictError('Stored retry approval claims do not match immutable approval authority');
  }
  return claims;
}

/** Retry approvals require a real authenticated workspace owner/admin, never a service or local shared identity. */
export async function assertHumanRetryApprover(
  user: Express.UserShape | undefined,
  workspaceId: string,
): Promise<RetryHumanPrincipal> {
  if (!user
    || user.id === LOCAL_ADMIN.id
    || user.id === INTERNAL_SERVICE_USER_ID
    || user.id === 'system'
    || user.email.toLowerCase().endsWith('@rorca.internal')) {
    throw new ForbiddenError('Retry approval requires an authenticated non-service human user session');
  }
  const membership = await queryOne<{ role: string }>(
    `SELECT role FROM workspace_members
     WHERE workspace_id = $1 AND user_auth_id = $2`,
    [workspaceId, user.supabaseId],
  );
  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    throw new ForbiddenError('Retry approval requires workspace owner or admin authority');
  }
  return {
    principalType: 'authenticated_user',
    principalId: user.id,
    principalAuthId: user.supabaseId,
    principalDisplayLabel: user.email,
    sourceChannel: 'api',
  };
}

export async function issueGovernedRetryHumanApproval(input: {
  principal: RetryHumanPrincipal;
  workspaceId: string;
  originalRunId: number;
  packet: RetryPreviewPacket;
  previewIdentity: RetryPreviewIdentity;
  rationale: string;
  idempotencyKey: string;
  now?: Date;
}): Promise<{ receipt: string; approvalId: string; expiresAt: string; replayed: boolean }> {
  const now = input.now ?? new Date();
  const rationale = input.rationale.trim();
  if (rationale.length < 10 || rationale.length > 2_000) {
    throw new ValidationError('Retry approval rationale must contain 10 to 2000 characters');
  }
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    throw new ValidationError('Idempotency-Key must contain 8 to 200 characters');
  }
  const identityExpiry = Date.parse(input.previewIdentity.expiresAt);
  if (!Number.isFinite(identityExpiry) || identityExpiry <= now.getTime()) {
    throw new ConflictError('Retry preview identity is expired');
  }
  const packetHash = retryHash(input.packet);
  const previewIdentityHash = retryHash(input.previewIdentity);
  const scopeHash = retryHash(input.packet.scope.executable.map((entry) => entry.storyId));
  const rationaleHash = retryHash(rationale);
  const expiresAt = new Date(Math.min(identityExpiry, now.getTime() + APPROVAL_TTL_MS));
  const requestHash = retryHash({
    schemaVersion: RETRY_HUMAN_APPROVAL_VERSION,
    workspaceId: input.workspaceId,
    originalRunId: input.originalRunId,
    previewHash: input.packet.previewHash,
    packetHash,
    previewIdentityHash,
    scopeHash,
    rationaleHash,
    principal: input.principal,
  });

  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `retry-human-approval:${input.workspaceId}:${idempotencyKey}`,
    ]);
    const existingResult = await client.query<ApprovalRow>(
      `SELECT * FROM governed_retry_human_approvals
       WHERE workspace_id = $1 AND idempotency_key = $2
       FOR UPDATE`,
      [input.workspaceId, idempotencyKey],
    );
    const existing = existingResult.rows[0];
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new ConflictError('Retry approval Idempotency-Key was reused with different authority');
      }
      const claims = exactClaimsFromRow(existing);
      const receipt = encodeReceipt(claims);
      if (retryHash(receipt) !== existing.receipt_hash) {
        throw new ConflictError('Stored retry approval receipt hash is inconsistent');
      }
      return { receipt, approvalId: existing.id, expiresAt: claims.expiresAt, replayed: true };
    }

    const approvalIdResult = await client.query<{ id: string }>('SELECT gen_random_uuid() AS id');
    const approvalId = approvalIdResult.rows[0]?.id;
    if (!approvalId) throw new Error('Failed to allocate retry approval identity');
    const claims: RetryHumanApprovalClaims = {
      schemaVersion: RETRY_HUMAN_APPROVAL_VERSION,
      approvalId,
      workspaceId: input.workspaceId,
      originalRunId: input.originalRunId,
      previewHash: input.packet.previewHash,
      packetHash,
      previewIdentityHash,
      scopeHash,
      rationaleHash,
      principalType: 'authenticated_user',
      principalId: input.principal.principalId,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    const receipt = encodeReceipt(claims);
    await client.query(
      `INSERT INTO governed_retry_human_approvals (
         id, receipt_hash, workspace_id, original_run_id, preview_hash, packet_hash,
         preview_identity_hash, scope_hash, rationale, rationale_hash,
         principal_type, principal_id, principal_auth_id, principal_display_label,
         source_channel, idempotency_key, request_hash, claims, issued_at, expires_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         $11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20
       )`,
      [approvalId, retryHash(receipt), input.workspaceId, input.originalRunId,
        input.packet.previewHash, packetHash, previewIdentityHash, scopeHash,
        rationale, rationaleHash, input.principal.principalType, input.principal.principalId,
        input.principal.principalAuthId, input.principal.principalDisplayLabel,
        input.principal.sourceChannel, idempotencyKey, requestHash, JSON.stringify(claims),
        claims.issuedAt, claims.expiresAt],
    );
    return { receipt, approvalId, expiresAt: claims.expiresAt, replayed: false };
  });
}

function decodeGovernedRetryHumanApprovalReceipt(
  receipt: string,
  now: Date,
  enforceExpiry: boolean,
): RetryHumanApprovalClaims {
  const [version, payload, signature, extra] = receipt.split('.');
  if (version !== 'v1' || !payload || !signature || extra !== undefined) {
    throw new ForbiddenError('Retry approval receipt is malformed');
  }
  const expected = createHmac('sha256', approvalSecret()).update(payload, 'utf8').digest('base64url');
  if (!safeEqual(signature, expected)) throw new ForbiddenError('Retry approval receipt signature is invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new ForbiddenError('Retry approval receipt payload is invalid');
  }
  const claims = ClaimsSchema.parse(parsed);
  if (enforceExpiry && Date.parse(claims.expiresAt) <= now.getTime()) {
    throw new ForbiddenError('Retry approval receipt is expired');
  }
  return claims;
}

export function verifyGovernedRetryHumanApprovalReceipt(
  receipt: string,
  now = new Date(),
): RetryHumanApprovalClaims {
  return decodeGovernedRetryHumanApprovalReceipt(receipt, now, true);
}

export async function consumeGovernedRetryHumanApproval(
  client: PoolClient,
  input: {
    receipt: string;
    workspaceId: string;
    originalRunId: number;
    previewHash: string;
    packetHash: string;
    previewIdentityHash: string;
    scopeHash: string;
    dispatchIdempotencyKey: string;
    retryRunId: number;
  },
): Promise<{ approvalId: string; replayed: boolean }> {
  // Parse and verify cryptographic binding before lookup. Expiry is enforced by
  // the atomic UPDATE for first consumption; an already-consumed exact replay
  // remains queryable after expiry and can never authorize another run/key.
  const claims = decodeGovernedRetryHumanApprovalReceipt(input.receipt, new Date(), false);
  const actual = {
    workspaceId: input.workspaceId,
    originalRunId: input.originalRunId,
    previewHash: input.previewHash,
    packetHash: input.packetHash,
    previewIdentityHash: input.previewIdentityHash,
    scopeHash: input.scopeHash,
  };
  const claimed = {
    workspaceId: claims.workspaceId,
    originalRunId: claims.originalRunId,
    previewHash: claims.previewHash,
    packetHash: claims.packetHash,
    previewIdentityHash: claims.previewIdentityHash,
    scopeHash: claims.scopeHash,
  };
  if (!safeEqual(canonical(actual), canonical(claimed))) {
    throw new ForbiddenError('Retry approval receipt is bound to different authority');
  }
  const result = await client.query<ApprovalRow>(
    `SELECT * FROM governed_retry_human_approvals
     WHERE id = $1 AND receipt_hash = $2
     FOR UPDATE`,
    [claims.approvalId, retryHash(input.receipt)],
  );
  const row = result.rows[0];
  if (!row || row.revoked_at) throw new ForbiddenError('Retry approval receipt is unknown or revoked');
  const storedClaims = exactClaimsFromRow(row);
  if (!safeEqual(canonical(storedClaims), canonical(claims))) {
    throw new ForbiddenError('Retry approval receipt differs from stored authority');
  }
  if (row.consumed_at) {
    if (Number(row.consumed_retry_run_id) !== input.retryRunId
      || row.consumed_idempotency_key !== input.dispatchIdempotencyKey) {
      throw new ForbiddenError('Retry approval receipt has already been consumed');
    }
    return { approvalId: row.id, replayed: true };
  }
  const consumed = await client.query<{ id: string }>(
    `UPDATE governed_retry_human_approvals
     SET consumed_at = NOW(), consumed_retry_run_id = $2, consumed_idempotency_key = $3
     WHERE id = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
     RETURNING id`,
    [row.id, input.retryRunId, input.dispatchIdempotencyKey],
  );
  if (consumed.rowCount !== 1) throw new ForbiddenError('Retry approval receipt expired before consumption');
  return { approvalId: row.id, replayed: false };
}
