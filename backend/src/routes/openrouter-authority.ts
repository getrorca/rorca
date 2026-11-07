/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ValidationError } from '../lib/errors';
import { requireLocalOperatorBoundary } from '../lib/local-operator-boundary';
import {
  OpenRouterAuthorityProviderAdapter,
  OpenRouterCreateLimitedKeySchema,
  OpenRouterManagementOperationSchema,
  OpenRouterOperationContextSchema,
  OpenRouterPolicyLimitsSchema,
  disableOpenRouterBinding,
  listRecordedOpenRouterKeys,
  registerOpenRouterBinding,
} from '../lib/openrouter-authority-provider-adapter';
import {
  OpenRouterRuntimeKeyCutoverService,
} from '../lib/openrouter-runtime-key-cutover';
import {
  ExecuteOpenRouterRotationInputSchema,
  OpenRouterRuntimeKeyRotationService,
} from '../lib/openrouter-runtime-key-rotation';
import {
  AcceptOpenRouterRotationPolicyInputSchema,
  ExecuteOpenRouterQualificationInputSchema,
  OpenRouterRuntimeKeyQualificationService,
} from '../lib/openrouter-runtime-key-qualification';

const adapter = new OpenRouterAuthorityProviderAdapter();
const cutoverService = new OpenRouterRuntimeKeyCutoverService(
  new OpenRouterRuntimeKeyRotationService(adapter),
  adapter,
);
const qualificationService = new OpenRouterRuntimeKeyQualificationService(adapter);
const router = Router({ strict: true, caseSensitive: true });
router.use(requireLocalOperatorBoundary);

function parseRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError('OpenRouter authority request is invalid', {
      fields: result.error.issues.map((issue) => issue.path.join('.')).filter(Boolean),
    });
  }
  return result.data;
}

const RegistrationSchema = z.object({
  providerAccountId: z.string().trim().min(1).max(255),
  managementCredential: z.string().trim().min(16).max(1024),
  policyLimits: OpenRouterPolicyLimitsSchema,
  approvedOperations: z.array(OpenRouterManagementOperationSchema).min(1).max(5),
}).strict();

function bodyContext(req: Request) {
  const body = req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body
    : {};
  return parseRequest(OpenRouterOperationContextSchema, {
    workspaceId: req.params.workspaceId,
    bindingId: req.params.bindingId,
    bindingGeneration: body.bindingGeneration,
    providerAccountId: body.providerAccountId,
  });
}

function queryContext(req: Request) {
  return parseRequest(OpenRouterOperationContextSchema, {
    workspaceId: req.params.workspaceId,
    bindingId: req.params.bindingId,
    bindingGeneration: Number(req.query.bindingGeneration),
    providerAccountId: req.query.providerAccountId,
  });
}

/**
 * @swagger
 * /api/openrouter-authority/bindings/{workspaceId}:
 *   post:
 *     summary: Configure a disabled-by-default OpenRouter management binding
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Local operator-only SecretStore ingestion and authority configuration; never MCP-exposed and never returns credential material."
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *     responses:
 *       201: { description: Redacted unverified provider binding }
 *       409: { description: Binding already exists }
 */
router.post('/bindings/:workspaceId', async (req: Request, res: Response) => {
  const input = parseRequest(RegistrationSchema, req.body);
  const binding = await registerOpenRouterBinding({
    workspaceId: String(req.params.workspaceId),
    providerAccountId: input.providerAccountId,
    managementCredential: input.managementCredential,
    policyLimits: input.policyLimits,
    approvedOperations: input.approvedOperations,
    createdBy: req.user?.id ? `operator:${req.user.id}` : 'operator:local',
  });
  res.status(201).json({ binding });
});

/**
 * @swagger
 * /api/openrouter-authority/bindings/{workspaceId}/{bindingId}:
 *   get:
 *     summary: Read one redacted OpenRouter management binding
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Local operator-only binding health and fingerprint metadata; no credential values or provider mutation."
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: path, name: bindingId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Redacted provider binding and recorded key metadata }
 */
router.get('/bindings/:workspaceId/:bindingId', async (req: Request, res: Response) => {
  const context = queryContext(req);
  const binding = await adapter.getProviderBinding(context.workspaceId);
  if (!binding || binding.bindingId !== context.bindingId
      || binding.generation !== context.bindingGeneration
      || binding.providerAccountId !== context.providerAccountId) {
    throw new ValidationError('Exact OpenRouter binding identity is required');
  }
  const keys = await listRecordedOpenRouterKeys(context.workspaceId, context.bindingId);
  res.json({ binding, keys });
});

/**
 * @swagger
 * /api/openrouter-authority/bindings/{workspaceId}/{bindingId}/verify:
 *   post:
 *     summary: Verify management scope and inference rejection
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Local operator-only bounded provider preflight; proves account binding and that the management key cannot perform inference."
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: path, name: bindingId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Healthy redacted provider binding }
 *       422: { description: Provider preflight failed closed }
 */
router.post('/bindings/:workspaceId/:bindingId/verify', async (req: Request, res: Response) => {
  res.json({ binding: await adapter.verify(bodyContext(req)) });
});

/**
 * @swagger
 * /api/openrouter-authority/bindings/{workspaceId}/{bindingId}/disable:
 *   post:
 *     summary: Disable future OpenRouter management operations
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Local operator-only fail-closed authority switch; it does not mutate existing runtime or provider keys."
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: path, name: bindingId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Binding disabled without provider key mutation }
 */
router.post('/bindings/:workspaceId/:bindingId/disable', async (req: Request, res: Response) => {
  const context = bodyContext(req);
  await disableOpenRouterBinding(context.workspaceId, context.bindingId, context.bindingGeneration);
  res.json({ bindingId: context.bindingId, generation: context.bindingGeneration, status: 'disabled' });
});
/**
 * @swagger
 * /api/openrouter-authority/bindings/{workspaceId}/{bindingId}/qualifications:
 *   post:
 *     summary: Run one bounded live OpenRouter qualification
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Local operator-only dedicated-account ceremony; executes redacted lifecycle, inference, denial, crash-recovery, rollback, and cleanup checks within an exact spend grant."
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: path, name: bindingId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       201: { description: Passing redacted qualification receipt; rollout remains disabled }
 *       403: { description: Exact healthy binding, grant, or fixture scope missing }
 *       422: { description: Qualification evidence failed closed }
 */
router.post('/bindings/:workspaceId/:bindingId/qualifications', async (req: Request, res: Response) => {
  const input = parseRequest(ExecuteOpenRouterQualificationInputSchema, req.body);
  if (input.workspaceId !== req.params.workspaceId
      || input.providerBinding.bindingId !== req.params.bindingId) {
    throw new ValidationError('Qualification does not match the exact route binding scope');
  }
  res.status(201).json({ qualification: await qualificationService.qualify(input) });
});

/**
 * @swagger
 * /api/openrouter-authority/bindings/{workspaceId}/{bindingId}/qualifications/{qualificationId}/policy:
 *   post:
 *     summary: Accept rollout policy for one passing qualification
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Local operator-only explicit rollout acceptance; binds one current qualification to one workspace, environment, target, generation, and credit ceiling."
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: path, name: bindingId, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: qualificationId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Accepted exact rotation policy }
 *       403: { description: Qualification or policy binding is stale, altered, or expired }
 */
router.post(
  '/bindings/:workspaceId/:bindingId/qualifications/:qualificationId/policy',
  async (req: Request, res: Response) => {
    const input = parseRequest(AcceptOpenRouterRotationPolicyInputSchema, req.body);
    if (input.workspaceId !== req.params.workspaceId
        || input.providerBinding.bindingId !== req.params.bindingId
        || input.qualificationId !== req.params.qualificationId) {
      throw new ValidationError('Rotation policy does not match the exact route qualification scope');
    }
    res.json({ policy: await qualificationService.acceptPolicy(input) });
  },
);

/**
 * @swagger
 * /api/openrouter-authority/bindings/{workspaceId}/{bindingId}/rotation-rollout:
 *   get:
 *     summary: Read fail-closed OpenRouter rotation availability
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Local operator-only redacted status for exact workspace rollout; absence, expiry, disablement, or stale health always reports unavailable."
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: path, name: bindingId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Redacted policy and computed availability }
 */
router.get('/bindings/:workspaceId/:bindingId/rotation-rollout', async (req: Request, res: Response) => {
  res.json({
    rollout: await qualificationService.status(
      String(req.params.workspaceId),
      String(req.params.bindingId),
    ),
  });
});

/**
 * @swagger
 * /api/openrouter-authority/bindings/{workspaceId}/{bindingId}/qualifications/{qualificationId}/rollback:
 *   post:
 *     summary: Disable rollout and reconcile a qualified disposable fixture
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Local operator-only fail-closed rollback; disables policy first, restores the prior target, revokes replacements, and preserves redacted receipts."
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: path, name: bindingId, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: qualificationId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Redacted rollback receipt }
 *       503: { description: Rollout disabled but fixture cleanup requires reconciliation }
 */
router.post(
  '/bindings/:workspaceId/:bindingId/qualifications/:qualificationId/rollback',
  async (req: Request, res: Response) => {
    const receipt = await qualificationService.rollback({
      qualificationId: String(req.params.qualificationId),
      workspaceId: String(req.params.workspaceId),
      bindingId: String(req.params.bindingId),
    });
    res.json({ rollback: receipt });
  },
);

/**
 * @swagger
 * /api/openrouter-authority/bindings/{workspaceId}/{bindingId}/rotations/execute:
 *   post:
 *     summary: Execute or resume one approved runtime-key rotation cutover
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Local operator-only fenced provider and target mutation; stages SecretStore references, requires real completion evidence, and never returns credential values."
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: path, name: bindingId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Completed redacted cutover or rollback receipt }
 *       202: { description: Durable authorization wait or redacted reconciliation-required checkpoint }
 *       422: { description: Request or durable recovery evidence failed closed }
 */
router.post('/bindings/:workspaceId/:bindingId/rotations/execute', async (req: Request, res: Response) => {
  const input = parseRequest(ExecuteOpenRouterRotationInputSchema, req.body);
  if (input.intent.workspaceId !== req.params.workspaceId
      || input.intent.providerBinding.bindingId !== req.params.bindingId) {
    throw new ValidationError('Rotation intent does not match the exact route binding scope');
  }
  await qualificationService.assertRotationAvailable(input.intent);
  const rotation = await cutoverService.execute(input);
  const requiresReconciliation = rotation.reconciliationReasonCode !== null;
  res.status(rotation.state === 'WAITING_FOR_AUTHORIZATION' || requiresReconciliation ? 202 : 200)
    .json({ rotation });
});


/**
 * @swagger
 * /api/openrouter-authority/bindings/{workspaceId}/{bindingId}/keys:
 *   get:
 *     summary: List OpenRouter key metadata through a redacted DTO
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Local operator-only bounded management read; returns provider resource ids, policy metadata, and fingerprints but never key values."
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: path, name: bindingId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Redacted key metadata }
 */
router.get('/bindings/:workspaceId/:bindingId/keys', async (req: Request, res: Response) => {
  res.json({ keys: await adapter.listKeys(queryContext(req)) });
});

/**
 * @swagger
 * /api/openrouter-authority/bindings/{workspaceId}/{bindingId}/keys:
 *   post:
 *     summary: Create one policy-bounded OpenRouter runtime key
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Local operator-only approved key lifecycle mutation; the created value moves directly into SecretStore and is never returned."
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: path, name: bindingId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       201: { description: Redacted created-key metadata }
 */
router.post('/bindings/:workspaceId/:bindingId/keys', async (req: Request, res: Response) => {
  const context = bodyContext(req);
  const parsedBody = z.record(z.string(), z.unknown()).safeParse(req.body);
  const body = parsedBody.success ? parsedBody.data : {};
  const input = parseRequest(OpenRouterCreateLimitedKeySchema, {
    ...context,
    name: body.name,
    creditLimitUsd: body.creditLimitUsd,
    usageLimit: body.usageLimit ?? null,
    limitReset: body.limitReset ?? null,
  });
  res.status(201).json({ key: await adapter.createLimitedKey(input) });
});

/**
 * @swagger
 * /api/openrouter-authority/bindings/{workspaceId}/{bindingId}/keys/{resourceId}/disable:
 *   post:
 *     summary: Disable one tracked OpenRouter runtime key
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Local operator-only approved mutation of an exactly bound, previously tracked provider resource."
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: path, name: bindingId, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: resourceId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Redacted disabled-key metadata }
 */
router.post('/bindings/:workspaceId/:bindingId/keys/:resourceId/disable', async (req: Request, res: Response) => {
  res.json({ key: await adapter.disableKey(bodyContext(req), String(req.params.resourceId)) });
});

/**
 * @swagger
 * /api/openrouter-authority/bindings/{workspaceId}/{bindingId}/keys/{resourceId}:
 *   delete:
 *     summary: Delete one tracked OpenRouter runtime key
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Local operator-only approved deletion of an exactly bound, previously tracked provider resource."
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: path, name: bindingId, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: resourceId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Redacted deletion acknowledgement }
 */
router.delete('/bindings/:workspaceId/:bindingId/keys/:resourceId', async (req: Request, res: Response) => {
  const context = bodyContext(req);
  await adapter.deleteKey(context, String(req.params.resourceId));
  res.json({ resourceId: req.params.resourceId, status: 'deleted' });
});

export default router;
