/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
/** Dedicated, bounded REST adapter for bounty Controller commands and projections. */
import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { handleRouteError } from '../lib/async-handler';
import { bountyCallbackBroker } from '../lib/bounty-callback-broker';
import { LocalFixtureLaunchTargetSchema, LocalFixtureProviderEventSchema } from '../lib/bounty-local-fixture-launch';
import {
  admitBountyProgram, controlBountyMission, createBountyHold, getBountyMissionStatus,
  launchBountyMission, listBountyDrafts, listBountyEvidence, listBountyFindings, listBountyHolds,
  listBountyWork, previewBountyMission, releaseBountyHold, reviewBountyDraftRelease,
} from '../lib/bounty-controller';
import { AdminRequiredError, AuthError, ForbiddenError, ServiceUnavailableError, ValidationError } from '../lib/errors';
import { parsePaginationParams } from '../lib/paginate';
import { bountyCredentialBroker } from '../lib/bounty-production-services';

const router = Router({ strict: true, caseSensitive: true });
const UuidSchema = z.string().uuid();
const WorkspaceSchema = z.string().trim().min(1).max(128);
const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const ReasonSchema = z.string().trim().min(1).max(512);
const AuthoritySchema = z.object({ workspaceId: WorkspaceSchema, programId: UuidSchema }).strict();
const MissionAuthoritySchema = AuthoritySchema.extend({ missionId: UuidSchema }).strict();
const MissionCommandSchema = MissionAuthoritySchema.extend({ expectedEpoch: z.number().int().positive(), reason: ReasonSchema }).strict();
const AdmissionSchema = z.object({
  workspaceId: WorkspaceSchema, programId: UuidSchema, programName: z.string().trim().min(1).max(256), policyRevision: z.number().int().positive(),
  scope: z.object({
    allowedOrigins: z.array(z.string().url().max(2048)).min(1).max(64),
    prohibitedActions: z.array(z.string().trim().min(1).max(128)).max(128),
    maxRequests: z.number().int().positive().max(1_000_000),
    expiresAt: z.string().datetime(), policyContractHash: HashSchema,
  }).strict(),
}).strict();
const PreviewSchema = AuthoritySchema.extend({
  missionId: UuidSchema, title: z.string().trim().min(1).max(512), contract: z.record(z.string(), z.unknown()), expectedProgramRevision: z.number().int().positive(),
}).strict();
const LaunchSchema = PreviewSchema.extend({
  previewReceiptId: UuidSchema,
  approvalTarget: LocalFixtureLaunchTargetSchema,
  providerHumanApproval: LocalFixtureProviderEventSchema,
}).strict();
const HoldReleaseSchema = MissionCommandSchema.extend({ holdId: UuidSchema }).strict();
const ReleaseReviewSchema = AuthoritySchema.extend({
  decision: z.enum(['approve-readiness', 'reject']), reason: ReasonSchema,
}).strict();
const PaginationQuerySchema = MissionAuthoritySchema.extend({
  limit: z.string().regex(/^\d+$/).optional(), page: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(), cursor: z.string().min(1).max(1024).optional(), raw: z.enum(['true', 'false']).optional(),
}).strict();

export interface BountyOperationMatrixEntry {
  operationId: string; method: 'GET' | 'POST'; path: string; tier: 'admin';
  mcp: false; pi: false; hermes: false; purpose: string; rawDataPolicy: string;
}

/** Auditable external exposure inventory. Target-effect IPC is intentionally absent. */
export const BOUNTY_REST_OPERATION_MATRIX: readonly BountyOperationMatrixEntry[] = Object.freeze([
  { operationId: 'admitBountyProgram', method: 'POST', path: '/api/bounty/admissions', tier: 'admin', mcp: false, pi: false, hermes: false, purpose: 'Admit one bounded program scope', rawDataPolicy: 'Validated scope only; no credentials or evidence' },
  { operationId: 'previewBountyMission', method: 'POST', path: '/api/bounty/missions/preview', tier: 'admin', mcp: false, pi: false, hermes: false, purpose: 'Preview exact mission hashes without effects', rawDataPolicy: 'Hash-only receipt' },
  { operationId: 'launchBountyMission', method: 'POST', path: '/api/bounty/missions/launch', tier: 'admin', mcp: false, pi: false, hermes: false, purpose: 'Launch an exactly previewed local-fixture mission with one-use provider-human authority', rawDataPolicy: 'Receipt exposes approval, deployment, and admitted-policy hashes, never credentials or target response data' },
  { operationId: 'getBountyMissionStatus', method: 'GET', path: '/api/bounty/missions/{missionId}', tier: 'admin', mcp: false, pi: false, hermes: false, purpose: 'Inspect mission state and aggregate counts', rawDataPolicy: 'Metadata only' },
  { operationId: 'listBountyMissionWork', method: 'GET', path: '/api/bounty/missions/{missionId}/work', tier: 'admin', mcp: false, pi: false, hermes: false, purpose: 'Inspect paginated work status', rawDataPolicy: 'Immutable identities/hashes only' },
  { operationId: 'listBountyMissionEvidence', method: 'GET', path: '/api/bounty/missions/{missionId}/evidence', tier: 'admin', mcp: false, pi: false, hermes: false, purpose: 'Inspect paginated evidence', rawDataPolicy: 'Payload omitted by default; raw requires separate capability; credential fields always redacted' },
  { operationId: 'listBountyMissionFindings', method: 'GET', path: '/api/bounty/missions/{missionId}/findings', tier: 'admin', mcp: false, pi: false, hermes: false, purpose: 'Inspect paginated admitted findings', rawDataPolicy: 'Metadata only' },
  { operationId: 'listBountyMissionDrafts', method: 'GET', path: '/api/bounty/missions/{missionId}/drafts', tier: 'admin', mcp: false, pi: false, hermes: false, purpose: 'Inspect paginated local drafts', rawDataPolicy: 'Bytes/manifests omitted by default; raw requires separate capability' },
  { operationId: 'listBountyMissionHolds', method: 'GET', path: '/api/bounty/missions/{missionId}/holds', tier: 'admin', mcp: false, pi: false, hermes: false, purpose: 'Inspect paginated mission holds', rawDataPolicy: 'Control metadata only' },
  { operationId: 'createBountyMissionHold', method: 'POST', path: '/api/bounty/missions/{missionId}/holds', tier: 'admin', mcp: false, pi: false, hermes: false, purpose: 'Fence an active mission with a durable hold', rawDataPolicy: 'Control metadata only' },
  { operationId: 'releaseBountyMissionHold', method: 'POST', path: '/api/bounty/missions/{missionId}/holds/{holdId}/release', tier: 'admin', mcp: false, pi: false, hermes: false, purpose: 'Release one reconciled hold', rawDataPolicy: 'Control metadata only' },
  { operationId: 'pauseBountyMission', method: 'POST', path: '/api/bounty/missions/{missionId}/pause', tier: 'admin', mcp: false, pi: false, hermes: false, purpose: 'Pause and revoke mission authority', rawDataPolicy: 'Control receipt only' },
  { operationId: 'stopBountyMission', method: 'POST', path: '/api/bounty/missions/{missionId}/stop', tier: 'admin', mcp: false, pi: false, hermes: false, purpose: 'Stop mission execution', rawDataPolicy: 'Control receipt only' },
  { operationId: 'killBountyMission', method: 'POST', path: '/api/bounty/missions/{missionId}/kill', tier: 'admin', mcp: false, pi: false, hermes: false, purpose: 'Emergency-kill mission execution', rawDataPolicy: 'Control receipt only' },
  { operationId: 'reviewBountyDraftRelease', method: 'POST', path: '/api/bounty/missions/{missionId}/drafts/{draftId}/release-review', tier: 'admin', mcp: false, pi: false, hermes: false, purpose: 'Record local human readiness review without submission', rawDataPolicy: 'Exact bundle hash only; no report bytes or provider transport' },
]);

function requireBountyControllerHuman(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new AuthError('Authentication required for bounty Controller operations'));
  if (req.user.role !== 'admin') return next(new AdminRequiredError());
  if (req.authSource !== 'bearer') return next(new AuthError('Credential-authenticated human administrator required for bounty Controller operations'));
  next();
}
router.use(requireBountyControllerHuman);

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ValidationError(`Invalid ${label}`, { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
  return parsed.data;
}
function actor(req: Request): string { return `${req.user!.id}:${req.user!.email}`; }
function idempotencyKey(req: Request): string {
  const parsed = z.string().trim().min(8).max(256).safeParse(req.header('Idempotency-Key'));
  if (!parsed.success) throw new ValidationError('A bounded Idempotency-Key header is required');
  return parsed.data;
}
function merged(req: Request): Record<string, unknown> { return { ...req.query, ...req.body, ...req.params }; }
function route(label: string, handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return async (req, res) => { try { await handler(req, res); } catch (error: unknown) { handleRouteError(res, error, `[Bounty REST] ${label}`); } };
}
function rawRequested(req: Request): boolean { return req.query.raw === 'true'; }
function assertRawAuthority(req: Request): void {
  if (!rawRequested(req)) return;
  const expected = String(process.env.RORCA_BOUNTY_RAW_CAPABILITY_SHA256 ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new ServiceUnavailableError('Raw bounty inspection is disabled until a separate capability is configured');
  const supplied = String(req.header('X-Rorca-Operator-Capability') ?? '');
  const actual = crypto.createHash('sha256').update(supplied, 'utf8').digest('hex');
  if (!supplied || !crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))) throw new ForbiddenError('Separate raw bounty inspection authority is required');
}
const lifecycleHooks = {
  revokeCredentials: (missionId: string, epoch: number) => bountyCredentialBroker.revokeMission(missionId, epoch).then(() => undefined),
  revokeCallbacks: (missionId: string, epoch: number) => { bountyCallbackBroker.revokeMission(missionId, epoch); },
  closeBrowserPartitions: async () => undefined,
};

/**
 * @swagger
 * /api/bounty/admissions:
 *   post:
 *     tags: [Bounty]
 *     summary: Admit one bounded bounty program scope
 *     operationId: admitBountyProgram
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Program admission creates operator-owned bounty authority and is human-admin-only, never agent or MCP callable."
 *     x-rorca-mcp: false
 *     x-rorca-idempotent: true
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: header, name: Idempotency-Key, required: true, schema: { type: string, minLength: 8, maxLength: 256 } }]
 *     requestBody: { required: true, content: { application/json: { schema: { type: object, additionalProperties: false, required: [workspaceId, programId, programName, policyRevision, scope], properties: { workspaceId: { type: string }, programId: { type: string, format: uuid }, programName: { type: string }, policyRevision: { type: integer, minimum: 1 }, scope: { type: object, additionalProperties: false, required: [allowedOrigins, prohibitedActions, maxRequests, expiresAt, policyContractHash], properties: { allowedOrigins: { type: array, items: { type: string, format: uri } }, prohibitedActions: { type: array, items: { type: string } }, maxRequests: { type: integer, minimum: 1 }, expiresAt: { type: string, format: date-time }, policyContractHash: { type: string, pattern: '^sha256:[0-9a-f]{64}$' } } } } } } } }
 *     responses: { 201: { description: Durable admission receipt }, 400: { description: Malformed input }, 401: { description: Credential authentication required }, 403: { description: Admin, plan, CSRF, or feature authority denied }, 409: { description: Conflicting replay } }
 */
router.post('/admissions', route('Admission', async (req, res) => {
  const input = parse(AdmissionSchema, req.body, 'bounty admission');
  const result = await admitBountyProgram({ ...input, actor: actor(req), idempotencyKey: idempotencyKey(req) });
  res.status(result.replayed ? 200 : 201).json(result);
}));

/**
 * @swagger
 * /api/bounty/missions/preview:
 *   post:
 *     tags: [Bounty]
 *     summary: Preview a bounded mission without target effects
 *     operationId: previewBountyMission
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Mission preview is operator-only and persists only hashes needed for exact launch authorization."
 *     x-rorca-mcp: false
 *     x-rorca-idempotent: true
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: header, name: Idempotency-Key, required: true, schema: { type: string, minLength: 8 } }]
 *     requestBody: { required: true, content: { application/json: { schema: { type: object, additionalProperties: false, required: [workspaceId, programId, missionId, title, contract, expectedProgramRevision], properties: { workspaceId: { type: string }, programId: { type: string, format: uuid }, missionId: { type: string, format: uuid }, title: { type: string }, contract: { type: object }, expectedProgramRevision: { type: integer, minimum: 1 } } } } } }
 *     responses: { 200: { description: Hash-only launch preview }, 400: { description: Malformed input }, 401: { description: Authentication required }, 403: { description: Authority or feature denied }, 404: { description: Program not authorized }, 409: { description: Stale revision or conflicting replay } }
 */
router.post('/missions/preview', route('Preview', async (req, res) => { res.json(await previewBountyMission({ ...parse(PreviewSchema, req.body, 'mission preview'), actor: actor(req), idempotencyKey: idempotencyKey(req) })); }));

/**
 * @swagger
 * /api/bounty/missions/launch:
 *   post:
 *     tags: [Bounty]
 *     summary: Launch an exactly previewed local-fixture mission with one-use provider-human approval
 *     operationId: launchBountyMission
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Launch creates Controller state but no target effect; exact preview, admitted policy, promoted deployment and one distinct trusted provider-human signature are mandatory and consumed once."
 *     x-rorca-mcp: false
 *     x-rorca-idempotent: true
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: header, name: Idempotency-Key, required: true, schema: { type: string, minLength: 8 } }]
 *     requestBody: { required: true, content: { application/json: { schema: { type: object, additionalProperties: false, required: [workspaceId, programId, missionId, title, contract, expectedProgramRevision, previewReceiptId], properties: { workspaceId: { type: string }, programId: { type: string, format: uuid }, missionId: { type: string, format: uuid }, title: { type: string }, contract: { type: object }, expectedProgramRevision: { type: integer, minimum: 1 }, previewReceiptId: { type: string, format: uuid } } } } } }
 *     responses: { 201: { description: Active canary mission receipt citing admitted policy; no target effect sent }, 200: { description: Idempotent replay }, 400: { description: Malformed input }, 401: { description: Authentication required }, 403: { description: Exact preview or feature denied }, 404: { description: Program not authorized }, 409: { description: Conflict } }
 */
router.post('/missions/launch', route('Launch', async (req, res) => {
  const result = await launchBountyMission({ ...parse(LaunchSchema, req.body, 'mission launch'), actor: actor(req), idempotencyKey: idempotencyKey(req) });
  res.status(result.replayed ? 200 : 201).json(result);
}));

/**
 * @swagger
 * /api/bounty/missions/{missionId}:
 *   get:
 *     tags: [Bounty]
 *     summary: Read one authorized mission status
 *     operationId: getBountyMissionStatus
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Mission status is operator metadata scoped to an exact workspace and program and excluded from agent surfaces."
 *     x-rorca-mcp: false
 *     x-rorca-idempotent: true
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: missionId, required: true, schema: { type: string, format: uuid } }, { in: query, name: workspaceId, required: true, schema: { type: string } }, { in: query, name: programId, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Mission metadata and aggregate counts }, 400: { description: Malformed input }, 401: { description: Authentication required }, 403: { description: Authority or feature denied }, 404: { description: Cross-workspace/program mission is not visible } }
 */
router.get('/missions/:missionId', route('Status', async (req, res) => {
  const input = parse(MissionAuthoritySchema, merged(req), 'mission authority'); res.json(await getBountyMissionStatus({ ...input, actor: actor(req) }, input.missionId));
}));

const listAnnotations = `Swagger annotations for each list operation are declared immediately above its route.`;
void listAnnotations;

/**
 * @swagger
 * /api/bounty/missions/{missionId}/work:
 *   get:
 *     tags: [Bounty]
 *     summary: List authorized mission work
 *     operationId: listBountyMissionWork
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Work inspection returns bounded execution metadata to a human administrator only."
 *     x-rorca-mcp: false
 *     x-rorca-idempotent: true
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: missionId, required: true, schema: { type: string, format: uuid } }, { in: query, name: workspaceId, required: true, schema: { type: string } }, { in: query, name: programId, required: true, schema: { type: string, format: uuid } }, { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100 } }, { in: query, name: cursor, schema: { type: string } }]
 *     responses: { 200: { description: Paginated work metadata }, 400: { description: Malformed pagination }, 401: { description: Authentication required }, 403: { description: Authority denied }, 404: { description: Mission not authorized } }
 */
router.get('/missions/:missionId/work', listRoute('Work', false, (context) => listBountyWork(context)));

/**
 * @swagger
 * /api/bounty/missions/{missionId}/evidence:
 *   get:
 *     tags: [Bounty]
 *     summary: List authorized mission evidence, redacted by default
 *     operationId: listBountyMissionEvidence
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Evidence is workspace/program scoped; raw payload needs a separate operator capability and is never MCP exposed."
 *     x-rorca-mcp: false
 *     x-rorca-idempotent: true
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: missionId, required: true, schema: { type: string, format: uuid } }, { in: query, name: workspaceId, required: true, schema: { type: string } }, { in: query, name: programId, required: true, schema: { type: string, format: uuid } }, { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100 } }, { in: query, name: cursor, schema: { type: string } }, { in: query, name: raw, schema: { type: boolean, default: false } }]
 *     responses: { 200: { description: Paginated evidence; payload absent unless separately authorized }, 400: { description: Malformed pagination }, 401: { description: Authentication required }, 403: { description: Workspace/program or raw capability denied }, 404: { description: Mission not authorized }, 503: { description: Raw inspection capability disabled } }
 */
router.get('/missions/:missionId/evidence', listRoute('Evidence', true, (context, raw) => listBountyEvidence(context, raw)));

/**
 * @swagger
 * /api/bounty/missions/{missionId}/findings:
 *   get:
 *     tags: [Bounty]
 *     summary: List authorized admitted findings
 *     operationId: listBountyMissionFindings
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Finding inspection exposes metadata only to a human administrator within exact program authority."
 *     x-rorca-mcp: false
 *     x-rorca-idempotent: true
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: missionId, required: true, schema: { type: string, format: uuid } }, { in: query, name: workspaceId, required: true, schema: { type: string } }, { in: query, name: programId, required: true, schema: { type: string, format: uuid } }, { in: query, name: limit, schema: { type: integer, maximum: 100 } }, { in: query, name: cursor, schema: { type: string } }]
 *     responses: { 200: { description: Paginated finding metadata }, 400: { description: Malformed pagination }, 401: { description: Authentication required }, 403: { description: Authority denied }, 404: { description: Mission not authorized } }
 */
router.get('/missions/:missionId/findings', listRoute('Findings', false, (context) => listBountyFindings(context)));

/**
 * @swagger
 * /api/bounty/missions/{missionId}/drafts:
 *   get:
 *     tags: [Bounty]
 *     summary: List local report drafts, with bytes omitted by default
 *     operationId: listBountyMissionDrafts
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Draft inspection is local human review; exact bytes require separate raw authority and cannot submit externally."
 *     x-rorca-mcp: false
 *     x-rorca-idempotent: true
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: missionId, required: true, schema: { type: string, format: uuid } }, { in: query, name: workspaceId, required: true, schema: { type: string } }, { in: query, name: programId, required: true, schema: { type: string, format: uuid } }, { in: query, name: limit, schema: { type: integer, maximum: 100 } }, { in: query, name: cursor, schema: { type: string } }, { in: query, name: raw, schema: { type: boolean, default: false } }]
 *     responses: { 200: { description: Paginated draft metadata or separately authorized local bytes }, 400: { description: Malformed pagination }, 401: { description: Authentication required }, 403: { description: Authority denied }, 404: { description: Mission not authorized }, 503: { description: Raw inspection disabled } }
 */
router.get('/missions/:missionId/drafts', listRoute('Drafts', true, (context, raw) => listBountyDrafts(context, raw)));

/**
 * @swagger
 * /api/bounty/missions/{missionId}/holds:
 *   get:
 *     tags: [Bounty]
 *     summary: List durable mission holds
 *     operationId: listBountyMissionHolds
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Hold inspection is human operator control metadata, exact-authority scoped and not agent exposed."
 *     x-rorca-mcp: false
 *     x-rorca-idempotent: true
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: missionId, required: true, schema: { type: string, format: uuid } }, { in: query, name: workspaceId, required: true, schema: { type: string } }, { in: query, name: programId, required: true, schema: { type: string, format: uuid } }, { in: query, name: limit, schema: { type: integer, maximum: 100 } }, { in: query, name: cursor, schema: { type: string } }]
 *     responses: { 200: { description: Paginated holds }, 400: { description: Malformed pagination }, 401: { description: Authentication required }, 403: { description: Authority denied }, 404: { description: Mission not authorized } }
 *   post:
 *     tags: [Bounty]
 *     summary: Place a durable mission hold
 *     operationId: createBountyMissionHold
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "A hold advances the Controller epoch and revokes execution authority; it is human-admin-only."
 *     x-rorca-mcp: false
 *     x-rorca-idempotent: true
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: missionId, required: true, schema: { type: string, format: uuid } }, { in: header, name: Idempotency-Key, required: true, schema: { type: string, minLength: 8 } }]
 *     requestBody: { required: true, content: { application/json: { schema: { type: object, additionalProperties: false, required: [workspaceId, programId, expectedEpoch, reason], properties: { workspaceId: { type: string }, programId: { type: string, format: uuid }, expectedEpoch: { type: integer, minimum: 1 }, reason: { type: string, minLength: 1, maxLength: 512 } } } } } }
 *     responses: { 201: { description: Durable hold receipt }, 200: { description: Idempotent replay }, 400: { description: Malformed input }, 401: { description: Authentication required }, 403: { description: Authority denied }, 404: { description: Mission not authorized }, 409: { description: Stale epoch or replay conflict }, 422: { description: Illegal hold } }
 */
router.get('/missions/:missionId/holds', listRoute('Holds', false, (context) => listBountyHolds(context)));
router.post('/missions/:missionId/holds', missionMutation('Hold', MissionCommandSchema, async (command) => createBountyHold(command), 201));

/**
 * @swagger
 * /api/bounty/missions/{missionId}/holds/{holdId}/release:
 *   post:
 *     tags: [Bounty]
 *     summary: Release one reconciled mission hold
 *     operationId: releaseBountyMissionHold
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Hold release restores Controller authority and therefore requires a credential-authenticated human admin."
 *     x-rorca-mcp: false
 *     x-rorca-idempotent: true
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: missionId, required: true, schema: { type: string, format: uuid } }, { in: path, name: holdId, required: true, schema: { type: string, format: uuid } }, { in: header, name: Idempotency-Key, required: true, schema: { type: string, minLength: 8 } }]
 *     requestBody: { required: true, content: { application/json: { schema: { type: object, additionalProperties: false, required: [workspaceId, programId, expectedEpoch, reason], properties: { workspaceId: { type: string }, programId: { type: string, format: uuid }, expectedEpoch: { type: integer, minimum: 1 }, reason: { type: string, minLength: 1, maxLength: 512 } } } } } }
 *     responses: { 200: { description: Durable release receipt }, 400: { description: Malformed input }, 401: { description: Authentication required }, 403: { description: Other holds or authority denied }, 404: { description: Hold or mission not found }, 409: { description: Stale epoch or replay conflict } }
 */
router.post('/missions/:missionId/holds/:holdId/release', missionMutation('Hold release', HoldReleaseSchema, async (command) => releaseBountyHold(command)));

/**
 * @swagger
 * /api/bounty/missions/{missionId}/pause:
 *   post:
 *     tags: [Bounty]
 *     summary: Pause a mission at a durable Controller epoch
 *     operationId: pauseBountyMission
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Pause revokes mission execution authority and is human-admin-only, excluded from every agent surface."
 *     x-rorca-mcp: false
 *     x-rorca-idempotent: true
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: missionId, required: true, schema: { type: string, format: uuid } }, { in: header, name: Idempotency-Key, required: true, schema: { type: string, minLength: 8 } }]
 *     requestBody: { required: true, content: { application/json: { schema: { type: object, additionalProperties: false, required: [workspaceId, programId, expectedEpoch, reason], properties: { workspaceId: { type: string }, programId: { type: string, format: uuid }, expectedEpoch: { type: integer, minimum: 1 }, reason: { type: string, minLength: 1, maxLength: 512 } } } } } }
 *     responses: { 200: { description: Durable pause receipt }, 400: { description: Malformed input }, 401: { description: Authentication required }, 403: { description: Authority denied }, 404: { description: Mission not found }, 409: { description: Stale epoch or replay conflict }, 422: { description: Illegal transition } }
 */
router.post('/missions/:missionId/pause', missionMutation('Pause', MissionCommandSchema, async (command) => controlBountyMission(command, 'pause', lifecycleHooks)));

/**
 * @swagger
 * /api/bounty/missions/{missionId}/stop:
 *   post:
 *     tags: [Bounty]
 *     summary: Stop a mission at a durable Controller epoch
 *     operationId: stopBountyMission
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Stop revokes target-effect authority and terminates work; it is never agent callable."
 *     x-rorca-mcp: false
 *     x-rorca-idempotent: true
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: missionId, required: true, schema: { type: string, format: uuid } }, { in: header, name: Idempotency-Key, required: true, schema: { type: string, minLength: 8 } }]
 *     requestBody: { required: true, content: { application/json: { schema: { type: object, additionalProperties: false, required: [workspaceId, programId, expectedEpoch, reason], properties: { workspaceId: { type: string }, programId: { type: string, format: uuid }, expectedEpoch: { type: integer, minimum: 1 }, reason: { type: string, minLength: 1, maxLength: 512 } } } } } }
 *     responses: { 200: { description: Durable stop receipt }, 400: { description: Malformed input }, 401: { description: Authentication required }, 403: { description: Authority denied }, 404: { description: Mission not found }, 409: { description: Stale epoch or replay conflict }, 422: { description: Illegal transition } }
 */
router.post('/missions/:missionId/stop', missionMutation('Stop', MissionCommandSchema, async (command) => controlBountyMission(command, 'stop', lifecycleHooks)));

/**
 * @swagger
 * /api/bounty/missions/{missionId}/kill:
 *   post:
 *     tags: [Bounty]
 *     summary: Emergency-kill a mission at a durable Controller epoch
 *     operationId: killBountyMission
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Emergency kill terminates process groups and revokes credentials; it requires human admin authority and is not agent exposed."
 *     x-rorca-mcp: false
 *     x-rorca-idempotent: true
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: missionId, required: true, schema: { type: string, format: uuid } }, { in: header, name: Idempotency-Key, required: true, schema: { type: string, minLength: 8 } }]
 *     requestBody: { required: true, content: { application/json: { schema: { type: object, additionalProperties: false, required: [workspaceId, programId, expectedEpoch, reason], properties: { workspaceId: { type: string }, programId: { type: string, format: uuid }, expectedEpoch: { type: integer, minimum: 1 }, reason: { type: string, minLength: 1, maxLength: 512 } } } } } }
 *     responses: { 200: { description: Durable kill receipt }, 400: { description: Malformed input }, 401: { description: Authentication required }, 403: { description: Authority denied }, 404: { description: Mission not found }, 409: { description: Stale epoch or replay conflict }, 422: { description: Illegal transition } }
 */
router.post('/missions/:missionId/kill', missionMutation('Kill', MissionCommandSchema, async (command) => controlBountyMission(command, 'kill', lifecycleHooks)));

/**
 * @swagger
 * /api/bounty/missions/{missionId}/drafts/{draftId}/release-review:
 *   post:
 *     tags: [Bounty]
 *     summary: Record local release-readiness review without submission
 *     operationId: reviewBountyDraftRelease
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Release review records a local exact-bundle readiness fact only; no provider submission operation exists."
 *     x-rorca-mcp: false
 *     x-rorca-idempotent: true
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: missionId, required: true, schema: { type: string, format: uuid } }, { in: path, name: draftId, required: true, schema: { type: string, format: uuid } }, { in: header, name: Idempotency-Key, required: true, schema: { type: string, minLength: 8 } }]
 *     requestBody: { required: true, content: { application/json: { schema: { type: object, additionalProperties: false, required: [workspaceId, programId, decision, reason], properties: { workspaceId: { type: string }, programId: { type: string, format: uuid }, decision: { type: string, enum: [approve-readiness, reject] }, reason: { type: string, minLength: 1, maxLength: 512 } } } } } }
 *     responses: { 201: { description: Local review receipt with submitted=false }, 200: { description: Idempotent replay }, 400: { description: Malformed input }, 401: { description: Authentication required }, 403: { description: Authority denied }, 404: { description: Draft or mission not authorized }, 409: { description: Conflicting replay } }
 */
router.post('/missions/:missionId/drafts/:draftId/release-review', route('Release review', async (req, res) => {
  const input = parse(ReleaseReviewSchema, { ...req.body }, 'release review');
  const paths = parse(z.object({ missionId: UuidSchema, draftId: UuidSchema }).strict(), req.params, 'release review path');
  const result = await reviewBountyDraftRelease({ ...input, ...paths, actor: actor(req), idempotencyKey: idempotencyKey(req) });
  res.status(result.replayed ? 200 : 201).json(result);
}));

function listRoute(
  label: string,
  allowRaw: boolean,
  handler: (context: { workspaceId: string; programId: string; missionId: string; actor: string; pagination: ReturnType<typeof parsePaginationParams> }, raw: boolean) => Promise<unknown>,
): RequestHandler {
  return route(label, async (req, res) => {
    const input = parse(PaginationQuerySchema, merged(req), `${label.toLowerCase()} query`);
    if (!allowRaw && input.raw !== undefined) throw new ValidationError('raw is not supported for this inspection operation');
    assertRawAuthority(req);
    res.json(await handler({ workspaceId: input.workspaceId, programId: input.programId, missionId: input.missionId, actor: actor(req), pagination: parsePaginationParams(req, { limit: 50, maxLimit: 100 }) }, rawRequested(req)));
  });
}

function missionMutation<T extends z.ZodTypeAny>(
  label: string,
  schema: T,
  handler: (command: z.infer<T> & { missionId: string; actor: string; idempotencyKey: string }) => Promise<Record<string, unknown>>,
  createdStatus?: 201,
): RequestHandler {
  return route(label, async (req, res) => {
    const command = parse(schema, { ...req.body, ...req.params }, `${label.toLowerCase()} command`) as z.infer<T> & { missionId: string };
    const result = await handler({ ...command, actor: actor(req), idempotencyKey: idempotencyKey(req) });
    res.status(result.replayed ? 200 : (createdStatus ?? 200)).json(result);
  });
}

export default router;
