/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { handleRouteError } from '../lib/async-handler';
import {
  appendBountySessionEvent,
  issueBountyCheckpointNudge,
  projectBountyAlert,
  readBountyActivities,
  readBountyAlerts,
  readBountySessionEvents,
  recordBountyTelemetry,
  summarizeBountyTelemetry,
  transitionBountyActivity,
} from '../lib/bounty-session-audit';
import { AdminRequiredError, AuthError, ValidationError } from '../lib/errors';

const router = Router();
const workspaceId = z.string().trim().min(1).max(128);
const jsonObject = z.record(z.string(), z.unknown());
const instant = z.string().datetime({ offset: true });
const counter = z.number().int().nonnegative().safe();
const MissionQuerySchema = z.object({ workspaceId }).strict();
const EventSchema = z.object({
  workspaceId, eventIdentity: z.string().trim().min(1).max(256), sourceRole: z.enum(['worker','validator','reporter','broker']),
  workerId: z.string().trim().min(1).max(256), sessionId: z.string().trim().min(1).max(256), eventType: z.string().trim().min(1).max(256),
  payload: jsonObject, occurredAt: instant,
}).strict();
const ActivitySchema = z.object({
  workspaceId, artifactId: z.string().uuid(), eventIdentity: z.string().trim().min(1).max(256), channel: z.enum(['note','lead','primitive','finding','draft']),
  expectedState: z.string().min(1).max(64).nullable(), state: z.string().min(1).max(64), title: z.string().trim().min(1).max(512), body: jsonObject,
  sourceCursor: z.number().int().positive().safe(),
}).strict();
const NudgeSchema = z.object({
  workspaceId, missionEpoch: z.number().int().positive().safe(), workerId: z.string().uuid(), checkpointId: z.string().uuid(),
  idempotencyKey: z.string().trim().min(1).max(256), text: z.string().trim().min(1).max(4000), expiresAt: instant,
}).strict();
const TelemetrySchema = z.object({
  workspaceId, eventIdentity: z.string().trim().min(1).max(256), workerId: z.string().trim().min(1).max(256),
  phase: z.string().trim().min(1).max(256), activity: z.string().trim().min(1).max(256), skill: z.string().trim().min(1).max(256), model: z.string().trim().min(1).max(256), occurredAt: instant,
  inputTokens: counter, outputTokens: counter, reasoningTokens: counter, contextTokens: counter, cacheHits: counter, cacheHitTokens: counter,
  toolCalls: counter, effectCalls: counter, requests: counter, callbacks: counter, wallTimeMs: counter, costMicrousd: counter,
  authLoopRequests: counter, authLoopCostMicrousd: counter, falsePositiveOutcomes: counter, oracleOutcomes: counter, highConfidenceAlerts: counter,
}).strict();
const AlertSchema = z.object({
  workspaceId, alertId: z.string().uuid(), sourceCursor: z.number().int().positive().safe(), confidence: z.number().min(0).max(1),
  severity: z.enum(['low','medium','high','critical']), triageState: z.enum(['new','triaged','escalated','dismissed','resolved']),
  expectedState: z.enum(['new','triaged','escalated','dismissed','resolved']).nullable(), summary: z.string().trim().min(1).max(2000),
  outcome: z.enum(['confirmed','false-positive','oracle']).optional(),
}).strict();

function requireOperator(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') return next(new AdminRequiredError());
  if (req.authSource !== 'bearer') return next(new AuthError('Credential-authenticated admin required for bounty session audit'));
  next();
}
function missionId(req: Request): string {
  const parsed = z.string().uuid().safeParse(req.params.missionId);
  if (!parsed.success) throw new ValidationError('Invalid bounty mission ID');
  return parsed.data;
}
function parsed<T>(result: { success: true; data: T } | { success: false }): T {
  if (!result.success) throw new ValidationError('Invalid bounty session audit request');
  return result.data;
}

/**
 * @swagger
 * /api/admin/bounty/sessions/{missionId}/events:
 *   post:
 *     summary: Append a redacted authoritative worker, validator, reporter, or broker event
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Session evidence can contain sensitive target activity and is writable only by credential-authenticated operators; it is never MCP-exposed."
 *     x-rorca-mcp: false
 *     parameters:
 *       - in: path
 *         name: missionId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       201: { description: Ordered authoritative event }
 *       200: { description: Exact idempotent replay }
 *       409: { description: Event identity conflict }
 */
router.post('/:missionId/events', requireOperator, async (req: Request, res: Response) => {
  try {
    const input = parsed(EventSchema.safeParse(req.body));
    const result = await appendBountySessionEvent({ ...input, missionId: missionId(req) });
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error: unknown) { handleRouteError(res, error, '[Bounty sessions] Append event'); }
});

/**
 * @swagger
 * /api/admin/bounty/sessions/{missionId}/events:
 *   get:
 *     summary: Resume an ordered redacted mission stream after an exclusive cursor
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Raw authoritative mission evidence is sensitive operator data and must not be exposed through MCP."
 *     x-rorca-mcp: false
 *     parameters:
 *       - in: path
 *         name: missionId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Gap-free event page and resumable next cursor }
 */
router.get('/:missionId/events', requireOperator, async (req: Request, res: Response) => {
  try {
    const queryInput = parsed(MissionQuerySchema.extend({ after: z.coerce.number().int().nonnegative().safe().default(0), limit: z.coerce.number().int().min(1).max(500).default(200) }).strict().safeParse(req.query));
    res.json(await readBountySessionEvents(queryInput.workspaceId, missionId(req), queryInput.after, queryInput.limit));
  } catch (error: unknown) { handleRouteError(res, error, '[Bounty sessions] Read events'); }
});

/**
 * @swagger
 * /api/admin/bounty/sessions/{missionId}/activities:
 *   post:
 *     summary: Apply a legal stable-ID note, lead, primitive, finding, or draft lifecycle transition
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Mission projections alter operator triage state and remain operator-only and excluded from MCP."
 *     x-rorca-mcp: false
 *     parameters:
 *       - in: path
 *         name: missionId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       201: { description: Lifecycle projection transition }
 *       200: { description: Exact lifecycle replay }
 *       422: { description: Illegal channel transition }
 */
router.post('/:missionId/activities', requireOperator, async (req: Request, res: Response) => {
  try {
    const input = parsed(ActivitySchema.safeParse(req.body));
    const result = await transitionBountyActivity({ ...input, missionId: missionId(req), actor: `${req.user!.id}:${req.user!.email}` });
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error: unknown) { handleRouteError(res, error, '[Bounty sessions] Transition activity'); }
});

/**
 * @swagger
 * /api/admin/bounty/sessions/{missionId}/activities:
 *   get:
 *     summary: List redacted note, lead, primitive, finding, and draft projections
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Mission activity projections contain sensitive target intelligence and remain operator-only and excluded from MCP."
 *     x-rorca-mcp: false
 *     parameters:
 *       - in: path
 *         name: missionId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Stable-ID channel projections linked to authoritative cursors }
 */
router.get('/:missionId/activities', requireOperator, async (req: Request, res: Response) => {
  try {
    const input = parsed(MissionQuerySchema.extend({ channel: z.enum(['note','lead','primitive','finding','draft']).optional() }).strict().safeParse(req.query));
    res.json({ activities: await readBountyActivities(input.workspaceId, missionId(req), input.channel) });
  } catch (error: unknown) { handleRouteError(res, error, '[Bounty sessions] Read activities'); }
});

/**
 * @swagger
 * /api/admin/bounty/sessions/{missionId}/nudges:
 *   post:
 *     summary: Issue an expiring checkpoint-bound authority-neutral human nudge
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Human intervention is operator-only and can influence live workers, so it is never MCP-exposed."
 *     x-rorca-mcp: false
 *     parameters:
 *       - in: path
 *         name: missionId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       201: { description: Immutable bound nudge }
 *       200: { description: Exact idempotent replay }
 *       403: { description: Stale epoch or mismatched worker/checkpoint }
 */
router.post('/:missionId/nudges', requireOperator, async (req: Request, res: Response) => {
  try {
    const input = parsed(NudgeSchema.safeParse(req.body));
    const result = await issueBountyCheckpointNudge({ ...input, missionId: missionId(req), operatorId: `${req.user!.id}:${req.user!.email}` });
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error: unknown) { handleRouteError(res, error, '[Bounty sessions] Issue nudge'); }
});

/**
 * @swagger
 * /api/admin/bounty/sessions/{missionId}/telemetry:
 *   post:
 *     summary: Record fully dimensioned mission activity and outcome accounting
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Telemetry includes sensitive target activity, worker identity, and spend, and is restricted to operators."
 *     x-rorca-mcp: false
 *     parameters:
 *       - in: path
 *         name: missionId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       201: { description: Immutable telemetry fact }
 *       200: { description: Exact telemetry replay }
 */
router.post('/:missionId/telemetry', requireOperator, async (req: Request, res: Response) => {
  try {
    const input = parsed(TelemetrySchema.safeParse(req.body));
    const result = await recordBountyTelemetry({ ...input, missionId: missionId(req) });
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error: unknown) { handleRouteError(res, error, '[Bounty sessions] Record telemetry'); }
});

/**
 * @swagger
 * /api/admin/bounty/sessions/{missionId}/telemetry:
 *   get:
 *     summary: Summarize mission metrics by worker, phase, activity, skill, and model
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Mission spend and operational outcome summaries are sensitive operator-only data and excluded from MCP."
 *     x-rorca-mcp: false
 *     parameters:
 *       - in: path
 *         name: missionId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Fully dimensioned telemetry summary }
 */
router.get('/:missionId/telemetry', requireOperator, async (req: Request, res: Response) => {
  try {
    const input = parsed(MissionQuerySchema.safeParse(req.query));
    res.json({ dimensions: await summarizeBountyTelemetry(input.workspaceId, missionId(req)) });
  } catch (error: unknown) { handleRouteError(res, error, '[Bounty sessions] Summarize telemetry'); }
});

/**
 * @swagger
 * /api/admin/bounty/sessions/{missionId}/alerts:
 *   post:
 *     summary: Create or legally transition a redacted alert triage projection
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Alert triage mutates sensitive operator projections and is excluded from MCP."
 *     x-rorca-mcp: false
 *     parameters:
 *       - in: path
 *         name: missionId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Stable alert projection }
 *       422: { description: Illegal alert transition }
 */
router.post('/:missionId/alerts', requireOperator, async (req: Request, res: Response) => {
  try {
    const input = parsed(AlertSchema.safeParse(req.body));
    res.json(await projectBountyAlert({ ...input, missionId: missionId(req) }));
  } catch (error: unknown) { handleRouteError(res, error, '[Bounty sessions] Project alert'); }
});

/**
 * @swagger
 * /api/admin/bounty/sessions/{missionId}/alerts:
 *   get:
 *     summary: List active mission alerts in deterministic operator triage order
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Redacted bounty alerts remain sensitive target intelligence and are available only to operators."
 *     x-rorca-mcp: false
 *     parameters:
 *       - in: path
 *         name: missionId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Ranked active alert queue }
 */
router.get('/:missionId/alerts', requireOperator, async (req: Request, res: Response) => {
  try {
    const input = parsed(MissionQuerySchema.safeParse(req.query));
    res.json({ alerts: await readBountyAlerts(input.workspaceId, missionId(req)) });
  } catch (error: unknown) { handleRouteError(res, error, '[Bounty sessions] Read alerts'); }
});

export default router;
