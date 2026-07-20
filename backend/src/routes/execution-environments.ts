/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../lib/validate';
import { handleRouteError } from '../lib/async-handler';
import { ConflictError, ValidationError } from '../lib/errors';
import {
  authenticateRunner,
  getExecutionEnvironmentById,
  getExecutionEnvironmentReadiness,
  listExecutionEnvironments,
  recordRunnerHeartbeat,
  setRunnerToken,
  upsertExecutionEnvironment,
} from '../lib/execution-environment-registry';
import {
  claimNextRunnerJob,
  completeRunnerJob,
  markRunnerJobRunning,
  revalidateRunnerJobPolicy,
  serializeRunnerJob,
} from '../lib/execution-runner-jobs';

const router = Router();

const AgentSchema = z.enum(['claude', 'codex', 'opencode', 'pi']);

const UpsertEnvironmentSchema = z.object({
  label: z.string().min(1),
  kind: z.enum(['remote-rorca', 'local-runner', 'ci-runner']),
  networkMode: z.enum(['local', 'tailscale', 'ssh-tunnel', 'public-https']).optional(),
  enabled: z.boolean().optional(),
  supportedAgents: z.array(AgentSchema).optional(),
  allowedWorkspaceIds: z.array(z.string()).optional(),
  secretProfileId: z.string().nullable().optional(),
  maxConcurrency: z.number().int().min(1).max(32).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const RunnerTokenSchema = z.object({
  token: z.string().min(24),
  registrationToken: z.string().optional(),
});

const RunnerHeartbeatSchema = z.object({
  runnerId: z.string().min(1),
  workspacePath: z.string().optional(),
  networkMode: z.string().optional(),
  agents: z.record(z.string(), z.object({
    installed: z.boolean(),
    credentialsReady: z.boolean(),
    version: z.string().optional(),
  })).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const RunnerPollSchema = z.object({
  runnerId: z.string().min(1),
});

const CompleteJobSchema = z.object({
  runnerId: z.string().min(1),
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});

function paramValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function runnerTokenFromRequest(req: Request): string {
  const auth = req.headers.authorization;
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice('bearer '.length).trim();
  const header = req.headers['x-rorca-runner-token'];
  if (Array.isArray(header)) return header[0] ?? '';
  return typeof header === 'string' ? header : '';
}

async function authenticateRunnerRequest(req: Request) {
  const token = runnerTokenFromRequest(req);
  if (!token) throw new ValidationError('Missing runner token');
  return authenticateRunner(paramValue(req.params.id), token);
}

/**
 * @swagger
 * /api/execution-environments:
 *   get:
 *     summary: List execution environments
 *     responses:
 *       200: { description: OK }
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const environments = await listExecutionEnvironments();
    const readiness = await Promise.all(environments.map((env) => getExecutionEnvironmentReadiness(env.id)));
    res.json({ environments: readiness });
  } catch (err) {
    handleRouteError(res, err);
  }
});

/**
 * @swagger
 * /api/execution-environments/{id}/readiness:
 *   get:
 *     summary: Get execution environment readiness
 *     responses:
 *       200: { description: OK }
 */
router.get('/:id/readiness', async (req: Request, res: Response) => {
  try {
    res.json({ environment: await getExecutionEnvironmentReadiness(paramValue(req.params.id)) });
  } catch (err) {
    handleRouteError(res, err);
  }
});

/**
 * @swagger
 * /api/execution-environments/{id}:
 *   put:
 *     summary: Upsert an execution environment
 *     responses:
 *       200: { description: OK }
 */
router.put('/:id', validateBody(UpsertEnvironmentSchema), async (req: Request, res: Response) => {
  try {
    const env = await upsertExecutionEnvironment({ id: paramValue(req.params.id), ...req.body });
    res.json({ environment: env, readiness: await getExecutionEnvironmentReadiness(env.id) });
  } catch (err) {
    handleRouteError(res, err);
  }
});

/**
 * @swagger
 * /api/execution-environments/{id}/runner-token:
 *   post:
 *     summary: Set runner token for an execution environment
 *     responses:
 *       200: { description: OK }
 */
router.post('/:id/runner-token', validateBody(RunnerTokenSchema), async (req: Request, res: Response) => {
  try {
    const requiredRegistrationToken = process.env.RORCA_RUNNER_REGISTRATION_TOKEN?.trim();
    if (requiredRegistrationToken && req.body.registrationToken !== requiredRegistrationToken) {
      throw new ConflictError('invalid_runner_registration_token');
    }
    const environmentId = paramValue(req.params.id);
    await getExecutionEnvironmentById(environmentId);
    await setRunnerToken(environmentId, req.body.token);
    res.json({ ok: true });
  } catch (err) {
    handleRouteError(res, err);
  }
});

/**
 * @swagger
 * /api/execution-environments/{id}/runner/heartbeat:
 *   post:
 *     summary: Runner heartbeat and capability report
 *     responses:
 *       200: { description: OK }
 */
router.post('/:id/runner/heartbeat', validateBody(RunnerHeartbeatSchema), async (req: Request, res: Response) => {
  try {
    await authenticateRunnerRequest(req);
    const environmentId = paramValue(req.params.id);
    await recordRunnerHeartbeat(environmentId, req.body);
    res.json({ ok: true, environment: await getExecutionEnvironmentReadiness(environmentId) });
  } catch (err) {
    handleRouteError(res, err);
  }
});

/**
 * @swagger
 * /api/execution-environments/{id}/runner/poll:
 *   post:
 *     summary: Claim next job for an outbound runner
 *     responses:
 *       200: { description: OK }
 */
router.post('/:id/runner/poll', validateBody(RunnerPollSchema), async (req: Request, res: Response) => {
  try {
    await authenticateRunnerRequest(req);
    const job = await claimNextRunnerJob(paramValue(req.params.id), req.body.runnerId);
    res.json({ job: job ? serializeRunnerJob(job) : null });
  } catch (err) {
    handleRouteError(res, err);
  }
});

/**
 * @swagger
 * /api/execution-environments/{id}/runner/jobs/{jobId}/running:
 *   post:
 *     summary: Mark a claimed runner job as running
 *     responses:
 *       200: { description: OK }
 */
router.post('/:id/runner/jobs/:jobId/running', validateBody(RunnerPollSchema), async (req: Request, res: Response) => {
  try {
    await authenticateRunnerRequest(req);
    const job = await markRunnerJobRunning(paramValue(req.params.jobId), req.body.runnerId);
    res.json({ job: serializeRunnerJob(job) });
  } catch (err) {
    handleRouteError(res, err);
  }
});

/**
 * @swagger
 * /api/execution-environments/{id}/runner/jobs/{jobId}/revalidate:
 *   post:
 *     summary: Revalidate governed execution policy immediately before local spawn
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Runner pre-spawn fencing is an operator execution boundary and must not be MCP exposed."
 *     responses:
 *       200: { description: Current effective policy fence }
 */
router.post('/:id/runner/jobs/:jobId/revalidate', validateBody(RunnerPollSchema), async (req: Request, res: Response) => {
  try {
    await authenticateRunnerRequest(req);
    const policy = await revalidateRunnerJobPolicy(paramValue(req.params.jobId), req.body.runnerId);
    res.json({
      allowed: policy.allowed,
      status: policy.status,
      effective: policy.effective,
      fence: policy.fence,
      receipt: policy.receipt,
      rollout: policy.rollout,
      fencingPolicy: policy.fencingPolicy,
    });
  } catch (err) {
    handleRouteError(res, err);
  }
});

/**
 * @swagger
 * /api/execution-environments/{id}/runner/jobs/{jobId}/complete:
 *   post:
 *     summary: Complete a runner job
 *     responses:
 *       200: { description: OK }
 */
router.post('/:id/runner/jobs/:jobId/complete', validateBody(CompleteJobSchema), async (req: Request, res: Response) => {
  try {
    await authenticateRunnerRequest(req);
    const job = await completeRunnerJob({
      jobId: paramValue(req.params.jobId),
      runnerId: req.body.runnerId,
      status: req.body.status,
      result: req.body.result,
      error: req.body.error,
    });
    res.json({ job: serializeRunnerJob(job) });
  } catch (err) {
    handleRouteError(res, err);
  }
});

export default router;
