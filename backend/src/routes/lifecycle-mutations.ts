/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type Request } from 'express';
import { z, type ZodType } from 'zod';
import { queryOne } from '../db/index';
import { AppError, AuthError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors';
import {
  emitLifecycleInvalidation,
  requireLifecycleIdempotencyKey,
  runIdempotentLifecycleMutation,
} from '../lib/lifecycle-mutations';
import { backfillWorkspacePlans, compileSpecPlan } from '../lib/ssdlc-plan-service';
import { retryPipelineRunHandler } from './pipeline';

const router = Router();

const WorkspaceId = z.string().trim().min(1).max(256);
const SpecId = z.string().trim().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const PreviewHash = z.string().regex(/^sha256:[a-f0-9]{64}$/);

function parseSpecId(value: string): string {
  const parsed = SpecId.safeParse(value);
  if (!parsed.success) throw new ValidationError('specId must be a bounded slug', { field: 'specId' });
  return parsed.data;
}

const RecompileSpecSchema = z.object({
  workspaceId: WorkspaceId,
  expectedSaveGeneration: z.number().int().positive().nullable().optional(),
}).strict();

const RecompileWorkspaceSchema = z.object({
  workspaceId: WorkspaceId,
  cursor: z.string().trim().min(1).max(512).nullable().optional(),
  limit: z.number().int().min(1).max(20).default(20),
}).strict();

const RetryPreviewSchema = z.object({
  workspaceId: WorkspaceId,
  storyIds: z.array(z.string().trim().min(1).max(256)).max(100).optional(),
  forceSequential: z.boolean().optional(),
}).strict();

const RetryDispatchSchema = z.object({
  workspaceId: WorkspaceId,
  previewHash: PreviewHash,
  approvedPreview: z.record(z.string(), z.unknown()),
  previewIdentity: z.object({
    schemaVersion: z.literal('retry-preview-identity.v1'),
    previewHash: PreviewHash,
    originalRunId: z.number().int().positive(),
    expiresAt: z.string().datetime(),
    signature: PreviewHash,
  }).strict(),
  approvalToken: z.string().trim().min(8).max(512).optional(),
}).strict();

function parseBody<T>(schema: ZodType<T>, req: Request): T {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError('Invalid lifecycle mutation body', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return parsed.data;
}

function requirePrincipal(req: Request, admin = false): Express.UserShape {
  if (!req.user) throw new AuthError();
  if (admin && req.user.role !== 'admin') throw new ForbiddenError('Workspace lifecycle backfill requires an admin principal');
  return req.user;
}

async function workspacePath(workspaceId: string): Promise<string> {
  const workspace = await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id = $1', [workspaceId]);
  if (!workspace) throw new NotFoundError('Workspace', workspaceId);
  return workspace.path;
}

async function assertRunWorkspace(runId: number, workspaceId: string): Promise<void> {
  const run = await queryOne<{ id: number }>(
    'SELECT id FROM pipeline_runs WHERE id = $1 AND workspace_id = $2',
    [runId, workspaceId],
  );
  if (!run) throw new NotFoundError('Pipeline run', String(runId));
}

function runId(req: Request): number {
  const value = Number(req.params.runId);
  if (!Number.isSafeInteger(value) || value <= 0) throw new ValidationError('runId must be a positive integer', { field: 'runId' });
  return value;
}

/**
 * @swagger
 * /api/lifecycle/specs/{specId}/recompile:
 *   post:
 *     tags: [Lifecycle]
 *     summary: Idempotently recompile one governed lifecycle plan
 *     operationId: recompileLifecycleSpec
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Compilation mutates a workspace-owned derived plan and is limited to authenticated callers with a durable replay key."
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema: { type: string, minLength: 8, maxLength: 200 }
 *     responses:
 *       200: { description: Compiled plan or idempotently skipped/replayed outcome }
 *       400: { description: Invalid scope or idempotency key }
 *       401: { description: Authentication required }
 *       409: { description: Idempotency conflict }
 *       422: { description: Compilation blocked by invalid or stale canonical input }
 */
router.post('/specs/:specId/recompile', async (req, res, next) => {
  try {
    requirePrincipal(req);
    const body = parseBody(RecompileSpecSchema, req);
    const specId = parseSpecId(req.params.specId);
    const idempotencyKey = requireLifecycleIdempotencyKey(req.get('Idempotency-Key'));
    const path = await workspacePath(body.workspaceId);
    const result = await runIdempotentLifecycleMutation({
      workspaceId: body.workspaceId,
      operation: `recompile:${specId}`,
      idempotencyKey,
      request: { specId, ...body },
      mutate: async () => {
        try {
          const outcome = await compileSpecPlan({
            workspaceId: body.workspaceId,
            workspacePath: path,
            specSlug: specId,
            expectedSaveGeneration: body.expectedSaveGeneration,
            source: 'lazy-compile',
          });
          // Publish even when compilation is now a skip: this repairs the narrow
          // crash window where plan commit succeeded before WAL/SSE publication.
          await emitLifecycleInvalidation({ workspaceId: body.workspaceId, specId, changeKind: 'plan_recompiled' });
          return outcome;
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          const outcome = {
            status: 'failed' as const,
            specSlug: specId,
            code: error.code ?? 'PLAN_COMPILATION_FAILED',
            message: error.message,
            retryable: true as const,
          };
          await emitLifecycleInvalidation({ workspaceId: body.workspaceId, specId, changeKind: 'plan_compilation_failed' });
          return outcome;
        }
      },
    });
    res.status(result.responseStatus).json({ ...result.value, replayed: result.replayed });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/lifecycle/recompile:
 *   post:
 *     tags: [Lifecycle]
 *     summary: Recompile one bounded page of workspace lifecycle plans
 *     operationId: recompileLifecycleWorkspacePage
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "A bounded workspace scan is operator maintenance and requires admin identity plus a durable replay key."
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema: { type: string, minLength: 8, maxLength: 200 }
 *     responses:
 *       200: { description: Bounded compiled, skipped, and failed outcomes with cursor }
 *       401: { description: Authentication required }
 *       403: { description: Admin principal required }
 *       409: { description: Idempotency conflict }
 */
router.post('/recompile', async (req, res, next) => {
  try {
    requirePrincipal(req, true);
    const body = parseBody(RecompileWorkspaceSchema, req);
    const idempotencyKey = requireLifecycleIdempotencyKey(req.get('Idempotency-Key'));
    const path = await workspacePath(body.workspaceId);
    const result = await runIdempotentLifecycleMutation({
      workspaceId: body.workspaceId,
      operation: 'recompile-workspace-page',
      idempotencyKey,
      request: body,
      mutate: async () => {
        const outcome = await backfillWorkspacePlans({
          workspaceId: body.workspaceId,
          workspacePath: path,
          cursor: body.cursor,
          limit: body.limit,
        });
        await emitLifecycleInvalidation({ workspaceId: body.workspaceId, changeKind: 'plans_backfilled' });
        return outcome;
      },
    });
    res.json({ ...result.value, replayed: result.replayed });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/lifecycle/runs/{runId}/retry-preview:
 *   post:
 *     tags: [Lifecycle]
 *     summary: Read the exact expiring governed retry packet without mutation
 *     operationId: previewLifecycleRetry
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Retry scope and run policy are sensitive workspace metadata; authenticated preview is read-only and cannot enqueue work."
 *     responses:
 *       200: { description: Exact self-verifying retry packet and unexpired identity }
 *       401: { description: Authentication required }
 *       404: { description: Workspace-scoped run not found }
 *       409: { description: Run state or reconciled scope is not retryable }
 */
router.post('/runs/:runId/retry-preview', async (req, res, next) => {
  try {
    requirePrincipal(req);
    const body = parseBody(RetryPreviewSchema, req);
    const id = runId(req);
    await assertRunWorkspace(id, body.workspaceId);
    req.body = {
      storyIds: body.storyIds,
      forceSequential: body.forceSequential,
      safeMode: true,
    };
    await retryPipelineRunHandler(req, res);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/lifecycle/runs/{runId}/retry-dispatch:
 *   post:
 *     tags: [Lifecycle]
 *     summary: Dispatch one unexpired approved retry packet through the canonical queue
 *     operationId: dispatchLifecycleRetry
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Dispatch creates a workspace-owned retry run only after exact packet, expiry, policy, and replay validation."
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema: { type: string, minLength: 8, maxLength: 200 }
 *     responses:
 *       201: { description: Retry submitted to the existing pipeline retry queue }
 *       200: { description: Exact dispatch replay returned without another run }
 *       401: { description: Authentication required }
 *       403: { description: Existing approval path required }
 *       409: { description: Expired, stale, mismatched, or replay-conflicting preview }
 *       503: { description: Existing retry queue unavailable }
 */
router.post('/runs/:runId/retry-dispatch', async (req, res, next) => {
  try {
    requirePrincipal(req);
    const body = parseBody(RetryDispatchSchema, req);
    requireLifecycleIdempotencyKey(req.get('Idempotency-Key'));
    const id = runId(req);
    await assertRunWorkspace(id, body.workspaceId);
    req.body = {
      previewHash: body.previewHash,
      approvedPreview: body.approvedPreview,
      previewIdentity: body.previewIdentity,
      approvalToken: body.approvalToken,
      safeMode: true,
    };
    await retryPipelineRunHandler(req, res);
  } catch (error) {
    next(error);
  }
});

export default router;
