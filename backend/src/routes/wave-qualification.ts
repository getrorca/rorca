/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { execute, query, queryOne } from '../db/index';
import { AdminRequiredError, AppError, NotFoundError, ServiceUnavailableError, UnprocessableError, ValidationError } from '../lib/errors';
import {
  assertPortableQualificationReport,
  computeLocalQualificationIdentity,
  renderQualificationReport,
  verifyQualificationReceipt,
  type QualificationReceipt,
  type QualificationReport,
} from '../lib/wave-qualification-evidence';
import { WAVE_CANONICAL_ASSERTION_IDS } from '../lib/wave-canonical-assertions';
import { QUALIFICATION_SCENARIOS } from '../lib/wave-qualification-model';
import { resolveWaveProductionPolicy } from '../lib/wave-production-governance';
import {
  assertWaveReleaseReadinessPacket,
  verifyWaveProductionActivation,
  verifyWaveReleaseEvidence,
  waveReleaseReadinessPacketHash,
  type WaveEvidenceResolver,
  type WaveReleaseReadinessPacket,
  type WaveResolvedEvidence,
} from '../lib/wave-release-readiness';

const router = Router();

/** Defense in depth: these operator routes can authorize production rollout. */
function requireWaveQualificationAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    next(new AdminRequiredError());
    return;
  }
  next();
}

router.use(requireWaveQualificationAdmin);

const CANONICAL_WAVE_ASSERTION_IDS: ReadonlySet<string> = new Set(WAVE_CANONICAL_ASSERTION_IDS);

const RolloutControlSchema = z.object({
  workspaceId: z.string().min(1).max(256),
  enabled: z.boolean(),
  qualificationReceiptId: z.union([z.string().min(1), z.number().int().positive()]),
  releaseReadinessPacketId: z.string().uuid(),
  productionActivationApprovalId: z.string().uuid(),
  cohort: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  workspaceAllowlist: z.array(z.string().min(1).max(256)).max(256),
  runAllowlist: z.array(z.number().int().positive()).max(256),
  maxParallelism: z.number().int().min(1).max(4),
  maxActiveWaveRuns: z.number().int().min(1).max(16),
  maxActiveWaveRunsPerWorkspace: z.number().int().min(1).max(4),
  maxCpuPercent: z.number().min(1).max(100),
  maxMemoryPercent: z.number().min(1).max(100),
  maxErrorRate: z.number().min(0).max(1),
  draining: z.boolean().optional().default(false),
  actor: z.string().min(1).max(256),
  rationale: z.string().min(1).max(2048),
}).strict();

const ReleaseEvidenceSchema = z.object({
  workspaceId: z.string().min(1).max(256),
  attestation: z.unknown(),
  authorization: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const ReleaseReadinessSchema = z.object({
  workspaceId: z.string().min(1).max(256),
  qualificationReceiptId: z.union([z.string().min(1), z.number().int().positive()]),
  packet: z.unknown(),
  actor: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/),
}).strict();

const ProductionActivationSchema = z.object({
  workspaceId: z.string().min(1).max(256),
  releaseReadinessPacketId: z.string().uuid(),
  operatorId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/),
  rationale: z.string().min(1).max(2048),
  confirmation: z.literal('AUTHORIZE_WAVE_PARALLEL_PRODUCTION'),
  authorization: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const RolloutHealthSchema = z.object({
  workspaceId: z.string().min(1).max(256),
  cpuPercent: z.number().min(0).max(100),
  memoryPercent: z.number().min(0).max(100),
  errorRate: z.number().min(0).max(1),
  actor: z.string().min(1).max(256),
  rationale: z.string().min(1).max(2048),
}).strict();

const RollbackSchema = z.object({
  workspaceId: z.string().min(1).max(256),
  actor: z.string().min(1).max(256),
  rationale: z.string().min(1).max(2048),
}).strict();

interface WorkspaceRow { id: string; path: string }
interface ReleasePacketRow {
  id: string;
  workspace_id: string;
  qualification_receipt_id: string;
  report_hash: string;
  source_revision: string;
  implementer_id: string;
  packet_hash: string;
  packet: WaveReleaseReadinessPacket;
}

interface ActivationRow { id: string }
interface ReleaseEvidenceRow {
  id: string;
  workspace_id: string;
  evidence_digest: string;
  source_revision: string;
  evidence_kind: WaveResolvedEvidence['kind'];
  subject_id: string | null;
  operator_id: string;
  attested_at: Date | string;
  attestation: Record<string, unknown>;
  authorization_digest: string;
}

interface ReceiptRow {
  id: string;
  workspace_id: string;
  report_hash: string;
  source_revision: string;
  source_tree: string;
  issuer_id: string;
  issuer_key_id: string;
  issued_at: Date | string;
  expires_at: Date | string;
  report: QualificationReport;
  receipt: QualificationReceipt;
  telemetry: QualificationReport['telemetry'];
  verified_at: Date | string;
}

async function durableEvidenceResolver(
  workspaceId: string,
  sourceRevision: string,
): Promise<WaveEvidenceResolver> {
  const rows = await query<ReleaseEvidenceRow>(
    `SELECT * FROM wave_release_evidence_artifacts
      WHERE workspace_id = $1 AND source_revision = $2
      ORDER BY id ASC LIMIT 4096`,
    [workspaceId, sourceRevision],
  );
  const evidence = new Map(rows.map(row => [row.evidence_digest, {
    digest: row.evidence_digest,
    sourceRevision: row.source_revision,
    kind: row.evidence_kind,
    durable: true as const,
    authenticated: true as const,
    ...(row.subject_id ? { subjectId: row.subject_id } : {}),
  }]));
  return digest => evidence.get(digest);
}

function assertReportDurableEvidenceResolved(
  report: QualificationReport,
  resolve: WaveEvidenceResolver,
): void {
  for (const assertion of report.evidenceAssertions) {
    if (!assertion.durable || assertion.authority !== 'measured') continue;
    const resolved = resolve(assertion.sourceDigest);
    const acceptedKinds: Partial<Record<QualificationReport['evidenceAssertions'][number]['evidenceClass'], WaveResolvedEvidence['kind'][]>> = {
      durable_database_wal: ['durable_db_wal'],
      git_integration: ['git_integration'],
      independent_checker: ['independent_checker'],
      canary_soak: ['canary', 'soak'],
      rollback_rehearsal: ['rollback'],
    };
    const kinds = acceptedKinds[assertion.evidenceClass] ?? [];
    if (!resolved
      || resolved.digest !== assertion.sourceDigest
      || resolved.sourceRevision !== assertion.sourceRevision
      || !resolved.durable
      || !resolved.authenticated
      || !kinds.includes(resolved.kind)) {
      throw new UnprocessableError(
        `Qualification assertion ${assertion.id} has no authenticated durable evidence artifact`,
        'QUALIFICATION_DURABLE_EVIDENCE_UNRESOLVED',
      );
    }
  }
}

function productionActivationKey(): string {
  const key = process.env.RORCA_WAVE_PRODUCTION_ACTIVATION_KEY;
  if (!key || Buffer.byteLength(key) < 32) {
    throw new ServiceUnavailableError('Production activation trust policy is not configured');
  }
  return key;
}

function trustedIssuers(): Record<string, Record<string, string>> {
  const serialized = process.env.RORCA_QUALIFICATION_TRUSTED_ISSUERS_JSON;
  if (!serialized) throw new ServiceUnavailableError('Qualification receipt trust policy is not configured');
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    for (const keys of Object.values(parsed as Record<string, unknown>)) {
      if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw new Error('shape');
      for (const key of Object.values(keys as Record<string, unknown>)) {
        if (typeof key !== 'string' || Buffer.byteLength(key) < 32) throw new Error('key');
      }
    }
    return parsed as Record<string, Record<string, string>>;
  } catch {
    throw new ServiceUnavailableError('Qualification receipt trust policy is invalid');
  }
}

function workspaceIdFrom(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new ValidationError('workspaceId is required and must be a bounded identifier');
  }
  return value;
}

async function workspace(workspaceId: string): Promise<WorkspaceRow> {
  const row = await queryOne<WorkspaceRow>('SELECT id, path FROM workspaces WHERE id = $1', [workspaceId]);
  if (!row) throw new NotFoundError('Workspace', workspaceId);
  return row;
}

function verifyPortable(input: { report: unknown; receipt: unknown }, local: ReturnType<typeof computeLocalQualificationIdentity>) {
  assertPortableQualificationReport(input.report);
  return verifyQualificationReceipt({
    report: input.report,
    receipt: input.receipt,
    localIdentity: local,
    requiredScenarioIds: QUALIFICATION_SCENARIOS,
    requiredAssertionIds: [...CANONICAL_WAVE_ASSERTION_IDS],
    trustedIssuers: trustedIssuers(),
    now: new Date().toISOString(),
  });
}

function portableSummary(row: ReceiptRow, current: boolean) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    reportHash: row.report_hash,
    sourceRevision: row.source_revision,
    sourceTree: row.source_tree,
    issuer: { id: row.issuer_id, keyId: row.issuer_key_id },
    issuedAt: new Date(row.issued_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    verifiedAt: new Date(row.verified_at).toISOString(),
    current,
    productionEnableAvailable: current && row.report.productionEnableAvailable,
    semanticCloseout: row.report.semanticCloseout,
    scenarioResults: row.report.scenarioResults,
    telemetry: row.telemetry,
  };
}

function qualificationFailure(error: unknown): never {
  if (error instanceof AppError) throw error;
  throw new UnprocessableError('Qualification receipt failed closed verification', 'QUALIFICATION_RECEIPT_REJECTED');
}

async function auditRejectedReceiptRequest(req: Request): Promise<void> {
  const workspaceId = typeof req.body?.workspaceId === 'string' ? req.body.workspaceId : '';
  const reportHash = typeof req.body?.receipt?.reportHash === 'string' ? req.body.receipt.reportHash : '';
  const sourceRevision = typeof req.body?.receipt?.sourceRevision === 'string' ? req.body.receipt.sourceRevision : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(workspaceId)
    || !/^sha256:[0-9a-f]{64}$/.test(reportHash)
    || !/^[0-9a-f]{40,64}$/.test(sourceRevision)) return;
  await auditReceiptVerification({
    workspaceId,
    reportHash,
    sourceRevision,
    actor: req.body?.actor,
    outcome: 'denied',
    rationale: 'Portable qualification receipt failed closed verification',
  }).catch(() => undefined);
}

async function auditReceiptVerification(input: {
  workspaceId: string;
  reportHash: string;
  sourceRevision: string;
  actor: unknown;
  outcome: 'allowed' | 'denied';
  rationale: string;
}): Promise<void> {
  const actor = typeof input.actor === 'string'
    ? input.actor.replace(/[^A-Za-z0-9@._:-]/g, '_').slice(0, 256)
    : 'local-operator';
  await execute(
    `INSERT INTO wave_parallel_governance_audit (
       workspace_id, event_type, actor, rationale, receipt_hash, source_revision,
       requested_policy, effective_policy, fencing_policy, outcome
     ) VALUES ($1, 'receipt_verification', $2, $3, $4, $5, '{}'::jsonb,
               $6::jsonb, 'dispatch-boundary-v1', $7)`,
    [
      input.workspaceId, actor || 'local-operator', input.rationale,
      input.reportHash, input.sourceRevision,
      JSON.stringify({ verified: input.outcome === 'allowed' }), input.outcome,
    ],
  );
}

/**
 * @swagger
 * /api/admin/wave-qualification/verify:
 *   post:
 *     tags: [Wave Qualification]
 *     summary: Verify a portable wave-qualification receipt against current local identities
 *     operationId: verifyWaveQualificationReceipt
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Receipt verification recomputes local repository and policy identities and is an operator-only production-enable gate."
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: Receipt is current, trusted, complete, and production-enable eligible }
 *       422: { description: Receipt failed closed verification }
 */
router.post('/verify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = workspaceIdFrom(req.body?.workspaceId);
    const currentWorkspace = await workspace(workspaceId);
    const local = computeLocalQualificationIdentity(currentWorkspace.path, workspaceId);
    const verified = verifyPortable({ report: req.body?.report, receipt: req.body?.receipt }, local);
    const report = req.body?.report as unknown;
    assertPortableQualificationReport(report);
    assertReportDurableEvidenceResolved(
      report,
      await durableEvidenceResolver(workspaceId, verified.sourceRevision),
    );
    await auditReceiptVerification({
      workspaceId,
      reportHash: verified.reportHash,
      sourceRevision: verified.sourceRevision,
      actor: req.body?.actor,
      outcome: 'allowed',
      rationale: 'Portable qualification receipt verified against current local identities',
    });
    res.json({
      valid: true,
      productionEnableAvailable: true,
      reportHash: verified.reportHash,
      sourceRevision: verified.sourceRevision,
      sourceTree: verified.sourceTree,
      expiresAt: verified.expiresAt,
      issuer: verified.issuer,
    });
  } catch (error) {
    await auditRejectedReceiptRequest(req);
    try { qualificationFailure(error); } catch (mapped) { next(mapped); }
  }
});

/**
 * @swagger
 * /api/admin/wave-qualification/receipts:
 *   post:
 *     tags: [Wave Qualification]
 *     summary: Verify and append an immutable wave-qualification receipt
 *     operationId: publishWaveQualificationReceipt
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Publishing production-enable evidence is an append-only local operator action and must never be MCP exposed."
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       201: { description: Receipt verified and published }
 *       422: { description: Receipt failed closed verification }
 */
router.post('/receipts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = workspaceIdFrom(req.body?.workspaceId);
    const currentWorkspace = await workspace(workspaceId);
    const report = req.body?.report as unknown;
    const local = computeLocalQualificationIdentity(currentWorkspace.path, workspaceId);
    const receipt = verifyPortable({ report, receipt: req.body?.receipt }, local);
    assertPortableQualificationReport(report);
    const portableReport = report;
    assertReportDurableEvidenceResolved(
      portableReport,
      await durableEvidenceResolver(workspaceId, receipt.sourceRevision),
    );
    const humanReport = renderQualificationReport(portableReport, receipt);
    const inserted = await queryOne<ReceiptRow>(`
      INSERT INTO wave_qualification_receipts (
        workspace_id, report_hash, source_revision, source_tree, policy_version,
        invariant_version, issuer_id, issuer_key_id, issued_at, expires_at,
        report, receipt, human_report, telemetry, production_enable_available
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14::jsonb, TRUE)
      ON CONFLICT (report_hash) DO NOTHING
      RETURNING *
    `, [
      workspaceId, receipt.reportHash, receipt.sourceRevision, receipt.sourceTree,
      receipt.policyVersion, receipt.invariantVersion, receipt.issuer.id, receipt.issuer.keyId,
      receipt.issuedAt, receipt.expiresAt, JSON.stringify(portableReport), JSON.stringify(receipt),
      humanReport, JSON.stringify(portableReport.telemetry),
    ]);
    const row = inserted ?? await queryOne<ReceiptRow>('SELECT * FROM wave_qualification_receipts WHERE report_hash = $1 AND workspace_id = $2', [receipt.reportHash, workspaceId]);
    if (!row) throw new UnprocessableError('Qualification receipt publication was not durable', 'QUALIFICATION_PUBLICATION_FAILED');
    await auditReceiptVerification({
      workspaceId,
      reportHash: receipt.reportHash,
      sourceRevision: receipt.sourceRevision,
      actor: req.body?.actor,
      outcome: 'allowed',
      rationale: inserted ? 'Verified qualification receipt published immutably' : 'Existing immutable qualification receipt reverified',
    });
    res.status(inserted ? 201 : 200).json(portableSummary(row, true));
  } catch (error) {
    await auditRejectedReceiptRequest(req);
    try { qualificationFailure(error); } catch (mapped) { next(mapped); }
  }
});

/**
 * @swagger
 * /api/admin/wave-qualification/receipts/latest:
 *   get:
 *     tags: [Wave Qualification]
 *     summary: Read the latest bounded receipt summary and runtime telemetry
 *     operationId: getLatestWaveQualificationReceipt
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "The latest production-enable receipt and bounded operator telemetry expose sensitive release posture and remain operator-only."
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string, maxLength: 256 }
 *     responses:
 *       200: { description: Latest receipt summary, with current local verification state }
 *       404: { description: No receipt exists }
 */
router.get('/receipts/latest', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = workspaceIdFrom(req.query.workspaceId);
    const currentWorkspace = await workspace(workspaceId);
    const row = await queryOne<ReceiptRow>('SELECT * FROM wave_qualification_receipts WHERE workspace_id = $1 ORDER BY verified_at DESC, id DESC LIMIT 1', [workspaceId]);
    if (!row) throw new NotFoundError('Wave qualification receipt');
    let current = false;
    try {
      const local = computeLocalQualificationIdentity(currentWorkspace.path, workspaceId);
      verifyPortable({ report: row.report, receipt: row.receipt }, local);
      current = true;
    } catch {
      // A stale or mismatched receipt remains visible as history but cannot enable production.
    }
    res.json(portableSummary(row, current));
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/admin/wave-qualification/evidence:
 *   post:
 *     tags: [Wave Qualification]
 *     summary: Verify and append an authenticated durable release-evidence artifact
 *     operationId: publishWaveReleaseEvidence
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Durable release authority is a signed operator-only action and is never inferred from caller-provided digest strings."
 *     responses:
 *       201: { description: Evidence attestation verified and stored immutably }
 *       422: { description: Attestation is invalid, stale, or conflicts with existing evidence }
 */
router.post('/evidence', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = ReleaseEvidenceSchema.parse(req.body);
    const currentWorkspace = await workspace(input.workspaceId);
    const attestation = verifyWaveReleaseEvidence({
      attestation: input.attestation,
      authorization: input.authorization,
      trustedKey: productionActivationKey(),
    });
    const local = computeLocalQualificationIdentity(currentWorkspace.path, input.workspaceId);
    if (attestation.workspaceId !== input.workspaceId
      || attestation.sourceRevision !== local.sourceRevision) {
      throw new UnprocessableError(
        'Release evidence is not bound to the current workspace and source revision',
        'WAVE_RELEASE_EVIDENCE_IDENTITY_MISMATCH',
      );
    }
    const authorizationDigest = `sha256:${createHash('sha256').update(input.authorization).digest('hex')}`;
    const inserted = await queryOne<ReleaseEvidenceRow>(
      `INSERT INTO wave_release_evidence_artifacts (
         workspace_id, evidence_digest, source_revision, evidence_kind, subject_id,
         operator_id, attested_at, attestation, authorization_digest
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
       ON CONFLICT (workspace_id, evidence_digest) DO NOTHING
       RETURNING *`,
      [
        input.workspaceId, attestation.digest, attestation.sourceRevision,
        attestation.kind, attestation.subjectId ?? null, attestation.operatorId,
        attestation.attestedAt, JSON.stringify(attestation), authorizationDigest,
      ],
    );
    const persisted = inserted ?? await queryOne<ReleaseEvidenceRow>(
      `SELECT * FROM wave_release_evidence_artifacts
        WHERE workspace_id = $1 AND evidence_digest = $2`,
      [input.workspaceId, attestation.digest],
    );
    if (!persisted
      || persisted.source_revision !== attestation.sourceRevision
      || persisted.evidence_kind !== attestation.kind
      || persisted.subject_id !== (attestation.subjectId ?? null)
      || persisted.operator_id !== attestation.operatorId
      || persisted.authorization_digest !== authorizationDigest) {
      throw new UnprocessableError(
        'Evidence digest is already bound to different immutable authority',
        'WAVE_RELEASE_EVIDENCE_CONFLICT',
      );
    }
    res.status(inserted ? 201 : 200).json({
      id: persisted.id,
      digest: persisted.evidence_digest,
      sourceRevision: persisted.source_revision,
      kind: persisted.evidence_kind,
      subjectId: persisted.subject_id,
      authenticated: true,
      durable: true,
    });
  } catch (error) {
    try { qualificationFailure(error); } catch (mapped) { next(mapped); }
  }
});

/**
 * @swagger
 * /api/admin/wave-qualification/release-readiness:
 *   post:
 *     tags: [Wave Qualification]
 *     summary: Verify and append an immutable independent release-readiness packet
 *     operationId: publishWaveReleaseReadiness
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Independent human review evidence and PR-only release posture are operator-only production gates."
 *     responses:
 *       201: { description: Review packet verified against the current receipt and PR head }
 *       422: { description: Review packet is incomplete, stale, self-approved, or unsafe }
 */
router.post('/release-readiness', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = ReleaseReadinessSchema.parse(req.body);
    const currentWorkspace = await workspace(input.workspaceId);
    const receiptRow = await queryOne<ReceiptRow>(
      'SELECT * FROM wave_qualification_receipts WHERE id = $1 AND workspace_id = $2',
      [input.qualificationReceiptId, input.workspaceId],
    );
    if (!receiptRow) throw new NotFoundError('Wave qualification receipt', String(input.qualificationReceiptId));
    const local = computeLocalQualificationIdentity(currentWorkspace.path, input.workspaceId);
    const receipt = verifyPortable({ report: receiptRow.report, receipt: receiptRow.receipt }, local);
    const packet = assertWaveReleaseReadinessPacket(
      input.packet,
      new Date().toISOString(),
      await durableEvidenceResolver(input.workspaceId, receipt.sourceRevision),
      CANONICAL_WAVE_ASSERTION_IDS,
    );
    if (packet.workspaceId !== input.workspaceId
      || packet.qualification.receiptId !== String(input.qualificationReceiptId)
      || packet.qualification.reportHash !== receipt.reportHash
      || packet.qualification.sourceRevision !== receipt.sourceRevision
      || packet.qualification.issuedAt !== receipt.issuedAt
      || packet.qualification.expiresAt !== receipt.expiresAt
      || packet.pullRequest.headRevision !== local.sourceRevision) {
      throw new UnprocessableError('Release-readiness packet does not match the current workspace, receipt, or PR head', 'RELEASE_READINESS_IDENTITY_MISMATCH');
    }
    const packetHash = waveReleaseReadinessPacketHash(packet);
    const row = await queryOne<ReleasePacketRow>(
      `INSERT INTO wave_release_readiness_packets (
         workspace_id, qualification_receipt_id, report_hash, source_revision,
         pull_request_number, implementer_id, packet_hash, packet, approved, recorded_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, TRUE, $9)
       ON CONFLICT (packet_hash) DO NOTHING
       RETURNING *`,
      [
        input.workspaceId, input.qualificationReceiptId, receipt.reportHash, receipt.sourceRevision,
        packet.pullRequest.number, packet.implementerId, packetHash, JSON.stringify(packet), input.actor,
      ],
    );
    const persisted = row ?? await queryOne<ReleasePacketRow>(
      'SELECT * FROM wave_release_readiness_packets WHERE packet_hash = $1 AND workspace_id = $2',
      [packetHash, input.workspaceId],
    );
    if (!persisted) throw new UnprocessableError('Release-readiness packet publication was not durable', 'RELEASE_READINESS_PUBLICATION_FAILED');
    res.status(row ? 201 : 200).json({
      id: persisted.id,
      packetHash: persisted.packet_hash,
      sourceRevision: persisted.source_revision,
      qualificationReceiptId: String(persisted.qualification_receipt_id),
      productionActivated: false,
    });
  } catch (error) {
    try { qualificationFailure(error); } catch (mapped) { next(mapped); }
  }
});

/**
 * @swagger
 * /api/admin/wave-qualification/production-activation:
 *   post:
 *     tags: [Wave Qualification]
 *     summary: Record separate explicit operator approval after all release gates pass
 *     operationId: approveWaveProductionActivation
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Production activation is a separate append-only operator authority and is never implied by a receipt, review packet, merge, or deployment."
 *     responses:
 *       201: { description: Separate production activation authority recorded; rollout remains independently configured }
 *       422: { description: Packet is stale or operator independence is not satisfied }
 */
router.post('/production-activation', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = ProductionActivationSchema.parse(req.body);
    const currentWorkspace = await workspace(input.workspaceId);
    const packetRow = await queryOne<ReleasePacketRow & { report: QualificationReport; receipt: QualificationReceipt }>(
      `SELECT packet.*, receipt.report, receipt.receipt
         FROM wave_release_readiness_packets packet
         JOIN wave_qualification_receipts receipt ON receipt.id = packet.qualification_receipt_id
        WHERE packet.id = $1 AND packet.workspace_id = $2`,
      [input.releaseReadinessPacketId, input.workspaceId],
    );
    if (!packetRow) throw new NotFoundError('Wave release-readiness packet', input.releaseReadinessPacketId);
    const packet = assertWaveReleaseReadinessPacket(
      packetRow.packet,
      new Date().toISOString(),
      await durableEvidenceResolver(input.workspaceId, packetRow.source_revision),
      CANONICAL_WAVE_ASSERTION_IDS,
    );
    const local = computeLocalQualificationIdentity(currentWorkspace.path, input.workspaceId);
    verifyPortable({ report: packetRow.report, receipt: packetRow.receipt }, local);
    const reviewers = new Set(packet.reviews.map(review => review.reviewerId));
    if (input.operatorId === packet.implementerId || reviewers.has(input.operatorId) || packet.pullRequest.headRevision !== local.sourceRevision) {
      throw new UnprocessableError('Production activation requires a separate operator and the current reviewed PR head', 'PRODUCTION_ACTIVATION_INDEPENDENCE_REQUIRED');
    }
    verifyWaveProductionActivation({
      workspaceId: input.workspaceId,
      packetHash: packetRow.packet_hash,
      sourceRevision: packetRow.source_revision,
      operatorId: input.operatorId,
      confirmation: input.confirmation,
      authorization: input.authorization,
      trustedKey: productionActivationKey(),
    });
    const authorizationDigest = `sha256:${createHash('sha256').update(input.authorization).digest('hex')}`;
    const inserted = await queryOne<ActivationRow>(
      `INSERT INTO wave_production_activation_approvals (
         workspace_id, release_readiness_packet_id, source_revision,
         operator_id, rationale, confirmation, authorization_digest
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (release_readiness_packet_id) DO NOTHING
       RETURNING id`,
      [
        input.workspaceId, packetRow.id, packetRow.source_revision, input.operatorId,
        input.rationale, input.confirmation, authorizationDigest,
      ],
    );
    const approval = inserted ?? await queryOne<ActivationRow>(
      'SELECT id FROM wave_production_activation_approvals WHERE release_readiness_packet_id = $1',
      [packetRow.id],
    );
    if (!approval) throw new UnprocessableError('Production activation approval was not durable', 'PRODUCTION_ACTIVATION_PUBLICATION_FAILED');
    res.status(inserted ? 201 : 200).json({
      id: approval.id,
      releaseReadinessPacketId: packetRow.id,
      sourceRevision: packetRow.source_revision,
      rolloutEnabled: false,
    });
  } catch (error) {
    try { qualificationFailure(error); } catch (mapped) { next(mapped); }
  }
});

/**
 * @swagger
 * /api/admin/wave-qualification/status:
 *   get:
 *     tags: [Wave Qualification]
 *     summary: Read governed wave production status without treating flags as evidence
 *     operationId: getWaveProductionStatus
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Production rollout posture and receipt identity are operator-only release controls."
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Governed status and effective sequential-default policy }
 */
router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = workspaceIdFrom(req.query.workspaceId);
    const currentWorkspace = await workspace(workspaceId);
    const policy = await resolveWaveProductionPolicy({
      workspaceId,
      workspacePath: currentWorkspace.path,
      request: {},
    });
    res.json({
      status: policy.status,
      effective: policy.effective,
      reason: policy.reason,
      receipt: policy.receipt,
      rollout: policy.rollout,
      fencingPolicy: policy.fencingPolicy,
      productionEnableAvailable: policy.status === 'enabled' || policy.status === 'canary-enabled',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/admin/wave-qualification/rollout:
 *   put:
 *     tags: [Wave Qualification]
 *     summary: Stage an explicit bounded production rollout cohort
 *     operationId: configureWaveProductionRollout
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Changing receipt selection, cohorts and resource caps is an operator-only audited release-control action."
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: Rollout configuration staged; no run or deployment is triggered }
 */
router.put('/rollout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = RolloutControlSchema.parse(req.body);
    const currentWorkspace = await workspace(input.workspaceId);
    const receiptRow = await queryOne<ReceiptRow>(
      'SELECT * FROM wave_qualification_receipts WHERE id = $1 AND workspace_id = $2',
      [input.qualificationReceiptId, input.workspaceId],
    );
    if (!receiptRow) throw new NotFoundError('Wave qualification receipt', String(input.qualificationReceiptId));
    const local = computeLocalQualificationIdentity(currentWorkspace.path, input.workspaceId);
    verifyPortable({ report: receiptRow.report, receipt: receiptRow.receipt }, local);
    const authority = await queryOne<{ packet_id: string; approval_id: string }>(
      `SELECT packet.id AS packet_id, approval.id AS approval_id
         FROM wave_release_readiness_packets packet
         JOIN wave_production_activation_approvals approval
           ON approval.release_readiness_packet_id = packet.id
        WHERE packet.id = $1
          AND approval.id = $2
          AND packet.workspace_id = $3
          AND packet.qualification_receipt_id = $4
          AND packet.report_hash = $5
          AND packet.source_revision = $6
          AND approval.workspace_id = packet.workspace_id
          AND approval.source_revision = packet.source_revision
          AND packet.approved`,
      [
        input.releaseReadinessPacketId, input.productionActivationApprovalId,
        input.workspaceId, input.qualificationReceiptId, receiptRow.report_hash, local.sourceRevision,
      ],
    );
    if (!authority) throw new UnprocessableError('Current independent review packet and separate operator activation are required', 'WAVE_RELEASE_AUTHORITY_REQUIRED');

    await execute(
      `INSERT INTO wave_parallel_rollout_controls (
         workspace_id, enabled, qualification_receipt_id, release_readiness_packet_id,
         production_activation_approval_id, cohort, workspace_allowlist,
         run_allowlist, max_parallelism, max_active_wave_runs,
         max_active_wave_runs_per_workspace, max_cpu_percent, max_memory_percent,
         max_error_rate, halted, draining, rationale, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::bigint[], $9, $10, $11, $12, $13, $14, FALSE, $15, $16, $17)
       ON CONFLICT (workspace_id) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         qualification_receipt_id = EXCLUDED.qualification_receipt_id,
         release_readiness_packet_id = EXCLUDED.release_readiness_packet_id,
         production_activation_approval_id = EXCLUDED.production_activation_approval_id,
         cohort = EXCLUDED.cohort,
         workspace_allowlist = EXCLUDED.workspace_allowlist,
         run_allowlist = EXCLUDED.run_allowlist,
         max_parallelism = EXCLUDED.max_parallelism,
         max_active_wave_runs = EXCLUDED.max_active_wave_runs,
         max_active_wave_runs_per_workspace = EXCLUDED.max_active_wave_runs_per_workspace,
         max_cpu_percent = EXCLUDED.max_cpu_percent,
         max_memory_percent = EXCLUDED.max_memory_percent,
         max_error_rate = EXCLUDED.max_error_rate,
         halted = FALSE,
         draining = EXCLUDED.draining,
         rationale = EXCLUDED.rationale,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()`,
      [
        input.workspaceId, input.enabled, input.qualificationReceiptId,
        authority.packet_id, authority.approval_id, input.cohort,
        input.workspaceAllowlist, input.runAllowlist, input.maxParallelism,
        input.maxActiveWaveRuns, input.maxActiveWaveRunsPerWorkspace,
        input.maxCpuPercent, input.maxMemoryPercent, input.maxErrorRate,
        input.draining, input.rationale, input.actor,
      ],
    );
    const policy = await resolveWaveProductionPolicy({
      workspaceId: input.workspaceId,
      workspacePath: currentWorkspace.path,
      request: {
        orchestrationMode: 'wave-parallel',
        parallelism: Math.min(2, input.maxParallelism),
        qualificationReceiptId: String(input.qualificationReceiptId),
        rolloutCohort: input.cohort,
      },
    });
    // The rollout-control trigger appends the immutable audit row in the same
    // transaction as this control mutation; do not create a split-brain audit
    // write after the control has committed.
    res.json({ staged: true, status: policy.status, effective: policy.effective, receipt: policy.receipt, rollout: policy.rollout });
  } catch (error) {
    try { qualificationFailure(error); } catch (mapped) { next(mapped); }
  }
});

/**
 * @swagger
 * /api/admin/wave-qualification/rollout/health:
 *   post:
 *     tags: [Wave Qualification]
 *     summary: Record bounded rollout health and automatically halt threshold breaches
 *     operationId: recordWaveProductionRolloutHealth
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Production health observations can stop dispatch and are operator-only audited controls."
 *     responses:
 *       200: { description: Health recorded and halt decision returned }
 */
router.post('/rollout/health', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = RolloutHealthSchema.parse(req.body);
    const currentWorkspace = await workspace(input.workspaceId);
    const updated = await queryOne<{ halted: boolean }>(
      `UPDATE wave_parallel_rollout_controls
          SET observed_cpu_percent = $2,
              observed_memory_percent = $3,
              observed_error_rate = $4,
              halted = halted OR $2 > max_cpu_percent OR $3 > max_memory_percent OR $4 > max_error_rate,
              draining = CASE WHEN $2 > max_cpu_percent OR $3 > max_memory_percent OR $4 > max_error_rate THEN FALSE ELSE draining END,
              rationale = $5,
              updated_by = $6,
              updated_at = NOW()
        WHERE workspace_id = $1
        RETURNING halted`,
      [input.workspaceId, input.cpuPercent, input.memoryPercent, input.errorRate, input.rationale, input.actor],
    );
    if (!updated) throw new NotFoundError('Wave rollout control', input.workspaceId);
    const policy = await resolveWaveProductionPolicy({ workspaceId: input.workspaceId, workspacePath: currentWorkspace.path, request: {} });
    // The UPDATE's audit trigger records both normal observations and halts atomically.
    res.json({ status: policy.status, halted: updated.halted, effective: policy.effective });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/admin/wave-qualification/rollout/rollback:
 *   post:
 *     tags: [Wave Qualification]
 *     summary: Immediately stop future parallel dispatch without rewriting in-flight evidence
 *     operationId: rollbackWaveProductionRollout
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Immediate production rollback is an operator-only audited release-control action."
 *     responses:
 *       200: { description: Future wave dispatch halted; in-flight evidence unchanged }
 */
router.post('/rollout/rollback', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = RollbackSchema.parse(req.body);
    const currentWorkspace = await workspace(input.workspaceId);
    const changed = await execute(
      `UPDATE wave_parallel_rollout_controls
          SET enabled = FALSE, halted = TRUE, draining = FALSE,
              rationale = $2, updated_by = $3, updated_at = NOW()
        WHERE workspace_id = $1`,
      [input.workspaceId, input.rationale, input.actor],
    );
    if (changed.rowCount !== 1) throw new NotFoundError('Wave rollout control', input.workspaceId);
    const policy = await resolveWaveProductionPolicy({ workspaceId: input.workspaceId, workspacePath: currentWorkspace.path, request: {} });
    // The rollback UPDATE and its append-only audit row commit together in DB.
    res.json({ rolledBack: true, status: policy.status, effective: policy.effective, inFlightEvidenceChanged: false });
  } catch (error) {
    next(error);
  }
});

export default router;
