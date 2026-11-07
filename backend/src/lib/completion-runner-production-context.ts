/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { canonicalTransaction } from '../db';
import {
  CanonicalObligationSetV1Schema,
  ContinuationScopeSchema,
  WorkPackageV1Schema,
  governedHash,
  type CanonicalObligationSetV1,
  type ContinuationScope,
  type WorkPackageV1,
} from './governed-contracts';

export interface ReadyProductionCompletionContext {
  kind: 'ready';
  scope: ContinuationScope;
  workPackage: WorkPackageV1;
  obligations: CanonicalObligationSetV1;
}

export type ProductionCompletionContextResolution =
  | { kind: 'not_governed' }
  | { kind: 'governed_incomplete'; reasonCode: 'COMPLETION_ATTEMPT_MISSING' | 'COMPLETION_SCOPE_CONFLICT' }
  | ReadyProductionCompletionContext;

export interface ProductionCompletionContextIdentity {
  workspaceId: string;
  specId: string;
  runId: number;
  storyId: string;
  manifestHash: string;
}

interface CompletionContextRow {
  attempt_id: string;
  protocol_version: number | string | null;
  writer_fence: number | string | null;
  obligation_payload: unknown;
  work_package_payload: unknown;
}

function exactScope(left: ContinuationScope, right: ContinuationScope): boolean {
  return governedHash('rorca.production-completion-scope.v1', left as never)
    === governedHash('rorca.production-completion-scope.v1', right as never);
}

/**
 * Resolve the exact canonical Completion Protocol context for one dispatched
 * story. Absence of a governed attempt is the only legacy/non-governed case;
 * once a governed attempt exists, missing or conflicting v1 state fails closed.
 */
export async function loadProductionCompletionContext(
  identity: ProductionCompletionContextIdentity,
): Promise<ProductionCompletionContextResolution> {
  return canonicalTransaction(async (client) => {
    await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [identity.workspaceId]);
    const governed = await client.query<{ attempt_id: string; manifest_hash: string }>(`
      SELECT attempt_id,manifest_hash
      FROM rorca.governed_execution_attempts
      WHERE workspace_id=$1 AND run_id=$2 AND story_id=$3
      ORDER BY generation DESC
      LIMIT 100
    `, [identity.workspaceId, identity.runId, identity.storyId]);
    if (governed.rows.length === 0) return { kind: 'not_governed' };
    const exactGoverned = governed.rows.filter((row) => row.manifest_hash === identity.manifestHash);
    if (exactGoverned.length !== 1) return { kind: 'governed_incomplete', reasonCode: 'COMPLETION_SCOPE_CONFLICT' };

    const result = await client.query<CompletionContextRow>(`
      SELECT ca.attempt_id,ca.protocol_version,ca.writer_fence,
             obligations.payload_json obligation_payload,
             package.payload_json work_package_payload
      FROM rorca.completion_attempts ca
      JOIN rorca.completion_obligation_sets obligations
        ON obligations.workspace_id=ca.workspace_id
       AND obligations.attempt_id=ca.attempt_id
       AND obligations.obligation_set_id=ca.obligation_set_id
       AND obligations.obligation_set_revision=ca.obligation_set_revision
       AND obligations.artifact_hash=ca.obligation_set_hash
      JOIN rorca.governed_execution_attempts attempt
        ON attempt.workspace_id=ca.workspace_id AND attempt.attempt_id=ca.attempt_id
      JOIN rorca.governed_work_package_revisions package
        ON package.workspace_id=attempt.workspace_id
       AND package.mission_id=attempt.mission_id
       AND package.work_package_id=attempt.work_package_id
       AND package.work_package_revision=attempt.work_package_revision
      WHERE ca.workspace_id=$1 AND ca.attempt_id=$2
        AND attempt.run_id=$3 AND attempt.story_id=$4 AND attempt.manifest_hash=$5
        AND obligations.state='active'
      LIMIT 2
    `, [identity.workspaceId, exactGoverned[0]!.attempt_id, identity.runId, identity.storyId, identity.manifestHash]);
    if (result.rows.length === 0) return { kind: 'governed_incomplete', reasonCode: 'COMPLETION_ATTEMPT_MISSING' };
    if (result.rows.length !== 1) return { kind: 'governed_incomplete', reasonCode: 'COMPLETION_SCOPE_CONFLICT' };

    const row = result.rows[0]!;
    if (Number(row.protocol_version) !== 1) return { kind: 'governed_incomplete', reasonCode: 'COMPLETION_SCOPE_CONFLICT' };
    const obligations = CanonicalObligationSetV1Schema.parse(row.obligation_payload);
    const workPackage = WorkPackageV1Schema.parse(row.work_package_payload);
    const scope = ContinuationScopeSchema.parse(obligations.scope);
    const exactIdentity = scope.workspaceId === identity.workspaceId
      && scope.runId === identity.runId
      && scope.spec.specId === identity.specId
      && scope.spec.storyId === identity.storyId
      && scope.attemptId === row.attempt_id
      && scope.fencingToken === Number(row.writer_fence)
      && obligations.manifestHash === identity.manifestHash
      && workPackage.workspaceId === scope.workspaceId
      && workPackage.missionId === scope.missionId
      && workPackage.missionRevision === scope.missionRevision
      && workPackage.missionHash === scope.missionHash
      && workPackage.workPackageId === scope.workPackageId
      && workPackage.workPackageRevision === scope.workPackageRevision
      && workPackage.workPackageHash === scope.workPackageHash
      && (workPackage.state === 'accepted' || workPackage.state === 'active')
      && governedHash('rorca.production-completion-spec-binding.v1', workPackage.spec as never)
        === governedHash('rorca.production-completion-spec-binding.v1', scope.spec as never)
      && governedHash('rorca.production-completion-repository-binding.v1', workPackage.repository as never)
        === governedHash('rorca.production-completion-repository-binding.v1', scope.repository as never)
      && workPackage.validationObligationsHash === obligations.validationHash
      && workPackage.evidenceObligationsHash === obligations.evidenceHash
      && workPackage.executionPostureHash === obligations.postureHash
      && workPackage.resourceLimitsHash === obligations.resourceHash
      && exactScope(scope, obligations.scope);
    if (!exactIdentity) return { kind: 'governed_incomplete', reasonCode: 'COMPLETION_SCOPE_CONFLICT' };
    return { kind: 'ready', scope, workPackage, obligations };
  });
}

export async function observeProductionCompletionControl(scope: ContinuationScope): Promise<{
  observedAt: string;
  cancellation: 'none' | 'requested' | 'acknowledged' | 'forced_expiry';
  cancellationId: string | null;
}> {
  return canonicalTransaction(async (client) => {
    await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [scope.workspaceId]);
    const result = await client.query<{
      db_time: Date;
      state: string;
      expires_at: Date;
      fencing_token: string;
      runtime_id: string;
      cancellation_disposition: string | null;
      cancellation_id: string | null;
    }>(`
      SELECT clock_timestamp() db_time,lease.state,lease.expires_at,
             lease.fencing_token::text,lease.runtime_id,
             cancellation.disposition cancellation_disposition,
             cancellation.cancellation_id
      FROM rorca.execution_leases lease
      LEFT JOIN LATERAL (
        SELECT request.cancellation_id,
               CASE request.state
                 WHEN 'forced_expiry' THEN 'forced_expiry'
                 WHEN 'acknowledged' THEN 'acknowledged'
                 WHEN 'graceful' THEN 'acknowledged'
                 WHEN 'lost_runtime' THEN 'forced_expiry'
                 ELSE CASE
                   WHEN acknowledgement.acknowledgement_id IS NOT NULL THEN 'acknowledged'
                   ELSE 'requested'
                 END
               END disposition
        FROM rorca.execution_cancellation_requests request
        LEFT JOIN rorca.execution_cancellation_acknowledgements acknowledgement
          ON acknowledgement.workspace_id=request.workspace_id
         AND acknowledgement.cancellation_id=request.cancellation_id
        WHERE request.workspace_id=lease.workspace_id
          AND request.attempt_id=lease.attempt_id
          AND request.lease_id=lease.lease_id
        ORDER BY request.requested_at DESC
        LIMIT 1
      ) cancellation ON TRUE
      WHERE lease.workspace_id=$1 AND lease.attempt_id=$2 AND lease.lease_id=$3
      LIMIT 2
    `, [scope.workspaceId, scope.attemptId, scope.leaseId]);
    if (result.rows.length !== 1) throw new Error('Completion control observation lacks one exact lease');
    const row = result.rows[0]!;
    if (Number(row.fencing_token) !== scope.fencingToken || row.runtime_id !== scope.runtimeId) {
      throw new Error('Completion control observation crossed runtime or writer fence');
    }
    const observedAt = row.db_time.toISOString();
    if (row.state === 'expired' || Date.parse(observedAt) >= row.expires_at.getTime()) {
      return { observedAt, cancellation: 'forced_expiry', cancellationId: scope.cancellationId };
    }
    if (row.state !== 'active') return { observedAt, cancellation: 'forced_expiry', cancellationId: scope.cancellationId };
    if (row.cancellation_disposition) {
      if (row.cancellation_id !== scope.cancellationId) throw new Error('Completion cancellation identity differs from exact scope');
      return {
        observedAt,
        cancellation: row.cancellation_disposition === 'acknowledged' ? 'acknowledged' : 'requested',
        cancellationId: row.cancellation_id,
      };
    }
    return { observedAt, cancellation: 'none', cancellationId: null };
  });
}
