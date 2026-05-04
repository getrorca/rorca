/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type Request, type Response } from 'express';
import { getJob, isTerminalStatus, toSpecJobState, updateJobStatus } from '../db/spec-jobs';
import { handleRouteError } from '../lib/async-handler';
import { ConflictError, NotFoundError } from '../lib/errors';
import { getBoss } from '../lib/pg-boss';
import { publishSpecJobSnapshot, specJobTopic, type SpecJobStreamEvent } from '../lib/spec-job-events';
import { subscribeTopic } from '../lib/sse-hub';

const router = Router();

const JOB_QUEUE_BY_TYPE = {
  enrich: 'spec:enrich',
  'match-skills': 'spec:match-skills',
  'suggest-skills': 'spec:suggest-skills',
} as const;

function writeSseEvent(res: Response, event: string, payload: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/**
 * @swagger
 * /api/spec-jobs/{jobId}:
 *   get:
 *     tags: [Specs]
 *     summary: Get a spec async job by ID
 *     operationId: rorca_spec_jobs_by_id
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only async job polling for local UI and MCP clients with no privileged side effects."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Current spec job state
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string, format: uuid }
 *                 specId: { type: string }
 *                 workspaceId: { type: string }
 *                 jobType: { type: string, enum: [enrich, match-skills, suggest-skills, suggest-models, detect-dependencies, knowledge-graph, add-stories, validate, score] }
 *                 status: { type: string, enum: [pending, running, completed, failed, cancelled] }
 *                 progress:
 *                   type: object
 *                   properties:
 *                     current: { type: integer }
 *                     total: { type: integer }
 *                     message: { type: string, nullable: true }
 *                 result: { type: object, nullable: true, additionalProperties: true }
 *                 error: { type: string, nullable: true }
 *                 startedAt: { type: string, format: date-time, nullable: true }
 *                 finishedAt: { type: string, format: date-time, nullable: true }
 *                 createdAt: { type: string, format: date-time }
 *       404:
 *         description: Job not found
 */
router.get('/:jobId', async (req: Request, res: Response) => {
  try {
    const jobId = String(req.params.jobId);
    const job = await getJob(jobId);
    if (!job) {
      throw new NotFoundError('Spec job not found');
    }

    res.json(toSpecJobState(job));
  } catch (error) {
    handleRouteError(res, error, '[spec-jobs] get');
  }
});

/**
 * @swagger
 * /api/spec-jobs/{jobId}/stream:
 *   get:
 *     tags: [Specs]
 *     summary: Stream a spec async job over SSE
 *     operationId: rorca_spec_jobs_by_id_stream
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only async job progress stream for local UI and MCP clients with no privileged side effects."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: text/event-stream with snapshot, progress, and terminal events
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       404:
 *         description: Job not found
 */
router.get('/:jobId/stream', async (req: Request, res: Response) => {
  try {
    const jobId = String(req.params.jobId);
    const initial = await getJob(jobId);
    if (!initial) {
      throw new NotFoundError('Spec job not found');
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const initialState = toSpecJobState(initial);
    let lastSerialized = JSON.stringify(initialState);
    writeSseEvent(res, 'snapshot', initialState);
    if (isTerminalStatus(initial.status)) {
      writeSseEvent(res, 'terminal', initialState);
      res.end();
      return;
    }

    const unsubscribe = subscribeTopic<SpecJobStreamEvent>(specJobTopic(jobId), (event) => {
      const serialized = JSON.stringify(event.job);
      if (serialized === lastSerialized) {
        return;
      }
      lastSerialized = serialized;
      writeSseEvent(res, event.event, event.job);
      if (event.event === 'terminal') {
        cleanup();
        res.end();
      }
    });

    const poll = setInterval(() => {
      void (async () => {
        const current = await getJob(jobId);
        if (!current) {
          cleanup();
          res.end();
          return;
        }

        const state = toSpecJobState(current);
        const serialized = JSON.stringify(state);
        if (serialized === lastSerialized) {
          return;
        }

        lastSerialized = serialized;
        const eventName = isTerminalStatus(current.status) ? 'terminal' : 'progress';
        writeSseEvent(res, eventName, state);
        if (eventName === 'terminal') {
          cleanup();
          res.end();
        }
      })().catch(() => {
        cleanup();
        res.end();
      });
    }, 1000);

    const keepAlive = setInterval(() => {
      res.write(': ping\n\n');
    }, 15000);

    const cleanup = () => {
      unsubscribe();
      clearInterval(poll);
      clearInterval(keepAlive);
    };

    req.on('close', cleanup);
  } catch (error) {
    handleRouteError(res, error, '[spec-jobs] stream');
  }
});

/**
 * @swagger
 * /api/spec-jobs/{jobId}/cancel:
 *   post:
 *     tags: [Specs]
 *     summary: Cancel a spec async job
 *     operationId: rorca_spec_jobs_by_id_cancel
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Allows local operators and MCP clients to stop their own async enrichment and skill jobs without any billing or admin side effects."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Cancellation requested
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *       404:
 *         description: Job not found
 *       409:
 *         description: Job is already terminal
 */
router.post('/:jobId/cancel', async (req: Request, res: Response) => {
  try {
    const jobId = String(req.params.jobId);
    const job = await getJob(jobId);
    if (!job) {
      throw new NotFoundError('Spec job not found');
    }
    if (isTerminalStatus(job.status)) {
      throw new ConflictError(`Spec job is already ${job.status}`);
    }

    const queueName = JOB_QUEUE_BY_TYPE[job.jobType as keyof typeof JOB_QUEUE_BY_TYPE];
    if (!queueName) {
      throw new ConflictError(`Spec job type '${job.jobType}' is not cancellable`);
    }
    if (!job.bossJobId) {
      throw new ConflictError('Spec job is missing boss_job_id and cannot be cancelled safely');
    }

    await getBoss().cancel(queueName, job.bossJobId);
    await updateJobStatus(jobId, 'cancelled', {
      finishedAt: new Date(),
      progressMessage: 'Cancelled by user',
      errorMessage: null,
    });
    await publishSpecJobSnapshot(jobId, 'terminal');

    res.json({ ok: true });
  } catch (error) {
    handleRouteError(res, error, '[spec-jobs] cancel');
  }
});

export default router;
