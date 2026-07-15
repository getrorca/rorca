/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { AuthError, ValidationError } from '../lib/errors';
import {
  deriveDecisionPrincipal,
  getSsdlcDecisionState,
  recordSsdlcDecision,
  revokeSsdlcDecision,
  type DecisionSubject,
  type DelegatedDecisionIdentity,
  type RecordSsdlcDecisionInput,
} from '../lib/ssdlc-decisions';

const router = Router();

const CALLER_ACTOR_FIELDS = [
  'actor',
  'actorId',
  'actorLabel',
  'principal',
  'principalType',
  'principalId',
  'principalDisplayLabel',
  'authority',
  'role',
] as const;

function bodyObject(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new ValidationError('Request body must be an object');
  }
  return req.body as Record<string, unknown>;
}

function rejectActorClaims(body: Record<string, unknown>): void {
  const field = CALLER_ACTOR_FIELDS.find((candidate) => body[candidate] !== undefined);
  if (field) {
    throw new ValidationError(`Request-body actor authority is not accepted; '${field}' is derived server-side`, { field });
  }
}

function delegatedIdentity(body: Record<string, unknown>): DelegatedDecisionIdentity | undefined {
  const value = body.delegatedOnBehalfOf;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('delegatedOnBehalfOf must be an identity object');
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.principalId !== 'string' || typeof candidate.displayLabel !== 'string') {
    throw new ValidationError('delegatedOnBehalfOf requires principalId and displayLabel');
  }
  return { principalId: candidate.principalId, displayLabel: candidate.displayLabel };
}

function requestPrincipal(req: Request, body: Record<string, unknown> = {}) {
  if (!req.user) throw new AuthError();
  return deriveDecisionPrincipal(req.user, delegatedIdentity(body));
}

function sourceRequestId(req: Request): string {
  const idempotencyKey = req.get('Idempotency-Key')?.trim();
  const requestId = req.get('X-Request-Id')?.trim();
  return idempotencyKey || requestId || crypto.randomUUID();
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'string' ? value : String(value);
}

function decisionSubject(value: unknown): DecisionSubject | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('subject must be an object');
  const subject = value as Record<string, unknown>;
  if ((subject.type !== 'commit_sha' && subject.type !== 'artifact_digest') || typeof subject.value !== 'string') {
    throw new ValidationError('subject requires type commit_sha/artifact_digest and a string value');
  }
  return { type: subject.type, value: subject.value };
}

/**
 * @swagger
 * /api/lifecycle/decisions:
 *   post:
 *     tags: [Lifecycle Decisions]
 *     summary: Record one governed SSDLC decision
 *     operationId: recordLifecycleDecision
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Governed decisions mutate a workspace-owned audit ledger and bind authority to the authenticated request principal."
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, specSlug, phaseId, decisionType, rationale]
 *             properties:
 *               workspaceId: { type: string }
 *               specSlug: { type: string }
 *               phaseId: { type: string }
 *               gateId: { type: string }
 *               decisionType: { type: string, enum: [defer, not_applicable_confirmation, gate_override, qa_approval, merge_approval, production_approval] }
 *               rationale: { type: string }
 *               expiresAt: { type: string, format: date-time }
 *               evidenceGap: { type: string }
 *               subject: { type: object }
 *               delegatedOnBehalfOf: { type: object }
 *     responses:
 *       201: { description: Governed decision durably recorded }
 *       200: { description: Exact idempotent replay returned }
 *       400: { description: Invalid scope or decision contract }
 *       403: { description: Principal or policy is not authorized }
 *       409: { description: Conflicting active decision or revision mismatch }
 */
router.post('/decisions', async (req, res, next) => {
  try {
    const body = bodyObject(req);
    rejectActorClaims(body);
    const principal = requestPrincipal(req, body);
    const input: RecordSsdlcDecisionInput = {
      workspaceId: optionalString(body.workspaceId) ?? '',
      specSlug: optionalString(body.specSlug) ?? '',
      specVersion: body.specVersion as string | number | null | undefined,
      runId: body.runId === undefined || body.runId === null ? body.runId as null | undefined : Number(body.runId),
      storyId: optionalString(body.storyId),
      phaseId: optionalString(body.phaseId) ?? '',
      gateId: optionalString(body.gateId),
      decisionType: body.decisionType as RecordSsdlcDecisionInput['decisionType'],
      rationale: optionalString(body.rationale) ?? '',
      expiresAt: body.expiresAt as string | null | undefined,
      evidenceGap: optionalString(body.evidenceGap),
      subject: decisionSubject(body.subject),
      sourceRequestId: sourceRequestId(req),
    };
    const result = await recordSsdlcDecision(input, principal);
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/lifecycle/decisions/{decisionId}/revoke:
 *   post:
 *     tags: [Lifecycle Decisions]
 *     summary: Revoke one governed SSDLC decision
 *     operationId: revokeLifecycleDecision
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Revocation immediately changes derived workspace lifecycle state and is retained as authenticated audit history."
 *     parameters:
 *       - in: path
 *         name: decisionId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Decision revoked or exact revocation replay returned }
 *       403: { description: Authenticated principal cannot revoke governed decisions }
 *       404: { description: Workspace-scoped decision not found }
 *       409: { description: Decision was already revoked by another request }
 */
router.post('/decisions/:decisionId/revoke', async (req, res, next) => {
  try {
    const body = bodyObject(req);
    rejectActorClaims(body);
    const principal = requestPrincipal(req, body);
    const result = await revokeSsdlcDecision({
      workspaceId: optionalString(body.workspaceId) ?? '',
      decisionId: req.params.decisionId,
      rationale: optionalString(body.rationale) ?? '',
      sourceRequestId: sourceRequestId(req),
    }, principal);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/lifecycle/decisions/state:
 *   get:
 *     tags: [Lifecycle Decisions]
 *     summary: Read derived decision state and immutable audit history
 *     operationId: getLifecycleDecisionState
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Decision state and provenance are workspace-owned audit data available to authenticated lifecycle operators."
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: specSlug
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: phaseId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: gateId
 *         schema: { type: string }
 *     responses:
 *       200: { description: Derived state with active, stale, expired, and revoked history }
 *       400: { description: Invalid scope }
 *       404: { description: Workspace or active lifecycle policy not found }
 */
router.get('/decisions/state', async (req, res, next) => {
  try {
    requestPrincipal(req);
    const result = await getSsdlcDecisionState({
      workspaceId: typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '',
      specSlug: typeof req.query.specSlug === 'string' ? req.query.specSlug : '',
      phaseId: typeof req.query.phaseId === 'string' ? req.query.phaseId : '',
      gateId: typeof req.query.gateId === 'string' ? req.query.gateId : undefined,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
