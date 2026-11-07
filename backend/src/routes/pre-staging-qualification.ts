/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireWorkspaceAdmin } from '../lib/auth-utils';
import { AuthError, ValidationError } from '../lib/errors';
import {
  listPreStagingQualifications,
  previewPreStagingQualification,
  runPreStagingQualification,
} from '../lib/pre-staging-qualification';

const router = Router();
const WorkspaceId = z.string().trim().min(1).max(256);
const SpecId = z.string().trim().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const Sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const RunId = z.coerce.number().int().positive().safe();
const PreviewQuery = z.object({ workspaceId: WorkspaceId, runId: RunId.optional() }).strict();
const RunBody = z.object({ workspaceId: WorkspaceId, previewHash: Sha256, runId: RunId.optional() }).strict();
const HistoryQuery = z.object({ workspaceId: WorkspaceId, limit: z.coerce.number().int().min(1).max(100).optional() }).strict();

function parseBoundary<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new ValidationError('Invalid pre-staging qualification request', {
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  });
}

function specId(req: Request): string {
  return parseBoundary(SpecId, req.params.specId);
}

function principal(req: Request): Express.UserShape {
  if (!req.user) throw new AuthError();
  return req.user;
}

function idempotencyKey(req: Request): string {
  const value = req.get('Idempotency-Key')?.trim();
  if (!value) throw new ValidationError('Idempotency-Key header is required', { field: 'Idempotency-Key' });
  return value;
}

/**
 * @swagger
 * /api/lifecycle/specs/{specId}/pre-staging-qualification/preview:
 *   get:
 *     summary: Preview repository-declared pre-staging qualification
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Reads local Git and repository command declarations for the selected workspace; local workspace administrators only."
 *     parameters:
 *       - { in: path, name: specId, required: true, schema: { type: string } }
 *       - { in: query, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: query, name: runId, required: false, schema: { type: integer } }
 *     responses:
 *       200: { description: Exact-revision qualification preview }
 *       401: { description: Authentication required }
 *       403: { description: Workspace administration required }
 */
router.get('/specs/:specId/pre-staging-qualification/preview', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    principal(req);
    const query = parseBoundary(PreviewQuery, req.query);
    res.json(await previewPreStagingQualification({ workspaceId: query.workspaceId, specId: specId(req), ...(query.runId ? { runId: query.runId } : {}) }));
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/lifecycle/specs/{specId}/pre-staging-qualification/run:
 *   post:
 *     summary: Execute preview-bound pre-staging qualification
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Executes repository-owned verification commands in an isolated local worktree and persists append-only evidence; local operator only."
 *     parameters:
 *       - { in: path, name: specId, required: true, schema: { type: string } }
 *       - { in: header, name: Idempotency-Key, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [workspaceId, previewHash]
 *             properties:
 *               workspaceId:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 256
 *               previewHash:
 *                 type: string
 *                 pattern: '^sha256:[a-f0-9]{64}$'
 *               runId:
 *                 type: integer
 *                 minimum: 1
 *     responses:
 *       201: { description: Qualification receipt }
 *       409: { description: Preview or idempotency conflict }
 *       422: { description: Qualification precondition blocked }
 *       401: { description: Authentication required }
 *       403: { description: Workspace administration required }
 */
router.post('/specs/:specId/pre-staging-qualification/run', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    const actor = principal(req);
    const body = parseBoundary(RunBody, req.body ?? {});
    const result = await runPreStagingQualification({
      workspaceId: body.workspaceId,
      specId: specId(req),
      previewHash: body.previewHash,
      idempotencyKey: idempotencyKey(req),
      actorId: actor.id,
      ...(body.runId ? { runId: body.runId } : {}),
    });
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/lifecycle/specs/{specId}/pre-staging-qualifications:
 *   get:
 *     summary: List immutable pre-staging qualification receipts
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Returns local operator qualification receipts with bounded command-output excerpts; local workspace administrators only."
 *     parameters:
 *       - { in: path, name: specId, required: true, schema: { type: string } }
 *       - { in: query, name: workspaceId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Qualification receipt history }
 *       401: { description: Authentication required }
 *       403: { description: Workspace administration required }
 */
router.get('/specs/:specId/pre-staging-qualifications', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    principal(req);
    const query = parseBoundary(HistoryQuery, req.query);
    res.json({ items: await listPreStagingQualifications({ workspaceId: query.workspaceId, specId: specId(req), limit: query.limit }) });
  } catch (error) {
    next(error);
  }
});

export default router;
