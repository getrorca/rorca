/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from './errors';

export const WAVE2_GATE_VERSION = 'rorca.wave2-prerequisite-gate.v1' as const;
export const WAVE2_IMPLEMENTATION_ISSUE = 'ROR-23' as const;
export const ROR24_GATE_ONLY_ISSUE = 'ROR-24' as const;
export const ROR24_SOURCE_SHA = 'dab2a136a1d1754ccdaeb15224a60a6e9dedd594' as const;
export const ROR24_SOURCE_BLOB = '8bc32c523890abb2e24bbe2d3253c2ed448c6369' as const;
export const ROR24_SOURCE_SHA256 = 'b6ca538e513716b5e331964af110c5f8b20d432c22308cac18099a3ef7f973a5' as const;
export const ROR24_SNAPSHOT_SHA256 = '9946a04ece8f1d92b3f0682c1a6a7f131c6c095194b05ab2e09ce87c726fd7c6' as const;
export const ROR24_TEAM_ID = 'e9bad59f-2e0a-49cf-b17e-ce50c21404a8' as const;
export const ROR24_STATE_ID = '7b11af68-882f-4d3a-bf79-ef0c42140cbe' as const;
export const ROR24_ACTOR_ID = '87d15d67-d272-4007-8300-459bdd6c0331' as const;
export const ROR24_COMMENT_ID = '2823a595-c79e-4d0a-8e48-7c5216b0bb66' as const;
export const ROR24_UPDATED_AT = '2026-07-29T17:54:04.845Z' as const;
export const WAVE1_SOURCE_SHA = '38d26ee944f0fd80904e79021100d5023b70f170' as const;
export const WAVE1_SPEC_SHA256 = 'caeb0720cd09f4e6a5cd22b078b2d50932b34613262c15631cdf71af9c056920' as const;
export const WAVE1_REVIEW_SHA256 = '577a6d9ab9efe0753b50e031d16bc67b53bad71fc314396e077b2d57849ecd4c' as const;
export const WAVE1_REVIEW_VERDICT = 'APPROVED_FOR_FINAL_WAVE1_PREFLIGHT' as const;
export const WAVE2_PROTECTED_IDENTITIES = ['20260316000549', '20260316000550'] as const;

const Sha40 = z.string().regex(/^[a-f0-9]{40}$/);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Sha256Prefixed = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Uuid = z.string().uuid();

const AcceptanceSnapshotSchema = z.object({
  acceptance: z.object({
    actor: z.object({ displayName: z.string(), id: Uuid, isAdmin: z.boolean(), name: z.string() }).strict(),
    authority: z.string(),
    commentId: Uuid,
    createdAt: z.string(),
    excludedAuthority: z.array(z.string()),
    scope: z.array(z.string()),
  }).strict(),
  adr: z.object({ path: z.string(), repository: z.string(), sha256: Sha256, sourceSha: Sha40, version: z.string() }).strict(),
  issue: z.object({
    completedAt: z.string(), identifier: z.string(),
    state: z.object({ id: Uuid, name: z.string(), type: z.string() }).strict(),
    title: z.string(), updatedAt: z.string(), url: z.string(),
  }).strict(),
  observedAt: z.string(), observer: z.string(), schemaVersion: z.string(),
  team: z.object({ id: Uuid, key: z.string(), name: z.string() }).strict(),
  workspace: z.object({ slug: z.string() }).strict(),
}).strict();

export const Ror24AcceptanceEnvelopeSchema = z.object({
  schemaVersion: z.literal('rorca.governed-adr-acceptance.v1'),
  acceptanceId: z.literal(`linear-comment:${ROR24_COMMENT_ID}`),
  decision: z.object({
    adrId: z.literal('ADR-0001'), adrVersion: z.literal('ADR-0001/v1'),
    acceptedAt: z.literal('2026-07-29T17:53:58.837Z'), acceptedDate: z.literal('2026-07-29'),
    status: z.literal('accepted'), metadataTransition: z.literal('Proposed->Accepted'),
    decisionBytesMateriallyChanged: z.literal(false),
  }).strict(),
  artifact: z.object({
    repository: z.literal('getrorca/rorca'), repositoryRemote: z.literal('https://github.com/getrorca/rorca.git'),
    sourceSha: z.literal(ROR24_SOURCE_SHA),
    path: z.literal('docs/architecture/adr/0001-governed-execution-authority.md'),
    gitBlobOid: z.literal(ROR24_SOURCE_BLOB), sha256: z.literal(ROR24_SOURCE_SHA256),
    statusInAcceptedBytes: z.literal('Proposed'), bindingRule: z.string().min(1).max(500),
  }).strict(),
  linear: z.object({
    workspaceSlug: z.literal('rorca'), teamId: z.literal(ROR24_TEAM_ID), teamKey: z.literal('ROR'),
    issueId: z.literal(ROR24_GATE_ONLY_ISSUE), issueUrl: z.string().url(),
    acceptedStateId: z.literal(ROR24_STATE_ID), acceptedStateName: z.literal('Done'),
    issueUpdatedAt: z.literal(ROR24_UPDATED_AT), issueCompletedAt: z.literal('2026-07-29T17:54:04.825Z'),
    acceptanceCommentId: z.literal(ROR24_COMMENT_ID),
    actor: z.object({ authorityClass: z.literal('provider_human'), id: z.literal(ROR24_ACTOR_ID), name: z.literal('Dimitri Teravanessian') }).strict(),
  }).strict(),
  snapshot: z.object({
    schemaVersion: z.literal('rorca.ror24-acceptance-snapshot.v1'),
    path: z.literal('docs/implementation/evidence/ror24-adr-0001-v1/linear-acceptance-snapshot.json'),
    sha256: z.literal(ROR24_SNAPSHOT_SHA256), observedAt: z.literal('2026-07-29T17:54:32.203824Z'),
    observer: z.literal('pi-linear-structured-tools'), serialization: z.literal('exact-file-bytes'),
  }).strict(),
  scope: z.object({
    gateFor: z.literal(WAVE2_IMPLEMENTATION_ISSUE),
    allowed: z.tuple([z.literal('wave2_preflight'), z.literal('wave2_isolated_implementation')]),
    excluded: z.tuple([
      z.literal('dispatch_ror24'), z.literal('merge'), z.literal('deployment'), z.literal('provider_operations'),
      z.literal('protected_run_access'), z.literal('proof_run_access'), z.literal('readiness_override'), z.literal('pass_fabrication'),
    ]),
    executionAuthority: z.literal('none'), mergeAuthority: z.literal('none'), deploymentAuthority: z.literal('none'),
  }).strict(),
  protectedIdentities: z.object({
    genesisRunId: z.literal(WAVE2_PROTECTED_IDENTITIES[0]), proofRunId: z.literal(WAVE2_PROTECTED_IDENTITIES[1]),
  }).strict(),
}).strict();

const Wave1SourcePacketSchema = z.object({
  repository: z.literal('getrorca/rorca'), sourceSha: z.literal(WAVE1_SOURCE_SHA),
  specPath: z.literal('forge/specs/pending/wave-1-stabilize-evidence-closeout-and-managed-branch-delivery.json'),
  specSha256: z.literal(WAVE1_SPEC_SHA256), canonicalStoryMaterialHash: Sha256Prefixed,
  storyCount: z.literal(10), criterionCount: z.literal(51),
  independentReview: z.object({
    path: z.literal('/tmp/rorca-wave1-local-rereview3-final.md'), sha256: z.literal(WAVE1_REVIEW_SHA256),
    verdict: z.literal(WAVE1_REVIEW_VERDICT), independentlySupportedCriteria: z.literal(49),
    retainedExactSourceEvidenceCriteria: z.literal(2), failedCriteria: z.literal(0),
  }).strict(),
  providerNeutralProof: z.object({
    adapterId: z.literal('LocalReviewBundleAdapter'), adapterVersion: z.literal('local-review-bundle@1.1.0'),
    manifestSchema: z.literal('rorca.local-review-bundle.v1'), requiresNetwork: z.literal(false), requiresCredentials: z.literal(false),
    sourceSha256: Sha256, testSha256: Sha256, migrationSha256: Sha256, databaseTestSha256: Sha256,
    validationReceipt: z.object({
      kind: z.literal('retained-exact-source-validation-evidence'), databaseLogSha256: Sha256,
      databaseAttestationSha256: Sha256, cleanupSha256: Sha256, waveUnitLogSha256: Sha256,
    }).strict(),
    mergeAuthority: z.literal('none'), deploymentAuthority: z.literal('none'),
  }).strict(),
  canonicalCloseoutReceipt: z.null(), passesChanged: z.literal(false), executionAuthority: z.literal('none'),
}).strict();

export const Wave2SourceGatePacketSchema = z.object({
  schemaVersion: z.literal('rorca.wave2-source-gate-packet.v1'), gateFor: z.literal(WAVE2_IMPLEMENTATION_ISSUE),
  ror24AcceptanceEnvelopePath: z.literal('docs/implementation/evidence/ror24-adr-0001-v1/acceptance-envelope.json'),
  wave1: Wave1SourcePacketSchema,
  implementation: z.object({
    baselineSha: z.literal(ROR24_SOURCE_SHA), branch: z.literal('feat/wave2-governed-contracts-20260729'),
    mode: z.literal('isolated-source-implementation'), authorized: z.literal(true), authoritySource: z.string().min(1).max(300),
    ror24DispatchAllowed: z.literal(false), providerOperationsAllowed: z.literal(false), mergeAllowed: z.literal(false),
    deploymentAllowed: z.literal(false), readinessOverrideAllowed: z.literal(false), passMutationAllowed: z.literal(false),
  }).strict(),
  protectedIdentities: z.tuple([z.literal(WAVE2_PROTECTED_IDENTITIES[0]), z.literal(WAVE2_PROTECTED_IDENTITIES[1])]),
}).strict();

/** Any dispatch-capable schema must structurally exclude ROR-24. */
export const Wave2DispatchTargetSchema = z.object({
  gateFor: z.literal(WAVE2_IMPLEMENTATION_ISSUE),
  issueId: z.string().regex(/^ROR-[0-9]+$/).refine((value) => value !== ROR24_GATE_ONLY_ISSUE, {
    message: 'ROR-24 is gate-only and cannot be dispatched',
  }),
  runId: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
}).strict();

export type Wave2GateBlockedReason =
  | 'MISSING_EVIDENCE' | 'MALFORMED_OR_CHANGED_EVIDENCE' | 'SNAPSHOT_HASH_MISMATCH'
  | 'ARTIFACT_HASH_MISMATCH' | 'ARTIFACT_BLOB_MISMATCH' | 'PENDING_ACCEPTANCE'
  | 'STALE_ACCEPTANCE' | 'CROSS_WORKSPACE' | 'WRONG_TEAM' | 'SELF_ASSERTED_AUTHORITY'
  | 'WRONG_SOURCE_SHA' | 'DUPLICATE_EVIDENCE' | 'WAVE1_SOURCE_MISMATCH'
  | 'WAVE1_REVIEW_MISMATCH' | 'ROR24_DISPATCH_FORBIDDEN' | 'PROTECTED_IDENTITY_FORBIDDEN';

export class Wave2GateBlockedError extends AppError {
  readonly statusCode = 409 as const;
  constructor(readonly reason: Wave2GateBlockedReason, message: string) {
    super(message, 'WAVE2_PREREQUISITE_BLOCKED', { reason, retryable: false });
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitBlobOid(bytes: Buffer): string {
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
}

function block(reason: Wave2GateBlockedReason, message: string): never {
  throw new Wave2GateBlockedError(reason, message);
}

export interface VerifyWave2PrerequisitesInput {
  acceptanceEnvelope: unknown;
  acceptanceSnapshotBytes: Buffer;
  acceptedAdrBytes: Buffer;
  sourceGatePacket: unknown;
  requestedIssueId?: string;
  requestedRunId?: string | number;
}

export interface Wave2SourceGateDecision {
  schemaVersion: typeof WAVE2_GATE_VERSION;
  decision: 'accepted';
  gateFor: typeof WAVE2_IMPLEMENTATION_ISSUE;
  acceptedAdr: { sourceSha: string; gitBlobOid: string; sha256: string; acceptanceCommentId: string };
  acceptedWave1: { sourceSha: string; specSha256: string; reviewSha256: string; verdict: string };
  implementationAuthority: 'isolated_source_only';
  executionAuthority: 'none';
  mergeAuthority: 'none';
  deploymentAuthority: 'none';
}

/**
 * Pure, read-only prerequisite verifier. Call before opening a migration
 * transaction, publishing generated contracts, selecting a run, or dispatching.
 */
export function verifyWave2Prerequisites(input: VerifyWave2PrerequisitesInput): Wave2SourceGateDecision {
  if (!input.acceptanceEnvelope || !input.sourceGatePacket || !input.acceptanceSnapshotBytes || !input.acceptedAdrBytes) {
    block('MISSING_EVIDENCE', 'The exact ROR-24 and Wave 1 evidence packet is required');
  }
  if (input.requestedIssueId === ROR24_GATE_ONLY_ISSUE) {
    block('ROR24_DISPATCH_FORBIDDEN', 'ROR-24 is prerequisite-only and cannot be dispatched');
  }
  if (input.requestedRunId !== undefined && WAVE2_PROTECTED_IDENTITIES.includes(String(input.requestedRunId) as never)) {
    block('PROTECTED_IDENTITY_FORBIDDEN', 'Protected and proof run identities are ineligible before any read or lock');
  }

  const rawEnvelope = input.acceptanceEnvelope as {
    linear?: { workspaceSlug?: unknown; teamId?: unknown; issueUpdatedAt?: unknown; actor?: { authorityClass?: unknown; id?: unknown } };
    artifact?: { sourceSha?: unknown };
    decision?: { status?: unknown };
    scope?: { excluded?: unknown[] };
  };
  if (rawEnvelope?.linear?.workspaceSlug !== 'rorca') block('CROSS_WORKSPACE', 'Acceptance belongs to another workspace');
  if (rawEnvelope?.linear?.teamId !== ROR24_TEAM_ID) block('WRONG_TEAM', 'Acceptance belongs to another Linear team');
  if (rawEnvelope?.linear?.actor?.authorityClass !== 'provider_human' || rawEnvelope?.linear?.actor?.id !== ROR24_ACTOR_ID) {
    block('SELF_ASSERTED_AUTHORITY', 'Acceptance must be bound to the exact provider-human actor');
  }
  if (rawEnvelope?.artifact?.sourceSha !== ROR24_SOURCE_SHA) block('WRONG_SOURCE_SHA', 'Accepted artifact source SHA changed');
  if (rawEnvelope?.decision?.status !== 'accepted') block('PENDING_ACCEPTANCE', 'ROR-24 is not accepted');
  if (rawEnvelope?.linear?.issueUpdatedAt !== ROR24_UPDATED_AT) block('STALE_ACCEPTANCE', 'Linear acceptance version marker changed');
  if (new Set(rawEnvelope?.scope?.excluded ?? []).size !== (rawEnvelope?.scope?.excluded ?? []).length) {
    block('DUPLICATE_EVIDENCE', 'Acceptance exclusions contain duplicate or ambiguous entries');
  }

  const envelopeResult = Ror24AcceptanceEnvelopeSchema.safeParse(input.acceptanceEnvelope);
  const packetResult = Wave2SourceGatePacketSchema.safeParse(input.sourceGatePacket);
  if (!envelopeResult.success || !packetResult.success) {
    const packet = input.sourceGatePacket as {
      wave1?: { sourceSha?: unknown; specSha256?: unknown; independentReview?: { sha256?: unknown; verdict?: unknown } };
    };
    if (packet?.wave1?.sourceSha !== WAVE1_SOURCE_SHA || packet?.wave1?.specSha256 !== WAVE1_SPEC_SHA256) {
      block('WAVE1_SOURCE_MISMATCH', 'Wave 1 source or spec identity changed');
    }
    if (packet?.wave1?.independentReview?.sha256 !== WAVE1_REVIEW_SHA256
      || packet?.wave1?.independentReview?.verdict !== WAVE1_REVIEW_VERDICT) {
      block('WAVE1_REVIEW_MISMATCH', 'Wave 1 independent review identity changed');
    }
    block('MALFORMED_OR_CHANGED_EVIDENCE', 'Gate evidence is malformed, incomplete, or differs from accepted exact values');
  }

  if (sha256(input.acceptanceSnapshotBytes) !== ROR24_SNAPSHOT_SHA256) {
    block('SNAPSHOT_HASH_MISMATCH', 'Acceptance snapshot bytes changed');
  }
  let snapshotCandidate: unknown;
  try {
    snapshotCandidate = JSON.parse(input.acceptanceSnapshotBytes.toString('utf8')) as unknown;
  } catch {
    block('MALFORMED_OR_CHANGED_EVIDENCE', 'Acceptance snapshot is not valid JSON');
  }
  const snapshotResult = AcceptanceSnapshotSchema.safeParse(snapshotCandidate);
  if (!snapshotResult.success) block('MALFORMED_OR_CHANGED_EVIDENCE', 'Acceptance snapshot schema is invalid');
  const snapshot = snapshotResult.data;
  if (snapshot.workspace.slug !== 'rorca') block('CROSS_WORKSPACE', 'Snapshot belongs to another workspace');
  if (snapshot.team.id !== ROR24_TEAM_ID) block('WRONG_TEAM', 'Snapshot belongs to another team');
  if (snapshot.acceptance.actor.id !== ROR24_ACTOR_ID || snapshot.acceptance.authority !== 'human') {
    block('SELF_ASSERTED_AUTHORITY', 'Snapshot is not exact human authority');
  }
  if (snapshot.issue.state.id !== ROR24_STATE_ID || snapshot.issue.state.name !== 'Done') block('PENDING_ACCEPTANCE', 'Snapshot state is not accepted');
  if (snapshot.issue.updatedAt !== ROR24_UPDATED_AT) block('STALE_ACCEPTANCE', 'Snapshot version marker is stale');

  if (sha256(input.acceptedAdrBytes) !== ROR24_SOURCE_SHA256) block('ARTIFACT_HASH_MISMATCH', 'Accepted ADR bytes changed');
  if (gitBlobOid(input.acceptedAdrBytes) !== ROR24_SOURCE_BLOB) block('ARTIFACT_BLOB_MISMATCH', 'Accepted ADR Git blob identity changed');

  return {
    schemaVersion: WAVE2_GATE_VERSION,
    decision: 'accepted', gateFor: WAVE2_IMPLEMENTATION_ISSUE,
    acceptedAdr: {
      sourceSha: ROR24_SOURCE_SHA, gitBlobOid: ROR24_SOURCE_BLOB, sha256: ROR24_SOURCE_SHA256,
      acceptanceCommentId: ROR24_COMMENT_ID,
    },
    acceptedWave1: {
      sourceSha: WAVE1_SOURCE_SHA, specSha256: WAVE1_SPEC_SHA256,
      reviewSha256: WAVE1_REVIEW_SHA256, verdict: WAVE1_REVIEW_VERDICT,
    },
    implementationAuthority: 'isolated_source_only', executionAuthority: 'none', mergeAuthority: 'none', deploymentAuthority: 'none',
  };
}

/** Resolve and verify the exact repository-local prerequisite evidence before any Wave 2 installation side effect. */
export function verifyLocalWave2Prerequisites(repositoryRoot: string): Wave2SourceGateDecision {
  const evidenceRoot = path.join(repositoryRoot, 'docs/implementation/evidence/ror24-adr-0001-v1');
  const acceptanceEnvelope = JSON.parse(fs.readFileSync(path.join(evidenceRoot, 'acceptance-envelope.json'), 'utf8')) as unknown;
  const sourceGatePacket = JSON.parse(fs.readFileSync(path.join(evidenceRoot, 'wave2-source-gate-packet.json'), 'utf8')) as unknown;
  const acceptanceSnapshotBytes = fs.readFileSync(path.join(evidenceRoot, 'linear-acceptance-snapshot.json'));
  // Runtime images intentionally contain no .git directory. The packaged ADR
  // bytes are independently pinned below by SHA-256 and Git-blob OID, while the
  // accepted source SHA remains bound by the signed evidence packet.
  const acceptedAdrBytes = fs.readFileSync(path.join(evidenceRoot, 'accepted-adr-source.md'));
  return verifyWave2Prerequisites({ acceptanceEnvelope, sourceGatePacket, acceptanceSnapshotBytes, acceptedAdrBytes });
}
