/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { execute, queryOne } from '../db/index';
import { AppError, NotFoundError, ServiceUnavailableError, UnprocessableError, ValidationError } from '../lib/errors';
import {
  assertPortableQualificationReport,
  computeLocalQualificationIdentity,
  renderQualificationReport,
  verifyQualificationReceipt,
  type QualificationReceipt,
  type QualificationReport,
} from '../lib/wave-qualification-evidence';
import { QUALIFICATION_SCENARIOS } from '../lib/wave-qualification-model';
import { auditWaveProductionDecision, resolveWaveProductionPolicy } from '../lib/wave-production-governance';

const router = Router();

const RolloutControlSchema = z.object({
  workspaceId: z.string().min(1).max(256),
  enabled: z.boolean(),
  qualificationReceiptId: z.union([z.string().min(1), z.number().int().positive()]),
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
    const humanReport = renderQualificationReport(report, receipt);
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
      receipt.issuedAt, receipt.expiresAt, JSON.stringify(report), JSON.stringify(receipt),
      humanReport, JSON.stringify(report.telemetry),
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

    await execute(
      `INSERT INTO wave_parallel_rollout_controls (
         workspace_id, enabled, qualification_receipt_id, cohort, workspace_allowlist,
         run_allowlist, max_parallelism, max_active_wave_runs,
         max_active_wave_runs_per_workspace, max_cpu_percent, max_memory_percent,
         max_error_rate, halted, draining, rationale, updated_by
       ) VALUES ($1, $2, $3, $4, $5::text[], $6::bigint[], $7, $8, $9, $10, $11, $12, FALSE, $13, $14, $15)
       ON CONFLICT (workspace_id) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         qualification_receipt_id = EXCLUDED.qualification_receipt_id,
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
        input.workspaceId, input.enabled, input.qualificationReceiptId, input.cohort,
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
    await auditWaveProductionDecision({
      envelope: policy,
      actor: input.actor,
      rationale: input.rationale,
      eventType: 'cohort_change',
      outcome: 'recorded',
    });
    if (input.enabled) {
      await auditWaveProductionDecision({ envelope: policy, actor: input.actor, rationale: input.rationale, eventType: 'enable', outcome: 'recorded' });
    }
    if (input.draining) {
      await auditWaveProductionDecision({ envelope: policy, actor: input.actor, rationale: input.rationale, eventType: 'drain', outcome: 'draining' });
    }
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
    if (updated.halted) {
      await auditWaveProductionDecision({ envelope: policy, actor: input.actor, rationale: input.rationale, eventType: 'automatic_halt', outcome: 'halted' });
    }
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
    await auditWaveProductionDecision({ envelope: policy, actor: input.actor, rationale: input.rationale, eventType: 'rollback', outcome: 'halted' });
    res.json({ rolledBack: true, status: policy.status, effective: policy.effective, inFlightEvidenceChanged: false });
  } catch (error) {
    next(error);
  }
});

export default router;
