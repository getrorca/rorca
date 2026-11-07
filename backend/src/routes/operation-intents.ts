/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../lib/errors';
import { requireLocalOperatorBoundary } from '../lib/local-operator-boundary';
import { CreateReleaseIntentSchema } from '../lib/release-intent';
import {
  PostgresReleaseIntentStore,
  type ReleaseIntentStore,
} from '../lib/release-intent-store';

const OperationIntentLocatorSchema = z.object({
  workspaceId: z.string().min(1).max(255),
  operationIntentId: z.string().uuid(),
}).strict();
const ValidateOperationIntentSchema = z.object({
  workspaceId: z.string().min(1).max(255),
  grantId: z.string().uuid(),
}).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError('Invalid operation intent request', {
      fields: result.error.issues.map((issue) => issue.path.join('.')).filter(Boolean),
    });
  }
  return result.data;
}

export async function createOperationIntentResponse(
  store: Pick<ReleaseIntentStore, 'create'>,
  createdBy: string | undefined,
  body: unknown,
) {
  if (!createdBy) throw new ValidationError('Authenticated local user is required');
  const input = parse(CreateReleaseIntentSchema, body);
  return { operationIntent: await store.create(input, createdBy) };
}

export async function readOperationIntentResponse(
  store: Pick<ReleaseIntentStore, 'get'>,
  workspaceId: unknown,
  operationIntentId: unknown,
) {
  const locator = parse(OperationIntentLocatorSchema, { workspaceId, operationIntentId });
  const operationIntent = await store.get(locator.workspaceId, locator.operationIntentId);
  if (!operationIntent) throw new NotFoundError('Release operation intent', locator.operationIntentId);
  return { operationIntent };
}

export async function validateOperationIntentResponse(
  store: Pick<ReleaseIntentStore, 'validate'>,
  operationIntentId: unknown,
  body: unknown,
) {
  const request = parse(ValidateOperationIntentSchema, body);
  const locator = parse(z.string().uuid(), operationIntentId);
  return {
    validation: await store.validate(request.workspaceId, locator, request.grantId),
  };
}

export function createOperationIntentsRouter(
  store: ReleaseIntentStore = new PostgresReleaseIntentStore(),
  operatorBoundary: RequestHandler = requireLocalOperatorBoundary,
): Router {
  const router = Router({ strict: true, caseSensitive: true });
  router.use(operatorBoundary);

  /**
   * @swagger
   * /api/authority/operation-intents:
   *   post:
   *     summary: Create an immutable versioned release OperationIntent
   *     x-rorca-native-api: true
   *     x-rorca-native-authority: local-admin
   *     x-rorca-rationale: "Persists production release authority material and provenance for the local operator; no provider actuation or credential resolution occurs."
   *     responses:
   *       201: { description: Redacted immutable OperationIntent projection }
   *       400: { description: Release material or provenance is invalid }
   */
  router.post('/operation-intents', async (req: Request, res: Response) => {
    res.status(201).json(await createOperationIntentResponse(store, req.user?.id, req.body));
  });

  /**
   * @swagger
   * /api/authority/operation-intents/{operationIntentId}:
   *   get:
   *     summary: Read a redacted immutable release OperationIntent projection
   *     x-rorca-native-api: true
   *     x-rorca-native-authority: local-admin
   *     x-rorca-rationale: "Reads only strict release inputs, digest-only provenance, and immutable record metadata for the local operator; environment secret values are not stored or projected."
   *     parameters:
   *       - { in: path, name: operationIntentId, required: true, schema: { type: string, format: uuid } }
   *     responses:
   *       200: { description: Redacted immutable OperationIntent projection }
   *       404: { description: OperationIntent absent }
   */
  router.get('/operation-intents/:operationIntentId', async (req: Request, res: Response) => {
    res.json(await readOperationIntentResponse(
      store,
      req.query.workspaceId,
      req.params.operationIntentId,
    ));
  });

  /**
   * @swagger
   * /api/authority/operation-intents/{operationIntentId}/validate:
   *   post:
   *     summary: Validate an immutable grant against exact release and CI evidence digests
   *     x-rorca-native-api: true
   *     x-rorca-native-authority: local-admin
   *     x-rorca-rationale: "Checks a persisted local authority grant without resolving production credentials or trusting caller-supplied evidence."
   *     parameters:
   *       - { in: path, name: operationIntentId, required: true, schema: { type: string, format: uuid } }
   *     responses:
   *       200: { description: Exact digest-bound validation projection }
   *       403: { description: Grant binds another intent or CI evidence }
   *       404: { description: OperationIntent or grant absent }
   */
  router.post('/operation-intents/:operationIntentId/validate', async (req: Request, res: Response) => {
    res.json(await validateOperationIntentResponse(store, req.params.operationIntentId, req.body));
  });

  return router;
}

export default createOperationIntentsRouter();
