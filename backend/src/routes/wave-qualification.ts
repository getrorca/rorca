/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { queryOne } from '../db/index';
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

const router = Router();

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
    res.status(inserted ? 201 : 200).json(portableSummary(row, true));
  } catch (error) {
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

export default router;
