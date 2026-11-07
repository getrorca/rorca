/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type Request } from 'express';
import { AuthError, ValidationError } from '../lib/errors';
import { requireWorkspaceAdmin, requireWorkspaceMember } from '../lib/auth-utils';
import { requireLifecycleIdempotencyKey } from '../lib/lifecycle-mutations';
import {
  deriveDecisionPrincipal,
  getSsdlcDecisionState,
  SSDLC_DECISION_TYPES,
  recordSsdlcDecision,
  revokeSsdlcDecision,
  type DecisionSubject,
  type RecordSsdlcDecisionInput,
} from '../lib/ssdlc-decisions';
import {
  ProviderHumanEventSchema,
  providerHumanActionHash,
  verifyAndPersistProviderHumanAuthority,
} from '../lib/provider-human-authority';

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
  'delegatedOnBehalfOf',
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

function requestPrincipal(req: Request) {
  if (!req.user) throw new AuthError();
  return deriveDecisionPrincipal(req.user);
}

function isServicePrincipal(req: Request): boolean {
  return !req.user
    || req.user.email.toLowerCase().endsWith('@rorca.internal')
    || req.user.id === 'system';
}

function sourceRequestId(req: Request): string {
  return requireLifecycleIdempotencyKey(req.get('Idempotency-Key'));
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'string' ? value : String(value);
}

function pathText(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${name} must be a non-empty path parameter`, { field: name });
  }
  return value.trim();
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

function lifecycleDecisionInput(body: Record<string, unknown>, sourceId = 'target-resolution'): RecordSsdlcDecisionInput {
  if (typeof body.decisionType !== 'string'
    || !SSDLC_DECISION_TYPES.includes(body.decisionType as (typeof SSDLC_DECISION_TYPES)[number])) {
    throw new ValidationError('decisionType is not a caller-authorized lifecycle decision type', { field: 'decisionType' });
  }
  return {
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
    sourceRequestId: sourceId,
  };
}

function lifecycleDecisionResponseScope(input: RecordSsdlcDecisionInput) {
  return {
    workspaceId: input.workspaceId,
    specSlug: input.specSlug,
    specVersion: input.specVersion ?? null,
    runId: input.runId ?? null,
    storyId: input.storyId ?? null,
    phaseId: input.phaseId,
    gateId: input.gateId ?? null,
    decisionType: input.decisionType,
  };
}

export function lifecycleDecisionProviderTarget(input: RecordSsdlcDecisionInput): string {
  return providerHumanActionHash({
    purpose: 'lifecycle_decision',
    workspaceId: input.workspaceId,
    specSlug: input.specSlug,
    specVersion: input.specVersion ?? null,
    runId: input.runId ?? null,
    storyId: input.storyId ?? null,
    phaseId: input.phaseId,
    gateId: input.gateId ?? null,
    decisionType: input.decisionType,
    rationale: input.rationale,
    expiresAt: input.expiresAt ?? null,
    evidenceGap: input.evidenceGap ?? null,
    subject: input.subject ?? null,
  });
}

/**
 * @swagger
 * /api/lifecycle/decisions/target:
 *   post:
 *     tags: [Lifecycle Decisions]
 *     summary: Resolve the exact provider-human lifecycle decision target
 *     operationId: resolveLifecycleDecisionTarget
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Returns the canonical hash a workspace member may ask a provider human to sign; it grants no decision authority and performs no mutation."
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
 *               specVersion: { oneOf: [{ type: string }, { type: integer }], nullable: true }
 *               runId: { type: integer, nullable: true }
 *               storyId: { type: string, nullable: true }
 *               phaseId: { type: string }
 *               gateId: { type: string, nullable: true }
 *               decisionType: { type: string, enum: [defer, not_applicable_confirmation, gate_override, qa_approval, merge_approval, production_approval] }
 *               rationale: { type: string }
 *               expiresAt: { type: string, format: date-time, nullable: true }
 *               evidenceGap: { type: string, nullable: true }
 *               subject: { type: object, nullable: true }
 *     responses:
 *       200:
 *         description: Canonical provider-human target hash and exact request identity
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [targetHash, command, workspaceId, responseIdentity]
 *               properties:
 *                 targetHash: { type: string }
 *                 command: { type: string }
 *                 workspaceId: { type: string }
 *                 responseIdentity: { type: object }
 *       403: { description: Workspace membership required }
 */
router.post('/decisions/target', requireWorkspaceMember(), async (req, res, next) => {
  try {
    const body = bodyObject(req);
    rejectActorClaims(body);
    requestPrincipal(req);
    const input = lifecycleDecisionInput(body);
    const targetHash = lifecycleDecisionProviderTarget(input);
    res.json({
      ok: true,
      workspaceId: input.workspaceId,
      targetHash,
      command: `approve lifecycle decision ${targetHash}`,
      responseIdentity: {
        schemaVersion: 'rorca.lifecycle-decision-target-identity.v1',
        ...lifecycleDecisionResponseScope(input),
        targetHash,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/lifecycle/decisions:
 *   post:
 *     tags: [Lifecycle Decisions]
 *     summary: Record one governed SSDLC decision
 *     operationId: recordLifecycleDecision
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Governed decisions mutate a workspace-owned audit ledger; baseline workspace membership is required before policy binds authority to the authenticated request principal or exact provider-human receipt."
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema: { type: string, minLength: 8, maxLength: 200 }
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
 *               specVersion: { oneOf: [{ type: string }, { type: integer }], nullable: true }
 *               runId: { type: integer, nullable: true }
 *               storyId: { type: string, nullable: true }
 *               phaseId: { type: string }
 *               gateId: { type: string, nullable: true }
 *               decisionType: { type: string, enum: [defer, not_applicable_confirmation, gate_override, qa_approval, merge_approval, production_approval] }
 *               rationale: { type: string }
 *               expiresAt: { type: string, format: date-time }
 *               evidenceGap: { type: string }
 *               subject: { type: object }
 *               humanApproval:
 *                 type: object
 *                 description: Exact signed provider-human event required for service-relayed governed decisions
 *                 required: [schemaVersion, issuerId, keyId, provider, providerTenantId, actorId, conversationId, threadId, messageId, occurredAt, normalizedCommandHash, ingressIdempotencyKey, signature]
 *     responses:
 *       201: { description: Governed decision durably recorded with exact responseIdentity }
 *       200: { description: Exact idempotent replay returned with the same responseIdentity }
 *       400: { description: Invalid scope or decision contract }
 *       403: { description: Principal or policy is not authorized }
 *       409: { description: Conflicting active decision or revision mismatch }
 */
router.post('/decisions', requireWorkspaceMember(), async (req, res, next) => {
  try {
    const body = bodyObject(req);
    rejectActorClaims(body);
    requestPrincipal(req);
    const input = lifecycleDecisionInput(body, sourceRequestId(req));
    const event = body.humanApproval === undefined
      ? null
      : ProviderHumanEventSchema.parse(body.humanApproval);
    if (isServicePrincipal(req) && !event) {
      throw new AuthError('Service principals must relay exact provider-human lifecycle authority');
    }
    const principal = event
      ? await (async () => {
        const targetHash = lifecycleDecisionProviderTarget(input);
        const receipt = await verifyAndPersistProviderHumanAuthority({
          workspaceId: input.workspaceId,
          purpose: 'lifecycle_decision',
          targetHash,
          event,
        });
        return {
          principalType: 'provider_human' as const,
          principalId: receipt.actorId,
          displayLabel: `${event.provider}:${receipt.actorId}`,
          role: 'human-approver',
          sourceChannel: 'provider' as const,
          providerHumanReceiptId: receipt.receiptId,
        };
      })()
      : requestPrincipal(req);
    const result = await recordSsdlcDecision(input, principal);
    const targetHash = lifecycleDecisionProviderTarget(input);
    res.status(result.replayed ? 200 : 201).json({
      ...result,
      responseIdentity: {
        schemaVersion: 'rorca.lifecycle-decision-response-identity.v1',
        ...lifecycleDecisionResponseScope(input),
        targetHash,
        sourceRequestId: input.sourceRequestId,
        actorId: principal.principalId,
        providerHumanReceiptId: principal.providerHumanReceiptId ?? null,
        decisionId: String(result.decision.id),
      },
    });
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
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Revocation immediately changes derived workspace lifecycle state and is retained as authenticated audit history, so workspace administrator authority is required."
 *     parameters:
 *       - in: path
 *         name: decisionId
 *         required: true
 *         schema: { type: string }
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema: { type: string, minLength: 8, maxLength: 200 }
 *     responses:
 *       200: { description: Decision revoked or exact revocation replay returned }
 *       403: { description: Authenticated principal cannot revoke governed decisions }
 *       404: { description: Workspace-scoped decision not found }
 *       409: { description: Decision was already revoked by another request }
 */
router.post('/decisions/:decisionId/revoke', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    const body = bodyObject(req);
    rejectActorClaims(body);
    const principal = requestPrincipal(req);
    const result = await revokeSsdlcDecision({
      workspaceId: optionalString(body.workspaceId) ?? '',
      decisionId: pathText(req, 'decisionId'),
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
 *     x-rorca-rationale: "Decision state and provenance are workspace-owned audit data available only to workspace members."
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
 *       403: { description: Workspace membership required }
 *       404: { description: Workspace or active lifecycle policy not found }
 */
router.get('/decisions/state', requireWorkspaceMember(), async (req, res, next) => {
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
