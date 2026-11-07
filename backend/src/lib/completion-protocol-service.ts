/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import type { PoolClient } from 'pg';
import { canonicalTransaction } from '../db';
import {
  AttemptTaskPlanV1Schema,
  CanonicalObligationSetV1Schema,
  CompletionGateDecisionV1Schema,
  ContinuationDirectiveV1Schema,
  FinalCompletionReportV1Schema,
  ProgressLedgerEntryV1Schema,
  ResultProposalV1Schema,
  WorkPackageV1Schema,
  governedHash,
  validateAttemptTaskPlan,
  validateContinuationDirective,
  validateFinalCompletionReport,
  validateResultProposal,
  type AttemptTaskPlanV1,
  type CanonicalObligationSetV1,
  type CompletionGateDecisionV1,
  type ContinuationDirectiveV1,
  type FinalCompletionReportV1,
  type ProgressLedgerEntryV1,
  type ResultProposalV1,
} from './governed-contracts';

const Sha256Pattern = /^sha256:[0-9a-f]{64}$/;
const TerminalAttemptStates = new Set(['submitted', 'blocked', 'cancelled', 'quarantined', 'escalated']);

export type CompletionMutationDisposition = 'accepted' | 'duplicate';
export interface CompletionMutationResult {
  disposition: CompletionMutationDisposition;
  operationKey: string;
  artifactHash: string;
}
export interface CanonicalCompletionProgressRecord {
  entry: ProgressLedgerEntryV1;
  event: Record<string, unknown>;
}
export type CompletionContinuationLifecycleState = ContinuationDirectiveV1['state'];
export interface CanonicalCompletionContinuationLifecycle {
  directive: ContinuationDirectiveV1;
  state: CompletionContinuationLifecycleState;
  dispatchId: string | null;
  dispatchReceiptHash: string | null;
  consumptionId: string | null;
  consumptionHash: string | null;
  consumedAt: string | null;
}
export interface CompletionTaskReceiptInput {
  workspaceId: string;
  attemptId: string;
  receiptId: string;
  operationKey: string;
  executionNonce: string;
  writerFence: number;
  receiptType: 'claim' | 'started' | 'settled' | 'validation' | 'self_review' | 'reconciled' | 'uncertain' | 'quarantined';
  outcome: 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain' | 'reconciled' | 'quarantined';
  resultHash: string;
  artifactHash: string;
  payload: Record<string, unknown>;
}
export interface CompletionContinuationDispatchInput {
  workspaceId: string;
  attemptId: string;
  directiveId: string;
  directiveRevision: number;
  directiveHash: string;
  continuationKey: string;
  dispatchId: string;
  leaseId: string;
  fencingToken: number;
}
export interface CompletionContinuationSettlementInput extends CompletionContinuationDispatchInput {
  dispatchReceiptHash: string;
}
export interface CompletionContinuationConsumptionInput extends CompletionContinuationSettlementInput {
  consumptionId: string;
}
export interface CompletionContinuationConsumptionResult extends CompletionMutationResult {
  directive: ContinuationDirectiveV1;
}
export function completionContinuationConsumptionHash(input: CompletionContinuationConsumptionInput): string {
  return governedHash('rorca.completion-continuation-consumption.v1', {
    ...input,
    contentHash: input.directiveHash,
  } as never);
}
export interface CompletionRecoveryEventInput {
  workspaceId: string;
  attemptId: string;
  recoveryGeneration: number;
  eventSequence: number;
  eventType: 'db_ahead' | 'ledger_ahead' | 'ledger_rebuilt' | 'suffix_quarantined' | 'attempt_quarantined' | 'nonce_reconciled' | 'writer_fenced';
  priorHash: string | null;
  eventHash: string;
  payload: Record<string, unknown>;
}

function requireHash(value: string, field: string): void {
  if (!Sha256Pattern.test(value)) throw new Error(`${field} must be a sha256 hash`);
}
function requireNonEmpty(value: string, field: string): void {
  if (!value || value.length > 256) throw new Error(`${field} is invalid`);
}
function requireRecord(value: unknown, field: string, maximumBytes = 262_144): asserts value is Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${field} must be an object`);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximumBytes) throw new Error(`${field} exceeds its byte limit`);
}
function throwViolations(label: string, result: { valid: boolean; violations: readonly { code: string; path: string }[] }): void {
  if (!result.valid) throw new Error(`${label} rejected: ${result.violations.map((item) => `${item.code}:${item.path}`).join(',')}`);
}
function operationKey(operation: string, workspaceId: string, artifactHash: string): string {
  return governedHash('rorca.completion-canonical-operation.v1', { operation, workspaceId, artifactHash } as never);
}
function requestHash(operation: string, artifact: unknown): string {
  return governedHash('rorca.completion-canonical-request.v1', { operation, artifact } as never);
}
async function setWorkspace(client: PoolClient, workspaceId: string): Promise<void> {
  requireNonEmpty(workspaceId, 'workspaceId');
  await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
}
async function authorize(client: PoolClient, operation: string, workspaceId: string, artifactHash: string, artifact: unknown): Promise<string> {
  requireHash(artifactHash, 'artifactHash');
  const hash = requestHash(operation, artifact);
  await client.query(`SELECT rorca.authorize_completion_protocol_mutation_v1($1,$2,$3,$4,$5::jsonb)`,
    [workspaceId, operation, hash, artifactHash, JSON.stringify({ artifact })]);
  return hash;
}
async function persistOperationReceipt(
  client: PoolClient,
  input: { workspaceId: string; attemptId: string | null; operation: string; operationKey: string; requestHash: string; artifactHash: string; disposition: CompletionMutationDisposition },
): Promise<void> {
  const response = { disposition: input.disposition, operationKey: input.operationKey, artifactHash: input.artifactHash };
  const responseHash = governedHash('rorca.completion-canonical-response.v1', response as never);
  const inserted = await client.query(`INSERT INTO rorca.completion_operation_receipts
    (workspace_id,operation_key,attempt_id,operation,request_hash,payload_hash,response_hash,outcome,artifact_hash,response_json)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    ON CONFLICT(workspace_id,operation_key) DO NOTHING RETURNING operation_key`, [
    input.workspaceId, input.operationKey, input.attemptId, input.operation, input.requestHash,
    input.artifactHash, responseHash, input.disposition, input.artifactHash, JSON.stringify(response),
  ]);
  if (inserted.rowCount === 1) return;
  const replay = await client.query<{ attempt_id: string | null; operation: string; request_hash: string; artifact_hash: string }>(
    `SELECT attempt_id,operation,request_hash,artifact_hash FROM rorca.completion_operation_receipts
      WHERE workspace_id=$1 AND operation_key=$2`,
    [input.workspaceId, input.operationKey],
  );
  const prior = replay.rows[0];
  if (!prior || prior.attempt_id !== input.attemptId || prior.operation !== input.operation
    || prior.request_hash !== input.requestHash || prior.artifact_hash !== input.artifactHash) {
    throw new Error('Completion operation replay conflicts with its durable receipt');
  }
}
async function existingHash(
  client: PoolClient,
  table: string,
  workspaceId: string,
  keyColumn: string,
  keyValue: string,
): Promise<string | null> {
  const allowed = new Set([
    'completion_obligation_sets:obligation_set_id', 'completion_task_plans:plan_id',
    'completion_result_proposals:proposal_id', 'completion_gate_decisions:decision_id',
    'completion_continuation_directives:directive_id', 'completion_final_reports:report_id',
  ]);
  if (!allowed.has(`${table}:${keyColumn}`)) throw new Error('Unsafe completion persistence query');
  const result = await client.query<{ artifact_hash: string }>(
    `SELECT artifact_hash FROM rorca.${table} WHERE workspace_id=$1 AND ${keyColumn}=$2 ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, keyValue],
  );
  return result.rows[0]?.artifact_hash ?? null;
}
function dispositionFor(existing: string | null, expected: string, identity: string): CompletionMutationDisposition {
  if (existing === null) return 'accepted';
  if (existing !== expected) throw new Error(`${identity} already exists with different immutable content`);
  return 'duplicate';
}

export async function activateCompletionAttempt(
  rawObligationSet: CanonicalObligationSetV1,
  retryMaximum: number,
): Promise<CompletionMutationResult> {
  const obligationSet = CanonicalObligationSetV1Schema.parse(rawObligationSet);
  if (!Number.isInteger(retryMaximum) || retryMaximum < 0 || retryMaximum > 3) throw new Error('retryMaximum must be between zero and three');
  const workspaceId = obligationSet.scope.workspaceId;
  const attemptId = obligationSet.scope.attemptId;
  const operation = 'completion.activate';
  const key = operationKey(operation, workspaceId, obligationSet.obligationSetHash);
  return canonicalTransaction(async (client) => {
    await setWorkspace(client, workspaceId);
    const authority = await client.query<{ lease_state: string; lease_fence: string; runtime_id: string; work_package_hash: string }>(`
      SELECT l.state lease_state,l.fencing_token::text lease_fence,l.runtime_id,w.work_package_hash
      FROM rorca.governed_execution_attempts a
      JOIN rorca.execution_leases l ON l.workspace_id=a.workspace_id AND l.attempt_id=a.attempt_id
      JOIN rorca.governed_work_package_revisions w ON w.workspace_id=a.workspace_id AND w.mission_id=a.mission_id
        AND w.work_package_id=a.work_package_id AND w.work_package_revision=a.work_package_revision
      WHERE a.workspace_id=$1 AND a.attempt_id=$2 AND l.lease_id=$3`,
    [workspaceId, attemptId, obligationSet.scope.leaseId]);
    const row = authority.rows[0];
    if (!row || row.lease_state !== 'active' || Number(row.lease_fence) !== obligationSet.scope.fencingToken
      || row.runtime_id !== obligationSet.scope.runtimeId || row.work_package_hash !== obligationSet.workPackageHash) {
      throw new Error('Completion activation requires the exact active governed lease, runtime, fence, and work package');
    }
    const prior = await existingHash(client, 'completion_obligation_sets', workspaceId, 'obligation_set_id', obligationSet.obligationSetId);
    const disposition = dispositionFor(prior, obligationSet.obligationSetHash, 'obligation set');
    const reqHash = await authorize(client, operation, workspaceId, obligationSet.obligationSetHash, obligationSet);
    if (disposition === 'accepted') {
      await client.query(`INSERT INTO rorca.completion_obligation_sets
        (workspace_id,obligation_set_id,obligation_set_revision,artifact_hash,attempt_id,lease_id,fencing_token,
         work_package_hash,manifest_hash,state,payload_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`, [workspaceId, obligationSet.obligationSetId,
        obligationSet.obligationSetRevision, obligationSet.obligationSetHash, attemptId, obligationSet.scope.leaseId,
        obligationSet.scope.fencingToken, obligationSet.workPackageHash, obligationSet.manifestHash, obligationSet.state,
        JSON.stringify(obligationSet)]);
      await client.query(`INSERT INTO rorca.completion_attempts
        (workspace_id,attempt_id,protocol_version,scope_hash,lease_id,fencing_token,runtime_id,obligation_set_id,
         obligation_set_revision,obligation_set_hash,state,writer_fence,retry_maximum,artifact_hash)
        VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$9)`, [workspaceId, attemptId,
        governedHash('rorca.completion-scope.v1', obligationSet.scope as never), obligationSet.scope.leaseId,
        obligationSet.scope.fencingToken, obligationSet.scope.runtimeId, obligationSet.obligationSetId,
        obligationSet.obligationSetRevision, obligationSet.obligationSetHash, obligationSet.scope.fencingToken, retryMaximum]);
    }
    await persistOperationReceipt(client, { workspaceId, attemptId, operation, operationKey: key, requestHash: reqHash,
      artifactHash: obligationSet.obligationSetHash, disposition });
    return { disposition, operationKey: key, artifactHash: obligationSet.obligationSetHash };
  });
}

export async function persistCompletionTaskPlan(rawPlan: AttemptTaskPlanV1): Promise<CompletionMutationResult> {
  const plan = AttemptTaskPlanV1Schema.parse(rawPlan);
  const { workspaceId, attemptId } = plan.scope;
  const operation = 'completion.plan';
  const key = operationKey(operation, workspaceId, plan.planHash);
  return canonicalTransaction(async (client) => {
    await setWorkspace(client, workspaceId);
    const records = await client.query<{ obligation: unknown; work_package: unknown; prior_plan: unknown | null }>(`
      SELECT o.payload_json obligation,w.payload_json work_package,
        (SELECT p.payload_json FROM rorca.completion_task_plans p WHERE p.workspace_id=o.workspace_id
          AND p.attempt_id=o.attempt_id AND p.plan_id=$4 AND p.plan_revision=$5) prior_plan
      FROM rorca.completion_obligation_sets o JOIN rorca.completion_attempts a USING(workspace_id,attempt_id)
      JOIN rorca.governed_execution_attempts ge USING(workspace_id,attempt_id)
      JOIN rorca.governed_work_package_revisions w ON w.workspace_id=ge.workspace_id AND w.mission_id=ge.mission_id
        AND w.work_package_id=ge.work_package_id AND w.work_package_revision=ge.work_package_revision
      WHERE o.workspace_id=$1 AND o.attempt_id=$2 AND o.artifact_hash=$3 AND o.state='active'`,
    [workspaceId, attemptId, plan.obligationSetHash, plan.planId, plan.planRevision - 1]);
    const row = records.rows[0];
    if (!row) throw new Error('Canonical obligation set or governed work package is absent');
    const obligationSet = CanonicalObligationSetV1Schema.parse(row.obligation);
    const workPackage = WorkPackageV1Schema.parse(row.work_package);
    const priorPlan = row.prior_plan ? AttemptTaskPlanV1Schema.parse(row.prior_plan) : null;
    throwViolations('attempt task plan', validateAttemptTaskPlan(plan, { workPackage, obligationSet, priorPlan }));
    const priorPlanHash = await client.query<{ artifact_hash: string }>(`SELECT artifact_hash FROM rorca.completion_task_plans
      WHERE workspace_id=$1 AND attempt_id=$2 AND plan_id=$3 AND plan_revision=$4`,
    [workspaceId, attemptId, plan.planId, plan.planRevision]);
    const prior = priorPlanHash.rows[0]?.artifact_hash ?? null;
    const disposition = dispositionFor(prior, plan.planHash, 'task plan');
    const reqHash = await authorize(client, operation, workspaceId, plan.planHash, plan);
    if (disposition === 'accepted') {
      await client.query(`UPDATE rorca.completion_attempts SET state='loading',state_version=state_version+1
        WHERE workspace_id=$1 AND attempt_id=$2 AND writer_fence=$3 AND state='pending'`,
      [workspaceId, attemptId, plan.scope.fencingToken]);
      await client.query(`INSERT INTO rorca.completion_task_plans
        (workspace_id,attempt_id,plan_id,plan_revision,plan_hash,prior_plan_hash,artifact_hash,payload_json)
        VALUES($1,$2,$3,$4,$5,$6,$5,$7::jsonb)`, [workspaceId, attemptId, plan.planId, plan.planRevision,
        plan.planHash, plan.priorPlanHash === 'not_applicable' ? null : plan.priorPlanHash, JSON.stringify(plan)]);
      const advanced = await client.query(`UPDATE rorca.completion_attempts SET current_plan_id=$3,current_plan_revision=$4,current_plan_hash=$5,
        state=CASE WHEN state='loading' THEN 'planning' ELSE state END,state_version=state_version+1
        WHERE workspace_id=$1 AND attempt_id=$2 AND writer_fence=$6 AND state IN('loading','planning')`,
      [workspaceId, attemptId, plan.planId, plan.planRevision, plan.planHash, plan.scope.fencingToken]);
      if (advanced.rowCount !== 1) throw new Error('Task plan attempt state or writer fence rejected');
    }
    await persistOperationReceipt(client, { workspaceId, attemptId, operation, operationKey: key, requestHash: reqHash,
      artifactHash: plan.planHash, disposition });
    return { disposition, operationKey: key, artifactHash: plan.planHash };
  });
}

export async function persistCompletionTaskReceipt(input: CompletionTaskReceiptInput): Promise<CompletionMutationResult> {
  requireNonEmpty(input.workspaceId, 'workspaceId'); requireNonEmpty(input.attemptId, 'attemptId');
  requireNonEmpty(input.receiptId, 'receiptId'); requireNonEmpty(input.executionNonce, 'executionNonce');
  requireHash(input.operationKey, 'operationKey'); requireHash(input.resultHash, 'resultHash'); requireHash(input.artifactHash, 'artifactHash');
  requireRecord(input.payload, 'payload');
  if (!Number.isInteger(input.writerFence) || input.writerFence <= 0) throw new Error('writerFence must be positive');
  const operation = 'completion.task-receipt';
  const key = operationKey(operation, input.workspaceId, input.artifactHash);
  return canonicalTransaction(async (client) => {
    await setWorkspace(client, input.workspaceId);
    const attempt = await client.query<{ writer_fence: string; state: string }>(
      `SELECT writer_fence::text,state FROM rorca.completion_attempts WHERE workspace_id=$1 AND attempt_id=$2`,
      [input.workspaceId, input.attemptId]);
    if (!attempt.rows[0] || Number(attempt.rows[0].writer_fence) !== input.writerFence || TerminalAttemptStates.has(attempt.rows[0].state)) {
      throw new Error('Task receipt is stale, terminal, or outside the writer fence');
    }
    const prior = await client.query<{ artifact_hash: string }>(`SELECT artifact_hash FROM rorca.completion_task_receipts
      WHERE workspace_id=$1 AND attempt_id=$2 AND operation_key=$3 AND receipt_type=$4`,
    [input.workspaceId, input.attemptId, input.operationKey, input.receiptType]);
    const disposition = dispositionFor(prior.rows[0]?.artifact_hash ?? null, input.artifactHash, 'task receipt');
    const reqHash = await authorize(client, operation, input.workspaceId, input.artifactHash, input);
    if (disposition === 'accepted') await client.query(`INSERT INTO rorca.completion_task_receipts
      (workspace_id,attempt_id,receipt_id,operation_key,execution_nonce,writer_fence,receipt_type,outcome,result_hash,artifact_hash,payload_json)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`, [input.workspaceId, input.attemptId, input.receiptId,
      input.operationKey, input.executionNonce, input.writerFence, input.receiptType, input.outcome, input.resultHash,
      input.artifactHash, JSON.stringify(input.payload)]);
    await persistOperationReceipt(client, { workspaceId: input.workspaceId, attemptId: input.attemptId, operation,
      operationKey: key, requestHash: reqHash, artifactHash: input.artifactHash, disposition });
    return { disposition, operationKey: key, artifactHash: input.artifactHash };
  });
}

export async function persistCompletionResultProposal(rawProposal: ResultProposalV1): Promise<CompletionMutationResult> {
  const proposal = ResultProposalV1Schema.parse(rawProposal);
  const { workspaceId, attemptId } = proposal.scope;
  const operation = 'completion.proposal';
  const key = operationKey(operation, workspaceId, proposal.proposalHash);
  return canonicalTransaction(async (client) => {
    await setWorkspace(client, workspaceId);
    const records = await client.query<{ plan: unknown; ledger_high_water_hash: string | null; state: string }>(`
      SELECT p.payload_json plan,a.ledger_high_water_hash,a.state FROM rorca.completion_attempts a
      JOIN rorca.completion_task_plans p ON p.workspace_id=a.workspace_id AND p.attempt_id=a.attempt_id
        AND p.plan_id=$3 AND p.plan_revision=$4
      WHERE a.workspace_id=$1 AND a.attempt_id=$2 AND p.plan_hash=$5`,
    [workspaceId, attemptId, proposal.planId, proposal.planRevision, proposal.planHash]);
    const row = records.rows[0];
    if (!row || !row.ledger_high_water_hash || TerminalAttemptStates.has(row.state)) throw new Error('Proposal requires a live attempt, exact plan, and durable ledger high-water');
    const plan = AttemptTaskPlanV1Schema.parse(row.plan);
    throwViolations('result proposal', validateResultProposal(proposal, { scope: proposal.scope, plan, ledgerHighWater: row.ledger_high_water_hash }));
    const priorProposalHash = await client.query<{ artifact_hash: string }>(`SELECT artifact_hash FROM rorca.completion_result_proposals
      WHERE workspace_id=$1 AND attempt_id=$2 AND proposal_id=$3 AND proposal_revision=$4`,
    [workspaceId, attemptId, proposal.proposalId, proposal.proposalRevision]);
    const prior = priorProposalHash.rows[0]?.artifact_hash ?? null;
    const disposition = dispositionFor(prior, proposal.proposalHash, 'result proposal');
    const reqHash = await authorize(client, operation, workspaceId, proposal.proposalHash, proposal);
    if (disposition === 'accepted') {
      await client.query(`UPDATE rorca.completion_attempts SET state='proposing',state_version=state_version+1
        WHERE workspace_id=$1 AND attempt_id=$2 AND writer_fence=$3 AND state='self_reviewing'`,
      [workspaceId, attemptId, proposal.scope.fencingToken]);
      await client.query(`INSERT INTO rorca.completion_result_proposals
        (workspace_id,attempt_id,proposal_id,proposal_revision,proposal_hash,disposition,artifact_hash,payload_json)
        VALUES($1,$2,$3,$4,$5,$6,$5,$7::jsonb)`, [workspaceId, attemptId, proposal.proposalId, proposal.proposalRevision,
        proposal.proposalHash, proposal.disposition, JSON.stringify(proposal)]);
      const advanced = await client.query(`UPDATE rorca.completion_attempts SET current_proposal_id=$3,current_proposal_revision=$4,
        current_proposal_hash=$5,state='gate_wait',state_version=state_version+1 WHERE workspace_id=$1 AND attempt_id=$2
        AND writer_fence=$6 AND state='proposing'`, [workspaceId, attemptId, proposal.proposalId, proposal.proposalRevision,
        proposal.proposalHash, proposal.scope.fencingToken]);
      if (advanced.rowCount !== 1) throw new Error('Result proposal attempt state or writer fence rejected');
    }
    await persistOperationReceipt(client, { workspaceId, attemptId, operation, operationKey: key, requestHash: reqHash,
      artifactHash: proposal.proposalHash, disposition });
    return { disposition, operationKey: key, artifactHash: proposal.proposalHash };
  });
}

export async function persistCompletionGateDecision(rawDecision: CompletionGateDecisionV1): Promise<CompletionMutationResult> {
  const decision = CompletionGateDecisionV1Schema.parse(rawDecision);
  const { workspaceId, attemptId } = decision.scope;
  const operation = 'completion.gate';
  const key = operationKey(operation, workspaceId, decision.decisionHash);
  return canonicalTransaction(async (client) => {
    await setWorkspace(client, workspaceId);
    const subject = await client.query<{ proposal_hash: string; state: string; writer_fence: string }>(`
      SELECT p.proposal_hash,a.state,a.writer_fence::text FROM rorca.completion_attempts a
      JOIN rorca.completion_result_proposals p ON p.workspace_id=a.workspace_id AND p.attempt_id=a.attempt_id
        AND p.proposal_id=$3 AND p.proposal_revision=$4 WHERE a.workspace_id=$1 AND a.attempt_id=$2`,
    [workspaceId, attemptId, decision.proposalId, decision.proposalRevision]);
    const row = subject.rows[0];
    if (!row || row.proposal_hash !== decision.proposalHash || row.state !== 'gate_wait'
      || Number(row.writer_fence) !== decision.scope.fencingToken) throw new Error('Gate decision subject is stale or not awaiting a gate');
    const priorDecisionHash = await client.query<{ artifact_hash: string }>(`SELECT artifact_hash FROM rorca.completion_gate_decisions
      WHERE workspace_id=$1 AND attempt_id=$2 AND decision_id=$3 AND decision_revision=$4`,
    [workspaceId, attemptId, decision.decisionId, decision.decisionRevision]);
    const prior = priorDecisionHash.rows[0]?.artifact_hash ?? null;
    const disposition = dispositionFor(prior, decision.decisionHash, 'gate decision');
    const reqHash = await authorize(client, operation, workspaceId, decision.decisionHash, decision);
    if (disposition === 'accepted') {
      await client.query(`INSERT INTO rorca.completion_gate_decisions
        (workspace_id,attempt_id,decision_id,decision_revision,decision_hash,proposal_id,proposal_revision,proposal_hash,
         stage,outcome,next_action,establishes_story_completion,artifact_hash,payload_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,FALSE,$5,$12::jsonb)`, [workspaceId, attemptId,
        decision.decisionId, decision.decisionRevision, decision.decisionHash, decision.proposalId,
        decision.proposalRevision, decision.proposalHash, decision.stage, decision.outcome, decision.nextAction,
        JSON.stringify(decision)]);
      const nextState = 'gate_wait';
      const advanced = await client.query(`UPDATE rorca.completion_attempts SET current_gate_decision_id=$3,current_gate_decision_hash=$4,
        state=$5,state_version=state_version+1 WHERE workspace_id=$1 AND attempt_id=$2 AND writer_fence=$6 AND state='gate_wait'`,
      [workspaceId, attemptId, decision.decisionId, decision.decisionHash, nextState, decision.scope.fencingToken]);
      if (advanced.rowCount !== 1) throw new Error('Gate decision attempt state or writer fence rejected');
    }
    await persistOperationReceipt(client, { workspaceId, attemptId, operation, operationKey: key, requestHash: reqHash,
      artifactHash: decision.decisionHash, disposition });
    return { disposition, operationKey: key, artifactHash: decision.decisionHash };
  });
}

export async function persistCompletionContinuationDirective(rawDirective: ContinuationDirectiveV1): Promise<CompletionMutationResult> {
  const directive = ContinuationDirectiveV1Schema.parse(rawDirective);
  if (directive.state !== 'authorized') throw new Error('Continuation directives may only be created in authorized state');
  const { workspaceId, attemptId } = directive.scope;
  const operation = 'completion.continuation';
  const key = operationKey(operation, workspaceId, directive.directiveHash);
  return canonicalTransaction(async (client) => {
    await setWorkspace(client, workspaceId);
    const records = await client.query<{ decision: unknown; attempt_state: string; retry_maximum: number; closeout_status: string | null }>(`
      SELECT d.payload_json decision,a.state attempt_state,a.retry_maximum,
        (SELECT s.status FROM rorca.story_closeout_decisions s JOIN rorca.governed_execution_attempts ge
          ON ge.workspace_id=s.workspace_id AND ge.run_id=s.run_id AND ge.story_id=s.story_id
          WHERE ge.workspace_id=a.workspace_id AND ge.attempt_id=a.attempt_id ORDER BY s.created_at DESC LIMIT 1) closeout_status
      FROM rorca.completion_gate_decisions d JOIN rorca.completion_attempts a USING(workspace_id,attempt_id)
      WHERE d.workspace_id=$1 AND d.attempt_id=$2 AND d.decision_id=$3 AND d.decision_revision=$4
      FOR KEY SHARE OF d,a`,
    [workspaceId, attemptId, directive.priorDecisionId, directive.priorDecisionRevision]);
    const row = records.rows[0];
    if (!row) throw new Error('Continuation gate decision is absent');
    const decision = CompletionGateDecisionV1Schema.parse(row.decision);
    const candidateState = row.closeout_status === 'accepted' ? 'accepted'
      : row.attempt_state === 'submitted' ? 'submitted_to_closeout'
        : row.attempt_state === 'cancelled' ? 'cancelled' : 'open';
    throwViolations('continuation directive', validateContinuationDirective(directive, {
      decision, candidateState, retryMaximum: row.retry_maximum,
    }));
    const priorDirectiveHash = await client.query<{ artifact_hash: string }>(`SELECT artifact_hash FROM rorca.completion_continuation_directives
      WHERE workspace_id=$1 AND attempt_id=$2 AND directive_id=$3 AND directive_revision=$4`,
    [workspaceId, attemptId, directive.directiveId, directive.directiveRevision]);
    const prior = priorDirectiveHash.rows[0]?.artifact_hash ?? null;
    const disposition = dispositionFor(prior, directive.directiveHash, 'continuation directive');
    const reqHash = await authorize(client, operation, workspaceId, directive.directiveHash, directive);
    if (disposition === 'accepted') await client.query(`INSERT INTO rorca.completion_continuation_directives
      (workspace_id,attempt_id,directive_id,directive_revision,directive_hash,continuation_key,prior_decision_id,
       prior_decision_revision,state,dispatch_id,artifact_hash,payload_json)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'authorized',NULL,$5,$9::jsonb)`, [workspaceId, attemptId, directive.directiveId,
      directive.directiveRevision, directive.directiveHash, directive.continuationKey, directive.priorDecisionId,
      directive.priorDecisionRevision, JSON.stringify(directive)]);
    await persistOperationReceipt(client, { workspaceId, attemptId, operation, operationKey: key, requestHash: reqHash,
      artifactHash: directive.directiveHash, disposition });
    return { disposition, operationKey: key, artifactHash: directive.directiveHash };
  });
}

function validateContinuationTransitionInput(input: CompletionContinuationDispatchInput): void {
  requireNonEmpty(input.workspaceId, 'workspaceId'); requireNonEmpty(input.attemptId, 'attemptId');
  requireNonEmpty(input.directiveId, 'directiveId'); requireNonEmpty(input.dispatchId, 'dispatchId');
  requireNonEmpty(input.leaseId, 'leaseId'); requireHash(input.directiveHash, 'directiveHash');
  requireHash(input.continuationKey, 'continuationKey');
  if (!Number.isInteger(input.directiveRevision) || input.directiveRevision <= 0
    || !Number.isInteger(input.fencingToken) || input.fencingToken <= 0) {
    throw new Error('Continuation directive revision and fencing token must be positive integers');
  }
}

export async function dispatchCompletionContinuationDirective(
  input: CompletionContinuationDispatchInput,
): Promise<CompletionMutationResult> {
  validateContinuationTransitionInput(input);
  const operation = 'completion.continuation-dispatch';
  const key = operationKey(operation, input.workspaceId, input.directiveHash);
  const artifact = { ...input, contentHash: input.directiveHash };
  return canonicalTransaction(async (client) => {
    await setWorkspace(client, input.workspaceId);
    const current = await client.query<{ state: string; dispatch_id: string | null; directive_hash: string; continuation_key: string }>(
      `SELECT state,dispatch_id,directive_hash,continuation_key FROM rorca.completion_continuation_directives
       WHERE workspace_id=$1 AND attempt_id=$2 AND directive_id=$3 AND directive_revision=$4 FOR UPDATE`,
      [input.workspaceId, input.attemptId, input.directiveId, input.directiveRevision],
    );
    const row = current.rows[0];
    if (!row || row.directive_hash !== input.directiveHash || row.continuation_key !== input.continuationKey) {
      throw new Error('Continuation dispatch subject is absent or conflicts with the exact directive');
    }
    if (row.dispatch_id !== null && row.dispatch_id !== input.dispatchId) {
      throw new Error('Continuation directive is already bound to a different dispatch');
    }
    const durable = await client.query(`SELECT 1 FROM rorca.continuation_dispatches d
      JOIN rorca.execution_leases l ON l.workspace_id=d.workspace_id AND l.lease_id=d.lease_id
      JOIN rorca.continuation_dispatch_consumptions c ON c.workspace_id=d.workspace_id AND c.dispatch_id=d.dispatch_id
        AND c.continuation_key=d.continuation_key
      JOIN rorca.continuation_dispatch_outbox o ON o.workspace_id=d.workspace_id AND o.dispatch_id=d.dispatch_id
        AND o.continuation_key=d.continuation_key
      WHERE d.workspace_id=$1 AND d.dispatch_id=$2 AND d.continuation_key=$3 AND d.lease_id=$4
        AND d.fencing_token=$5 AND l.attempt_id=$6 AND d.state IN('dispatched','settled')
        AND d.payload_json->'scope'=(SELECT payload_json->'scope' FROM rorca.completion_continuation_directives
          WHERE workspace_id=$1 AND attempt_id=$6 AND directive_id=$7 AND directive_revision=$8)`,
    [input.workspaceId, input.dispatchId, input.continuationKey, input.leaseId, input.fencingToken,
      input.attemptId, input.directiveId, input.directiveRevision]);
    if (durable.rowCount !== 1) throw new Error('Continuation dispatch lacks its exact durable dispatched row and consumption receipt');
    const disposition: CompletionMutationDisposition = row.state === 'authorized' ? 'accepted' : 'duplicate';
    if (!['authorized', 'dispatched', 'settled'].includes(row.state)) throw new Error('Continuation dispatch CAS state rejected');
    const reqHash = await authorize(client, operation, input.workspaceId, input.directiveHash, artifact);
    if (disposition === 'accepted') {
      const advanced = await client.query(`UPDATE rorca.completion_continuation_directives SET state='dispatched',dispatch_id=$5
        WHERE workspace_id=$1 AND attempt_id=$2 AND directive_id=$3 AND directive_revision=$4
          AND state='authorized' AND dispatch_id IS NULL`, [input.workspaceId, input.attemptId,
        input.directiveId, input.directiveRevision, input.dispatchId]);
      if (advanced.rowCount !== 1) throw new Error('Continuation dispatch CAS transition lost');
    }
    await persistOperationReceipt(client, { workspaceId: input.workspaceId, attemptId: input.attemptId, operation,
      operationKey: key, requestHash: reqHash, artifactHash: input.directiveHash, disposition });
    return { disposition, operationKey: key, artifactHash: input.directiveHash };
  });
}

export async function settleCompletionContinuationDirective(
  input: CompletionContinuationSettlementInput,
): Promise<CompletionMutationResult> {
  validateContinuationTransitionInput(input); requireHash(input.dispatchReceiptHash, 'dispatchReceiptHash');
  const operation = 'completion.continuation-settle';
  const key = operationKey(operation, input.workspaceId, input.directiveHash);
  const artifact = { ...input, contentHash: input.directiveHash };
  return canonicalTransaction(async (client) => {
    await setWorkspace(client, input.workspaceId);
    const current = await client.query<{ state: string; dispatch_id: string | null; dispatch_receipt_hash: string | null; directive_hash: string; continuation_key: string }>(
      `SELECT state,dispatch_id,dispatch_receipt_hash,directive_hash,continuation_key
       FROM rorca.completion_continuation_directives
       WHERE workspace_id=$1 AND attempt_id=$2 AND directive_id=$3 AND directive_revision=$4 FOR UPDATE`,
      [input.workspaceId, input.attemptId, input.directiveId, input.directiveRevision],
    );
    const row = current.rows[0];
    if (!row || row.directive_hash !== input.directiveHash || row.continuation_key !== input.continuationKey
      || row.dispatch_id !== input.dispatchId) throw new Error('Continuation settlement subject conflicts with its exact dispatch');
    if (row.dispatch_receipt_hash !== null && row.dispatch_receipt_hash !== input.dispatchReceiptHash) {
      throw new Error('Continuation directive is already settled by a different receipt');
    }
    const receipt = await client.query(`SELECT 1 FROM rorca.continuation_dispatches d
      JOIN rorca.execution_leases l ON l.workspace_id=d.workspace_id AND l.lease_id=d.lease_id
      JOIN rorca.continuation_dispatch_outbox o ON o.workspace_id=d.workspace_id AND o.dispatch_id=d.dispatch_id
        AND o.continuation_key=d.continuation_key
      JOIN rorca.continuation_dispatch_acceptances a ON a.workspace_id=o.workspace_id AND a.dispatch_id=o.dispatch_id
        AND a.acceptance_receipt_hash=o.receiver_acceptance_receipt_hash
      WHERE d.workspace_id=$1 AND d.dispatch_id=$2 AND d.continuation_key=$3 AND d.lease_id=$4
        AND d.fencing_token=$5 AND l.attempt_id=$6 AND d.state='settled' AND o.state='sent'
        AND a.acceptance_receipt_hash=$7 AND a.delivery_key=o.delivery_key AND a.payload_hash=o.payload_hash
        AND d.payload_json->'scope'=(SELECT payload_json->'scope' FROM rorca.completion_continuation_directives
          WHERE workspace_id=$1 AND attempt_id=$6 AND directive_id=$8 AND directive_revision=$9)`,
    [input.workspaceId, input.dispatchId, input.continuationKey, input.leaseId, input.fencingToken,
      input.attemptId, input.dispatchReceiptHash, input.directiveId, input.directiveRevision]);
    if (receipt.rowCount !== 1) throw new Error('Continuation settlement lacks one exact durable receiver acceptance receipt');
    const disposition: CompletionMutationDisposition = row.state === 'dispatched' ? 'accepted' : 'duplicate';
    if (!['dispatched', 'settled'].includes(row.state)) throw new Error('Continuation settlement CAS state rejected');
    const reqHash = await authorize(client, operation, input.workspaceId, input.directiveHash, artifact);
    if (disposition === 'accepted') {
      const advanced = await client.query(`UPDATE rorca.completion_continuation_directives
        SET state='settled',dispatch_receipt_hash=$5 WHERE workspace_id=$1 AND attempt_id=$2
          AND directive_id=$3 AND directive_revision=$4 AND state='dispatched' AND dispatch_id=$6
          AND dispatch_receipt_hash IS NULL`, [input.workspaceId, input.attemptId, input.directiveId,
        input.directiveRevision, input.dispatchReceiptHash, input.dispatchId]);
      if (advanced.rowCount !== 1) throw new Error('Continuation settlement CAS transition lost');
    }
    await persistOperationReceipt(client, { workspaceId: input.workspaceId, attemptId: input.attemptId, operation,
      operationKey: key, requestHash: reqHash, artifactHash: input.directiveHash, disposition });
    return { disposition, operationKey: key, artifactHash: input.directiveHash };
  });
}

export async function consumeCompletionContinuationDirective(
  input: CompletionContinuationConsumptionInput,
): Promise<CompletionContinuationConsumptionResult> {
  validateContinuationTransitionInput(input); requireHash(input.dispatchReceiptHash, 'dispatchReceiptHash');
  requireNonEmpty(input.consumptionId, 'consumptionId');
  const operation = 'completion.continuation-consume';
  const key = operationKey(operation, input.workspaceId, input.directiveHash);
  const artifact = { ...input, contentHash: input.directiveHash };
  const consumptionHash = completionContinuationConsumptionHash(input);
  return canonicalTransaction(async (client) => {
    await setWorkspace(client, input.workspaceId);
    const current = await client.query<{ state: string; dispatch_id: string | null; dispatch_receipt_hash: string | null;
      consumption_id: string | null; consumption_hash: string | null; payload_json: unknown; retry_maximum: number;
      decision: unknown; attempt_state: string; closeout_status: string | null }>(`
      SELECT c.state,c.dispatch_id,c.dispatch_receipt_hash,c.consumption_id,c.consumption_hash,c.payload_json,
        a.retry_maximum,d.payload_json decision,a.state attempt_state,
        (SELECT s.status FROM rorca.story_closeout_decisions s JOIN rorca.governed_execution_attempts ge
          ON ge.workspace_id=s.workspace_id AND ge.run_id=s.run_id AND ge.story_id=s.story_id
          WHERE ge.workspace_id=a.workspace_id AND ge.attempt_id=a.attempt_id ORDER BY s.created_at DESC LIMIT 1) closeout_status
      FROM rorca.completion_continuation_directives c
      JOIN rorca.completion_attempts a USING(workspace_id,attempt_id)
      JOIN rorca.completion_gate_decisions d ON d.workspace_id=c.workspace_id AND d.attempt_id=c.attempt_id
        AND d.decision_id=c.prior_decision_id AND d.decision_revision=c.prior_decision_revision
      WHERE c.workspace_id=$1 AND c.attempt_id=$2 AND c.directive_id=$3 AND c.directive_revision=$4 FOR UPDATE OF c`,
    [input.workspaceId, input.attemptId, input.directiveId, input.directiveRevision]);
    const row = current.rows[0];
    const directive = ContinuationDirectiveV1Schema.parse(row?.payload_json);
    if (!row || row.state !== 'settled' || row.dispatch_id !== input.dispatchId
      || row.dispatch_receipt_hash !== input.dispatchReceiptHash
      || directive.directiveHash !== input.directiveHash || directive.continuationKey !== input.continuationKey
      || directive.scope.leaseId !== input.leaseId || directive.scope.fencingToken !== input.fencingToken) {
      throw new Error('Continuation consumption requires the exact receipt-verified settled directive');
    }
    const decision = CompletionGateDecisionV1Schema.parse(row.decision);
    const candidateState = row.closeout_status === 'accepted' ? 'accepted'
      : row.attempt_state === 'submitted' ? 'submitted_to_closeout'
        : row.attempt_state === 'cancelled' ? 'cancelled' : 'open';
    throwViolations('continuation consumption', validateContinuationDirective(directive, {
      decision, candidateState, retryMaximum: row.retry_maximum,
    }));
    const receipt = await client.query(`SELECT 1 FROM rorca.continuation_dispatch_acceptances a
      JOIN rorca.continuation_dispatch_outbox o ON o.workspace_id=a.workspace_id AND o.dispatch_id=a.dispatch_id
      JOIN rorca.continuation_dispatches d ON d.workspace_id=a.workspace_id AND d.dispatch_id=a.dispatch_id
      WHERE a.workspace_id=$1 AND a.dispatch_id=$2 AND d.continuation_key=$3 AND d.state='settled'
        AND o.state='sent' AND a.acceptance_receipt_hash=$4
        AND o.receiver_acceptance_receipt_hash=a.acceptance_receipt_hash`,
    [input.workspaceId, input.dispatchId, input.continuationKey, input.dispatchReceiptHash]);
    if (receipt.rowCount !== 1) throw new Error('Continuation consumption receipt is no longer canonical');
    if (row.consumption_id !== null && (row.consumption_id !== input.consumptionId || row.consumption_hash !== consumptionHash)) {
      throw new Error('Settled continuation was already consumed by a different exact request');
    }
    const disposition: CompletionMutationDisposition = row.consumption_id === null ? 'accepted' : 'duplicate';
    const reqHash = await authorize(client, operation, input.workspaceId, input.directiveHash, artifact);
    if (disposition === 'accepted') {
      const consumed = await client.query(`UPDATE rorca.completion_continuation_directives
        SET consumption_id=$5,consumption_hash=$6,consumed_at=clock_timestamp()
        WHERE workspace_id=$1 AND attempt_id=$2 AND directive_id=$3 AND directive_revision=$4
          AND state='settled' AND consumption_id IS NULL`, [input.workspaceId, input.attemptId,
        input.directiveId, input.directiveRevision, input.consumptionId, consumptionHash]);
      if (consumed.rowCount !== 1) throw new Error('Continuation consumption CAS transition lost');
    }
    await persistOperationReceipt(client, { workspaceId: input.workspaceId, attemptId: input.attemptId, operation,
      operationKey: key, requestHash: reqHash, artifactHash: input.directiveHash, disposition });
    return { disposition, operationKey: key, artifactHash: input.directiveHash, directive };
  });
}

export async function persistCompletionRecoveryEvent(input: CompletionRecoveryEventInput): Promise<CompletionMutationResult> {
  requireNonEmpty(input.workspaceId, 'workspaceId'); requireNonEmpty(input.attemptId, 'attemptId');
  requireHash(input.eventHash, 'eventHash'); if (input.priorHash !== null) requireHash(input.priorHash, 'priorHash');
  requireRecord(input.payload, 'payload');
  if (!Number.isInteger(input.recoveryGeneration) || input.recoveryGeneration < 0
    || !Number.isInteger(input.eventSequence) || input.eventSequence < 0) throw new Error('Recovery generation and sequence must be non-negative integers');
  const operation = 'completion.recovery';
  const key = operationKey(operation, input.workspaceId, input.eventHash);
  return canonicalTransaction(async (client) => {
    await setWorkspace(client, input.workspaceId);
    const prior = await client.query<{ artifact_hash: string }>(`SELECT artifact_hash FROM rorca.completion_recovery_events
      WHERE workspace_id=$1 AND attempt_id=$2 AND recovery_generation=$3 AND event_sequence=$4`,
    [input.workspaceId, input.attemptId, input.recoveryGeneration, input.eventSequence]);
    const disposition = dispositionFor(prior.rows[0]?.artifact_hash ?? null, input.eventHash, 'recovery event');
    const reqHash = await authorize(client, operation, input.workspaceId, input.eventHash, input);
    if (disposition === 'accepted') await client.query(`INSERT INTO rorca.completion_recovery_events
      (workspace_id,attempt_id,recovery_generation,event_sequence,event_type,prior_hash,event_hash,artifact_hash,payload_json)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8::jsonb)`, [input.workspaceId, input.attemptId,
      input.recoveryGeneration, input.eventSequence, input.eventType, input.priorHash, input.eventHash, JSON.stringify(input.payload)]);
    await persistOperationReceipt(client, { workspaceId: input.workspaceId, attemptId: input.attemptId, operation,
      operationKey: key, requestHash: reqHash, artifactHash: input.eventHash, disposition });
    return { disposition, operationKey: key, artifactHash: input.eventHash };
  });
}

export async function persistFinalCompletionReport(rawReport: FinalCompletionReportV1): Promise<CompletionMutationResult> {
  const report = FinalCompletionReportV1Schema.parse(rawReport);
  const { workspaceId, attemptId } = report.scope;
  const operation = 'completion.final-report';
  const key = operationKey(operation, workspaceId, report.contentHash);
  return canonicalTransaction(async (client) => {
    await setWorkspace(client, workspaceId);
    const records = await client.query<{ closeout_id: string; closeout_status: 'accepted' | 'blocked';
      decision: unknown; proposal: unknown }>(`
      SELECT s.decision_id closeout_id,s.status closeout_status,d.payload_json decision,p.payload_json proposal
      FROM rorca.story_closeout_decisions s
      JOIN rorca.governed_execution_attempts ge ON ge.workspace_id=s.workspace_id
        AND ge.run_id=s.run_id AND ge.story_id=s.story_id AND ge.manifest_hash=s.manifest_hash
      JOIN rorca.completion_gate_decisions d ON d.workspace_id=ge.workspace_id
        AND d.attempt_id=ge.attempt_id AND d.decision_id=$3
      JOIN rorca.completion_result_proposals p ON p.workspace_id=d.workspace_id AND p.attempt_id=d.attempt_id
        AND p.proposal_id=d.proposal_id AND p.proposal_revision=d.proposal_revision
      WHERE ge.workspace_id=$1 AND ge.attempt_id=$2 AND s.decision_id=$4 AND s.status='accepted'`,
    [workspaceId, attemptId, report.gateDecisionId, report.storyCloseoutDecisionId]);
    const row = records.rows[0];
    if (!row) throw new Error('Exact accepted closeout, gate decision, or result proposal is absent');
    const decision = CompletionGateDecisionV1Schema.parse(row.decision);
    const proposal = ResultProposalV1Schema.parse(row.proposal);
    throwViolations('final completion report', validateFinalCompletionReport(report, {
      closeoutDecision: { decisionId: row.closeout_id, status: row.closeout_status }, gateDecision: decision, proposal,
    }));
    const authority = await client.query<{ story_attempt_result_id: string; story_manifest_hash: string; active_subject_sha: string }>(
      `SELECT story_attempt_result_id,story_manifest_hash,active_subject_sha
       FROM rorca.completion_final_report_authority_subject_v1($1,$2,$3::jsonb)`,
      [workspaceId, attemptId, JSON.stringify(report)],
    );
    const exactSubject = authority.rows[0];
    if (!exactSubject || exactSubject.active_subject_sha !== report.finalSha
      || report.scope.repository.currentSha !== exactSubject.active_subject_sha) {
      throw new Error('Final completion report repository revision or immutable closeout lineage differs');
    }
    const prior = await existingHash(client, 'completion_final_reports', workspaceId, 'report_id', report.reportId);
    const disposition = dispositionFor(prior, report.contentHash, 'final completion report');
    const reqHash = await authorize(client, operation, workspaceId, report.contentHash, report);
    if (disposition === 'accepted') await client.query(`INSERT INTO rorca.completion_final_reports
      (workspace_id,attempt_id,report_id,report_hash,story_closeout_decision_id,story_attempt_result_id,
       story_manifest_hash,active_subject_sha,gate_decision_id,gate_decision_hash,proposal_id,proposal_hash,
       final_sha,tree_hash,diff_hash,merge_ready,merged,deployed,production_approved,artifact_hash,payload_json)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,FALSE,FALSE,FALSE,$4,$17::jsonb)`,
    [workspaceId, attemptId, report.reportId, report.contentHash, report.storyCloseoutDecisionId,
      exactSubject.story_attempt_result_id, exactSubject.story_manifest_hash, exactSubject.active_subject_sha, report.gateDecisionId,
      report.gateDecisionHash, report.proposalId, report.proposalHash, report.finalSha, report.treeHash,
      report.diffHash, report.mergeReady, JSON.stringify(report)]);
    await persistOperationReceipt(client, { workspaceId, attemptId, operation, operationKey: key, requestHash: reqHash,
      artifactHash: report.contentHash, disposition });
    return { disposition, operationKey: key, artifactHash: report.contentHash };
  });
}

export async function persistCompletionProgressEntry(
  rawEntry: ProgressLedgerEntryV1,
  eventPayload: Record<string, unknown>,
  expectedStateVersion: number,
  nextState?: 'loading' | 'planning' | 'executing' | 'validating' | 'self_reviewing' | 'proposing' | 'submitted' | 'blocked' | 'cancelled' | 'quarantined' | 'escalated',
): Promise<CompletionMutationResult> {
  const entry = ProgressLedgerEntryV1Schema.parse(rawEntry);
  requireRecord(eventPayload, 'eventPayload');
  if (entry.payloadHash !== governedHash('rorca.completion-durable-event.v1', eventPayload as never)) {
    throw new Error('Progress entry payload hash does not bind the exact durable event');
  }
  const { workspaceId, attemptId } = entry.scope;
  if (!Number.isInteger(expectedStateVersion) || expectedStateVersion <= 0) throw new Error('Expected state version is invalid');
  const operation = 'completion.progress-entry';
  const key = operationKey(operation, workspaceId, entry.entryHash);
  return canonicalTransaction(async (client) => {
    await setWorkspace(client, workspaceId);
    const attempt = await client.query<{ ledger_high_water: string; ledger_high_water_hash: string | null; state_version: string; writer_fence: string; state: string }>(
      `SELECT ledger_high_water::text,ledger_high_water_hash,state_version::text,writer_fence::text,state
       FROM rorca.completion_attempts WHERE workspace_id=$1 AND attempt_id=$2`, [workspaceId, attemptId]);
    const head = attempt.rows[0];
    if (!head || Number(head.writer_fence) !== entry.writerFence || Number(head.state_version) !== expectedStateVersion
      || (TerminalAttemptStates.has(head.state) && entry.entryType !== 'recovery_recorded')) {
      throw new Error('Progress entry CAS, writer fence, or attempt state rejected');
    }
    const existing = await client.query<{ artifact_hash: string }>(`SELECT artifact_hash FROM rorca.completion_progress_entries
      WHERE workspace_id=$1 AND attempt_id=$2 AND sequence=$3`, [workspaceId, attemptId, entry.sequence]);
    const prior = existing.rows[0]?.artifact_hash ?? null;
    const disposition = dispositionFor(prior, entry.entryHash, 'progress entry');
    if (disposition === 'accepted' && (entry.sequence !== Number(head.ledger_high_water) + 1
      || (entry.sequence === 0 ? entry.priorEntryHash !== 'not_applicable' : entry.priorEntryHash !== head.ledger_high_water_hash))) {
      throw new Error('Progress entry does not extend the canonical database high-water exactly once');
    }
    const reqHash = await authorize(client, operation, workspaceId, entry.entryHash, entry);
    if (disposition === 'accepted') {
      await client.query(`INSERT INTO rorca.completion_progress_entries
        (workspace_id,attempt_id,sequence,prior_entry_hash,entry_hash,writer_fence,plan_id,plan_revision,plan_hash,
         repository_sha,entry_type,payload_hash,artifact_hash,payload_json,event_json,recorded_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$5,$13::jsonb,$14::jsonb,$15)`, [workspaceId, attemptId,
        entry.sequence, entry.priorEntryHash === 'not_applicable' ? null : entry.priorEntryHash, entry.entryHash,
        entry.writerFence, entry.planId, entry.planRevision, entry.planHash, entry.repositorySha, entry.entryType,
        entry.payloadHash, JSON.stringify(entry), JSON.stringify(eventPayload), entry.recordedAt]);
      const updated = await client.query(`UPDATE rorca.completion_attempts SET ledger_high_water=$5,ledger_high_water_hash=$6,
        state=COALESCE($7,state),state_version=state_version+1 WHERE workspace_id=$1 AND attempt_id=$2 AND writer_fence=$3
        AND state_version=$4 AND (state NOT IN('submitted','blocked','cancelled','quarantined','escalated') OR $8='recovery_recorded')`, [workspaceId,
        attemptId, entry.writerFence, expectedStateVersion, entry.sequence, entry.entryHash, nextState ?? null, entry.entryType]);
      if (updated.rowCount !== 1) throw new Error('Progress entry canonical high-water CAS rejected');
    }
    await persistOperationReceipt(client, { workspaceId, attemptId, operation, operationKey: key, requestHash: reqHash,
      artifactHash: entry.entryHash, disposition });
    return { disposition, operationKey: key, artifactHash: entry.entryHash };
  });
}

export async function loadCanonicalCompletionProgressRecords(
  workspaceId: string,
  attemptId: string,
): Promise<readonly CanonicalCompletionProgressRecord[]> {
  return canonicalTransaction(async (client) => {
    await setWorkspace(client, workspaceId);
    const result = await client.query<{ payload_json: unknown; event_json: unknown }>(
      `SELECT payload_json,event_json FROM rorca.completion_progress_entries
       WHERE workspace_id=$1 AND attempt_id=$2 ORDER BY sequence ASC`, [workspaceId, attemptId]);
    return result.rows.map((row) => {
      requireRecord(row.event_json, 'canonical event');
      const entry = ProgressLedgerEntryV1Schema.parse(row.payload_json);
      if (entry.payloadHash !== governedHash('rorca.completion-durable-event.v1', row.event_json as never)) {
        throw new Error('Canonical progress event payload hash mismatch');
      }
      return { entry, event: row.event_json };
    });
  });
}

export async function loadCanonicalCompletionContinuationLifecycles(
  workspaceId: string,
  attemptId: string,
): Promise<readonly CanonicalCompletionContinuationLifecycle[]> {
  requireNonEmpty(workspaceId, 'workspaceId');
  requireNonEmpty(attemptId, 'attemptId');
  return canonicalTransaction(async (client) => {
    await setWorkspace(client, workspaceId);
    const result = await client.query<{
      workspace_id: string;
      attempt_id: string;
      directive_id: string;
      directive_revision: number;
      directive_hash: string;
      continuation_key: string;
      prior_decision_id: string;
      prior_decision_revision: number;
      state: string;
      dispatch_id: string | null;
      dispatch_receipt_hash: string | null;
      consumption_id: string | null;
      consumption_hash: string | null;
      consumed_at: Date | string | null;
      artifact_hash: string;
      payload_json: unknown;
      attempt_lease_id: string;
      attempt_writer_fence: number | string;
      dispatch_verified: boolean;
      settlement_verified: boolean;
    }>(`SELECT c.*,ca.lease_id attempt_lease_id,ca.writer_fence attempt_writer_fence,
        CASE WHEN c.dispatch_id IS NULL THEN FALSE ELSE EXISTS(
          SELECT 1 FROM rorca.continuation_dispatches d
          JOIN rorca.execution_leases l ON l.workspace_id=d.workspace_id AND l.lease_id=d.lease_id
          JOIN rorca.continuation_dispatch_consumptions dc ON dc.workspace_id=d.workspace_id
            AND dc.dispatch_id=d.dispatch_id AND dc.continuation_key=d.continuation_key
          JOIN rorca.continuation_dispatch_outbox o ON o.workspace_id=d.workspace_id
            AND o.dispatch_id=d.dispatch_id AND o.continuation_key=d.continuation_key
          WHERE d.workspace_id=c.workspace_id AND d.dispatch_id=c.dispatch_id
            AND d.continuation_key=c.continuation_key AND l.attempt_id=c.attempt_id
            AND d.lease_id=c.payload_json->'scope'->>'leaseId'
            AND d.fencing_token=(c.payload_json->'scope'->>'fencingToken')::bigint
            AND d.payload_json->'scope'=c.payload_json->'scope'
        ) END dispatch_verified,
        CASE WHEN c.dispatch_receipt_hash IS NULL THEN FALSE ELSE EXISTS(
          SELECT 1 FROM rorca.continuation_dispatches d
          JOIN rorca.continuation_dispatch_outbox o ON o.workspace_id=d.workspace_id
            AND o.dispatch_id=d.dispatch_id AND o.continuation_key=d.continuation_key
          JOIN rorca.continuation_dispatch_acceptances a ON a.workspace_id=o.workspace_id
            AND a.dispatch_id=o.dispatch_id AND a.acceptance_receipt_hash=o.receiver_acceptance_receipt_hash
          WHERE d.workspace_id=c.workspace_id AND d.dispatch_id=c.dispatch_id
            AND d.continuation_key=c.continuation_key AND d.state='settled' AND o.state='sent'
            AND a.acceptance_receipt_hash=c.dispatch_receipt_hash
            AND a.delivery_key=o.delivery_key AND a.payload_hash=o.payload_hash
        ) END settlement_verified
      FROM rorca.completion_continuation_directives c
      JOIN rorca.completion_attempts ca ON ca.workspace_id=c.workspace_id AND ca.attempt_id=c.attempt_id
      WHERE c.workspace_id=$1 AND c.attempt_id=$2
      ORDER BY c.created_at ASC,c.directive_id ASC,c.directive_revision ASC`, [workspaceId, attemptId]);

    return result.rows.map((row) => {
      const directive = ContinuationDirectiveV1Schema.parse(row.payload_json);
      if (directive.state !== 'authorized'
          || directive.scope.workspaceId !== workspaceId
          || directive.scope.attemptId !== attemptId
          || row.workspace_id !== workspaceId
          || row.attempt_id !== attemptId
          || row.directive_id !== directive.directiveId
          || row.directive_revision !== directive.directiveRevision
          || row.directive_hash !== directive.directiveHash
          || row.artifact_hash !== directive.directiveHash
          || row.continuation_key !== directive.continuationKey
          || row.prior_decision_id !== directive.priorDecisionId
          || row.prior_decision_revision !== directive.priorDecisionRevision
          || row.attempt_lease_id !== directive.scope.leaseId
          || Number(row.attempt_writer_fence) !== directive.scope.fencingToken) {
        throw new Error('Canonical continuation lifecycle conflicts with its immutable authorized payload');
      }
      if (!['authorized', 'dispatched', 'settled', 'expired', 'quarantined'].includes(row.state)) {
        throw new Error('Canonical continuation lifecycle has an illegal state');
      }
      const noConsumption = row.consumption_id === null && row.consumption_hash === null && row.consumed_at === null;
      const completeConsumption = row.consumption_id !== null && row.consumption_hash !== null && row.consumed_at !== null;
      const legalColumns = row.state === 'authorized'
        ? row.dispatch_id === null && row.dispatch_receipt_hash === null && noConsumption
        : row.state === 'dispatched'
          ? row.dispatch_id !== null && row.dispatch_receipt_hash === null && noConsumption
          : row.state === 'settled'
            ? row.dispatch_id !== null && row.dispatch_receipt_hash !== null && (noConsumption || completeConsumption)
            : row.dispatch_id !== null && noConsumption;
      if (!legalColumns
          || (row.dispatch_receipt_hash !== null && !Sha256Pattern.test(row.dispatch_receipt_hash))
          || (row.consumption_hash !== null && !Sha256Pattern.test(row.consumption_hash))
          || (row.dispatch_id !== null && !row.dispatch_verified)
          || (row.dispatch_receipt_hash !== null && !row.settlement_verified)) {
        throw new Error('Canonical continuation lifecycle has an illegal or unverified state/receipt combination');
      }
      const consumedAt = row.consumed_at instanceof Date ? row.consumed_at.toISOString() : row.consumed_at;
      if ((row.dispatch_id !== null && (!row.dispatch_id || row.dispatch_id.length > 256))
          || (row.consumption_id !== null && (!row.consumption_id || row.consumption_id.length > 256))
          || (consumedAt !== null && !Number.isFinite(Date.parse(consumedAt)))) {
        throw new Error('Canonical continuation lifecycle contains invalid lifecycle identity or time material');
      }
      if (completeConsumption) {
        const expectedConsumptionHash = completionContinuationConsumptionHash({
          workspaceId,
          attemptId,
          directiveId: directive.directiveId,
          directiveRevision: directive.directiveRevision,
          directiveHash: directive.directiveHash,
          continuationKey: directive.continuationKey,
          dispatchId: row.dispatch_id!,
          dispatchReceiptHash: row.dispatch_receipt_hash!,
          leaseId: directive.scope.leaseId,
          fencingToken: directive.scope.fencingToken,
          consumptionId: row.consumption_id!,
        });
        if (row.consumption_hash !== expectedConsumptionHash) {
          throw new Error('Canonical continuation lifecycle consumption hash conflicts with its exact claim');
        }
      }
      return {
        directive,
        state: row.state as CompletionContinuationLifecycleState,
        dispatchId: row.dispatch_id,
        dispatchReceiptHash: row.dispatch_receipt_hash,
        consumptionId: row.consumption_id,
        consumptionHash: row.consumption_hash,
        consumedAt,
      };
    });
  });
}

export async function loadCanonicalCompletionProgressEntries(
  workspaceId: string,
  attemptId: string,
): Promise<readonly ProgressLedgerEntryV1[]> {
  const records = await loadCanonicalCompletionProgressRecords(workspaceId, attemptId);
  return records.map((record) => record.entry);
}

export async function loadCurrentCompletionTaskPlan(
  workspaceId: string,
  attemptId: string,
): Promise<AttemptTaskPlanV1 | null> {
  return canonicalTransaction(async (client) => {
    await setWorkspace(client, workspaceId);
    const result = await client.query<{ payload_json: unknown }>(`SELECT p.payload_json
      FROM rorca.completion_attempts a JOIN rorca.completion_task_plans p
        ON p.workspace_id=a.workspace_id AND p.attempt_id=a.attempt_id
        AND p.plan_id=a.current_plan_id AND p.plan_revision=a.current_plan_revision
      WHERE a.workspace_id=$1 AND a.attempt_id=$2 AND p.plan_hash=a.current_plan_hash`,
    [workspaceId, attemptId]);
    return result.rows[0] ? AttemptTaskPlanV1Schema.parse(result.rows[0].payload_json) : null;
  });
}

export async function loadCompletionAttempt(workspaceId: string, attemptId: string): Promise<Record<string, unknown> | null> {
  return canonicalTransaction(async (client) => {
    await setWorkspace(client, workspaceId);
    const result = await client.query<Record<string, unknown>>(`SELECT * FROM rorca.completion_attempts
      WHERE workspace_id=$1 AND attempt_id=$2`, [workspaceId, attemptId]);
    return result.rows[0] ?? null;
  });
}
