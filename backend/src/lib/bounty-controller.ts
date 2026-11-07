/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Sole application mutation boundary for bounty authority state.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { queryOne, transaction } from '../db';
import { ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError, UnprocessableError, ValidationError } from './errors';
import { hashBountyContract } from './bounty-contracts';
import { LocalFixtureLaunchTargetSchema, assertLocalFixtureDeploymentBinding, localFixtureLaunchTargetHash, localFixtureProviderKeyHash, verifyLocalFixtureProviderApproval, type LocalFixtureProviderEvent, type LocalFixtureLaunchTarget } from './bounty-local-fixture-launch';
import { BountyFeatureDisabledError, resolveBountyFeaturePolicy } from './bounty-feature-policy';
import { executeBountyLifecycleCommand, type BountyLifecycleAction, type MissionControlHooks } from './bounty-mission-control';
import { checkBountyReflectionBeforeRoute, type BountyReflectionCheck } from './bounty-reflection';
import { BountyWorkerProposalSchema, type BountyWorkerProposal } from './bounty-isolated-runtime';
import {
  routeBountyWorkPackages,
  type BountyRouteInput,
  type BountyRouteResult,
} from './bounty-work-package-router';
import { paginateQuery, type PaginatedResponse, type PaginationParams } from './paginate';

export type BountyMissionState = 'draft' | 'active' | 'held' | 'completed' | 'cancelled';
export interface BountyControllerCommand {
  workspaceId: string;
  programId: string;
  missionId: string;
  actor: string;
  purpose: string;
  expectedEpoch: number;
  idempotencyKey: string;
  payloadHash: string;
  payload: Record<string, unknown>;
  transition: BountyMissionState;
  expiresAt?: string;
}
export interface BountyControllerReceipt {
  receiptId: string;
  operationId: string;
  missionId: string;
  previousState: BountyMissionState;
  state: BountyMissionState;
  epoch: number;
}
export interface BountyPackageRouteCommand {
  workspaceId: string;
  missionId: string;
  actor: string;
  purpose: string;
  expectedEpoch: number;
  routeInput: BountyRouteInput;
}
export interface PersistedBountyPackageRoute {
  replayed: boolean;
  reflectionCheck: BountyReflectionCheck;
  route: Extract<BountyRouteResult, { canCreate: true }>;
  records: Array<{ id: string; releaseSequence: number; packageHash: string }>;
}
export interface BountyRuntimeAssignmentCommand {
  workspaceId: string; missionId: string; workPackageId: string; attemptId: string;
  routePackageHash: string; immutablePayloadHash: string; runtimePolicyHash: string;
  workerExecutableHash: string; targetBrokerSocketIdentity: string; providerPolicyHash: string;
  providerExactOriginHash: string; proposalSchemaHash: string; contextNonce: string;
  authorityEpoch: number; capabilityExpiresAt: string;
}
export interface PersistedBountyRuntimeAssignment { id: string; replayed: boolean }
export interface PersistedBountyWorkerProposal { id: string; proposalHash: string; replayed: boolean }

const transitions: Record<BountyMissionState, readonly BountyMissionState[]> = {
  draft: ['active', 'cancelled'], active: ['held', 'completed', 'cancelled'],
  held: ['active', 'cancelled'], completed: [], cancelled: [],
};
const required = (value: string, name: string): void => {
  if (!value.trim() || value.length > 256) throw new ValidationError(`${name} is required and must be at most 256 characters`);
};

/** Execute one command; all authority mutation, event, receipt and outbox writes share one transaction. */
export async function executeBountyCommand(command: BountyControllerCommand): Promise<BountyControllerReceipt> {
  for (const [value, name] of [[command.workspaceId, 'workspaceId'], [command.programId, 'programId'], [command.missionId, 'missionId'], [command.actor, 'actor'], [command.purpose, 'purpose'], [command.idempotencyKey, 'idempotencyKey']] as const) required(value, name);
  if (!Number.isSafeInteger(command.expectedEpoch) || command.expectedEpoch < 1) throw new ValidationError('expectedEpoch must be a positive integer');
  const calculatedHash = hashBountyContract('controller-command', command.payload);
  if (calculatedHash !== command.payloadHash) throw new ValidationError('payloadHash does not match the canonical payload');
  if (command.expiresAt && (!Number.isFinite(Date.parse(command.expiresAt)) || Date.parse(command.expiresAt) <= Date.now())) throw new UnprocessableError('Command expired', 'COMMAND_EXPIRED');

  return transaction(async (client) => {
    // Serialize the key before replay lookup so concurrent identical commands observe the committed receipt.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`bounty-controller:${command.workspaceId}:${command.idempotencyKey}`]);
    const replay = await client.query<{ payload_hash: string; payload: BountyControllerReceipt }>(
      `SELECT o.payload_hash, r.payload FROM bounty_operations o
       JOIN bounty_operation_receipts r ON r.workspace_id=o.workspace_id AND r.operation_id=o.id
       WHERE o.workspace_id=$1 AND o.idempotency_key=$2 FOR UPDATE OF o`,
      [command.workspaceId, command.idempotencyKey],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].payload_hash !== command.payloadHash) throw new ConflictError('Idempotency key was used with a different payload');
      return replay.rows[0].payload;
    }

    if (command.expiresAt) {
      const freshness = await client.query<{ fresh: boolean }>('SELECT clock_timestamp() < $1::timestamptz AS fresh', [command.expiresAt]);
      if (freshness.rows[0]?.fresh !== true) throw new UnprocessableError('Command expired', 'COMMAND_EXPIRED');
    }
    const missionResult = await client.query<{ state: BountyMissionState; epoch: string }>(
      `SELECT m.state, m.epoch FROM bounty_missions m
       WHERE m.id=$1 AND m.workspace_id=$2 AND m.program_id=$3 FOR UPDATE`,
      [command.missionId, command.workspaceId, command.programId],
    );
    const mission = missionResult.rows[0];
    if (!mission) throw new NotFoundError('Bounty mission');
    const epoch = Number(mission.epoch);
    if (epoch !== command.expectedEpoch) throw new ConflictError('Stale mission epoch', { expected: command.expectedEpoch, actual: epoch });
    if (!transitions[mission.state].includes(command.transition)) throw new UnprocessableError(`Illegal mission transition: ${mission.state} -> ${command.transition}`, 'ILLEGAL_TRANSITION');
    const hold = await client.query('SELECT 1 FROM bounty_holds WHERE workspace_id=$1 AND mission_id=$2 AND released_at IS NULL LIMIT 1', [command.workspaceId, command.missionId]);
    if (hold.rowCount) throw new ForbiddenError('Mission is held');

    const operationId = randomUUID();
    const receiptId = randomUUID();
    const outboxId = randomUUID();
    const jobId = randomUUID();
    const nextEpoch = epoch + 1;
    const receipt: BountyControllerReceipt = { receiptId, operationId, missionId: command.missionId, previousState: mission.state, state: command.transition, epoch: nextEpoch };
    await client.query('UPDATE bounty_missions SET state=$1, epoch=$2 WHERE id=$3 AND workspace_id=$4', [command.transition, nextEpoch, command.missionId, command.workspaceId]);
    await client.query(`INSERT INTO bounty_operations (id,workspace_id,mission_id,idempotency_key,kind,payload,payload_hash,actor,purpose,expires_at,state,decision,repeatable,authority_epoch) VALUES ($1,$2,$3,$4,'mission.transition',$5,$6,$7,$8,$9,'observed','ALLOW',false,$10)`, [operationId, command.workspaceId, command.missionId, command.idempotencyKey, command.payload, command.payloadHash, command.actor, command.purpose, command.expiresAt ?? null, nextEpoch]);
    await client.query(`INSERT INTO bounty_events (workspace_id,mission_id,event_identity,event_type,payload) VALUES ($1,$2,$3,'mission.transitioned',$4)`, [command.workspaceId, command.missionId, `controller:${operationId}`, receipt]);
    await client.query(`INSERT INTO bounty_operation_receipts (id,workspace_id,operation_id,receipt_identity,payload) VALUES ($1,$2,$3,$4,$5)`, [receiptId, command.workspaceId, operationId, `${command.workspaceId}:${command.idempotencyKey}`, receipt]);
    // Commit transport intent only. A separate relay owns queue publication; the payload is
    // deliberately authority IDs/hashes, never executable instructions or mission data.
    await client.query(`INSERT INTO bounty_application_outbox
      (id,workspace_id,mission_id,idempotency_key,topic,queue_name,job_id,mission_epoch,payload)
      VALUES ($1,$2,$3,$4,'bounty.mission.transitioned','bounty:control',$5,$6,$7)`,
    [outboxId, command.workspaceId, command.missionId, `controller:${command.idempotencyKey}`, jobId, nextEpoch,
      { outboxId, workspaceId: command.workspaceId, missionId: command.missionId, operationId, missionEpoch: nextEpoch, payloadHash: command.payloadHash }]);
    return receipt;
  });
}

/**
 * Persist a deterministic route exactly once. Route authority is calculated in
 * process, before the transaction; untrusted/model proposals cannot substitute
 * package bodies, selected skills, capabilities, model tiers, or hashes.
 */
export async function persistBountyPackageRoute(command: BountyPackageRouteCommand): Promise<PersistedBountyPackageRoute> {
  for (const [value, name] of [[command.workspaceId, 'workspaceId'], [command.missionId, 'missionId'], [command.actor, 'actor'], [command.purpose, 'purpose']] as const) required(value, name);
  if (!Number.isSafeInteger(command.expectedEpoch) || command.expectedEpoch < 1) throw new ValidationError('expectedEpoch must be a positive integer');
  if (command.routeInput.missionId !== command.missionId) throw new ValidationError('route missionId does not match command missionId');
  // Reflection is durable and program-scoped. It runs before the pure router so
  // known false positives, rejections, duplicates, dead gadgets, and disclosures
  // cannot be transformed into new work-package decisions.
  const reflectionCheck = await checkBountyReflectionBeforeRoute({
    workspaceId: command.workspaceId,
    missionId: command.missionId,
    fingerprints: [
      command.routeInput.objective.summaryHash,
      ...command.routeInput.targets.map((target) => target.targetHash),
      ...command.routeInput.evidenceRefs.map((evidence) => evidence.evidenceHash),
    ],
  });
  if (reflectionCheck.decision === 'block') {
    throw new ForbiddenError('Program reflection blocked bounty work-package routing', { reflectionCheck });
  }
  const routed = routeBountyWorkPackages(command.routeInput);
  const outcome = await transaction(async (client): Promise<
    | { blocked: Extract<BountyRouteResult, { canCreate: false }> }
    | { persisted: PersistedBountyPackageRoute }
  > => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`bounty-package-route:${command.workspaceId}:${routed.inputHash}`]);
    if (routed.canCreate) {
      const replay = await client.query<{ id: string; release_sequence: string; package_hash: string }>(
        `SELECT w.id,w.release_sequence,w.package_hash FROM bounty_generations g
         JOIN bounty_work_packages w ON w.workspace_id=g.workspace_id AND w.generation_id=g.id
         WHERE g.workspace_id=$1 AND g.mission_id=$2 AND g.input_identity=$3
         ORDER BY w.release_sequence`,
        [command.workspaceId, command.missionId, routed.inputHash],
      );
      if (replay.rows.length) {
        return {
          persisted: {
            replayed: true,
            reflectionCheck,
            route: routed,
            records: replay.rows.map((row) => ({ id: row.id, releaseSequence: Number(row.release_sequence), packageHash: row.package_hash })),
          },
        };
      }
    }

    const missionResult = await client.query<{ state: BountyMissionState; epoch: string }>(
      `SELECT state,epoch FROM bounty_missions WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,
      [command.missionId, command.workspaceId],
    );
    const mission = missionResult.rows[0];
    if (!mission) throw new NotFoundError('Bounty mission');
    const missionEpoch = Number(mission.epoch);
    if (missionEpoch !== command.expectedEpoch) throw new ConflictError('Stale mission epoch', { expected: command.expectedEpoch, actual: missionEpoch });
    if (mission.state !== 'draft' && mission.state !== 'active') throw new UnprocessableError(`Mission state ${mission.state} cannot create work packages`, 'MISSION_NOT_ROUTABLE');
    const hold = await client.query('SELECT 1 FROM bounty_holds WHERE workspace_id=$1 AND mission_id=$2 AND released_at IS NULL LIMIT 1', [command.workspaceId, command.missionId]);
    if (hold.rowCount) throw new ForbiddenError('Mission is held');

    await client.query(
      `INSERT INTO bounty_work_package_route_decisions(
         id,workspace_id,mission_id,mission_epoch,route_input_hash,route_hash,route_policy_hash,
         can_create,reason_codes,omissions,reports,telemetry,decision_body,actor,purpose
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (workspace_id,mission_id,route_input_hash) DO NOTHING`,
      [
        randomUUID(), command.workspaceId, command.missionId, missionEpoch, routed.inputHash,
        routed.routeHash, routed.policyHash, routed.canCreate, routed.reasonCodes,
        routed.reports.routing.omitted, routed.reports, routed.telemetry, routed,
        command.actor, command.purpose,
      ],
    );
    if (!routed.canCreate) return { blocked: routed };

    const generationSequence = await client.query<{ next: string }>(
      'SELECT COALESCE(max(epoch),0)+1 AS next FROM bounty_generations WHERE mission_id=$1',
      [command.missionId],
    );
    const releaseSequence = await client.query<{ next: string }>(
      'SELECT COALESCE(max(release_sequence),0)+1 AS next FROM bounty_work_packages WHERE mission_id=$1',
      [command.missionId],
    );
    const generationId = randomUUID();
    await client.query(
      `INSERT INTO bounty_generations(id,workspace_id,mission_id,epoch,input_identity)
       VALUES($1,$2,$3,$4,$5)`,
      [generationId, command.workspaceId, command.missionId, Number(generationSequence.rows[0]?.next ?? 1), routed.inputHash],
    );
    const firstReleaseSequence = Number(releaseSequence.rows[0]?.next ?? 1);
    const records: PersistedBountyPackageRoute['records'] = [];
    for (const [index, workPackage] of routed.packages.entries()) {
      const workPackageId = randomUUID();
      const sequence = firstReleaseSequence + index;
      await client.query(
        `INSERT INTO bounty_work_packages(
           id,workspace_id,mission_id,generation_id,release_sequence,status,package_hash,
           route_input_hash,route_hash,route_policy_hash,objective_id,objective_class,
           role_name,context_tokens,model_tier,selected_hashes,omissions,reason_codes,route_body
         ) VALUES($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          workPackageId, command.workspaceId, command.missionId, generationId, sequence,
          workPackage.packageHash, routed.inputHash, routed.routeHash, routed.policyHash,
          workPackage.objective.id, workPackage.objective.objectiveClass, workPackage.role,
          workPackage.context.totalTokens, workPackage.modelTier, workPackage.selectedHashes,
          workPackage.omissions, workPackage.reasonCodes, workPackage,
        ],
      );
      records.push({ id: workPackageId, releaseSequence: sequence, packageHash: workPackage.packageHash });
    }
    return { persisted: { replayed: false, reflectionCheck, route: routed, records } };
  });

  if ('blocked' in outcome) {
    throw new UnprocessableError('Bounty work package route is blocked', 'BOUNTY_ROUTE_BLOCKED', {
      reasonCodes: outcome.blocked.reasonCodes,
      omissions: outcome.blocked.omissions,
      reports: outcome.blocked.reports,
      telemetry: outcome.blocked.telemetry,
      routeHash: outcome.blocked.routeHash,
    });
  }
  return outcome.persisted;
}

const SHA256_ID = /^sha256:[0-9a-f]{64}$/;

/** Persist the immutable launch assignment after rechecking dispatch authority. */
export async function persistBountyRuntimeAssignment(command: BountyRuntimeAssignmentCommand): Promise<PersistedBountyRuntimeAssignment> {
  for (const [value, name] of [[command.workspaceId, 'workspaceId'], [command.missionId, 'missionId'], [command.workPackageId, 'workPackageId'], [command.attemptId, 'attemptId']] as const) required(value, name);
  for (const [value, name] of [[command.routePackageHash, 'routePackageHash'], [command.immutablePayloadHash, 'immutablePayloadHash'], [command.runtimePolicyHash, 'runtimePolicyHash'], [command.workerExecutableHash, 'workerExecutableHash'], [command.targetBrokerSocketIdentity, 'targetBrokerSocketIdentity'], [command.providerPolicyHash, 'providerPolicyHash'], [command.providerExactOriginHash, 'providerExactOriginHash'], [command.proposalSchemaHash, 'proposalSchemaHash']] as const) {
    if (!SHA256_ID.test(value)) throw new ValidationError(`${name} must be a sha256 identity`);
  }
  const capabilityExpiry = Date.parse(command.capabilityExpiresAt);
  if (!Number.isSafeInteger(command.authorityEpoch) || command.authorityEpoch < 1 || !Number.isFinite(capabilityExpiry) || capabilityExpiry <= Date.now()) throw new ValidationError('assignment epoch and capability expiry must be fresh');
  const assignmentBody = { ...command };
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`bounty-runtime-assignment:${command.workspaceId}:${command.attemptId}`]);
    const replay = await client.query<{ id: string; assignment_body: BountyRuntimeAssignmentCommand }>(
      'SELECT id,assignment_body FROM bounty_worker_runtime_assignments WHERE workspace_id=$1 AND attempt_id=$2',
      [command.workspaceId, command.attemptId],
    );
    if (replay.rows[0]) {
      if (hashBountyContract('runtime-assignment', replay.rows[0].assignment_body) !== hashBountyContract('runtime-assignment', assignmentBody)) throw new ConflictError('Attempt already has a different runtime assignment');
      return { id: replay.rows[0].id, replayed: true };
    }
    const authority = await client.query<{ state: BountyMissionState; epoch: string; package_hash: string; package_status: string; attempt_status: string; fresh: boolean }>(
      `SELECT m.state,m.epoch,w.package_hash,w.status AS package_status,a.status AS attempt_status,
              clock_timestamp() < $5::timestamptz AS fresh
         FROM bounty_attempts a
         JOIN bounty_work_packages w ON w.workspace_id=a.workspace_id AND w.id=a.work_package_id
         JOIN bounty_missions m ON m.workspace_id=w.workspace_id AND m.id=w.mission_id
        WHERE a.workspace_id=$1 AND a.id=$2 AND w.id=$3 AND m.id=$4
        FOR UPDATE OF m,w,a`,
      [command.workspaceId, command.attemptId, command.workPackageId, command.missionId, command.capabilityExpiresAt],
    );
    const row = authority.rows[0];
    if (!row) throw new NotFoundError('Bounty worker attempt');
    if (row.state !== 'active' || row.package_status !== 'running' || !['pending', 'running'].includes(row.attempt_status)) throw new ForbiddenError('Bounty attempt is not dispatchable');
    if (Number(row.epoch) !== command.authorityEpoch || row.package_hash !== command.routePackageHash || !row.fresh) throw new ConflictError('Bounty runtime assignment authority is stale');
    const id = randomUUID();
    await client.query(
      `INSERT INTO bounty_worker_runtime_assignments(
         id,workspace_id,mission_id,work_package_id,attempt_id,route_package_hash,immutable_payload_hash,
         runtime_policy_hash,worker_executable_hash,target_broker_socket_identity,provider_policy_hash,
         provider_exact_origin_hash,proposal_schema_hash,context_nonce,authority_epoch,capability_expires_at,assignment_body
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [id, command.workspaceId, command.missionId, command.workPackageId, command.attemptId, command.routePackageHash,
        command.immutablePayloadHash, command.runtimePolicyHash, command.workerExecutableHash, command.targetBrokerSocketIdentity,
        command.providerPolicyHash, command.providerExactOriginHash, command.proposalSchemaHash, command.contextNonce,
        command.authorityEpoch, command.capabilityExpiresAt, assignmentBody],
    );
    return { id, replayed: false };
  });
}

/** Store validated model output as an append-only proposal; this changes no mission, finding, evidence, approval, or attempt authority. */
export async function persistBountyWorkerProposal(workspaceId: string, assignmentId: string, rawProposal: BountyWorkerProposal): Promise<PersistedBountyWorkerProposal> {
  required(workspaceId, 'workspaceId'); required(assignmentId, 'assignmentId');
  const proposal = BountyWorkerProposalSchema.parse(rawProposal);
  const proposalHash = hashBountyContract('isolated-worker-proposal', proposal);
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`bounty-worker-proposal:${workspaceId}:${proposal.attemptId}`]);
    const assignment = await client.query<{ id: string; authority_epoch: string; mission_epoch: string; mission_state: string; fresh: boolean }>(
      `SELECT a.id,a.authority_epoch,m.epoch AS mission_epoch,m.state AS mission_state,
              clock_timestamp()<a.capability_expires_at AS fresh
         FROM bounty_worker_runtime_assignments a
         JOIN bounty_missions m ON m.workspace_id=a.workspace_id AND m.id=a.mission_id
        WHERE a.workspace_id=$1 AND a.id=$2 AND a.mission_id=$3 AND a.work_package_id=$4 AND a.attempt_id=$5
          AND a.immutable_payload_hash=$6 AND a.context_nonce=$7 FOR UPDATE OF m`,
      [workspaceId, assignmentId, proposal.missionId, proposal.workPackageId, proposal.attemptId, proposal.immutablePayloadHash, proposal.contextNonce],
    );
    const authority = assignment.rows[0];
    if (!authority) throw new ForbiddenError('Proposal does not match its immutable runtime assignment');
    if (authority.mission_state !== 'active' || !authority.fresh || Number(authority.authority_epoch) !== Number(authority.mission_epoch)) {
      throw new ForbiddenError('Stale worker proposal has no mission authority');
    }
    const replay = await client.query<{ id: string; proposal_hash: string }>(
      'SELECT id,proposal_hash FROM bounty_worker_proposals WHERE workspace_id=$1 AND attempt_id=$2', [workspaceId, proposal.attemptId],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].proposal_hash !== proposalHash) throw new ConflictError('Attempt already has a different worker proposal');
      return { id: replay.rows[0].id, proposalHash, replayed: true };
    }
    const id = randomUUID();
    await client.query(
      `INSERT INTO bounty_worker_proposals(
         id,workspace_id,mission_id,work_package_id,attempt_id,assignment_id,immutable_payload_hash,proposal_hash,
         disposition,authority_effect,evidence_admission,finding_admission,proposal_body
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'proposal-only','none',FALSE,FALSE,$9)`,
      [id, workspaceId, proposal.missionId, proposal.workPackageId, proposal.attemptId, assignmentId, proposal.immutablePayloadHash, proposalHash, proposal],
    );
    return { id, proposalHash, replayed: false };
  });
}

// ─── Bounded REST Controller facade (BBM-025) ───
export interface BountyAuthority {
  workspaceId: string;
  programId: string;
  actor: string;
}
export interface BountyAdmissionCommand extends BountyAuthority {
  programName: string;
  programId: string;
  policyRevision: number;
  scope: Record<string, unknown>;
  idempotencyKey: string;
}
export interface BountyMissionPreviewCommand extends BountyAuthority {
  missionId: string;
  title: string;
  contract: Record<string, unknown>;
  expectedProgramRevision: number;
  idempotencyKey: string;
}
export interface BountyMissionLaunchCommand extends BountyMissionPreviewCommand {
  previewReceiptId: string;
  approvalTarget: LocalFixtureLaunchTarget;
  providerHumanApproval: LocalFixtureProviderEvent;
}
export interface BountyMissionCommand extends BountyAuthority {
  missionId: string;
  expectedEpoch: number;
  reason: string;
  idempotencyKey: string;
}
export interface BountyHoldReleaseCommand extends BountyMissionCommand { holdId: string }
export interface BountyReleaseReviewCommand extends BountyAuthority {
  missionId: string;
  draftId: string;
  decision: 'approve-readiness' | 'reject';
  reason: string;
  idempotencyKey: string;
}

interface ProgramRow { id: string; name: string; revision: string }
interface ReceiptRow { id: string; operation: string; request_hash: string; response: Record<string, unknown> }
interface MissionRow { id: string; state: string; epoch: string; title: string; program_id: string; created_at: Date | string }
interface ListContext extends BountyAuthority { missionId: string; pagination: PaginationParams }

const RAW_SECRET_KEYS = /^(?:authorization|cookie|cookies|credential|credentials|password|secret|token|accessToken|refreshToken|apiKey|material)$/i;

/** Credentials remain redacted even for separately-authorized raw evidence inspection. */
export function redactBountyRawValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactBountyRawValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
    key,
    RAW_SECRET_KEYS.test(key) ? '[REDACTED]' : redactBountyRawValue(child),
  ]));
}

function restRequired(value: string, label: string, max = 256): void {
  if (!value.trim() || value.length > max) throw new ValidationError(`${label} is required and must be at most ${max} characters`);
}
function assertAuthority(authority: BountyAuthority): void {
  restRequired(authority.workspaceId, 'workspaceId'); restRequired(authority.programId, 'programId'); restRequired(authority.actor, 'actor');
}
async function assertEnabled(): Promise<void> {
  if (!(await resolveBountyFeaturePolicy()).enabled) throw new BountyFeatureDisabledError();
}

/** Workspace and program are always checked as one composite authority. */
export async function assertBountyProgramAuthority(authority: BountyAuthority, missionId?: string): Promise<ProgramRow> {
  assertAuthority(authority);
  const program = await queryOne<ProgramRow>(
    missionId
      ? `SELECT p.id,p.name,p.revision FROM bounty_programs p
         JOIN bounty_program_admissions a ON a.workspace_id=p.workspace_id AND a.program_id=p.id
           AND clock_timestamp() < (a.scope->>'expiresAt')::timestamptz
         JOIN bounty_missions m ON m.workspace_id=p.workspace_id AND m.program_id=p.id
         WHERE p.workspace_id=$1 AND p.id=$2 AND m.id=$3`
      : `SELECT p.id,p.name,p.revision FROM bounty_programs p
         JOIN bounty_program_admissions a ON a.workspace_id=p.workspace_id AND a.program_id=p.id
           AND clock_timestamp() < (a.scope->>'expiresAt')::timestamptz
         WHERE p.workspace_id=$1 AND p.id=$2`,
    missionId ? [authority.workspaceId, authority.programId, missionId] : [authority.workspaceId, authority.programId],
  );
  if (!program) throw new NotFoundError('Bounty program authority');
  return program;
}

async function assertProgramAuthorityInTransaction(client: PoolClient, authority: BountyAuthority, missionId?: string): Promise<ProgramRow> {
  const result = await client.query<ProgramRow>(
    missionId
      ? `SELECT p.id,p.name,p.revision FROM bounty_programs p
         JOIN bounty_program_admissions a ON a.workspace_id=p.workspace_id AND a.program_id=p.id
           AND clock_timestamp() < (a.scope->>'expiresAt')::timestamptz
         JOIN bounty_missions m ON m.workspace_id=p.workspace_id AND m.program_id=p.id
         WHERE p.workspace_id=$1 AND p.id=$2 AND m.id=$3 FOR SHARE OF p,a,m`
      : `SELECT p.id,p.name,p.revision FROM bounty_programs p
         JOIN bounty_program_admissions a ON a.workspace_id=p.workspace_id AND a.program_id=p.id
           AND clock_timestamp() < (a.scope->>'expiresAt')::timestamptz
         WHERE p.workspace_id=$1 AND p.id=$2 FOR SHARE OF p,a`,
    missionId ? [authority.workspaceId, authority.programId, missionId] : [authority.workspaceId, authority.programId],
  );
  if (!result.rows[0]) throw new NotFoundError('Bounty program authority');
  return result.rows[0];
}

async function replayReceipt(client: PoolClient, workspaceId: string, key: string, operation: string, requestHash: string): Promise<Record<string, unknown> | null> {
  const result = await client.query<ReceiptRow>(
    'SELECT id,operation,request_hash,response FROM bounty_controller_api_receipts WHERE workspace_id=$1 AND idempotency_key=$2 FOR SHARE',
    [workspaceId, key],
  );
  const replay = result.rows[0];
  if (!replay) return null;
  if (replay.operation !== operation || replay.request_hash !== requestHash) throw new ConflictError('Idempotency key was used with a different bounty Controller command');
  return { ...replay.response, replayed: true };
}

async function assertFreshProgramAdmission(client: PoolClient, authority: BountyAuthority): Promise<{ id: string; scope_hash: string; policy_contract_hash: string }> {
  const result = await client.query<{ id: string; scope_hash: string; policy_contract_hash: string }>(
    `SELECT id,scope_hash,scope->>'policyContractHash' AS policy_contract_hash FROM bounty_program_admissions
     WHERE workspace_id=$1 AND program_id=$2
       AND clock_timestamp() < (scope->>'expiresAt')::timestamptz FOR SHARE`,
    [authority.workspaceId, authority.programId],
  );
  if (!result.rows[0]) throw new ForbiddenError('Bounty program scope is absent or expired');
  return result.rows[0];
}

async function saveReceipt(client: PoolClient, input: {
  authority: BountyAuthority; missionId?: string; key: string; operation: string; requestHash: string; response: Record<string, unknown>;
}): Promise<void> {
  await client.query(
    `INSERT INTO bounty_controller_api_receipts
     (id,workspace_id,program_id,mission_id,idempotency_key,operation,request_hash,response,actor)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [input.response.receiptId, input.authority.workspaceId, input.authority.programId, input.missionId ?? null,
      input.key, input.operation, input.requestHash, input.response, input.authority.actor],
  );
}

/** Admit one exact workspace/program scope. Replays return the original receipt. */
export async function admitBountyProgram(command: BountyAdmissionCommand): Promise<Record<string, unknown>> {
  assertAuthority(command); restRequired(command.programName, 'programName'); restRequired(command.idempotencyKey, 'idempotencyKey');
  if (!Number.isSafeInteger(command.policyRevision) || command.policyRevision < 1) throw new ValidationError('policyRevision must be a positive integer');
  const scopeExpiresAt = Date.parse(String(command.scope.expiresAt ?? ''));
  if (!Number.isFinite(scopeExpiresAt) || scopeExpiresAt <= Date.now()) throw new ValidationError('Program admission scope expiry must be in the future');
  await assertEnabled();
  const request = { programId: command.programId, programName: command.programName, policyRevision: command.policyRevision, scope: command.scope };
  const requestHash = hashBountyContract('rest-program-admission', request);
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bounty-rest:${command.workspaceId}:${command.idempotencyKey}`]);
    const replay = await replayReceipt(client, command.workspaceId, command.idempotencyKey, 'program.admit', requestHash);
    if (replay) return replay;
    const existing = await client.query<ProgramRow>('SELECT id,name,revision FROM bounty_programs WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [command.workspaceId, command.programId]);
    if (existing.rows[0] && (existing.rows[0].name !== command.programName || Number(existing.rows[0].revision) !== command.policyRevision)) throw new ConflictError('Program admission changed an existing program identity');
    if (!existing.rows[0]) {
      const sameName = await client.query<{ id: string }>('SELECT id FROM bounty_programs WHERE workspace_id=$1 AND name=$2 FOR SHARE', [command.workspaceId, command.programName]);
      if (sameName.rows[0]) throw new ConflictError('Program name is already admitted under another identity');
      await client.query('INSERT INTO bounty_programs(id,workspace_id,name,revision) VALUES($1,$2,$3,$4)', [command.programId, command.workspaceId, command.programName, command.policyRevision]);
    }
    const priorAdmission = await client.query<{ id: string; scope_hash: string }>('SELECT id,scope_hash FROM bounty_program_admissions WHERE workspace_id=$1 AND program_id=$2', [command.workspaceId, command.programId]);
    const scopeHash = hashBountyContract('program-admission-scope', command.scope);
    if (priorAdmission.rows[0] && priorAdmission.rows[0].scope_hash !== scopeHash) throw new ConflictError('Program already has a different admitted scope');
    const admissionId = priorAdmission.rows[0]?.id ?? randomUUID();
    if (!priorAdmission.rows[0]) await client.query(
      `INSERT INTO bounty_program_admissions(id,workspace_id,program_id,policy_revision,scope,scope_hash,actor)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [admissionId, command.workspaceId, command.programId, command.policyRevision, command.scope, scopeHash, command.actor],
    );
    const response = { receiptId: randomUUID(), admissionId, programId: command.programId, policyRevision: command.policyRevision, scopeHash, admitted: true, replayed: false };
    await saveReceipt(client, { authority: command, key: command.idempotencyKey, operation: 'program.admit', requestHash, response });
    return response;
  });
}

/** Persist only a bounded, hash-only preview receipt; no mission or effect is launched. */
export async function previewBountyMission(command: BountyMissionPreviewCommand): Promise<Record<string, unknown>> {
  assertAuthority(command); restRequired(command.missionId, 'missionId'); restRequired(command.title, 'title', 512); restRequired(command.idempotencyKey, 'idempotencyKey');
  if (!Number.isSafeInteger(command.expectedProgramRevision) || command.expectedProgramRevision < 1) throw new ValidationError('expectedProgramRevision must be a positive integer');
  await assertEnabled();
  const request = { missionId: command.missionId, title: command.title, contract: command.contract, expectedProgramRevision: command.expectedProgramRevision };
  const requestHash = hashBountyContract('rest-mission-preview', request);
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bounty-rest:${command.workspaceId}:${command.idempotencyKey}`]);
    const replay = await replayReceipt(client, command.workspaceId, command.idempotencyKey, 'mission.preview', requestHash);
    if (replay) return replay;
    const program = await assertProgramAuthorityInTransaction(client, command);
    if (Number(program.revision) !== command.expectedProgramRevision) throw new ConflictError('Stale bounty program revision');
    const admission = await assertFreshProgramAdmission(client, command);
    const receiptId = randomUUID();
    const deployment = await client.query<{ qualification_receipt_hash: string; source_sha: string; worker_image_digest: string }>(
      `SELECT p.qualification_receipt_hash,p.source_sha,p.signed_payload->>'workerImageDigest' AS worker_image_digest FROM bounty_feature_policy f
       JOIN bounty_release_promotions p ON p.id=f.promotion_receipt_id
       LEFT JOIN bounty_release_promotion_revocations r ON r.promotion_id=p.id
       WHERE f.id=1 AND f.state='enabled' AND r.promotion_id IS NULL AND p.expires_at>now()`,
    );
    const deployed = deployment.rows[0];
    const workerImageDigest = String(process.env.RORCA_BOUNTY_WORKER_IMAGE_DIGEST ?? '').trim();
    if (!deployed || !/^sha256:[a-f0-9]{64}$/.test(workerImageDigest) || deployed.worker_image_digest !== workerImageDigest) throw new ServiceUnavailableError('Exact promoted deployment and worker image identity are required for mission preview');
    const contractHash = hashBountyContract('mission-contract', command.contract);
    const local = command.contract.localFixture;
    const configuredOrigin = String(process.env.RORCA_BOUNTY_LOCAL_FIXTURE_ORIGIN ?? '').trim();
    if (!local || typeof local !== 'object' || (local as Record<string, unknown>).targetOrigin !== configuredOrigin || !configuredOrigin) throw new ForbiddenError('Contract is not bound to the configured local-fixture origin');
    const approvalTarget = LocalFixtureLaunchTargetSchema.parse({
      version: 'bounty.local-fixture-launch.v1', action: 'mission.launch.local-fixture', workspaceId: command.workspaceId,
      programId: command.programId, missionId: command.missionId, previewReceiptId: receiptId, previewRequestHash: requestHash,
      contractHash, policyContractHash: admission.policy_contract_hash, deployedSourceSha: deployed.source_sha,
      deployedQualificationReceiptHash: deployed.qualification_receipt_hash, workerImageDigest, expectedProgramRevision: command.expectedProgramRevision,
      requesterId: command.actor, nonce: randomUUID(), issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    const response = {
      receiptId, missionId: command.missionId, programId: command.programId, contractHash, requestHash,
      approvalTarget, approvalTargetHash: localFixtureLaunchTargetHash(approvalTarget),
      launchable: false, providerHumanApprovalRequired: true, targetEffectsSent: false, replayed: false,
    };
    await saveReceipt(client, { authority: command, key: command.idempotencyKey, operation: 'mission.preview', requestHash, response });
    return response;
  });
}

/** Launch exactly the previously previewed mission; launch itself sends no target effect. */
export async function launchBountyMission(command: BountyMissionLaunchCommand): Promise<Record<string, unknown>> {
  assertAuthority(command); restRequired(command.missionId, 'missionId'); restRequired(command.title, 'title', 512); restRequired(command.previewReceiptId, 'previewReceiptId'); restRequired(command.idempotencyKey, 'idempotencyKey');
  if (!Number.isSafeInteger(command.expectedProgramRevision) || command.expectedProgramRevision < 1) throw new ValidationError('expectedProgramRevision must be a positive integer');
  await assertEnabled();
  const approval = verifyLocalFixtureProviderApproval(command.approvalTarget, command.providerHumanApproval);
  const request = { missionId: command.missionId, title: command.title, contract: command.contract, expectedProgramRevision: command.expectedProgramRevision, previewReceiptId: command.previewReceiptId, approvalTargetHash: approval.targetHash };
  const requestHash = hashBountyContract('rest-mission-launch', request);
  const previewHash = hashBountyContract('rest-mission-preview', { missionId: command.missionId, title: command.title, contract: command.contract, expectedProgramRevision: command.expectedProgramRevision });
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bounty-rest:${command.workspaceId}:${command.idempotencyKey}`]);
    const replay = await replayReceipt(client, command.workspaceId, command.idempotencyKey, 'mission.launch', requestHash);
    if (replay) return replay;
    const program = await assertProgramAuthorityInTransaction(client, command);
    if (Number(program.revision) !== command.expectedProgramRevision) throw new ConflictError('Stale bounty program revision');
    const admission = await assertFreshProgramAdmission(client, command);
    if (admission.policy_contract_hash !== approval.target.policyContractHash) throw new ForbiddenError('Local-fixture launch approval does not cite the admitted policy');
    if (approval.target.workspaceId !== command.workspaceId || approval.target.programId !== command.programId || approval.target.missionId !== command.missionId
        || approval.target.previewReceiptId !== command.previewReceiptId || approval.target.expectedProgramRevision !== command.expectedProgramRevision
        || approval.target.contractHash !== hashBountyContract('mission-contract', command.contract)
        || approval.target.workerImageDigest !== String(process.env.RORCA_BOUNTY_WORKER_IMAGE_DIGEST ?? '').trim()) throw new ForbiddenError('Local-fixture launch approval does not match the exact deployment and command');
    const deployment = await client.query<{ qualification_receipt_hash: string; source_sha: string; worker_image_digest: string }>(
      `SELECT p.qualification_receipt_hash,p.source_sha,p.signed_payload->>'workerImageDigest' AS worker_image_digest FROM bounty_feature_policy f
       JOIN bounty_release_promotions p ON p.id=f.promotion_receipt_id
       LEFT JOIN bounty_release_promotion_revocations r ON r.promotion_id=p.id
       WHERE f.id=1 AND f.state='enabled' AND r.promotion_id IS NULL AND p.expires_at>now()`,
    );
    const activeDeployment = deployment.rows[0];
    if (!activeDeployment) throw new ForbiddenError('Active promoted deployment is unavailable');
    assertLocalFixtureDeploymentBinding(approval.target, {
      deployedSourceSha: activeDeployment.source_sha,
      deployedQualificationReceiptHash: activeDeployment.qualification_receipt_hash,
      workerImageDigest: activeDeployment.worker_image_digest,
    });
    const preview = await client.query<ReceiptRow>(
      `SELECT id,operation,request_hash,response FROM bounty_controller_api_receipts
       WHERE workspace_id=$1 AND program_id=$2 AND id=$3 AND operation='mission.preview' FOR SHARE`,
      [command.workspaceId, command.programId, command.previewReceiptId],
    );
    if (!preview.rows[0] || preview.rows[0].request_hash !== previewHash || preview.rows[0].response.missionId !== command.missionId
        || preview.rows[0].response.approvalTargetHash !== approval.targetHash) throw new ForbiddenError('Launch does not match its exact mission preview and approval target');
    await client.query(
      `INSERT INTO bounty_local_fixture_launch_approvals
       (id,workspace_id,program_id,mission_id,target_hash,exact_target,provider_event,provider_key_hash)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(),command.workspaceId,command.programId,command.missionId,approval.targetHash,approval.target,approval.event,localFixtureProviderKeyHash(approval.event.publicKeyPem)],
    ).catch((error: unknown) => { throw new ForbiddenError('Provider-human launch approval was already consumed or conflicts with prior authority', { cause: error }); });
    const existing = await client.query('SELECT 1 FROM bounty_missions WHERE workspace_id=$1 AND id=$2', [command.workspaceId, command.missionId]);
    if (existing.rowCount) throw new ConflictError('Mission identity already exists');
    await client.query(`INSERT INTO bounty_missions(id,workspace_id,program_id,title,state,epoch) VALUES($1,$2,$3,$4,'active',1)`, [command.missionId, command.workspaceId, command.programId, command.title]);
    await client.query('INSERT INTO bounty_contracts(workspace_id,mission_id,revision,body) VALUES($1,$2,1,$3)', [command.workspaceId, command.missionId, command.contract]);
    const response = { receiptId: randomUUID(), missionId: command.missionId, programId: command.programId, state: 'active', epoch: 1, targetEffectsSent: false, authorizationHash: approval.targetHash, approvalReceiptConsumed: true, policyContractHash: approval.target.policyContractHash, workerImageDigest: approval.target.workerImageDigest, deployedQualificationReceiptHash: approval.target.deployedQualificationReceiptHash, replayed: false };
    await saveReceipt(client, { authority: command, missionId: command.missionId, key: command.idempotencyKey, operation: 'mission.launch', requestHash, response });
    await client.query(`INSERT INTO bounty_events(workspace_id,mission_id,event_identity,event_type,payload) VALUES($1,$2,$3,'mission.launched',$4)`, [command.workspaceId, command.missionId, `rest-launch:${response.receiptId}`, response]);
    return response;
  });
}

export async function getBountyMissionStatus(authority: BountyAuthority, missionId: string): Promise<Record<string, unknown>> {
  restRequired(missionId, 'missionId'); await assertEnabled(); await assertBountyProgramAuthority(authority, missionId);
  const status = await queryOne<MissionRow & {
    program_name: string; program_revision: string; scope_hash: string; scope_expires_at: string;
    contract_body: Record<string, unknown>; budget_revision: string | null; budget_limit_cents: string | null;
    work_total: string; work_active: string; evidence_total: string; finding_total: string; draft_total: string; hold_total: string;
  }>(
    `SELECT m.id,m.program_id,m.title,m.state,m.epoch,m.created_at,
      p.name AS program_name,p.revision AS program_revision,a.scope_hash,a.scope->>'expiresAt' AS scope_expires_at,
      c.body AS contract_body,b.revision AS budget_revision,b.limit_cents AS budget_limit_cents,
      (SELECT count(*) FROM bounty_work_packages w WHERE w.workspace_id=m.workspace_id AND w.mission_id=m.id) AS work_total,
      (SELECT count(*) FROM bounty_work_packages w WHERE w.workspace_id=m.workspace_id AND w.mission_id=m.id AND w.status IN ('pending','running')) AS work_active,
      (SELECT count(*) FROM bounty_evidence e WHERE e.workspace_id=m.workspace_id AND e.mission_id=m.id) AS evidence_total,
      (SELECT count(*) FROM bounty_findings f WHERE f.workspace_id=m.workspace_id AND f.mission_id=m.id) AS finding_total,
      (SELECT count(*) FROM bounty_report_drafts d WHERE d.workspace_id=m.workspace_id AND d.mission_id=m.id) AS draft_total,
      (SELECT count(*) FROM bounty_holds h WHERE h.workspace_id=m.workspace_id AND h.mission_id=m.id AND h.released_at IS NULL) AS hold_total
     FROM bounty_missions m
     JOIN bounty_programs p ON p.workspace_id=m.workspace_id AND p.id=m.program_id
     JOIN bounty_program_admissions a ON a.workspace_id=p.workspace_id AND a.program_id=p.id
     JOIN LATERAL (SELECT body FROM bounty_contracts WHERE workspace_id=m.workspace_id AND mission_id=m.id ORDER BY revision DESC LIMIT 1) c ON TRUE
     LEFT JOIN LATERAL (SELECT revision,limit_cents FROM bounty_budgets WHERE workspace_id=m.workspace_id AND mission_id=m.id ORDER BY revision DESC LIMIT 1) b ON TRUE
     WHERE m.workspace_id=$1 AND m.program_id=$2 AND m.id=$3`, [authority.workspaceId, authority.programId, missionId],
  );
  if (!status) throw new NotFoundError('Bounty mission');
  return {
    id: status.id, programId: status.program_id, programName: status.program_name,
    programRevision: Number(status.program_revision), title: status.title, state: status.state,
    epoch: Number(status.epoch), createdAt: new Date(status.created_at).toISOString(),
    contractHash: hashBountyContract('mission-contract', status.contract_body), scopeHash: status.scope_hash,
    scopeExpiresAt: status.scope_expires_at, budgetRevision: status.budget_revision === null ? null : Number(status.budget_revision),
    budgetLimitCents: status.budget_limit_cents === null ? null : Number(status.budget_limit_cents),
    workTotal: Number(status.work_total), workActive: Number(status.work_active), evidenceTotal: Number(status.evidence_total),
    findingTotal: Number(status.finding_total), draftTotal: Number(status.draft_total), holdTotal: Number(status.hold_total),
  };
}

async function listAuthorized<T>(context: ListContext, table: string, select: string): Promise<PaginatedResponse<T>> {
  restRequired(context.missionId, 'missionId'); await assertEnabled(); await assertBountyProgramAuthority(context, context.missionId);
  return paginateQuery<T>({
    query: `SELECT ${select} FROM ${table} x WHERE x.workspace_id=$1 AND x.mission_id=$2`,
    countQuery: `SELECT count(*) AS total FROM ${table} x WHERE x.workspace_id=$1 AND x.mission_id=$2`,
    params: [context.workspaceId, context.missionId], pagination: context.pagination, orderBy: 'x.id DESC', cursorColumn: 'id',
  });
}

export const listBountyWork = (context: ListContext): Promise<PaginatedResponse<Record<string, unknown>>> => listAuthorized(context, 'bounty_work_packages', 'x.id,x.release_sequence,x.status,x.package_hash,x.created_at');
export const listBountyFindings = (context: ListContext): Promise<PaginatedResponse<Record<string, unknown>>> => listAuthorized(context, 'bounty_findings', 'x.id,x.finding_identity,x.status,x.authority_epoch,x.created_at');
export const listBountyHolds = (context: ListContext): Promise<PaginatedResponse<Record<string, unknown>>> => listAuthorized(context, 'bounty_holds', 'x.id,x.reason,x.created_at,x.released_at');

export async function listBountyEvidence(context: ListContext, includeRaw: boolean): Promise<PaginatedResponse<Record<string, unknown>>> {
  const result = await listAuthorized<Record<string, unknown>>(context, 'bounty_evidence', includeRaw ? 'x.id,x.evidence_identity,x.digest,x.authority_epoch,x.created_at,x.payload' : 'x.id,x.evidence_identity,x.digest,x.authority_epoch,x.created_at');
  return includeRaw ? { ...result, items: result.items.map((item) => redactBountyRawValue(item) as Record<string, unknown>) } : result;
}
export async function listBountyDrafts(context: ListContext, includeRaw: boolean): Promise<PaginatedResponse<Record<string, unknown>>> {
  const select = includeRaw
    ? `x.id,x.finding_id,x.revision,x.bundle_hash,x.markdown_hash,x.json_hash,x.release_status,x.created_at,
       encode(x.markdown_bytes,'base64') AS markdown_base64,encode(x.json_bytes,'base64') AS json_base64,x.citation_manifest,x.redaction_manifest`
    : 'x.id,x.finding_id,x.revision,x.bundle_hash,x.markdown_hash,x.json_hash,x.release_status,x.created_at';
  const result = await listAuthorized<Record<string, unknown>>(context, 'bounty_report_drafts', select);
  return includeRaw ? { ...result, items: result.items.map((item) => redactBountyRawValue(item) as Record<string, unknown>) } : result;
}

export async function createBountyHold(command: BountyMissionCommand): Promise<Record<string, unknown>> {
  assertAuthority(command); restRequired(command.missionId, 'missionId'); restRequired(command.reason, 'reason', 512); restRequired(command.idempotencyKey, 'idempotencyKey');
  if (!Number.isSafeInteger(command.expectedEpoch) || command.expectedEpoch < 1) throw new ValidationError('expectedEpoch must be a positive integer');
  await assertEnabled();
  const requestHash = hashBountyContract('rest-mission-hold', { missionId: command.missionId, expectedEpoch: command.expectedEpoch, reason: command.reason });
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bounty-rest:${command.workspaceId}:${command.idempotencyKey}`]);
    const replay = await replayReceipt(client, command.workspaceId, command.idempotencyKey, 'mission.hold', requestHash); if (replay) return replay;
    await assertProgramAuthorityInTransaction(client, command, command.missionId);
    const mission = await client.query<{ state: string; epoch: string }>('SELECT state,epoch FROM bounty_missions WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [command.workspaceId, command.missionId]);
    if (!mission.rows[0] || mission.rows[0].state !== 'active') throw new UnprocessableError('Only an active mission can be held', 'ILLEGAL_MISSION_HOLD');
    if (Number(mission.rows[0].epoch) !== command.expectedEpoch) throw new ConflictError('Stale mission epoch');
    const holdId = randomUUID(); const epoch = command.expectedEpoch + 1;
    await client.query('INSERT INTO bounty_holds(id,workspace_id,mission_id,reason) VALUES($1,$2,$3,$4)', [holdId, command.workspaceId, command.missionId, command.reason]);
    await client.query(`UPDATE bounty_missions SET state='held',epoch=$1,control_reason=$2,controlled_at=now() WHERE workspace_id=$3 AND id=$4`, [epoch, command.reason, command.workspaceId, command.missionId]);
    const response = { receiptId: randomUUID(), holdId, missionId: command.missionId, state: 'held', epoch, replayed: false };
    await saveReceipt(client, { authority: command, missionId: command.missionId, key: command.idempotencyKey, operation: 'mission.hold', requestHash, response }); return response;
  });
}

export async function releaseBountyHold(command: BountyHoldReleaseCommand): Promise<Record<string, unknown>> {
  assertAuthority(command); restRequired(command.missionId, 'missionId'); restRequired(command.holdId, 'holdId'); restRequired(command.reason, 'reason', 512); restRequired(command.idempotencyKey, 'idempotencyKey');
  if (!Number.isSafeInteger(command.expectedEpoch) || command.expectedEpoch < 1) throw new ValidationError('expectedEpoch must be a positive integer');
  await assertEnabled();
  const requestHash = hashBountyContract('rest-mission-hold-release', { missionId: command.missionId, holdId: command.holdId, expectedEpoch: command.expectedEpoch, reason: command.reason });
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bounty-rest:${command.workspaceId}:${command.idempotencyKey}`]);
    const replay = await replayReceipt(client, command.workspaceId, command.idempotencyKey, 'mission.hold.release', requestHash); if (replay) return replay;
    await assertProgramAuthorityInTransaction(client, command, command.missionId);
    const mission = await client.query<{ state: string; epoch: string }>('SELECT state,epoch FROM bounty_missions WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [command.workspaceId, command.missionId]);
    if (!mission.rows[0] || mission.rows[0].state !== 'held' || Number(mission.rows[0].epoch) !== command.expectedEpoch) throw new ConflictError('Held mission authority changed');
    const released = await client.query('UPDATE bounty_holds SET released_at=now() WHERE workspace_id=$1 AND mission_id=$2 AND id=$3 AND released_at IS NULL', [command.workspaceId, command.missionId, command.holdId]);
    if (!released.rowCount) throw new NotFoundError('Active bounty hold');
    const remaining = await client.query('SELECT 1 FROM bounty_holds WHERE workspace_id=$1 AND mission_id=$2 AND released_at IS NULL LIMIT 1', [command.workspaceId, command.missionId]);
    if (remaining.rowCount) throw new ForbiddenError('Other active holds still block mission release');
    const epoch = command.expectedEpoch + 1;
    await client.query(`UPDATE bounty_missions SET state='active',epoch=$1,control_reason=$2,controlled_at=now() WHERE workspace_id=$3 AND id=$4`, [epoch, command.reason, command.workspaceId, command.missionId]);
    const response = { receiptId: randomUUID(), holdId: command.holdId, missionId: command.missionId, state: 'active', epoch, replayed: false };
    await saveReceipt(client, { authority: command, missionId: command.missionId, key: command.idempotencyKey, operation: 'mission.hold.release', requestHash, response }); return response;
  });
}

export async function controlBountyMission(command: BountyMissionCommand, action: Exclude<BountyLifecycleAction, 'resume'>, hooks: MissionControlHooks = {}): Promise<Record<string, unknown>> {
  assertAuthority(command); restRequired(command.missionId, 'missionId'); restRequired(command.reason, 'reason', 512); restRequired(command.idempotencyKey, 'idempotencyKey');
  await assertEnabled(); await assertBountyProgramAuthority(command, command.missionId);
  const requestHash = hashBountyContract('rest-mission-control', { missionId: command.missionId, expectedEpoch: command.expectedEpoch, reason: command.reason, action });
  // Hold the REST replay lock while the canonical lifecycle transaction executes.
  // This prevents another REST command from claiming the same key before its receipt is saved.
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bounty-rest:${command.workspaceId}:${command.idempotencyKey}`]);
    const replay = await replayReceipt(client, command.workspaceId, command.idempotencyKey, `mission.${action}`, requestHash); if (replay) return replay;
    const receipt = await executeBountyLifecycleCommand({ ...command, action }, hooks);
    const response = { ...receipt, replayed: false };
    await saveReceipt(client, { authority: command, missionId: command.missionId, key: command.idempotencyKey, operation: `mission.${action}`, requestHash, response }); return response;
  });
}

/** Record local human readiness review. It never creates a release or submission transport. */
export async function reviewBountyDraftRelease(command: BountyReleaseReviewCommand): Promise<Record<string, unknown>> {
  assertAuthority(command); restRequired(command.missionId, 'missionId'); restRequired(command.draftId, 'draftId'); restRequired(command.reason, 'reason', 512); restRequired(command.idempotencyKey, 'idempotencyKey');
  await assertEnabled();
  const requestHash = hashBountyContract('rest-draft-release-review', { missionId: command.missionId, draftId: command.draftId, decision: command.decision, reason: command.reason });
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bounty-rest:${command.workspaceId}:${command.idempotencyKey}`]);
    const replay = await replayReceipt(client, command.workspaceId, command.idempotencyKey, 'draft.release.review', requestHash); if (replay) return replay;
    await assertProgramAuthorityInTransaction(client, command, command.missionId);
    const draft = await client.query<{ bundle_hash: string }>(
      `SELECT bundle_hash FROM bounty_report_drafts WHERE workspace_id=$1 AND program_id=$2 AND mission_id=$3 AND id=$4 FOR SHARE`,
      [command.workspaceId, command.programId, command.missionId, command.draftId],
    );
    if (!draft.rows[0]) throw new NotFoundError('Bounty report draft');
    const reviewId = randomUUID();
    await client.query(
      `INSERT INTO bounty_draft_release_reviews(id,workspace_id,program_id,mission_id,draft_id,decision,bundle_hash,reason,actor)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [reviewId, command.workspaceId, command.programId, command.missionId, command.draftId, command.decision, draft.rows[0].bundle_hash, command.reason, command.actor],
    );
    const response = { receiptId: randomUUID(), reviewId, draftId: command.draftId, decision: command.decision, bundleHash: draft.rows[0].bundle_hash, submissionReady: false, submitted: false, replayed: false };
    await saveReceipt(client, { authority: command, missionId: command.missionId, key: command.idempotencyKey, operation: 'draft.release.review', requestHash, response }); return response;
  });
}

/** Explicitly empty: target-effect IPC is Controller-internal and has no external operation inventory. */
export const BOUNTY_TARGET_EFFECT_EXTERNAL_OPERATIONS = Object.freeze([] as readonly never[]);
