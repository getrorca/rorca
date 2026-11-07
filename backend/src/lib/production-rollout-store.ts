/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { canonicalTransaction, query, queryOne } from '../db/index';
import { ConflictError, NotFoundError } from './errors';
import {
  ProductionActionAcceptanceSchema,
  ProductionActionObservationSchema,
  ProductionHealthEvaluationSchema,
  ProductionProviderStateSchema,
  ProductionRevokedLeaseSchema,
  ProductionRolloutAuthoritySchema,
  ProductionRolloutReceiptSchema,
  ProductionTargetSchema,
  productionCohortsMatch,
  type ProductionActionAcceptance,
  type ProductionActionObservation,
  type ProductionHealthEvaluation,
  type ProductionProviderState,
  type ProductionRevokedLease,
  type ProductionRolloutAuthority,
  type ProductionRolloutPhase,
  type ProductionRolloutReceipt,
  type ProductionTarget,
  type ProductionRevision,
} from './production-rollout';
import { ReleaseRolloutCohortSchema, type ReleaseIntent } from './release-intent';

const ProductionRolloutStatusSchema = z.enum([
  'canary_dispatched',
  'expansion_pending',
  'expansion_dispatched',
  'rollback_pending',
  'rollback_dispatched',
  'reconciliation_required',
  'settled',
]);
export type ProductionRolloutStatus = z.infer<typeof ProductionRolloutStatusSchema>;

const ProductionActionStatusSchema = z.enum([
  'prepared',
  'dispatched',
  'outcome_unknown',
  'observed',
  'revoked',
]);
export type ProductionActionStatus = z.infer<typeof ProductionActionStatusSchema>;

export interface StoredProductionAction {
  actionId: string;
  phase: ProductionRolloutPhase;
  status: ProductionActionStatus;
  targetRevision: ProductionRevision;
  cohort: ReleaseIntent['rolloutCohort'];
  acceptance: ProductionActionAcceptance | null;
  observation: ProductionActionObservation | null;
  revocation: ProductionRevokedLease | null;
}

export interface StoredProductionRollout {
  authority: ProductionRolloutAuthority;
  target: ProductionTarget;
  approvedCohort: ReleaseIntent['rolloutCohort'];
  priorState: ProductionProviderState;
  status: ProductionRolloutStatus;
  actions: StoredProductionAction[];
  evaluation: ProductionHealthEvaluation | null;
  receipt: ProductionRolloutReceipt | null;
}

export interface StartProductionRolloutInput {
  authority: ProductionRolloutAuthority;
  target: ProductionTarget;
  priorState: ProductionProviderState;
  approvedCohort: ReleaseIntent['rolloutCohort'];
  canary: ProductionActionAcceptance;
}

export interface ProductionRolloutStore {
  start(input: StartProductionRolloutInput): Promise<StoredProductionRollout>;
  read(workspaceId: string, operationId: string): Promise<StoredProductionRollout | null>;
  prepareAction(input: {
    workspaceId: string;
    operationId: string;
    phase: 'expansion' | 'rollback';
    targetRevision: ProductionRevision;
  }): Promise<StoredProductionAction>;
  recordActionAcceptance(
    workspaceId: string,
    operationId: string,
    acceptance: ProductionActionAcceptance,
  ): Promise<StoredProductionRollout>;
  recordActionObservation(
    workspaceId: string,
    operationId: string,
    observation: ProductionActionObservation,
  ): Promise<StoredProductionRollout>;
  recordEvaluation(
    workspaceId: string,
    operationId: string,
    evaluation: ProductionHealthEvaluation,
  ): Promise<StoredProductionRollout>;
  recordRevocation(
    workspaceId: string,
    operationId: string,
    revocation: ProductionRevokedLease,
  ): Promise<StoredProductionRollout>;
  settle(receipt: ProductionRolloutReceipt): Promise<ProductionRolloutReceipt>;
}

interface RolloutRow {
  operation_id: string;
  workspace_id: string;
  authorization_id: string;
  binding_id: string;
  binding_generation: number | string;
  operation_intent_id: string;
  intent_digest: string;
  ci_evidence_digest: string;
  grant_id: string;
  external_gate_evidence_id: string | null;
  authorized_at: Date | string;
  provider_id: string;
  project_uuid: string;
  application_uuid: string;
  environment_uuid: string;
  approved_cohort: unknown;
  prior_state: unknown;
  status: string;
  health_evaluation: unknown | null;
  receipt_payload: unknown | null;
}

interface ActionRow {
  id: string;
  rollout_operation_id: string;
  phase: string;
  status: string;
  target_revision: unknown;
  cohort: unknown;
  lease_id: string | null;
  provider_deployment_id: string | null;
  provider_accepted_at: Date | string | null;
  observation: unknown | null;
  revoked_at: Date | string | null;
}

const ROLLOUT_SELECT = `SELECT r.operation_id, r.workspace_id, r.authorization_id,
  r.binding_id, r.binding_generation, r.operation_intent_id, r.intent_digest,
  r.ci_evidence_digest, r.grant_id, r.external_gate_evidence_id, r.authorized_at,
  r.provider_id, r.project_uuid, r.application_uuid, r.environment_uuid,
  r.approved_cohort, r.prior_state, r.status, r.health_evaluation,
  e.receipt_payload
FROM rorca.authority_production_rollouts r
LEFT JOIN rorca.authority_execution_receipts e ON e.operation_id = r.operation_id`;

function jsonValue(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) as unknown : value;
}

function mapAction(row: ActionRow): StoredProductionAction {
  const phase = z.enum(['canary', 'expansion', 'rollback']).parse(row.phase);
  const targetRevision = ProductionProviderStateSchema.shape.revision.parse(jsonValue(row.target_revision));
  const cohort = ReleaseRolloutCohortSchema.parse(jsonValue(row.cohort));
  const hasAcceptance = row.provider_deployment_id !== null
    || row.provider_accepted_at !== null;
  if (hasAcceptance && (row.lease_id === null
    || row.provider_deployment_id === null
    || row.provider_accepted_at === null)) {
    throw new ConflictError('Production rollout action has partial provider acceptance lineage');
  }
  const acceptance = hasAcceptance
    ? ProductionActionAcceptanceSchema.parse({
      actionId: row.id,
      phase,
      leaseId: row.lease_id,
      providerDeploymentId: row.provider_deployment_id,
      acceptedAt: new Date(row.provider_accepted_at!).toISOString(),
      cohort,
      targetRevision,
    })
    : null;
  const rawObservation = row.observation === null ? null : jsonValue(row.observation);
  const observation = rawObservation === null
    ? null
    : ProductionActionObservationSchema.parse(rawObservation);
  const revocation = row.revoked_at === null || acceptance === null
    ? null
    : ProductionRevokedLeaseSchema.parse({
      actionId: row.id,
      phase,
      leaseId: acceptance.leaseId,
      providerDeploymentId: acceptance.providerDeploymentId,
      revokedAt: new Date(row.revoked_at).toISOString(),
    });
  return {
    actionId: row.id,
    phase,
    status: ProductionActionStatusSchema.parse(row.status),
    targetRevision,
    cohort,
    acceptance,
    observation,
    revocation,
  };
}

function mapRollout(row: RolloutRow, actions: StoredProductionAction[]): StoredProductionRollout {
  return {
    authority: ProductionRolloutAuthoritySchema.parse({
      authorizationId: row.authorization_id,
      operationId: row.operation_id,
      workspaceId: row.workspace_id,
      bindingId: row.binding_id,
      bindingGeneration: Number(row.binding_generation),
      operationIntentId: row.operation_intent_id,
      intentDigest: row.intent_digest,
      ciEvidenceDigest: row.ci_evidence_digest,
      grantId: row.grant_id,
      gateEvidenceId: row.external_gate_evidence_id,
      authorizedAt: new Date(row.authorized_at).toISOString(),
    }),
    target: ProductionTargetSchema.parse({
      providerId: row.provider_id,
      bindingId: row.binding_id,
      projectUuid: row.project_uuid,
      applicationUuid: row.application_uuid,
      environmentUuid: row.environment_uuid,
    }),
    approvedCohort: ReleaseRolloutCohortSchema.parse(jsonValue(row.approved_cohort)),
    priorState: ProductionProviderStateSchema.parse(jsonValue(row.prior_state)),
    status: ProductionRolloutStatusSchema.parse(row.status),
    actions,
    evaluation: row.health_evaluation === null
      ? null
      : ProductionHealthEvaluationSchema.parse(jsonValue(row.health_evaluation)),
    receipt: row.receipt_payload === null
      ? null
      : ProductionRolloutReceiptSchema.parse(jsonValue(row.receipt_payload)),
  };
}

async function readActionRows(operationId: string): Promise<StoredProductionAction[]> {
  const rows = await query<ActionRow>(
    `SELECT id, rollout_operation_id, phase, status, target_revision, cohort,
            lease_id, provider_deployment_id, provider_accepted_at,
            observation, revoked_at
       FROM rorca.authority_production_rollout_actions
      WHERE rollout_operation_id = $1
      ORDER BY CASE phase WHEN 'canary' THEN 1 WHEN 'expansion' THEN 2 ELSE 3 END`,
    [operationId],
  );
  return rows.map(mapAction);
}

export class PostgresProductionRolloutStore implements ProductionRolloutStore {
  constructor(private readonly randomUUID: () => string = () => crypto.randomUUID()) {}

  async start(rawInput: StartProductionRolloutInput): Promise<StoredProductionRollout> {
    const authority = ProductionRolloutAuthoritySchema.parse(rawInput.authority);
    const target = ProductionTargetSchema.parse(rawInput.target);
    const priorState = ProductionProviderStateSchema.parse(rawInput.priorState);
    const approvedCohort = ReleaseRolloutCohortSchema.parse(rawInput.approvedCohort);
    const canary = ProductionActionAcceptanceSchema.parse(rawInput.canary);
    if (canary.phase !== 'canary'
      || canary.actionId !== authority.operationId
      || target.bindingId !== authority.bindingId
      || priorState.authorityBindingGeneration !== authority.bindingGeneration
      || !productionCohortsMatch(canary.cohort, approvedCohort)) {
      throw new ConflictError('Canary acceptance differs from exact production rollout authority');
    }
    await canonicalTransaction(async (client) => {
      await client.query(
        `INSERT INTO rorca.authority_production_rollouts
          (operation_id, workspace_id, authorization_id, binding_id,
           binding_generation, operation_intent_id, intent_digest,
           ci_evidence_digest, grant_id, external_gate_evidence_id,
           authorized_at, provider_id, project_uuid, application_uuid,
           environment_uuid, approved_cohort, prior_state, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 $12, $13, $14, $15, $16::jsonb, $17::jsonb, 'canary_dispatched')
         ON CONFLICT (operation_id) DO NOTHING`,
        [
          authority.operationId, authority.workspaceId, authority.authorizationId,
          authority.bindingId, authority.bindingGeneration, authority.operationIntentId,
          authority.intentDigest, authority.ciEvidenceDigest, authority.grantId,
          authority.gateEvidenceId, authority.authorizedAt, target.providerId,
          target.projectUuid, target.applicationUuid, target.environmentUuid,
          JSON.stringify(approvedCohort), JSON.stringify(priorState),
        ],
      );
      await client.query(
        `INSERT INTO rorca.authority_production_rollout_actions
          (id, rollout_operation_id, phase, status, target_revision, cohort,
           lease_id, provider_deployment_id, provider_accepted_at)
         VALUES ($1, $2, 'canary', 'dispatched', $3::jsonb, $4::jsonb, $5, $6, $7)
         ON CONFLICT (rollout_operation_id, phase) DO NOTHING`,
        [
          canary.actionId, authority.operationId,
          JSON.stringify(canary.targetRevision), JSON.stringify(canary.cohort),
          canary.leaseId, canary.providerDeploymentId, canary.acceptedAt,
        ],
      );
    });
    const rollout = await this.read(authority.workspaceId, authority.operationId);
    if (!rollout) throw new NotFoundError('Production rollout not found');
    const storedCanary = rollout.actions.find((action) => action.phase === 'canary');
    if (!storedCanary?.acceptance
      || JSON.stringify(storedCanary.acceptance) !== JSON.stringify(canary)
      || JSON.stringify(rollout.authority) !== JSON.stringify(authority)
      || JSON.stringify(rollout.target) !== JSON.stringify(target)
      || JSON.stringify(rollout.priorState) !== JSON.stringify(priorState)
      || !productionCohortsMatch(rollout.approvedCohort, approvedCohort)) {
      throw new ConflictError('Production operation is already bound to different immutable rollout material');
    }
    return rollout;
  }

  async read(workspaceId: string, operationId: string): Promise<StoredProductionRollout | null> {
    const row = await queryOne<RolloutRow>(
      `${ROLLOUT_SELECT} WHERE r.operation_id = $1 AND r.workspace_id = $2`,
      [operationId, workspaceId],
    );
    if (!row) return null;
    return mapRollout(row, await readActionRows(operationId));
  }

  async prepareAction(input: {
    workspaceId: string;
    operationId: string;
    phase: 'expansion' | 'rollback';
    targetRevision: ProductionRevision;
  }): Promise<StoredProductionAction> {
    const targetRevision = ProductionProviderStateSchema.shape.revision.parse(input.targetRevision);
    const actionId = this.randomUUID();
    await canonicalTransaction(async (client) => {
      const rollout = await client.query<{
        status: string;
        approved_cohort: unknown;
        health_evaluation: unknown;
        expansion_unhealthy: boolean;
      }>(
        `SELECT r.status, r.approved_cohort, r.health_evaluation,
                EXISTS (
                  SELECT 1
                    FROM rorca.authority_production_rollout_actions a
                   WHERE a.rollout_operation_id = r.operation_id
                     AND a.phase = 'expansion'
                     AND a.observation#>>'{evidence,providerOutcome}' = 'unhealthy'
                ) AS expansion_unhealthy
           FROM rorca.authority_production_rollouts r
          WHERE r.operation_id = $1 AND r.workspace_id = $2
          FOR UPDATE`,
        [input.operationId, input.workspaceId],
      );
      const row = rollout.rows[0];
      if (!row) throw new NotFoundError('Production rollout not found');
      const evaluation = ProductionHealthEvaluationSchema.parse(jsonValue(row.health_evaluation));
      const expectedPhase = evaluation.decision === 'abort' || row.expansion_unhealthy
        ? 'rollback'
        : evaluation.decision === 'expand'
          ? 'expansion'
          : null;
      if (expectedPhase !== input.phase) {
        throw new ConflictError('Production rollout action differs from the deterministic health decision');
      }
      await client.query(
        `INSERT INTO rorca.authority_production_rollout_actions
          (id, rollout_operation_id, phase, status, target_revision, cohort)
         VALUES ($1, $2, $3, 'prepared', $4::jsonb, $5::jsonb)
         ON CONFLICT (rollout_operation_id, phase) DO NOTHING`,
        [actionId, input.operationId, input.phase, JSON.stringify(targetRevision), JSON.stringify(row.approved_cohort)],
      );
    });
    const rollout = await this.read(input.workspaceId, input.operationId);
    const action = rollout?.actions.find((candidate) => candidate.phase === input.phase);
    if (!action) throw new ConflictError('Production rollout action could not be prepared');
    if (JSON.stringify(action.targetRevision) !== JSON.stringify(targetRevision)) {
      throw new ConflictError('Production rollout action is already bound to a different target revision');
    }
    return action;
  }

  async recordActionAcceptance(
    workspaceId: string,
    operationId: string,
    rawAcceptance: ProductionActionAcceptance,
  ): Promise<StoredProductionRollout> {
    const acceptance = ProductionActionAcceptanceSchema.parse(rawAcceptance);
    await canonicalTransaction(async (client) => {
      const result = await client.query(
        `UPDATE rorca.authority_production_rollout_actions
            SET status = 'dispatched', lease_id = $4,
                provider_deployment_id = $5, provider_accepted_at = $6,
                updated_at = NOW()
          WHERE id = $1 AND rollout_operation_id = $2 AND phase = $3
            AND target_revision = $7::jsonb AND cohort = $8::jsonb
            AND status IN ('prepared', 'dispatched', 'outcome_unknown')
            AND (lease_id IS NULL OR lease_id = $4)
            AND (provider_deployment_id IS NULL OR provider_deployment_id = $5)
         RETURNING id`,
        [
          acceptance.actionId, operationId, acceptance.phase, acceptance.leaseId,
          acceptance.providerDeploymentId, acceptance.acceptedAt,
          JSON.stringify(acceptance.targetRevision), JSON.stringify(acceptance.cohort),
        ],
      );
      if (result.rowCount === 0) {
        throw new ConflictError('Production action acceptance differs from its persisted checkpoint');
      }
      await client.query(
        `UPDATE rorca.authority_production_rollouts
            SET status = $3, updated_at = NOW()
          WHERE operation_id = $1 AND workspace_id = $2 AND status <> 'settled'`,
        [
          operationId,
          workspaceId,
          acceptance.phase === 'expansion' ? 'expansion_dispatched'
            : acceptance.phase === 'rollback' ? 'rollback_dispatched' : 'canary_dispatched',
        ],
      );
    });
    const rollout = await this.read(workspaceId, operationId);
    if (!rollout) throw new NotFoundError('Production rollout not found');
    return rollout;
  }


  async recordActionObservation(
    workspaceId: string,
    operationId: string,
    rawObservation: ProductionActionObservation,
  ): Promise<StoredProductionRollout> {
    const observation = ProductionActionObservationSchema.parse(rawObservation);
    await canonicalTransaction(async (client) => {
      const result = await client.query(
        `UPDATE rorca.authority_production_rollout_actions
            SET status = 'observed', observation = $4::jsonb, updated_at = NOW()
          WHERE id = $1 AND rollout_operation_id = $2 AND phase = $3
            AND provider_deployment_id = $5
            AND target_revision = $6::jsonb AND cohort = $7::jsonb
            AND status IN ('dispatched', 'outcome_unknown', 'observed')
            AND (observation IS NULL OR observation = $4::jsonb)
         RETURNING id`,
        [
          observation.actionId, operationId, observation.phase,
          JSON.stringify(observation), observation.evidence.providerDeploymentId,
          JSON.stringify(observation.evidence.revision), JSON.stringify(observation.evidence.rolloutCohort),
        ],
      );
      if (result.rowCount === 0) {
        throw new ConflictError('Production observation differs from its exact action target');
      }
    });
    const rollout = await this.read(workspaceId, operationId);
    if (!rollout) throw new NotFoundError('Production rollout not found');
    return rollout;
  }

  async recordEvaluation(
    workspaceId: string,
    operationId: string,
    rawEvaluation: ProductionHealthEvaluation,
  ): Promise<StoredProductionRollout> {
    const evaluation = ProductionHealthEvaluationSchema.parse(rawEvaluation);
    const nextStatus = evaluation.decision === 'expand'
      ? 'expansion_pending'
      : evaluation.decision === 'abort'
        ? 'rollback_pending'
        : 'canary_dispatched';
    await canonicalTransaction(async (client) => {
      const result = await client.query<{ health_evaluation: unknown }>(
        `UPDATE rorca.authority_production_rollouts
            SET health_evaluation = COALESCE(health_evaluation, $3::jsonb),
                status = $4, updated_at = NOW()
          WHERE operation_id = $1 AND workspace_id = $2
            AND status <> 'settled'
            AND (health_evaluation IS NULL OR health_evaluation = $3::jsonb)
         RETURNING health_evaluation`,
        [operationId, workspaceId, JSON.stringify(evaluation), nextStatus],
      );
      if (result.rowCount === 0) {
        throw new ConflictError('Production health evidence differs from the immutable recorded evaluation');
      }
    });
    const rollout = await this.read(workspaceId, operationId);
    if (!rollout) throw new NotFoundError('Production rollout not found');
    return rollout;
  }

  async recordRevocation(
    workspaceId: string,
    operationId: string,
    rawRevocation: ProductionRevokedLease,
  ): Promise<StoredProductionRollout> {
    const revocation = ProductionRevokedLeaseSchema.parse(rawRevocation);
    await canonicalTransaction(async (client) => {
      const result = await client.query(
        `UPDATE rorca.authority_production_rollout_actions
            SET status = 'revoked', revoked_at = $6, updated_at = NOW()
          WHERE id = $1 AND rollout_operation_id = $2 AND phase = $3
            AND lease_id = $4 AND provider_deployment_id = $5
            AND status IN ('observed', 'revoked')
            AND (revoked_at IS NULL OR revoked_at = $6)
         RETURNING id`,
        [
          revocation.actionId, operationId, revocation.phase,
          revocation.leaseId, revocation.providerDeploymentId, revocation.revokedAt,
        ],
      );
      if (result.rowCount === 0) throw new ConflictError('Production lease revocation differs from action lineage');
    });
    const rollout = await this.read(workspaceId, operationId);
    if (!rollout) throw new NotFoundError('Production rollout not found');
    return rollout;
  }

  async settle(rawReceipt: ProductionRolloutReceipt): Promise<ProductionRolloutReceipt> {
    const receipt = ProductionRolloutReceiptSchema.parse(rawReceipt);
    return canonicalTransaction(async (client) => {
      await client.query(
        `INSERT INTO rorca.authority_execution_receipts
          (id, operation_id, workspace_id, receipt_payload, settled_at)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (operation_id) DO NOTHING`,
        [receipt.receiptId, receipt.operationId, receipt.workspaceId, JSON.stringify(receipt), receipt.settledAt],
      );
      const stored = await client.query<{ receipt_payload: unknown }>(
        `SELECT receipt_payload
           FROM rorca.authority_execution_receipts
          WHERE operation_id = $1 AND workspace_id = $2`,
        [receipt.operationId, receipt.workspaceId],
      );
      if (!stored.rows[0]) throw new ConflictError('Production rollout receipt could not be settled');
      const parsedStored = ProductionRolloutReceiptSchema.parse(jsonValue(stored.rows[0].receipt_payload));
      if (JSON.stringify(parsedStored) !== JSON.stringify(receipt)) {
        throw new ConflictError('Production rollout already settled with a different immutable receipt');
      }
      await client.query(
        `UPDATE rorca.authority_production_rollouts
            SET status = 'settled', updated_at = NOW()
          WHERE operation_id = $1 AND workspace_id = $2 AND status <> 'settled'`,
        [receipt.operationId, receipt.workspaceId],
      );
      await client.query(
        `UPDATE rorca.authority_deployment_operations
            SET status = 'settled'
          WHERE id = $1 AND workspace_id = $2 AND status IN ('dispatched', 'outcome_unknown', 'settled')`,
        [receipt.operationId, receipt.workspaceId],
      );
      return parsedStored;
    });
  }
}
