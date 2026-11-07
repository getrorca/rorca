/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { transaction } from '../db/index';
import { ConflictError, ValidationError } from './errors';
import { normalizeSsdlcContractJson } from './ssdlc-contracts';
import { bindEcoPhaseWork, type EcoPhaseWorkBinding } from './eco-phase-work';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPILED_PLAN_ID = /^[1-9]\d*$/;

export interface LifecycleDispatchClaim {
  schemaVersion: 'lifecycle-dispatch-claim.v1';
  claimId: string;
  workspaceId: string;
  specId: string;
  specHash: string;
  compiledPlanId: string;
  requestIdentity: string;
  requestHash: string;
}

export interface LifecycleDispatchClaimInput {
  /** Reference pin only; never an ECO effect-policy or source-authority grant. */
  phaseWorkBinding?: EcoPhaseWorkBinding;
  workspaceId: string;
  specId: string;
  specHash: string;
  compiledPlanId: string;
  requestIdentity: string;
  requestHash: string;
}

type QueryClient = Pick<PoolClient, 'query'>;

type ClaimRow = {
  claim_id: string;
  workspace_id: string;
  spec_slug: string;
  spec_hash: string;
  compiled_plan_id: string;
  request_identity: string;
  request_hash: string;
};

function nonEmpty(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim();
}

function validateInput(input: LifecycleDispatchClaimInput): void {
  if (!nonEmpty(input.workspaceId, 256)
    || !nonEmpty(input.specId, 512)
    || !SHA256.test(input.specHash)
    || !COMPILED_PLAN_ID.test(input.compiledPlanId)
    || !nonEmpty(input.requestIdentity, 512)
    || !SHA256.test(input.requestHash)) {
    throw new ValidationError('Invalid lifecycle dispatch claim identity');
  }
}

function fromRow(row: ClaimRow): LifecycleDispatchClaim {
  return {
    schemaVersion: 'lifecycle-dispatch-claim.v1',
    claimId: row.claim_id,
    workspaceId: row.workspace_id,
    specId: row.spec_slug,
    specHash: row.spec_hash,
    compiledPlanId: row.compiled_plan_id,
    requestIdentity: row.request_identity,
    requestHash: row.request_hash,
  };
}

function exact(row: ClaimRow, input: LifecycleDispatchClaimInput): boolean {
  return row.workspace_id === input.workspaceId
    && row.spec_slug === input.specId
    && row.spec_hash === input.specHash
    && row.compiled_plan_id === input.compiledPlanId
    && row.request_identity === input.requestIdentity
    && row.request_hash === input.requestHash;
}

async function claimWithClient(
  client: QueryClient,
  input: LifecycleDispatchClaimInput,
): Promise<LifecycleDispatchClaim> {
  validateInput(input);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `lifecycle-dispatch-claim:${input.workspaceId}:${input.requestIdentity}`,
  ]);
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
    [input.workspaceId, input.specId],
  );

  const proposedClaimId = randomUUID();
  const inserted = await client.query<ClaimRow>(`
    INSERT INTO ssdlc_lifecycle_dispatch_claims (
      claim_id, workspace_id, spec_slug, spec_hash, compiled_plan_id,
      request_identity, request_hash
    )
    SELECT $1::uuid, $2, $3, $4, plan.id, $6, $7
      FROM ssdlc_compiled_plans plan
     WHERE plan.workspace_id = $2
       AND plan.spec_slug = $3
       AND plan.id = $5::bigint
       AND plan.is_current = TRUE
       AND plan.validation_status = 'validated'
       AND plan.provenance_json->>'specHash' = $4
    ON CONFLICT (workspace_id, request_identity) DO NOTHING
    RETURNING claim_id::text, workspace_id, spec_slug, spec_hash,
              compiled_plan_id::text, request_identity, request_hash
  `, [
    proposedClaimId,
    input.workspaceId,
    input.specId,
    input.specHash,
    input.compiledPlanId,
    input.requestIdentity,
    input.requestHash,
  ]);
  if (inserted.rows[0]) {
    const claim = fromRow(inserted.rows[0]);
    if (input.phaseWorkBinding) {
      await client.query("SELECT set_config('rorca.workspace_id',$1,TRUE)", [input.workspaceId]);
      await bindEcoPhaseWork(client, claim, input.phaseWorkBinding);
    }
    return claim;
  }

  const existing = await client.query<ClaimRow>(`
    SELECT claim_id::text, workspace_id, spec_slug, spec_hash,
           compiled_plan_id::text, request_identity, request_hash
      FROM ssdlc_lifecycle_dispatch_claims
     WHERE workspace_id = $1 AND request_identity = $2
     LIMIT 1
  `, [input.workspaceId, input.requestIdentity]);
  const row = existing.rows[0];
  if (!row) {
    throw new ConflictError(
      'Lifecycle dispatch claim could not prove the exact current validated plan',
      { workspaceId: input.workspaceId, specId: input.specId, compiledPlanId: input.compiledPlanId },
    );
  }
  if (!exact(row, input)) {
    throw new ConflictError(
      'Lifecycle dispatch request identity is already bound to a different immutable claim',
      { workspaceId: input.workspaceId, requestIdentity: input.requestIdentity, claimId: row.claim_id },
    );
  }
  await assertLifecycleDispatchClaim(fromRow(row), client);
  if (input.phaseWorkBinding) {
    await client.query("SELECT set_config('rorca.workspace_id',$1,TRUE)", [input.workspaceId]);
    await bindEcoPhaseWork(client, fromRow(row), input.phaseWorkBinding);
  }
  return fromRow(row);
}


export async function claimLifecycleDispatch(
  input: LifecycleDispatchClaimInput,
  client?: QueryClient,
): Promise<LifecycleDispatchClaim> {
  if (client) return claimWithClient(client, input);
  return transaction((transactionClient) => claimWithClient(transactionClient, input));
}

export function parseLifecycleDispatchClaim(value: unknown): LifecycleDispatchClaim | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const expectedKeys = [
    'claimId', 'compiledPlanId', 'requestHash', 'requestIdentity',
    'schemaVersion', 'specHash', 'specId', 'workspaceId',
  ];
  if (Object.keys(row).sort().join(',') !== expectedKeys.sort().join(',')) return undefined;
  if (row.schemaVersion !== 'lifecycle-dispatch-claim.v1'
    || !nonEmpty(row.claimId, 64) || !UUID.test(row.claimId)
    || !nonEmpty(row.workspaceId, 256)
    || !nonEmpty(row.specId, 512)
    || typeof row.specHash !== 'string' || !SHA256.test(row.specHash)
    || typeof row.compiledPlanId !== 'string' || !COMPILED_PLAN_ID.test(row.compiledPlanId)
    || !nonEmpty(row.requestIdentity, 512)
    || typeof row.requestHash !== 'string' || !SHA256.test(row.requestHash)) return undefined;
  return row as unknown as LifecycleDispatchClaim;
}

export async function assertLifecycleDispatchClaim(
  claim: LifecycleDispatchClaim,
  client?: QueryClient,
  expectedPlanHash?: string,
): Promise<void> {
  const parsed = parseLifecycleDispatchClaim(claim);
  if (!parsed) throw new ConflictError('Pipeline run lacks a valid immutable lifecycle dispatch claim');
  if (expectedPlanHash !== undefined && !SHA256.test(expectedPlanHash)) {
    throw new ConflictError('Lifecycle execution contract has an invalid compiled plan hash');
  }
  const run = async (queryClient: QueryClient): Promise<void> => {
    const result = await queryClient.query<{ claim_id: string; plan_json: unknown }>(`
      SELECT claim.claim_id::text, plan.plan_json
        FROM ssdlc_lifecycle_dispatch_claims claim
        JOIN ssdlc_compiled_plans plan ON plan.id = claim.compiled_plan_id
       WHERE claim.claim_id = $1::uuid
         AND claim.workspace_id = $2
         AND claim.spec_slug = $3
         AND claim.spec_hash = $4
         AND claim.compiled_plan_id = $5::bigint
         AND claim.request_identity = $6
         AND claim.request_hash = $7
         AND plan.workspace_id = claim.workspace_id
         AND plan.spec_slug = claim.spec_slug
         AND plan.is_current = TRUE
         AND plan.validation_status = 'validated'
         AND plan.provenance_json->>'specHash' = claim.spec_hash
       LIMIT 1
       FOR SHARE OF plan
    `, [
      parsed.claimId,
      parsed.workspaceId,
      parsed.specId,
      parsed.specHash,
      parsed.compiledPlanId,
      parsed.requestIdentity,
      parsed.requestHash,
    ]);
    if (!result.rows[0]) {
      throw new ConflictError(
        'Lifecycle dispatch claim no longer matches the exact current validated plan',
        { claimId: parsed.claimId, workspaceId: parsed.workspaceId, specId: parsed.specId },
      );
    }
    if (expectedPlanHash !== undefined) {
      const persistedPlan = result.rows[0].plan_json;
      if (!persistedPlan || typeof persistedPlan !== 'object') {
        throw new ConflictError(
          'Lifecycle dispatch claim selected an invalid compiled plan payload',
          { claimId: parsed.claimId, compiledPlanId: parsed.compiledPlanId },
        );
      }
      const persistedPlanHash = `sha256:${createHash('sha256')
        .update(normalizeSsdlcContractJson(persistedPlan), 'utf8')
        .digest('hex')}`;
      if (persistedPlanHash !== expectedPlanHash) {
        throw new ConflictError(
          'Lifecycle execution contract does not match the exact claimed compiled plan',
          { claimId: parsed.claimId, compiledPlanId: parsed.compiledPlanId },
        );
      }
    }
  };
  if (client) return run(client);
  return transaction(run);
}

/**
 * Hold the same per-spec transaction lock used by plan activation while the
 * caller crosses one irreversible dispatch boundary.
 */
export async function withLifecycleDispatchClaimLock<T>(
  claim: LifecycleDispatchClaim,
  action: (client: QueryClient) => Promise<T> | T,
): Promise<T> {
  const parsed = parseLifecycleDispatchClaim(claim);
  if (!parsed) throw new ConflictError('Pipeline run lacks a valid immutable lifecycle dispatch claim');
  return transaction(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [parsed.workspaceId, parsed.specId],
    );
    await assertLifecycleDispatchClaim(parsed, client);
    return action(client);
  });
}
