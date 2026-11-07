/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { queryOne } from '../db/index';
import { requireWorkspaceMember } from '../lib/auth-utils';
import { requireLocalOperatorBoundary } from '../lib/local-operator-boundary';
import { NotFoundError, ValidationError } from '../lib/errors';
import { paginateArray, parsePaginationParams } from '../lib/paginate';
import {
  StripeCredentialFailureService,
  StripeRuntimeAuthenticationFailureSchema,
} from '../lib/stripe-credential-failure';
import { StripeAuthorityProviderAdapter, StripeModeSchema } from '../lib/stripe-authority-provider-adapter';
import { stripeOperatorCeremony, StripeRotationApprovalSchema, StripeRotationIntentInputSchema } from '../lib/stripe-credential-rotation';
import {
  StripeCutoverAdvanceSchema,
  StripeDashboardRevocationEvidenceSchema,
} from '../lib/stripe-credential-cutover';
import {
  StripeCredentialRotationService,
  StripeRotationAuthenticationCompletionSchema,
} from '../lib/stripe-credential-rotation-store';

export type ProviderBindingWorkspaceReader = (workspaceId: string) => Promise<boolean>;
export type StripeCredentialRotationRouteService = Pick<
  StripeCredentialRotationService,
  | 'createApprovedIntent'
  | 'get'
  | 'completeAuthentication'
  | 'getCutover'
  | 'advanceCutover'
  | 'completeRevocation'
>;
export type StripeCredentialFailureRouteService = Pick<
  StripeCredentialFailureService,
  'createEmergencyRequest' | 'listIncidents'
>;

async function workspaceExists(workspaceId: string): Promise<boolean> {
  return Boolean(await queryOne<{ id: string }>('SELECT id FROM workspaces WHERE id = $1', [workspaceId]));
}

const RotationBindingPathSchema = z.object({
  id: z.string().trim().min(1).max(255),
  bindingId: z.string().uuid(),
}).passthrough();

const RotationIntentPathSchema = RotationBindingPathSchema.extend({
  intentId: z.string().uuid(),
}).passthrough();

const RotationIntentCreateBodySchema = z.object({
  intent: StripeRotationIntentInputSchema,
  approval: StripeRotationApprovalSchema,
}).strict();

const StripeRevocationCompletionBodySchema = z.object({
  intentDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  evidence: StripeDashboardRevocationEvidenceSchema,
}).strict();

export function createProviderBindingsInventoryHandler(
  stripeAdapter = new StripeAuthorityProviderAdapter(),
  readWorkspace: ProviderBindingWorkspaceReader = workspaceExists,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const workspaceId = String(req.params.id);
      if (!await readWorkspace(workspaceId)) throw new NotFoundError('Workspace', workspaceId);

      const parsedMode = req.query.mode === undefined
        ? null
        : StripeModeSchema.safeParse(req.query.mode);
      if (parsedMode !== null && !parsedMode.success) {
        throw new ValidationError('Stripe provider-binding inventory filter is invalid', {
          issues: parsedMode.error.issues,
        });
      }
      const mode = parsedMode === null ? null : parsedMode.data;
      const bindings = (await stripeAdapter.inventory(workspaceId))
        .filter((binding) => mode === null || binding.mode === mode);
      const page = paginateArray(bindings, parsePaginationParams(req, { limit: 100, maxLimit: 250 }), {
        cursorKey: (binding) => binding.bindingId,
      });

      res.json({
        provider: 'stripe',
        workspaceId,
        mode,
        ...page,
      });
    } catch (error) {
      next(error);
    }
  };
}

export function createStripeCredentialIncidentsHandler(
  failureService: StripeCredentialFailureRouteService = new StripeCredentialFailureService(),
  readWorkspace: ProviderBindingWorkspaceReader = workspaceExists,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const path = z.object({ id: z.string().trim().min(1).max(255) }).passthrough()
        .safeParse(req.params);
      if (!path.success) {
        throw new ValidationError('Stripe credential incident path is invalid', {
          issues: path.error.issues,
        });
      }
      if (!await readWorkspace(path.data.id)) throw new NotFoundError('Workspace', path.data.id);
      const incidents = await failureService.listIncidents(path.data.id, 250);
      const page = paginateArray(
        incidents,
        parsePaginationParams(req, { limit: 100, maxLimit: 250 }),
        {
          cursorKey: (incident) => incident.kind === 'emergency'
            ? incident.request.requestId
            : incident.receipt.receiptId,
        },
      );
      res.json({
        provider: 'stripe',
        workspaceId: path.data.id,
        ...page,
      });
    } catch (error) {
      next(error);
    }
  };
}

export function createStripeRuntimeAuthenticationFailureHandler(
  failureService: StripeCredentialFailureRouteService = new StripeCredentialFailureService(),
  readWorkspace: ProviderBindingWorkspaceReader = workspaceExists,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const path = RotationBindingPathSchema.safeParse(req.params);
      const failure = StripeRuntimeAuthenticationFailureSchema.safeParse(req.body);
      if (!path.success || !failure.success) {
        throw new ValidationError('Stripe runtime authentication failure report is invalid', {
          issues: [
            ...(!path.success ? path.error.issues : []),
            ...(!failure.success ? failure.error.issues : []),
          ],
        });
      }
      if (!await readWorkspace(path.data.id)) throw new NotFoundError('Workspace', path.data.id);
      const emergencyRequest = await failureService.createEmergencyRequest({
        workspaceId: path.data.id,
        bindingId: path.data.bindingId,
        failure: failure.data,
      });
      res.status(202).json({ emergencyRequest });
    } catch (error) {
      next(error);
    }
  };
}

export function createStripeRotationIntentHandler(
  rotationService: StripeCredentialRotationRouteService = new StripeCredentialRotationService(),
  readWorkspace: ProviderBindingWorkspaceReader = workspaceExists,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const path = RotationBindingPathSchema.safeParse(req.params);
      const body = RotationIntentCreateBodySchema.safeParse(req.body);
      if (!path.success || !body.success) {
        throw new ValidationError('Stripe rotation intent request is invalid', {
          issues: [...(!path.success ? path.error.issues : []), ...(!body.success ? body.error.issues : [])],
        });
      }
      if (!await readWorkspace(path.data.id)) throw new NotFoundError('Workspace', path.data.id);
      if (body.data.intent.workspaceId !== path.data.id
          || body.data.intent.bindingId !== path.data.bindingId) {
        throw new ValidationError('Stripe rotation intent must match the workspace and binding path exactly');
      }
      const record = await rotationService.createApprovedIntent({
        intent: body.data.intent,
        approval: body.data.approval,
      });
      res.status(201).json({
        intent: record.intent,
        lifecycle: record.lifecycle,
        ceremony: stripeOperatorCeremony(record.intent),
      });
    } catch (error) {
      next(error);
    }
  };
}

export function createStripeRotationIntentReadHandler(
  rotationService: StripeCredentialRotationRouteService = new StripeCredentialRotationService(),
  readWorkspace: ProviderBindingWorkspaceReader = workspaceExists,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const path = RotationIntentPathSchema.safeParse(req.params);
      if (!path.success) {
        throw new ValidationError('Stripe rotation intent path is invalid', { issues: path.error.issues });
      }
      if (!await readWorkspace(path.data.id)) throw new NotFoundError('Workspace', path.data.id);
      const record = await rotationService.get(path.data.id, path.data.intentId);
      if (!record || record.intent.bindingId !== path.data.bindingId) {
        throw new NotFoundError('Stripe rotation intent', path.data.intentId);
      }
      const cutover = await rotationService.getCutover(path.data.id, path.data.intentId);
      res.json({
        intent: record.intent,
        lifecycle: record.lifecycle,
        ...(record.lifecycle.state === 'WAITING_FOR_AUTHENTICATION'
          ? { ceremony: stripeOperatorCeremony(record.intent) }
          : {}),
        cutover,
      });
    } catch (error) {
      next(error);
    }
  };
}

export function createStripeRotationAuthenticationCompletionHandler(
  rotationService: StripeCredentialRotationRouteService = new StripeCredentialRotationService(),
  readWorkspace: ProviderBindingWorkspaceReader = workspaceExists,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const path = RotationIntentPathSchema.safeParse(req.params);
      const completion = StripeRotationAuthenticationCompletionSchema.safeParse(req.body);
      if (!path.success || !completion.success) {
        throw new ValidationError('Stripe rotation authentication completion is invalid', {
          issues: [
            ...(!path.success ? path.error.issues : []),
            ...(!completion.success ? completion.error.issues : []),
          ],
        });
      }
      if (!await readWorkspace(path.data.id)) throw new NotFoundError('Workspace', path.data.id);
      const record = await rotationService.get(path.data.id, path.data.intentId);
      if (!record || record.intent.bindingId !== path.data.bindingId) {
        throw new NotFoundError('Stripe rotation intent', path.data.intentId);
      }
      const result = await rotationService.completeAuthentication({
        workspaceId: path.data.id,
        intentId: path.data.intentId,
        completion: completion.data,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  };
}

export function createStripeCutoverAdvanceHandler(
  rotationService: StripeCredentialRotationRouteService = new StripeCredentialRotationService(),
  readWorkspace: ProviderBindingWorkspaceReader = workspaceExists,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const path = RotationIntentPathSchema.safeParse(req.params);
      const body = StripeCutoverAdvanceSchema.safeParse(req.body);
      if (!path.success || !body.success) {
        throw new ValidationError('Stripe credential cutover request is invalid', {
          issues: [...(!path.success ? path.error.issues : []), ...(!body.success ? body.error.issues : [])],
        });
      }
      if (!await readWorkspace(path.data.id)) throw new NotFoundError('Workspace', path.data.id);
      const record = await rotationService.get(path.data.id, path.data.intentId);
      if (!record || record.intent.bindingId !== path.data.bindingId) {
        throw new NotFoundError('Stripe rotation intent', path.data.intentId);
      }
      const cutover = await rotationService.advanceCutover({
        workspaceId: path.data.id,
        intentId: path.data.intentId,
        intentDigest: body.data.intentDigest,
      });
      res.json({ cutover });
    } catch (error) {
      next(error);
    }
  };
}

export function createStripeRevocationCompletionHandler(
  rotationService: StripeCredentialRotationRouteService = new StripeCredentialRotationService(),
  readWorkspace: ProviderBindingWorkspaceReader = workspaceExists,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const path = RotationIntentPathSchema.safeParse(req.params);
      const body = StripeRevocationCompletionBodySchema.safeParse(req.body);
      if (!path.success || !body.success) {
        throw new ValidationError('Stripe revocation completion request is invalid', {
          issues: [...(!path.success ? path.error.issues : []), ...(!body.success ? body.error.issues : [])],
        });
      }
      if (!await readWorkspace(path.data.id)) throw new NotFoundError('Workspace', path.data.id);
      const record = await rotationService.get(path.data.id, path.data.intentId);
      if (!record || record.intent.bindingId !== path.data.bindingId) {
        throw new NotFoundError('Stripe rotation intent', path.data.intentId);
      }
      const cutover = await rotationService.completeRevocation({
        workspaceId: path.data.id,
        intentId: path.data.intentId,
        intentDigest: body.data.intentDigest,
        evidence: body.data.evidence,
      });
      res.json({ cutover });
    } catch (error) {
      next(error);
    }
  };
}

export function createProviderBindingsRouter(
  stripeAdapter = new StripeAuthorityProviderAdapter(),
  readWorkspace: ProviderBindingWorkspaceReader = workspaceExists,
  rotationService: StripeCredentialRotationRouteService = new StripeCredentialRotationService(stripeAdapter),
  failureService: StripeCredentialFailureRouteService = new StripeCredentialFailureService(stripeAdapter),
): Router {
  const router = Router({ strict: true, caseSensitive: true });

  router.use('/:id/provider-bindings', requireWorkspaceMember());

  /**
   * @swagger
   * /api/workspaces/{id}/provider-bindings:
   *   get:
   *     tags: [Provider Bindings]
   *     summary: "SCR-001: Inventory secret-free provider credential bindings"
   *     operationId: listWorkspaceProviderBindings
   *     x-rorca-tier: auth
   *     x-rorca-rationale: "Read-only workspace-owned credential metadata contains references and fingerprints but no credential values."
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *       - in: query
   *         name: mode
   *         required: false
   *         schema: { type: string, enum: [test, live] }
   *       - in: query
   *         name: limit
   *         required: false
   *         schema: { type: integer, minimum: 1, maximum: 250, default: 100 }
   *       - in: query
   *         name: page
   *         required: false
   *         schema: { type: integer, minimum: 1 }
   *       - in: query
   *         name: offset
   *         required: false
   *         schema: { type: integer, minimum: 0 }
   *       - in: query
   *         name: cursor
   *         required: false
   *         schema: { type: string }
   *     responses:
   *       200: { description: Paginated secret-free Stripe credential binding inventory }
   *       400: { description: Invalid exact mode filter }
   *       401: { description: Authentication required }
   *       403: { description: Workspace membership required }
   *       404: { description: Workspace not found }
   */
  router.get(
    '/:id/provider-bindings',
    createProviderBindingsInventoryHandler(stripeAdapter, readWorkspace),
  );

  /**
   * @swagger
   * /api/workspaces/{id}/provider-bindings/credential-incidents:
   *   get:
   *     tags: [Provider Bindings]
   *     summary: "SCR-004: List secret-free credential rollback and emergency incidents"
   *     operationId: listStripeCredentialIncidents
   *     x-rorca-tier: auth
   *     x-rorca-rationale: "Read-only workspace-owned rollback, reconciliation, and emergency evidence contains fingerprints and references but no credential values or mutation authority."
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *       - in: query
   *         name: limit
   *         required: false
   *         schema: { type: integer, minimum: 1, maximum: 250, default: 100 }
   *       - in: query
   *         name: cursor
   *         required: false
   *         schema: { type: string }
   *     responses:
   *       200: { description: Paginated secret-free Stripe credential incidents }
   *       401: { description: Authentication required }
   *       403: { description: Workspace membership required }
   *       404: { description: Workspace not found }
   */
  router.get(
    '/:id/provider-bindings/credential-incidents',
    createStripeCredentialIncidentsHandler(failureService, readWorkspace),
  );

  /**
   * @swagger
   * /api/workspaces/{id}/provider-bindings/{bindingId}/runtime-authentication-failures:
   *   post:
   *     tags: [Provider Bindings]
   *     summary: "SCR-004: Report a typed Stripe runtime authentication failure"
   *     operationId: reportStripeRuntimeAuthenticationFailure
   *     x-rorca-tier: auth
   *     x-rorca-rationale: "Creates an evidence-only emergency request for an exact workspace binding; it grants no authority and still requires a separate authenticated Dashboard rotation ceremony."
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *       - in: path
   *         name: bindingId
   *         required: true
   *         schema: { type: string, format: uuid }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             additionalProperties: false
   *     responses:
   *       202: { description: Inert emergency request awaiting authenticated Dashboard action }
   *       400: { description: Invalid or credential-bearing evidence }
   *       401: { description: Authentication required }
   *       403: { description: Evidence does not match exact workspace, mode, resource, or permissions }
   *       404: { description: Workspace or binding not found }
   */
  router.post(
    '/:id/provider-bindings/:bindingId/runtime-authentication-failures',
    createStripeRuntimeAuthenticationFailureHandler(failureService, readWorkspace),
  );

  /**
   * @swagger
   * /api/workspaces/{id}/provider-bindings/{bindingId}/rotation-intents:
   *   post:
   *     tags: [Provider Bindings]
   *     summary: "SCR-002: Create an approved immutable Stripe rotation intent"
   *     operationId: createStripeRotationIntent
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Creates a credential-mutation authority target and human ceremony; local operator capability keeps it outside autonomous and MCP execution."
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *       - in: path
   *         name: bindingId
   *         required: true
   *         schema: { type: string, format: uuid }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema: { type: object }
   *     responses:
   *       201: { description: Immutable intent waiting for secure operator authentication }
   *       400: { description: Invalid secret-free intent request }
   *       403: { description: Local operator capability or exact approval required }
   *       404: { description: Workspace or binding not found }
   */
  router.post(
    '/:id/provider-bindings/:bindingId/rotation-intents',
    requireLocalOperatorBoundary,
    createStripeRotationIntentHandler(rotationService, readWorkspace),
  );

  /**
   * @swagger
   * /api/workspaces/{id}/provider-bindings/{bindingId}/rotation-intents/{intentId}:
   *   get:
   *     tags: [Provider Bindings]
   *     summary: "SCR-002: Read a secure Stripe operator ceremony"
   *     operationId: getStripeRotationIntent
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Exposes only the exact secret-free authority target and ceremony to a capability-bearing local operator."
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *       - in: path
   *         name: bindingId
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: intentId
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200: { description: Secret-free intent, lifecycle, and pending ceremony }
   *       403: { description: Local operator capability required }
   *       404: { description: Workspace, binding, or intent not found }
   */
  router.get(
    '/:id/provider-bindings/:bindingId/rotation-intents/:intentId',
    requireLocalOperatorBoundary,
    createStripeRotationIntentReadHandler(rotationService, readWorkspace),
  );

  /**
   * @swagger
   * /api/workspaces/{id}/provider-bindings/{bindingId}/rotation-intents/{intentId}/complete-authentication:
   *   post:
   *     tags: [Provider Bindings]
   *     summary: "SCR-002: Resume from an isolated Stripe credential capture"
   *     operationId: completeStripeRotationAuthentication
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Consumes only a signed SecretStore capture reference under local operator capability; no credential value crosses this API."
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *       - in: path
   *         name: bindingId
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: intentId
   *         required: true
   *         schema: { type: string, format: uuid }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [intentDigest, captureReceiptReference]
   *             additionalProperties: false
   *             properties:
   *               intentDigest: { type: string, pattern: '^sha256:[0-9a-f]{64}$' }
   *               captureReceiptReference: { type: string }
   *     responses:
   *       200: { description: SecretStore reference, fingerprint, and provenance only }
   *       400: { description: Invalid secret-free completion request }
   *       403: { description: Operator capability or provider evidence missing }
   *       404: { description: Workspace, binding, or intent not found }
   *       409: { description: Intent already resumed with different evidence }
   */
  router.post(
    '/:id/provider-bindings/:bindingId/rotation-intents/:intentId/complete-authentication',
    requireLocalOperatorBoundary,
    createStripeRotationAuthenticationCompletionHandler(rotationService, readWorkspace),
  );

  /**
   * @swagger
   * /api/workspaces/{id}/provider-bindings/{bindingId}/rotation-intents/{intentId}/advance-cutover:
   *   post:
   *     tags: [Provider Bindings]
   *     summary: "SCR-003: Reconcile and advance verified Stripe test-mode cutover"
   *     operationId: advanceStripeCredentialCutover
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Stages a SecretStore reference and performs real provider/target verification under local operator authority; no credential value crosses the API."
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *       - in: path
   *         name: bindingId
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: intentId
   *         required: true
   *         schema: { type: string, format: uuid }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [intentDigest]
   *             additionalProperties: false
   *             properties:
   *               intentDigest: { type: string, pattern: '^sha256:[0-9a-f]{64}$' }
   *     responses:
   *       200: { description: Secret-free persisted cutover, grace, or revocation-ceremony state }
   *       400: { description: Invalid cutover request }
   *       403: { description: Local operator authority or immutable intent mismatch }
   *       409: { description: Provider or runtime target state requires reconciliation }
   */
  router.post(
    '/:id/provider-bindings/:bindingId/rotation-intents/:intentId/advance-cutover',
    requireLocalOperatorBoundary,
    createStripeCutoverAdvanceHandler(rotationService, readWorkspace),
  );

  /**
   * @swagger
   * /api/workspaces/{id}/provider-bindings/{bindingId}/rotation-intents/{intentId}/complete-revocation:
   *   post:
   *     tags: [Provider Bindings]
   *     summary: "SCR-003: Verify human old-key revocation and settle replacement binding"
   *     operationId: completeStripeCredentialRevocation
   *     x-rorca-tier: admin
   *     x-rorca-rationale: "Consumes signed Dashboard revocation evidence and verifies old-key rejection after cutover; local operator authority prevents autonomous revocation."
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *       - in: path
   *         name: bindingId
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: intentId
   *         required: true
   *         schema: { type: string, format: uuid }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [intentDigest, evidence]
   *             additionalProperties: false
   *     responses:
   *       200: { description: Completed secret-free cutover receipt with verified old-key rejection }
   *       400: { description: Invalid signed revocation evidence }
   *       403: { description: Local operator authority or evidence mismatch }
   *       409: { description: Grace, post-cutover verification, or old-key rejection is incomplete }
   */
  router.post(
    '/:id/provider-bindings/:bindingId/rotation-intents/:intentId/complete-revocation',
    requireLocalOperatorBoundary,
    createStripeRevocationCompletionHandler(rotationService, readWorkspace),
  );

  return router;
}

export default createProviderBindingsRouter();
