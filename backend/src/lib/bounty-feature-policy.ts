/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Operator-owned bounty feature authority.
 *
 * Workspace files, specs, skills, models, Hermes payloads, TaskManifest values,
 * schedules, and MCP input are intentionally absent from this resolver. The only
 * enable authorities are a strict deployment policy or the persisted singleton
 * written by the authenticated-admin route.
 */
import { z } from 'zod';
import { queryOne, transaction } from '../db/index';
import { BountyOperationalReasonCode } from '../reason-codes';
import {
  AdminRequiredError,
  AppError,
  AuthError,
  ConflictError,
  ValidationError,
} from './errors';

export const BOUNTY_DEPLOYMENT_POLICY_ENV = 'RORCA_BOUNTY_DEPLOYMENT_POLICY' as const;
export const BOUNTY_FEATURE_DISABLED_REASON_CODE = BountyOperationalReasonCode.FeatureDisabled;
export const BOUNTY_MISSION_MODE = 'bounty' as const;

export const BountyDeploymentPolicySchema = z.object({
  state: z.literal('disabled'),
  missionMode: z.literal(BOUNTY_MISSION_MODE),
  revision: z.number().int().positive(),
  auditIdentity: z.string().trim().min(1).max(256),
}).strict();

export const BountyAdminPolicyMutationSchema = z.object({
  state: z.enum(['disabled', 'enabled']),
  missionMode: z.literal(BOUNTY_MISSION_MODE),
  revision: z.number().int().positive(),
  promotionReceiptId: z.string().uuid().optional(),
}).strict().superRefine((value, context) => {
  if (value.state === 'enabled' && !value.promotionReceiptId) context.addIssue({ code: z.ZodIssueCode.custom, path: ['promotionReceiptId'], message: 'A trusted post-commit promotion receipt is required to enable bounty effects' });
  if (value.state === 'disabled' && value.promotionReceiptId) context.addIssue({ code: z.ZodIssueCode.custom, path: ['promotionReceiptId'], message: 'Disabled policy must not carry promotion authority' });
});

export type BountyAdminPolicyMutation = z.infer<typeof BountyAdminPolicyMutationSchema>;
export interface BountyAdminMutationAuthority {
  id: string;
  email: string;
  role?: string;
  authSource?: 'bearer' | 'internal' | 'local-fallback';
}
export type BountyPolicyState = 'disabled' | 'enabled';
export type BountyPolicyAuthority = 'system_default' | 'admin_mutation' | 'deployment_policy';

export interface BountyFeaturePolicy {
  state: BountyPolicyState;
  enabled: boolean;
  missionMode: typeof BOUNTY_MISSION_MODE;
  revision: number;
  auditIdentity: string;
  authoritySource: BountyPolicyAuthority;
  updatedAt: string | null;
  promotionReceiptId?: string | null;
}

interface PersistedBountyPolicyRow {
  state: BountyPolicyState;
  mission_mode: typeof BOUNTY_MISSION_MODE;
  revision: string | number;
  audit_identity: string;
  authority_source: 'admin_mutation';
  updated_at: Date | string;
  promotion_receipt_id?: string | null;
}

export type PersistedBountyPolicyLoader = () => Promise<PersistedBountyPolicyRow | undefined>;

export const DEFAULT_BOUNTY_FEATURE_POLICY: Readonly<BountyFeaturePolicy> = Object.freeze({
  state: 'disabled',
  enabled: false,
  missionMode: BOUNTY_MISSION_MODE,
  revision: 0,
  auditIdentity: 'system:default-disabled',
  authoritySource: 'system_default',
  updatedAt: null,
});

export class BountyFeatureDisabledError extends AppError {
  readonly statusCode = 403 as const;

  constructor() {
    super('Bounty effects are disabled by operator policy', BOUNTY_FEATURE_DISABLED_REASON_CODE, {
      reasonCode: BOUNTY_FEATURE_DISABLED_REASON_CODE,
    });
  }
}

function validationDetails(error: z.ZodError): Record<string, unknown> {
  return {
    issues: error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

export function parseBountyDeploymentPolicy(raw: string | undefined): BountyFeaturePolicy | null {
  if (raw === undefined || raw.trim() === '') return null;

  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new ValidationError(`${BOUNTY_DEPLOYMENT_POLICY_ENV} must be valid JSON`);
  }

  const parsed = BountyDeploymentPolicySchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ValidationError(`${BOUNTY_DEPLOYMENT_POLICY_ENV} is invalid`, validationDetails(parsed.error));
  }

  return Object.freeze({
    state: parsed.data.state,
    enabled: false,
    missionMode: parsed.data.missionMode,
    revision: parsed.data.revision,
    auditIdentity: parsed.data.auditIdentity,
    authoritySource: 'deployment_policy',
    updatedAt: null,
  });
}

function rowToPolicy(row: PersistedBountyPolicyRow): BountyFeaturePolicy {
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision <= 0 || row.mission_mode !== BOUNTY_MISSION_MODE) {
    throw new ValidationError('Persisted bounty feature policy is invalid');
  }
  return Object.freeze({
    state: row.state,
    enabled: row.state === 'enabled',
    missionMode: row.mission_mode,
    revision,
    auditIdentity: row.audit_identity,
    authoritySource: row.authority_source,
    updatedAt: new Date(row.updated_at).toISOString(),
    promotionReceiptId: row.promotion_receipt_id ?? null,
  });
}

async function loadPersistedBountyPolicy(): Promise<PersistedBountyPolicyRow | undefined> {
  return queryOne<PersistedBountyPolicyRow>(
    `SELECT state, mission_mode, revision, audit_identity, authority_source, updated_at, promotion_receipt_id
       FROM bounty_feature_policy
      WHERE singleton = TRUE`,
  );
}

export async function resolveBountyFeaturePolicy(options: {
  deploymentPolicy?: string;
  loadPersisted?: PersistedBountyPolicyLoader;
} = {}): Promise<BountyFeaturePolicy> {
  const deployment = parseBountyDeploymentPolicy(
    options.deploymentPolicy ?? process.env[BOUNTY_DEPLOYMENT_POLICY_ENV],
  );
  if (deployment) return deployment;

  const persisted = await (options.loadPersisted ?? loadPersistedBountyPolicy)();
  return persisted ? rowToPolicy(persisted) : DEFAULT_BOUNTY_FEATURE_POLICY;
}

export async function persistBountyAdminPolicy(
  mutation: BountyAdminPolicyMutation,
  authority: BountyAdminMutationAuthority,
): Promise<BountyFeaturePolicy> {
  if (authority.role !== 'admin') throw new AdminRequiredError();
  if (authority.authSource !== 'bearer') {
    throw new AuthError('Credential-authenticated admin required for bounty policy mutation');
  }
  const parsed = BountyAdminPolicyMutationSchema.safeParse(mutation);
  if (!parsed.success) {
    throw new ValidationError('Invalid bounty feature policy mutation', validationDetails(parsed.error));
  }
  const actorId = authority.id.trim();
  const actorEmail = authority.email.trim();
  if (!actorId || !actorEmail) {
    throw new ValidationError('Bounty feature policy audit identity is required');
  }
  const actor = `${actorId}:${actorEmail}`;
  if (parseBountyDeploymentPolicy(process.env[BOUNTY_DEPLOYMENT_POLICY_ENV])) {
    throw new ConflictError('Bounty feature policy is controlled by deployment policy');
  }

  return transaction(async (client) => {
    const existingResult = await client.query<PersistedBountyPolicyRow>(
      `SELECT state, mission_mode, revision, audit_identity, authority_source, updated_at, promotion_receipt_id
         FROM bounty_feature_policy
        WHERE singleton = TRUE
        FOR UPDATE`,
    );
    const existing = existingResult.rows[0];
    const currentRevision = existing ? Number(existing.revision) : 0;
    if (parsed.data.revision !== currentRevision + 1) {
      throw new ConflictError('Bounty feature policy revision must advance exactly once', {
        currentRevision,
        requestedRevision: parsed.data.revision,
      });
    }

    if (parsed.data.state === 'enabled') {
      const promotion = await client.query(
        `SELECT p.id FROM bounty_release_promotions p
         LEFT JOIN bounty_release_promotion_revocations r ON r.promotion_id=p.id
         WHERE p.id=$1 AND r.promotion_id IS NULL AND clock_timestamp() < p.expires_at FOR SHARE OF p`,
        [parsed.data.promotionReceiptId],
      );
      if (!promotion.rowCount) throw new ConflictError('Bounty release promotion is absent, expired, or revoked');
    }

    const savedResult = await client.query<PersistedBountyPolicyRow>(
      `INSERT INTO bounty_feature_policy
         (singleton, state, mission_mode, revision, audit_identity, authority_source, updated_at, promotion_receipt_id)
       VALUES (TRUE, $1, $2, $3, $4, 'admin_mutation', NOW(), $5)
       ON CONFLICT (singleton) DO UPDATE SET
         state = EXCLUDED.state,
         mission_mode = EXCLUDED.mission_mode,
         revision = EXCLUDED.revision,
         audit_identity = EXCLUDED.audit_identity,
         authority_source = EXCLUDED.authority_source,
         updated_at = NOW(),
         promotion_receipt_id = EXCLUDED.promotion_receipt_id
       RETURNING state, mission_mode, revision, audit_identity, authority_source, updated_at, promotion_receipt_id`,
      [parsed.data.state, parsed.data.missionMode, parsed.data.revision, actor, parsed.data.promotionReceiptId ?? null],
    );

    await client.query(
      `INSERT INTO bounty_feature_policy_audit
         (previous_state, state, mission_mode, revision, audit_identity, authority_source, promotion_receipt_id)
       VALUES ($1, $2, $3, $4, $5, 'admin_mutation', $6)`,
      [existing?.state ?? null, parsed.data.state, parsed.data.missionMode, parsed.data.revision, actor, parsed.data.promotionReceiptId ?? null],
    );

    const saved = savedResult.rows[0];
    if (!saved) throw new ConflictError('Bounty feature policy update was not persisted');
    return rowToPolicy(saved);
  });
}

const bountyMissionBrand: unique symbol = Symbol('operator-issued-bounty-mission');

export interface BountyMissionContext {
  readonly missionMode: typeof BOUNTY_MISSION_MODE;
  readonly missionId: string;
  readonly policyRevision: number;
  readonly auditIdentity: string;
  readonly [bountyMissionBrand]: true;
}

/** Issue a non-serializable mission identity only after the operator gate passes. */
export function issueBountyMissionContext(
  policy: BountyFeaturePolicy,
  missionId: string,
): BountyMissionContext {
  if (!policy.enabled) throw new BountyFeatureDisabledError();
  const boundedMissionId = missionId.trim();
  if (!boundedMissionId) throw new ValidationError('Bounty mission id is required');
  return Object.freeze({
    missionMode: BOUNTY_MISSION_MODE,
    missionId: boundedMissionId,
    policyRevision: policy.revision,
    auditIdentity: policy.auditIdentity,
    [bountyMissionBrand]: true as const,
  });
}

/** Plain JSON and ordinary pipeline envelopes can never satisfy this check. */
export function isBountyMissionContext(value: unknown): value is BountyMissionContext {
  return typeof value === 'object'
    && value !== null
    && (value as Partial<BountyMissionContext>)[bountyMissionBrand] === true
    && (value as Partial<BountyMissionContext>).missionMode === BOUNTY_MISSION_MODE;
}
