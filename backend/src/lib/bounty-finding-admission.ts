/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';
import { transaction } from '../db';
import { bountyApprovalTargetHash, type BountyApprovalReceipt, type BountyApprovalTarget } from './bounty-approvals';
import { hashBountyContract } from './bounty-contracts';
import {
  BOUNTY_VALIDATION_POLICY_VERSION,
  INITIAL_EVIDENCE_CONFIDENCE_THRESHOLD,
  INITIAL_FINDING_CLASS_POLICY,
  evaluateIndependentValidation,
  type BlindValidationPacket,
  type IndependentValidationReport,
  type ValidationDecision,
} from './bounty-finding-validation';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from './errors';

export const BOUNTY_FINDING_VALIDATION_POLICY_HASH = hashBountyContract('finding-validation-policy', {
  version: BOUNTY_VALIDATION_POLICY_VERSION,
  confidenceThreshold: INITIAL_EVIDENCE_CONFIDENCE_THRESHOLD,
  classes: INITIAL_FINDING_CLASS_POLICY,
});

export interface ValidatedFindingAdmission {
  workspaceId: string;
  programId: string;
  missionId: string;
  authorityEpoch: number;
  candidateIdentity: string;
  findingIdentity: string;
  packet: BlindValidationPacket;
  report: IndependentValidationReport;
  approval?: { receiptId: string; target: BountyApprovalTarget };
}

export interface FindingAdmissionResult {
  findingId: string;
  affectedTargetId: string;
  stopFenceCommitted: true;
  replay: boolean;
}

export function findingAdmissionSubjectHash(packet: BlindValidationPacket, decision: ValidationDecision): string {
  return hashBountyContract('finding-admission-subject', {
    packetHash: hashBountyContract('blind-validation-packet', packet),
    decision,
  });
}

/** Persist the already verified provider-human event so admission can consume it in the same DB transaction. */
export async function persistFindingApprovalReceipt(receipt: BountyApprovalReceipt): Promise<void> {
  if (receipt.target.action !== 'finding.admit' || !receipt.target.missionId || receipt.consumedAt || receipt.revokedAt) {
    throw new ValidationError('Only a fresh finding admission receipt can enter the finding approval store');
  }
  const targetHash = bountyApprovalTargetHash(receipt.target);
  if (receipt.targetHash !== targetHash || receipt.providerEvent.targetHash !== targetHash) throw new ForbiddenError('Finding approval receipt does not bind the exact provider-human event');
  await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`bounty:finding-approval:${receipt.receiptId}`]);
    const existing = await client.query<{ target_hash: string; exact_target: BountyApprovalTarget; provider_event: unknown }>(
      'SELECT target_hash,exact_target,provider_event FROM bounty_finding_approval_receipts WHERE workspace_id=$1 AND id=$2',
      [receipt.target.workspaceId, receipt.receiptId],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.target_hash !== targetHash
          || hashBountyContract('approval-target', row.exact_target) !== hashBountyContract('approval-target', receipt.target)
          || hashBountyContract('provider-human-event', row.provider_event) !== hashBountyContract('provider-human-event', receipt.providerEvent)) {
        throw new ConflictError('Finding approval receipt replay changed exact authority');
      }
      return;
    }
    await client.query(
      `INSERT INTO bounty_finding_approval_receipts
       (id,workspace_id,program_id,mission_id,action,target_hash,exact_target,provider_event,expires_at)
       VALUES ($1,$2,$3,$4,'finding.admit',$5,$6,$7,$8)`,
      [receipt.receiptId, receipt.target.workspaceId, receipt.target.programId, receipt.target.missionId,
        targetHash, receipt.target, receipt.providerEvent, receipt.target.expiresAt],
    );
  });
}

function exactHumanApprovalRequired(input: ValidatedFindingAdmission): boolean {
  const classPolicy = INITIAL_FINDING_CLASS_POLICY[input.packet.findingClass as keyof typeof INITIAL_FINDING_CLASS_POLICY];
  return !classPolicy || classPolicy.disposition === 'human' || input.packet.sensitivity !== 'public';
}

function assertAdmission(input: ValidatedFindingAdmission): { humanRequired: boolean; decisionHash: string; decision: ValidationDecision } {
  if (!input.workspaceId || !input.programId || !input.missionId || !input.candidateIdentity || !input.findingIdentity) throw new ValidationError('Finding admission identity is incomplete');
  if (!Number.isSafeInteger(input.authorityEpoch) || input.authorityEpoch < 1) throw new ValidationError('Finding admission authority epoch is invalid');
  if (input.packet.workspaceId !== input.workspaceId || input.packet.programId !== input.programId || input.packet.missionId !== input.missionId) throw new ValidationError('Finding admission crosses validation packet authority');
  const decision = evaluateIndependentValidation(input.packet, input.report);
  if (input.packet.policyVersion !== BOUNTY_VALIDATION_POLICY_VERSION || decision.policyVersion !== BOUNTY_VALIDATION_POLICY_VERSION
      || input.packet.confidenceThreshold !== INITIAL_EVIDENCE_CONFIDENCE_THRESHOLD
      || decision.evidenceConfidence < INITIAL_EVIDENCE_CONFIDENCE_THRESHOLD) throw new ForbiddenError('Finding does not satisfy the active evidence confidence policy');
  const humanRequired = exactHumanApprovalRequired(input);
  if (humanRequired !== decision.humanAdmissionRequired
      || humanRequired && decision.disposition !== 'human-required'
      || !humanRequired && decision.disposition !== 'admitted') throw new ForbiddenError('Finding disposition does not match the exact approval matrix');
  if (!humanRequired && input.approval) throw new ValidationError('Auto-routable finding must not consume unrelated human approval');
  const decisionHash = findingAdmissionSubjectHash(input.packet, decision);
  if (humanRequired) {
    const approval = input.approval;
    if (!approval || approval.target.workspaceId !== input.workspaceId || approval.target.programId !== input.programId
        || approval.target.missionId !== input.missionId || approval.target.action !== 'finding.admit'
        || approval.target.subjectHash !== decisionHash || approval.target.policyHash !== BOUNTY_FINDING_VALIDATION_POLICY_HASH) {
      throw new ForbiddenError('Exact provider-human finding admission is required');
    }
  }
  return { humanRequired, decisionHash, decision };
}

/**
 * Atomically creates the finding and its affected-target stop fence. Candidate replay returns the
 * original commit; concurrent or different candidates cannot create a second finding for the target.
 */
export async function commitValidatedFinding(input: ValidatedFindingAdmission): Promise<FindingAdmissionResult> {
  const { humanRequired, decisionHash, decision } = assertAdmission(input);
  return transaction(async (client) => {
    const lockKeys = [
      `bounty:finding-candidate:${input.workspaceId}:${input.missionId}:${input.candidateIdentity}`,
      `bounty:finding-target:${input.workspaceId}:${input.missionId}:${input.packet.affectedTargetId}`,
    ].sort();
    for (const key of lockKeys) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);

    const replay = await client.query<{ finding_id: string; affected_target_id: string; decision_hash: string }>(
      `SELECT finding_id,affected_target_id,decision_hash FROM bounty_finding_admissions
       WHERE workspace_id=$1 AND mission_id=$2 AND candidate_identity=$3`,
      [input.workspaceId, input.missionId, input.candidateIdentity],
    );
    if (replay.rows[0]) {
      const prior = replay.rows[0];
      if (prior.affected_target_id !== input.packet.affectedTargetId || prior.decision_hash !== decisionHash) throw new ConflictError('Candidate admission replay changed its exact target or decision');
      return { findingId: prior.finding_id, affectedTargetId: prior.affected_target_id, stopFenceCommitted: true, replay: true };
    }

    const mission = await client.query<{ state: string; program_id: string; epoch: string }>(
      'SELECT state,program_id,epoch FROM bounty_missions WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [input.workspaceId, input.missionId],
    );
    if (!mission.rows[0]) throw new NotFoundError('Bounty mission');
    if (mission.rows[0].program_id !== input.programId || mission.rows[0].state !== 'active' || Number(mission.rows[0].epoch) !== input.authorityEpoch) throw new ConflictError('Mission authority changed before finding admission');

    let approvalReceiptId: string | null = null;
    if (humanRequired) {
      const approval = input.approval!;
      const consumed = await client.query<{ id: string }>(
        `UPDATE bounty_finding_approval_receipts SET consumed_at=now()
         WHERE workspace_id=$1 AND id=$2 AND target_hash=$3 AND action='finding.admit'
           AND program_id=$4 AND mission_id=$5
           AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now()
         RETURNING id`,
        [input.workspaceId, approval.receiptId, bountyApprovalTargetHash(approval.target), input.programId, input.missionId],
      );
      if (!consumed.rows[0]) throw new ForbiddenError('Exact provider-human approval is expired, revoked, changed, or already consumed');
      approvalReceiptId = consumed.rows[0].id;
    }

    const existingFence = await client.query<{ finding_id: string }>(
      `SELECT finding_id FROM bounty_affected_target_stop_fences
       WHERE workspace_id=$1 AND mission_id=$2 AND affected_target_id=$3 FOR UPDATE`,
      [input.workspaceId, input.missionId, input.packet.affectedTargetId],
    );
    if (existingFence.rows[0]) throw new ConflictError('Affected target is already stopped by an admitted finding');

    const findingId = randomUUID();
    await client.query(
      `INSERT INTO bounty_findings (id,workspace_id,mission_id,finding_identity,status,authority_epoch)
       VALUES ($1,$2,$3,$4,'validated',$5)`,
      [findingId, input.workspaceId, input.missionId, input.findingIdentity, input.authorityEpoch],
    );
    await client.query(
      `INSERT INTO bounty_affected_target_stop_fences
       (workspace_id,mission_id,affected_target_id,finding_id,decision_hash)
       VALUES ($1,$2,$3,$4,$5)`,
      [input.workspaceId, input.missionId, input.packet.affectedTargetId, findingId, decisionHash],
    );
    await client.query(
      `INSERT INTO bounty_finding_admissions
       (workspace_id,mission_id,candidate_identity,finding_id,affected_target_id,policy_version,decision_hash,disposition,approval_receipt_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [input.workspaceId, input.missionId, input.candidateIdentity, findingId, input.packet.affectedTargetId,
        BOUNTY_VALIDATION_POLICY_VERSION, decisionHash, decision.disposition, approvalReceiptId],
    );
    return { findingId, affectedTargetId: input.packet.affectedTargetId, stopFenceCommitted: true, replay: false };
  });
}
