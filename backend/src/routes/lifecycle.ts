/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type Request } from 'express';
import { ValidationError } from '../lib/errors';
import { generateLearnCloseoutCandidates } from '../lib/learn-closeout';
import { emitLifecycleInvalidation } from '../lib/lifecycle-mutations';
import { getLifecycleOperationsReport, recordLifecycleEvaluatorError } from '../lib/lifecycle-operations';
import { parsePaginationParams } from '../lib/paginate';
import {
  assertLifecyclePortfolioFilters,
  assertPhaseId,
  assertSnapshotId,
  getLifecycleEvidence,
  getLifecyclePhase,
  getLifecyclePortfolio,
  getLifecycleSpec,
} from '../lib/ssdlc-lifecycle-read';

const router = Router();

function queryText(req: Request, name: string, required = false): string | undefined {
  const value = req.query[name];
  if (value === undefined) {
    if (required) throw new ValidationError(`${name} is required`, { field: name });
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`${name} must be a non-empty string`, { field: name });
  return value.trim();
}

function validatePagination(req: Request, maxLimit: number): void {
  for (const field of ['limit', 'page', 'offset'] as const) {
    const value = req.query[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new ValidationError(`${field} must be an integer`, { field });
    const number = Number(value);
    const minimum = field === 'offset' ? 0 : 1;
    if (!Number.isSafeInteger(number) || number < minimum) throw new ValidationError(`${field} must be at least ${minimum}`, { field });
    if (field === 'limit' && number > maxLimit) throw new ValidationError(`limit must be at most ${maxLimit}`, { field });
  }
  if (req.query.cursor !== undefined) {
    if (typeof req.query.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(req.query.cursor)) {
      throw new ValidationError('cursor must be a bounded opaque base64url string', { field: 'cursor' });
    }
  }
}

/**
 * @swagger
 * /api/lifecycle:
 *   get:
 *     tags: [Lifecycle]
 *     summary: Read one paginated evaluated lifecycle portfolio
 *     operationId: getLifecyclePortfolio
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "The aggregate contains workspace-owned delivery, risk, assignment, blocker, and run-liveness metadata and is restricted to authenticated callers."
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: search
 *         schema: { type: string, maxLength: 200 }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [not_started, in_progress, blocked, awaiting_approval, passed, deferred, not_applicable, stale, needs_compilation] }
 *       - in: query
 *         name: specStatus
 *         schema: { type: string, enum: [pending, approved, completed, rejected] }
 *       - in: query
 *         name: phase
 *         schema: { type: string, enum: [intake, requirements, architecture, implementation, validation, security, staging, qa, merge, production, learn] }
 *       - in: query
 *         name: risk
 *         schema: { type: string, enum: [low, medium, high, critical] }
 *       - in: query
 *         name: owner
 *         schema: { type: string }
 *       - in: query
 *         name: blocked
 *         schema: { type: boolean }
 *       - in: query
 *         name: disposition
 *         schema: { type: string, enum: [required, deferred, not_applicable] }
 *       - in: query
 *         name: sort
 *         schema: { type: string, enum: [current_view, updated_desc, title_asc, risk_desc, readiness_desc, owner_asc], default: current_view }
 *       - in: query
 *         name: snapshotId
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 25 }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *     responses:
 *       200: { description: Paginated lifecycle portfolio with one evaluator snapshot set }
 *       400: { description: Invalid workspace, filter, sort, or pagination boundary }
 *       404: { description: Workspace not found }
 *       409: { description: Requested snapshot is stale or the bounded view must be narrowed }
 */
router.get('/', async (req, res, next) => {
  try {
    const workspaceId = queryText(req, 'workspaceId', true)!;
    validatePagination(req, 100);
    const filters = assertLifecyclePortfolioFilters({
      search: req.query.search,
      status: req.query.status,
      specStatus: req.query.specStatus,
      phase: req.query.phase,
      risk: req.query.risk,
      owner: req.query.owner,
      blocked: req.query.blocked,
      disposition: req.query.disposition,
      sort: req.query.sort,
      snapshotId: req.query.snapshotId,
    });
    const result = await getLifecyclePortfolio({
      workspaceId,
      ...filters,
      pagination: parsePaginationParams(req, { limit: 25, maxLimit: 100 }),
    });
    res.json(result);
  } catch (error) {
    await recordLifecycleEvaluatorError({
      workspaceId: typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined,
      operation: 'portfolio',
      error,
    });
    next(error);
  }
});

/**
 * @swagger
 * /api/lifecycle/operations:
 *   get:
 *     tags: [Lifecycle]
 *     summary: Read bounded Lifecycle rollout progress and health counters
 *     operationId: getLifecycleOperations
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Workspace-wide compiler, evidence-adapter, denial, and rollout diagnostics are read-only local operator metadata and never include evidence payloads."
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Bounded plan coverage, backfill progress, blocked phases, retry actions, and redacted 24-hour health counters }
 *       400: { description: Invalid workspace scope }
 *       404: { description: Workspace not found }
 *       409: { description: Workspace exceeds the bounded rollout view }
 */
router.get('/operations', async (req, res, next) => {
  try {
    const workspaceId = queryText(req, 'workspaceId', true)!;
    res.json(await getLifecycleOperationsReport({ workspaceId }));
  } catch (error) {
    await recordLifecycleEvaluatorError({
      workspaceId: typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined,
      operation: 'operations',
      error,
    });
    next(error);
  }
});

/**
 * @swagger
 * /api/lifecycle/specs/{specId}:
 *   get:
 *     tags: [Lifecycle]
 *     summary: Read one evaluated lifecycle spec aggregate
 *     operationId: getLifecycleSpec
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Spec lifecycle traceability, provenance, decisions, and current-run context are workspace-owned delivery metadata available to authenticated callers."
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: snapshotId
 *         schema: { type: string }
 *     responses:
 *       200: { description: Evaluated spec detail or stable needs_compilation shape }
 *       400: { description: Invalid scope }
 *       404: { description: Workspace or spec not found }
 *       409: { description: Requested snapshot is stale and refresh is required }
 */
router.get('/specs/:specId', async (req, res, next) => {
  try {
    const workspaceId = queryText(req, 'workspaceId', true)!;
    const snapshotId = assertSnapshotId(req.query.snapshotId);
    res.json(await getLifecycleSpec({ workspaceId, specId: req.params.specId, expectedSnapshotId: snapshotId }));
  } catch (error) {
    await recordLifecycleEvaluatorError({
      workspaceId: typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined,
      specId: req.params.specId,
      operation: 'spec',
      error,
    });
    next(error);
  }
});

/**
 * @swagger
 * /api/lifecycle/specs/{specId}/phases/{phaseId}:
 *   get:
 *     tags: [Lifecycle]
 *     summary: Read one evaluated lifecycle phase with bounded evidence
 *     operationId: getLifecyclePhase
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Phase blockers, governed decisions, and evidence provenance are workspace-owned delivery metadata available to authenticated callers."
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: phaseId
 *         required: true
 *         schema: { type: string, enum: [intake, requirements, architecture, implementation, validation, security, staging, qa, merge, production, learn] }
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: snapshotId
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 25 }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *     responses:
 *       200: { description: Evaluated phase detail with deterministic paginated evidence }
 *       400: { description: Invalid phase, scope, snapshot, or pagination boundary }
 *       404: { description: Workspace, spec, or phase not found }
 *       409: { description: Requested snapshot is stale and refresh is required }
 */
router.get('/specs/:specId/phases/:phaseId', async (req, res, next) => {
  try {
    const workspaceId = queryText(req, 'workspaceId', true)!;
    const phaseId = assertPhaseId(req.params.phaseId);
    const snapshotId = assertSnapshotId(req.query.snapshotId);
    validatePagination(req, 100);
    res.json(await getLifecyclePhase({
      workspaceId,
      specId: req.params.specId,
      phaseId,
      expectedSnapshotId: snapshotId,
      evidencePagination: parsePaginationParams(req, { limit: 25, maxLimit: 100 }),
    }));
  } catch (error) {
    await recordLifecycleEvaluatorError({
      workspaceId: typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined,
      specId: req.params.specId,
      operation: 'phase',
      error,
    });
    next(error);
  }
});

/**
 * @swagger
 * /api/lifecycle/specs/{specId}/runs/{runId}/learn-closeout:
 *   post:
 *     tags: [Lifecycle]
 *     summary: Retry governed Learn closeout candidate generation for a terminal run
 *     operationId: generateLifecycleLearnCloseout
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Closeout generation stages workspace-owned review candidates and lifecycle evidence, so it is a local operator-only recovery action."
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               modelSummarization: { type: boolean, default: false }
 *     responses:
 *       200: { description: Deterministic candidates generated or deduplicated }
 *       400: { description: Invalid scope }
 *       404: { description: Workspace-scoped run not found }
 *       409: { description: Run is not terminal }
 */
router.post('/specs/:specId/runs/:runId/learn-closeout', async (req, res, next) => {
  try {
    const workspaceId = queryText(req, 'workspaceId', true)!;
    const runId = Number(req.params.runId);
    if (!Number.isSafeInteger(runId) || runId <= 0) throw new ValidationError('runId must be a positive integer', { field: 'runId' });
    if (req.body?.modelSummarization !== undefined && typeof req.body.modelSummarization !== 'boolean') {
      throw new ValidationError('modelSummarization must be a boolean', { field: 'modelSummarization' });
    }
    const result = await generateLearnCloseoutCandidates({
      workspaceId,
      specId: req.params.specId,
      runId,
      modelSummarization: req.body?.modelSummarization === true,
    });
    await emitLifecycleInvalidation({ workspaceId, specId: req.params.specId, phaseId: 'learn', runId, changeKind: 'evidence_persisted' });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/lifecycle/evidence/{evidenceId}:
 *   get:
 *     tags: [Lifecycle]
 *     summary: Read redacted normalized lifecycle evidence pinned to an evaluator snapshot
 *     operationId: getLifecycleEvidence
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Evidence provenance and raw-reference locations are sensitive workspace-owned audit metadata; authenticated access returns sanitized fields and never embeds raw payloads."
 *     parameters:
 *       - in: path
 *         name: evidenceId
 *         required: true
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: snapshotId
 *         schema: { type: string }
 *     responses:
 *       200: { description: Redacted immutable evidence metadata and raw-reference permission }
 *       400: { description: Invalid workspace or evidence identity }
 *       404: { description: Workspace-scoped evidence not found }
 *       409: { description: Caller snapshot changed; refresh is required and no evidence item was silently substituted }
 */
router.get('/evidence/:evidenceId', async (req, res, next) => {
  try {
    const workspaceId = queryText(req, 'workspaceId', true)!;
    const snapshotId = assertSnapshotId(req.query.snapshotId);
    res.json(await getLifecycleEvidence({ workspaceId, evidenceId: req.params.evidenceId, expectedSnapshotId: snapshotId }));
  } catch (error) {
    await recordLifecycleEvaluatorError({
      workspaceId: typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined,
      operation: 'evidence',
      error,
    });
    next(error);
  }
});

export default router;
