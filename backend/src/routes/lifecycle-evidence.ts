/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type Request } from 'express';
import { AuthError, ForbiddenError, ValidationError } from '../lib/errors';
import { emitLifecycleInvalidation } from '../lib/lifecycle-mutations';
import {
  normalizeHermesEvidence,
  paginateNormalizedEvidence,
  parseHermesEvidenceEnvelope,
  persistCanonicalEvidence,
  type EvidencePrincipal,
} from '../lib/ssdlc-evidence';
import { parsePaginationParams } from '../lib/paginate';

const router = Router();

function requestPrincipal(req: Request): EvidencePrincipal {
  if (!req.user) throw new AuthError();
  const internalAdapter = req.user.role === 'admin'
    && (req.user.email.endsWith('@rorca.internal') || req.user.id === 'system');
  return {
    id: req.user.id,
    displayName: req.user.email,
    adapterVerified: internalAdapter,
  };
}

/**
 * @swagger
 * /api/lifecycle/evidence:
 *   post:
 *     tags: [Lifecycle Evidence]
 *     summary: Ingest one bounded normalized Hermes evidence envelope
 *     operationId: ingestHermesLifecycleEvidence
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Hermes evidence mutates a workspace-owned audit ledger and must bind provenance to the authenticated Rorca request identity."
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [schemaVersion, kind, sourceSystem, sourceEventId, observedAt, scope, subject, status, confidence, payloadHash, provenanceChain]
 *             properties:
 *               schemaVersion: { type: string, enum: [hermes.evidence.v1] }
 *               kind: { type: string, enum: [gitreins_judgment, manual_qa, staging_result, deployment_proof, memory_closeout] }
 *               sourceSystem: { type: string, maxLength: 256 }
 *               sourceEventId: { type: string, maxLength: 512 }
 *               observedAt: { type: string, format: date-time }
 *               status: { type: string, enum: [passed, story_caused_failure, unrelated_baseline, environment_credential_blocker, skipped_with_rationale, unknown] }
 *               confidence: { type: number, minimum: 0, maximum: 1 }
 *               payloadHash: { type: string }
 *               excerpt: { type: string, maxLength: 8192 }
 *               rawReference: { type: string, maxLength: 4096 }
 *     responses:
 *       201: { description: Immutable evidence created }
 *       200: { description: Exact source replay returned idempotently }
 *       400: { description: Invalid or unbounded envelope }
 *       409: { description: Source event ID conflicts with an existing immutable payload }
 */
async function ingestEvidence(req: Request, res: import('express').Response, next: import('express').NextFunction): Promise<void> {
  try {
    const envelope = parseHermesEvidenceEnvelope(req.body);
    const principal = requestPrincipal(req);
    if (envelope.kind !== 'manual_qa' && !principal.adapterVerified) {
      throw new ForbiddenError('Automated lifecycle evidence requires an authenticated internal/Hermes adapter identity', {
        classification: 'blocked',
        source: envelope.kind,
      });
    }
    const evidence = normalizeHermesEvidence(envelope, principal);
    const result = await persistCanonicalEvidence(evidence);
    // Emit after persistence on both create and source replay. If the process
    // died after the evidence commit but before WAL publication, replay repairs
    // the invalidation without duplicating immutable evidence.
    await emitLifecycleInvalidation({
      workspaceId: evidence.scope.workspaceId,
      specId: evidence.scope.specSlug,
      phaseId: evidence.scope.phaseId,
      runId: evidence.scope.runId,
      changeKind: 'evidence_persisted',
    });
    res.status(result.replayed ? 200 : 201).json({
      classification: result.replayed ? 'duplicate' : 'persisted',
      ...result,
    });
  } catch (error) {
    next(error);
  }
}

router.post('/evidence', ingestEvidence);

/**
 * @swagger
 * /api/lifecycle/evidence/hermes:
 *   post:
 *     tags: [Lifecycle Evidence]
 *     summary: Deprecated alias for canonical lifecycle evidence ingress
 *     deprecated: true
 *     operationId: ingestHermesLifecycleEvidenceCompatibility
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Compatibility ingress has the identical authenticated, bounded, redacted contract as canonical lifecycle evidence ingress."
 *     responses:
 *       201: { description: Immutable evidence created }
 *       200: { description: Exact source replay returned idempotently }
 *       400: { description: Invalid or unbounded envelope }
 *       403: { description: Source identity blocked }
 *       409: { description: Source event conflicts with immutable evidence }
 */
router.post('/evidence/hermes', ingestEvidence);

/**
 * @swagger
 * /api/lifecycle/evidence:
 *   get:
 *     tags: [Lifecycle Evidence]
 *     summary: List redacted normalized lifecycle evidence
 *     operationId: listLifecycleEvidence
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Lifecycle evidence contains workspace-owned delivery and provenance metadata and is available only to authenticated callers."
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: specSlug
 *         schema: { type: string }
 *       - in: query
 *         name: runId
 *         schema: { type: integer }
 *       - in: query
 *         name: storyId
 *         schema: { type: string }
 *       - in: query
 *         name: phaseId
 *         schema: { type: string }
 *       - in: query
 *         name: gateId
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 200 }
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *     responses:
 *       200: { description: Paginated redacted evidence }
 *       400: { description: Invalid filter }
 */
router.get('/evidence', async (req, res, next) => {
  try {
    requestPrincipal(req);
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
    if (!workspaceId) throw new ValidationError('workspaceId is required');
    const rawRunId = req.query.runId;
    const runId = rawRunId === undefined ? undefined : Number(rawRunId);
    if (runId !== undefined && (!Number.isSafeInteger(runId) || runId <= 0)) {
      throw new ValidationError('runId must be a positive integer');
    }
    const pagination = parsePaginationParams(req, { limit: 50, maxLimit: 200 });
    const result = await paginateNormalizedEvidence(workspaceId, {
      specSlug: typeof req.query.specSlug === 'string' ? req.query.specSlug : undefined,
      runId,
      storyId: typeof req.query.storyId === 'string' ? req.query.storyId : undefined,
      phaseId: typeof req.query.phaseId === 'string' ? req.query.phaseId : undefined,
      gateId: typeof req.query.gateId === 'string' ? req.query.gateId : undefined,
    }, pagination);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
