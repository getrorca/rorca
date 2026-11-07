/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireWorkspaceAdmin, requireWorkspaceMember } from '../lib/auth-utils';
import { getDeliveryAdapterCatalog } from '../lib/delivery-adapter';
import { ValidationError } from '../lib/errors';
import { requireLocalDeliveryCreationAuthority } from '../lib/local-delivery-authority';
import { assertNotProtectedWave1Run } from '../lib/wave-1-stabilization';
import {
  selectDeliveryAdapter,
} from '../lib/delivery-adapter-selection';
import {
  getLocalReviewBundle,
  listLocalReviewBundles,
} from '../lib/local-review-bundle-adapter';

const router = Router({ strict: true, caseSensitive: true });
const ALLOWED_CREATE_FIELDS = new Set(['workspaceId', 'runId', 'storyId', 'attempt', 'generation', 'hostAttemptEnvelopeId']);
const SAFE_WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function exactQueryString(value: unknown, label: string, maxLength = 255): string {
  if (typeof value !== 'string' || value.trim() !== value || !value || value.length > maxLength) {
    throw new ValidationError(`${label} is required and must be at most ${maxLength} characters`);
  }
  return value;
}

function exactWorkspaceId(value: unknown): string {
  const workspaceId = exactQueryString(value, 'workspaceId');
  if (!SAFE_WORKSPACE_ID.test(workspaceId)) throw new ValidationError('workspaceId is invalid');
  return workspaceId;
}

function createBody(req: Request): {
  workspaceId: string;
  runId: number;
  storyId: string;
  attempt: number;
  generation: string;
  hostAttemptEnvelopeId: string;
} {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new ValidationError('Local review bundle request body must be an object');
  }
  const body = req.body as Record<string, unknown>;
  const forbidden = Object.keys(body).find((key) => !ALLOWED_CREATE_FIELDS.has(key));
  if (forbidden) {
    throw new ValidationError(`Local review bundle request field '${forbidden}' is not accepted`);
  }
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
  const storyId = typeof body.storyId === 'string' ? body.storyId : '';
  const runId = body.runId;
  const attempt = body.attempt;
  const generation = typeof body.generation === 'string' ? body.generation : '';
  const hostAttemptEnvelopeId = typeof body.hostAttemptEnvelopeId === 'string' ? body.hostAttemptEnvelopeId : '';
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!SAFE_WORKSPACE_ID.test(workspaceId) || workspaceId.length > 255
    || !storyId || storyId.trim() !== storyId || storyId.length > 160 || /[\u0000-\u001f\u007f]/.test(storyId)
    || !Number.isSafeInteger(runId) || Number(runId) <= 0
    || !Number.isSafeInteger(attempt) || Number(attempt) <= 0
    || !uuid.test(generation) || !uuid.test(hostAttemptEnvelopeId)) {
    throw new ValidationError('workspaceId, positive runId, storyId, positive attempt, UUID generation, and exact host-attempt envelope are required');
  }
  return { workspaceId, runId: Number(runId), storyId, attempt: Number(attempt), generation, hostAttemptEnvelopeId };
}

function rejectProtectedRunBeforeDownstream(req: Request, _res: Response, next: NextFunction): void {
  try {
    const candidate = req.method === 'POST' ? (req.body as Record<string, unknown> | undefined)?.runId : req.query.runId;
    if (candidate !== undefined) {
      const runId = Number(candidate);
      if (Number.isSafeInteger(runId)) assertNotProtectedWave1Run(runId);
    }
    next();
  } catch (error) {
    next(error);
  }
}

function idempotencyKey(req: Request): string {
  const value = String(req.get('Idempotency-Key') ?? '');
  if (value.length < 8 || value.length > 200 || !SAFE_IDEMPOTENCY_KEY.test(value)) {
    throw new ValidationError('Idempotency-Key header must be 8-200 safe characters');
  }
  return value;
}

function validateListIdentity(req: Request, _res: Response, next: NextFunction): void {
  try {
    exactWorkspaceId(req.query.workspaceId);
    if (req.query.runId !== undefined) {
      const runId = Number(exactQueryString(req.query.runId, 'runId', 16));
      if (!Number.isSafeInteger(runId) || runId <= 0) throw new ValidationError('runId must be a positive integer');
    }
    if (req.query.limit !== undefined) {
      const limit = Number(exactQueryString(req.query.limit, 'limit', 3));
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new ValidationError('limit must be an integer from 1 to 100');
      }
    }
    next();
  } catch (error) { next(error); }
}

function validateDetailIdentity(req: Request, _res: Response, next: NextFunction): void {
  try {
    exactWorkspaceId(req.query.workspaceId);
    const runId = Number(exactQueryString(req.query.runId, 'runId', 16));
    if (!Number.isSafeInteger(runId) || runId <= 0) throw new ValidationError('runId must be a positive integer');
    if (!/^lrb-[0-9a-f]{64}$/.test(String(req.params.bundleId))) throw new ValidationError('bundleId is invalid');
    next();
  } catch (error) { next(error); }
}

function validateCreateIdentity(req: Request, _res: Response, next: NextFunction): void {
  try {
    createBody(req);
    idempotencyKey(req);
    next();
  } catch (error) { next(error); }
}

/**
 * @swagger
 * /api/delivery/adapters:
 *   get:
 *     tags: [Delivery]
 *     summary: List provider-neutral delivery adapters and the local-first default
 *     operationId: listDeliveryAdapters
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Static, credential-free adapter capabilities let local UI/CLI/MCP clients discover that local review bundles are the default while GitHub remains optional."
 *     x-rorca-public-api: true
 *     responses:
 *       200:
 *         description: Provider-neutral adapter catalog
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: false
 *               required: [contractVersion, defaultAdapterId, adapters]
 *               properties:
 *                 contractVersion: { type: string, enum: [rorca.delivery-adapter.v1] }
 *                 defaultAdapterId: { type: string, enum: [local-review-bundle] }
 *                 adapters:
 *                   type: array
 *                   items:
 *                     type: object
 *                     additionalProperties: false
 *                     required: [contractVersion, adapterId, adapterVersion, label, kind, default, optional, requiresNetwork, requiresCredentials, supportsReviewBundle, supportsExternalChangeRequest, implementationStatus, mergeAuthority, deploymentAuthority]
 *                     properties:
 *                       contractVersion: { type: string }
 *                       adapterId: { type: string }
 *                       adapterVersion: { type: string }
 *                       label: { type: string }
 *                       kind: { type: string, enum: [local, provider] }
 *                       default: { type: boolean }
 *                       optional: { type: boolean }
 *                       requiresNetwork: { type: boolean }
 *                       requiresCredentials: { type: boolean }
 *                       supportsReviewBundle: { type: boolean }
 *                       supportsExternalChangeRequest: { type: boolean }
 *                       implementationStatus: { type: string, enum: [canonical_adapter, legacy_optional_surfaces] }
 *                       mergeAuthority: { type: string, enum: [none] }
 *                       deploymentAuthority: { type: string, enum: [none] }
 */
router.get('/adapters', (_req, res) => {
  res.json(getDeliveryAdapterCatalog());
});

/**
 * @swagger
 * /api/delivery/review-bundles:
 *   get:
 *     tags: [Delivery]
 *     summary: List safe local review bundle read models
 *     operationId: listLocalReviewBundles
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Bounded workspace-scoped read models contain hashes and explicit no-merge/no-deploy state only; raw paths, patches, transcripts, credentials, actors, and provider state are excluded."
 *     x-rorca-public-api: true
 *     parameters:
 *       - { in: query, name: workspaceId, required: true, schema: { type: string, minLength: 1, maxLength: 255, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' } }
 *       - { in: query, name: runId, required: false, schema: { type: integer, minimum: 1 } }
 *       - { in: query, name: limit, required: false, schema: { type: integer, minimum: 1, maximum: 100 } }
 *     responses:
 *       200:
 *         description: Bounded local review bundle list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: false
 *               required: [schemaVersion, items, limit]
 *               properties:
 *                 schemaVersion: { type: string, enum: [rorca.local-review-bundle-read.v1] }
 *                 items: { type: array, maxItems: 100, items: { $ref: '#/components/schemas/LocalReviewBundleReadModel' } }
 *                 limit: { type: integer, minimum: 1, maximum: 100 }
 *       400: { description: Invalid workspace, run, or limit }
 */
router.get('/review-bundles', rejectProtectedRunBeforeDownstream, validateListIdentity, requireWorkspaceMember(), async (req, res, next) => {
  try {
    const workspaceId = exactWorkspaceId(req.query.workspaceId);
    const runId = req.query.runId === undefined ? undefined : Number(req.query.runId);
    const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
    if (runId !== undefined && (!Number.isSafeInteger(runId) || runId <= 0)) {
      throw new ValidationError('runId must be a positive integer');
    }
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
      throw new ValidationError('limit must be an integer from 1 to 100');
    }
    res.json(await listLocalReviewBundles({ workspaceId, runId, limit }));
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/delivery/review-bundles/{bundleId}:
 *   get:
 *     tags: [Delivery]
 *     summary: Read one safe immutable local review bundle projection
 *     operationId: getLocalReviewBundle
 *     x-rorca-tier: public
 *     x-rorca-rationale: "The response exposes only bounded content identities, host receipt counts, and projection integrity; artifact bytes, changed paths, host paths, credentials, and raw evidence remain local and unexposed."
 *     x-rorca-public-api: true
 *     parameters:
 *       - { in: path, name: bundleId, required: true, schema: { type: string, pattern: '^lrb-[0-9a-f]{64}$' } }
 *       - { in: query, name: workspaceId, required: true, schema: { type: string, minLength: 1, maxLength: 255, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' } }
 *       - { in: query, name: runId, required: true, schema: { type: integer, minimum: 1 } }
 *     responses:
 *       200:
 *         description: Safe local review bundle read model
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/LocalReviewBundleReadModel' }
 *       404: { description: Bundle not found }
 *       409: { description: Immutable projection is missing or corrupt }
 */
router.get('/review-bundles/:bundleId', rejectProtectedRunBeforeDownstream, validateDetailIdentity, requireWorkspaceMember(), async (req, res, next) => {
  try {
    const runId = Number(exactQueryString(req.query.runId, 'runId'));
    if (!Number.isSafeInteger(runId) || runId <= 0) throw new ValidationError('runId must be a positive integer');
    res.json(await getLocalReviewBundle({
      workspaceId: exactWorkspaceId(req.query.workspaceId),
      runId,
      bundleId: String(req.params.bundleId),
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/delivery/review-bundles:
 *   post:
 *     tags: [Delivery]
 *     summary: Create one immutable local review bundle from host-observed authority
 *     operationId: createLocalReviewBundle
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Artifact finalization is an operator-authorized local mutation. The server re-derives all attempt, Git, validation, and evidence identity and grants no merge or deployment authority."
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema: { type: string, minLength: 8, maxLength: 200, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [workspaceId, runId, storyId, attempt, generation, hostAttemptEnvelopeId]
 *             properties:
 *               workspaceId: { type: string, minLength: 1, maxLength: 255, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' }
 *               runId: { type: integer, minimum: 1 }
 *               storyId: { type: string, minLength: 1, maxLength: 160 }
 *               attempt: { type: integer, minimum: 1 }
 *               generation: { type: string, format: uuid }
 *               hostAttemptEnvelopeId: { type: string, format: uuid }
 *     responses:
 *       201: { description: Immutable local review bundle finalized }
 *       200: { description: Exact idempotent replay returned }
 *       400: { description: Invalid or authority-claiming input }
 *       403: { description: Human workspace administrator authority required }
 *       409: { description: Stale authority, changed replay, unsafe content, or projection corruption }
 *       413: { description: Changed files, content, patch, or manifest exceed bounded limits }
 */
router.post(
  '/review-bundles',
  rejectProtectedRunBeforeDownstream,
  validateCreateIdentity,
  requireLocalDeliveryCreationAuthority,
  requireWorkspaceAdmin(),
  async (req, res, next) => {
    try {
      const body = createBody(req);
      // Use canonical adapter selection. Default remains local-review-bundle.
      // Future stories will provide the external-send policy from the request or standing state.
      const selection = await selectDeliveryAdapter(body.workspaceId, null);
      if (selection.kind !== 'local') {
        throw new ValidationError('External delivery is not supported through the local review bundle endpoint');
      }
      const result = await selection.adapter.create({
        ...body,
        idempotencyKey: idempotencyKey(req),
        requestedBy: req.user!.id,
      });
      // Provider bindings are intentionally excluded from the public read model
      // but are verified by the selection logic.
      res.status(result.replayed ? 200 : 201).json({
        schemaVersion: result.manifest.schemaVersion,
        bundleId: result.manifest.bundleId,
        contentHash: result.manifest.contentHash,
        manifestHash: result.manifestHash,
        projectionKey: result.projectionKey,
        replayed: result.replayed,
        validationStatus: result.manifest.validation.status,
        delivery: result.manifest.delivery,
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
