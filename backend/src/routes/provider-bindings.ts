/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  CoolifyAuthorityProviderAdapter,
  CreateCoolifyBindingRequestSchema,
  CreateCoolifyBindingSchema,
} from '../lib/coolify-authority-provider-adapter';
import {
  CoolifyProviderBindingSchema,
  DeploymentCapabilitySchema,
  StagingDeploymentRequestSchema,
  type CoolifyProviderBinding,
  type StagingDeploymentResult,
} from '../lib/authority-provider-adapter';
import {
  CoolifyProductionDeploymentService,
  ProductionDeploymentRequestSchema,
  type ProductionDeploymentResult,
} from '../lib/production-deployment';
import { NotFoundError, UnprocessableError, ValidationError } from '../lib/errors';
import { requireLocalOperatorBoundary } from '../lib/local-operator-boundary';
import { CoolifyStagingDeploymentService } from '../lib/coolify-staging-deployment';

export type ProviderBindingsAdapter = Pick<CoolifyAuthorityProviderAdapter,
  | 'createProviderBinding'
  | 'getProviderBinding'
  | 'revalidateProviderBinding'
  | 'preflight'
  | 'acquireLease'
  | 'disableProviderBinding'
  | 'dispatchAuthorizedProduction'
  | 'observeProductionAction'
  | 'dispatchProductionAction'
  | 'reconcileProductionAction'
  | 'revokeProductionActionLease'>;
export interface CreateProviderBindingResponse {
  binding: CoolifyProviderBinding;
}
export type StagingDeploymentRunner = Pick<CoolifyStagingDeploymentService, 'deploy' | 'reconcile'>;
export interface StagingDeploymentResponse {
  result: StagingDeploymentResult;
}
export type ProductionDeploymentRunner = Pick<CoolifyProductionDeploymentService, 'deploy' | 'reconcile'>;
export interface ProductionDeploymentResponse {
  result: ProductionDeploymentResult;
}


const BindingLocatorSchema = z.object({
  workspaceId: z.string().min(1).max(255),
  bindingId: z.string().uuid(),
}).strict();
const PreflightSchema = z.object({
  workspaceId: z.string().min(1).max(255),
  action: DeploymentCapabilitySchema,
  bindingGeneration: z.number().int().positive().optional(),
}).strict();
const LeaseSchema = PreflightSchema.extend({
  bindingGeneration: z.number().int().positive(),
  operationId: z.string().uuid(),
  requestedSeconds: z.number().int().min(30).max(3600).optional(),
}).strict();
const DisableSchema = z.object({
  workspaceId: z.string().min(1).max(255),
  reason: z.string().trim().min(1).max(500),
}).strict();
const ReconcileStagingDeploymentSchema = z.object({
  workspaceId: z.string().min(1).max(255),
  operationId: z.string().uuid(),
}).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError('Invalid provider binding request', {
      fields: result.error.issues.map((issue) => issue.path.join('.')).filter(Boolean),
    });
  }
  return result.data;
}

function redactedCoolifyBinding(value: unknown): CoolifyProviderBinding {
  const result = CoolifyProviderBindingSchema.safeParse(value);
  if (!result.success) {
    throw new UnprocessableError(
      'Provider binding projection failed redaction',
      'PROVIDER_BINDING_REDACTION_FAILED',
    );
  }
  return result.data;
}
export async function createProviderBindingResponse(
  adapter: Pick<ProviderBindingsAdapter, 'createProviderBinding'>,
  userId: string | undefined,
  requestBody: unknown,
): Promise<CreateProviderBindingResponse> {
  if (!userId) throw new ValidationError('Authenticated local user is required');
  const body = parse(CreateCoolifyBindingRequestSchema, requestBody);
  const input = CreateCoolifyBindingSchema.parse({ ...body, userId });
  return { binding: redactedCoolifyBinding(await adapter.createProviderBinding(input)) };
}

export async function createStagingDeploymentResponse(
  service: StagingDeploymentRunner,
  requestBody: unknown,
): Promise<StagingDeploymentResponse> {
  const request = parse(StagingDeploymentRequestSchema, requestBody);
  return { result: await service.deploy(request) };
}

export async function createProductionDeploymentResponse(
  service: ProductionDeploymentRunner,
  localOperatorId: string | undefined,
  requestBody: unknown,
): Promise<ProductionDeploymentResponse> {
  const request = parse(ProductionDeploymentRequestSchema, requestBody);
  return { result: await service.deploy(request, localOperatorId) };
}

export async function reconcileStagingDeploymentResponse(
  service: StagingDeploymentRunner,
  workspaceId: unknown,
  operationId: unknown,
): Promise<StagingDeploymentResponse> {
  const locator = parse(ReconcileStagingDeploymentSchema, { workspaceId, operationId });
  return { result: await service.reconcile(locator.workspaceId, locator.operationId) };
}

export async function reconcileProductionDeploymentResponse(
  service: ProductionDeploymentRunner,
  workspaceId: unknown,
  operationId: unknown,
): Promise<ProductionDeploymentResponse> {
  const locator = parse(ReconcileStagingDeploymentSchema, { workspaceId, operationId });
  return { result: await service.reconcile(locator.workspaceId, locator.operationId) };
}


export function createProviderBindingsRouter(
  adapter: ProviderBindingsAdapter = new CoolifyAuthorityProviderAdapter(),
  operatorBoundary: RequestHandler = requireLocalOperatorBoundary,
  stagingDeploymentService: StagingDeploymentRunner = new CoolifyStagingDeploymentService(),
  productionDeploymentService: ProductionDeploymentRunner =
    new CoolifyProductionDeploymentService(adapter),
): Router {
  const router = Router({ strict: true, caseSensitive: true });
  router.use(operatorBoundary);

  /**
   * @swagger
   * /api/authority/provider-bindings:
   *   post:
   *     summary: Create and provider-verify an immutable deployment binding
   *     x-rorca-native-api: true
   *     x-rorca-native-authority: local-admin
   *     x-rorca-rationale: "Creates an operator-owned provider binding and encrypted SecretStore entry; mutating provider control configuration is never MCP-callable."
   *     responses:
   *       201: { description: Redacted verified binding profile }
   *       422: { description: Exact target or capability probe failed }
   */
  router.post('/provider-bindings', async (req: Request, res: Response) => {
    res.status(201).json(await createProviderBindingResponse(adapter, req.user?.id, req.body));
  });

  /**
   * @swagger
   * /api/authority/provider-bindings/{bindingId}:
   *   get:
   *     summary: Read a redacted immutable provider binding projection
   *     x-rorca-native-api: true
   *     x-rorca-native-authority: local-admin
   *     x-rorca-rationale: "Reads provider identity, policy, profile, and an opaque SecretStore reference for the local operator; returns no credential material."
   *     parameters:
   *       - { in: path, name: bindingId, required: true, schema: { type: string, format: uuid } }
   *     responses:
   *       200: { description: Redacted binding projection }
   *       404: { description: Binding absent }
   */
  router.get('/provider-bindings/:bindingId', async (req: Request, res: Response) => {
    const locator = parse(BindingLocatorSchema, {
      workspaceId: req.query.workspaceId,
      bindingId: req.params.bindingId,
    });
    const binding = await adapter.getProviderBinding(locator.workspaceId, { bindingId: locator.bindingId });
    if (!binding) throw new NotFoundError('Provider binding not found');
    res.json({ binding: redactedCoolifyBinding(binding) });
  });

  /**
   * @swagger
   * /api/authority/provider-bindings/{bindingId}/revalidate:
   *   post:
   *     summary: Revalidate exact provider identity and capability scope
   *     x-rorca-native-api: true
   *     x-rorca-native-authority: local-admin
   *     x-rorca-rationale: "Performs a bounded operator-requested provider probe using a trusted SecretStore resolution and returns only a redacted profile."
   *     parameters:
   *       - { in: path, name: bindingId, required: true, schema: { type: string, format: uuid } }
   *     responses:
   *       200: { description: Current redacted verified profile }
   *       422: { description: Provider preflight failed closed }
   */
  router.post('/provider-bindings/:bindingId/revalidate', async (req: Request, res: Response) => {
    const locator = parse(BindingLocatorSchema, {
      workspaceId: req.body?.workspaceId,
      bindingId: req.params.bindingId,
    });
    const binding = redactedCoolifyBinding(
      await adapter.revalidateProviderBinding(locator.workspaceId, locator.bindingId),
    );
    res.json({ binding });
  });

  /**
   * @swagger
   * /api/authority/provider-bindings/{bindingId}/preflight:
   *   post:
   *     summary: Fail-closed deployment binding preflight
   *     x-rorca-native-api: true
   *     x-rorca-native-authority: local-admin
   *     x-rorca-rationale: "Checks current exact target identity, environment isolation, generation, token scope, and allowed action before any deployment lease."
   *     parameters:
   *       - { in: path, name: bindingId, required: true, schema: { type: string, format: uuid } }
   *     responses:
   *       200: { description: Redacted preflight profile }
   *       422: { description: Binding is unsafe or stale }
   */
  router.post('/provider-bindings/:bindingId/preflight', async (req: Request, res: Response) => {
    const body = parse(PreflightSchema, req.body);
    const bindingId = parse(z.string().uuid(), req.params.bindingId);
    const binding = redactedCoolifyBinding(await adapter.preflight({ ...body, bindingId }));
    res.json({ ready: true, binding });
  });

  /**
   * @swagger
   * /api/authority/provider-bindings/{bindingId}/leases:
   *   post:
   *     summary: Acquire a bounded generation-fenced deployment lease
   *     x-rorca-native-api: true
   *     x-rorca-native-authority: local-admin
   *     x-rorca-rationale: "Issues a single-operation deployment lease only after current trusted preflight; provider actuation remains outside this lifecycle route."
   *     parameters:
   *       - { in: path, name: bindingId, required: true, schema: { type: string, format: uuid } }
   *     responses:
   *       201: { description: Bounded lease projection }
   *       409: { description: Duplicate operation lease }
   *       422: { description: Binding cannot issue a lease }
   */
  router.post('/provider-bindings/:bindingId/leases', async (req: Request, res: Response) => {
    const body = parse(LeaseSchema, req.body);
    const bindingId = parse(z.string().uuid(), req.params.bindingId);
    const lease = await adapter.acquireLease({ ...body, bindingId });
    res.status(201).json({ lease });
  });

  /**
   * @swagger
   * /api/authority/staging-deployments:
   *   post:
   *     summary: Dispatch or resume an exact generation-fenced staging deployment
   *     x-rorca-native-api: true
   *     x-rorca-native-authority: local-admin
   *     x-rorca-rationale: "Uses a trusted staging-only provider adapter and bounded single-operation lease; mutating provider control is local operator-only and never MCP-callable."
   *     responses:
   *       201: { description: Immutable terminal staging execution receipt }
   *       202: { description: Waiting for authorization or provider reconciliation }
   *       422: { description: Exact target, revision, generation, or health preflight failed }
   */
  router.post('/staging-deployments', async (req: Request, res: Response) => {
    const response = await createStagingDeploymentResponse(stagingDeploymentService, req.body);
    res.status(response.result.status === 'settled' ? 201 : 202).json(response);
  });

  /**
   * @swagger
   * /api/authority/production-deployments:
   *   post:
   *     summary: Authorize and dispatch an exact protected production deployment
   *     x-rorca-native-api: true
   *     x-rorca-native-authority: local-admin
   *     x-rorca-rationale: "Evaluates immutable release, CI, reviewed external-gate, replay, and change-window authority before the trusted adapter can resolve production credentials; mutating provider control is local operator-only."
   *     responses:
   *       201: { description: Exact authorized production deployment accepted }
   *       202: { description: Typed authorization or change-window wait }
   *       403: { description: Production dispatch authority is stale or invalid }
   */
  router.post('/production-deployments', async (req: Request, res: Response) => {
    const response = await createProductionDeploymentResponse(
      productionDeploymentService,
      req.user?.id,
      req.body,
    );
    res.status(response.result.status === 'dispatched' ? 201 : 202).json(response);
  });

  /**
   * @swagger
   * /api/authority/production-deployments/{operationId}/reconcile:
   *   post:
   *     summary: Reconcile and advance an exact protected production rollout
   *     x-rorca-native-api: true
   *     x-rorca-native-authority: local-admin
   *     x-rorca-rationale: "Observes only persisted provider action ids, deterministically evaluates declared health evidence, and advances or rolls back through generation-fenced local operator authority."
   *     parameters:
   *       - { in: path, name: operationId, required: true, schema: { type: string, format: uuid } }
   *     responses:
   *       200: { description: Immutable terminal production rollout receipt }
   *       202: { description: Canary, expansion, or rollback requires further reconciliation }
   *       409: { description: Rollout checkpoint or provider lineage conflicts }
   */
  router.post('/production-deployments/:operationId/reconcile', async (req: Request, res: Response) => {
    const response = await reconcileProductionDeploymentResponse(
      productionDeploymentService,
      req.body?.workspaceId,
      req.params.operationId,
    );
    res.status(response.result.status === 'settled' ? 200 : 202).json(response);
  });

  /**
   * @swagger
   * /api/authority/staging-deployments/{operationId}/reconcile:
   *   post:
   *     summary: Reconcile an accepted staging deployment without redispatch
   *     x-rorca-native-api: true
   *     x-rorca-native-authority: local-admin
   *     x-rorca-rationale: "Observes a previously accepted provider deployment id, settles one redacted receipt, and cannot initiate a new provider mutation."
   *     parameters:
   *       - { in: path, name: operationId, required: true, schema: { type: string, format: uuid } }
   *     responses:
   *       200: { description: Reconciled terminal execution receipt }
   *       202: { description: Provider outcome remains pending }
   *       409: { description: No accepted provider deployment exists }
   */
  router.post('/staging-deployments/:operationId/reconcile', async (req: Request, res: Response) => {
    const response = await reconcileStagingDeploymentResponse(
      stagingDeploymentService,
      req.body?.workspaceId,
      req.params.operationId,
    );
    res.status(response.result.status === 'settled' ? 200 : 202).json(response);
  });

  /**
   * @swagger
   * /api/authority/provider-bindings/{bindingId}/disable:
   *   post:
   *     summary: Disable a provider binding and reconcile active leases
   *     x-rorca-native-api: true
   *     x-rorca-native-authority: local-admin
   *     x-rorca-rationale: "Stops new deploy authority and atomically marks existing attempts for revocation or reconciliation; local operator-only and never MCP-callable."
   *     parameters:
   *       - { in: path, name: bindingId, required: true, schema: { type: string, format: uuid } }
   *     responses:
   *       200: { description: Disabled binding and lease reconciliation counts }
   *       404: { description: Binding absent }
   */
  router.post('/provider-bindings/:bindingId/disable', async (req: Request, res: Response) => {
    const body = parse(DisableSchema, req.body);
    const bindingId = parse(z.string().uuid(), req.params.bindingId);
    const result = await adapter.disableProviderBinding(body.workspaceId, bindingId, body.reason);
    res.json({
      binding: redactedCoolifyBinding(result.binding),
      revoked: result.revoked,
      revocationRequired: result.revocationRequired,
      reconciliationRequired: result.reconciliationRequired,
    });
  });

  return router;
}

export default createProviderBindingsRouter();
