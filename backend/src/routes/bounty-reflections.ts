/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { handleRouteError } from '../lib/async-handler';
import {
  BOUNTY_REFLECTION_KINDS,
  createBountyLessonCandidate,
  getBountyLessonCandidateForReview,
  loadPinnedBountyLessons,
  pinBountyLessonsForMission,
  recordBountyMissionCloseout,
  recordBountyProgramReflection,
  reviewBountyLessonCandidate,
  reviseBountyLessonCandidate,
} from '../lib/bounty-reflection';
import { AdminRequiredError, AuthError, ValidationError } from '../lib/errors';

const router = Router();
const Id = z.string().uuid();
const Hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const WorkspaceId = z.string().trim().min(1).max(128);
const LessonDraft = z.object({
  category: z.enum(['Architecture', 'Convention', 'Bug Fix', 'Decision', 'Pattern', 'Gotcha']),
  title: z.string().trim().min(1).max(240),
  rule: z.string().trim().min(1).max(4_000),
  context: z.string().trim().min(1).max(8_000),
}).strict();
const ReflectionSchema = z.object({
  workspaceId: WorkspaceId, programId: Id, sourceMissionId: Id,
  kind: z.enum(BOUNTY_REFLECTION_KINDS), subjectFingerprint: Hash,
  observation: z.string().trim().min(1).max(1_000_000),
}).strict();
const CloseoutSchema = z.object({
  workspaceId: WorkspaceId, programId: Id, missionId: Id,
  closeout: z.unknown().refine((value) => value !== undefined, 'closeout is required'),
}).strict();
const CandidateSchema = z.object({
  workspaceId: WorkspaceId, sourceCloseoutId: Id, draft: LessonDraft,
  subjectFingerprints: z.array(Hash).max(256).default([]),
}).strict();
const RevisionSchema = z.object({
  workspaceId: WorkspaceId, draft: LessonDraft,
  editReason: z.string().trim().min(1).max(1_000),
}).strict();
const ReviewSchema = z.object({
  workspaceId: WorkspaceId, revision: z.number().int().positive(),
  expectedCandidateHash: Hash, expectedRedactionManifestHash: Hash, expectedSourceCloseoutHash: Hash,
  decision: z.enum(['approved', 'rejected']), reason: z.string().trim().min(1).max(2_000),
}).strict();
const PinSchema = z.object({ workspaceId: WorkspaceId, lessonHashes: z.array(Hash).min(1).max(256) }).strict();

function requireBountyAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') return next(new AdminRequiredError());
  if (req.authSource !== 'bearer') return next(new AuthError('Credential-authenticated admin required for bounty reflection governance'));
  next();
}
function actor(req: Request): string { return `${req.user!.id}:${req.user!.email}`; }
function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError(message, { issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
  return result.data;
}
function route(handler: (req: Request, res: Response) => Promise<void>): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    try { await handler(req, res); } catch (error: unknown) { handleRouteError(res, error, '[Bounty reflection]'); }
  };
}

/**
 * @swagger
 * /api/admin/bounty/reflections:
 *   post:
 *     tags: [Admin]
 *     summary: Record program-scoped false-positive, rejection, duplicate, dead-gadget, or disclosure reflection
 *     operationId: recordAdminBountyReflection
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Raw bounty reflection can contain target evidence and identifiers; only credential-authenticated operators may persist it inside its program boundary."
 *     x-rorca-mcp: false
 *     responses:
 *       201: { description: Program-scoped reflection recorded with a visible reason code }
 *       200: { description: Exact idempotent reflection replay }
 *       400: { description: Invalid strict reflection payload }
 *       401: { description: Credential-authenticated operator required }
 *       403: { description: Admin required }
 *       404: { description: Program mission not found }
 *       409: { description: Fingerprint replay changed observation bytes }
 */
router.post('/reflections', requireBountyAdmin, route(async (req, res) => {
  const body = parse(ReflectionSchema, req.body, 'Invalid bounty reflection');
  const result = await recordBountyProgramReflection({ ...body, actor: actor(req) });
  res.status(result.replayed ? 200 : 201).json(result);
}));

/**
 * @swagger
 * /api/admin/bounty/closeouts:
 *   post:
 *     tags: [Admin]
 *     summary: Store an exact program-scoped bounty mission closeout
 *     operationId: recordAdminBountyCloseout
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Closeouts are sensitive program-scoped source records and are never direct memory inputs or MCP-visible."
 *     x-rorca-mcp: false
 *     responses:
 *       201: { description: Exact closeout bytes recorded }
 *       200: { description: Exact closeout replay }
 *       400: { description: Invalid strict closeout payload }
 *       401: { description: Credential-authenticated operator required }
 *       403: { description: Admin required }
 *       404: { description: Program mission not found }
 */
router.post('/closeouts', requireBountyAdmin, route(async (req, res) => {
  const body = parse(CloseoutSchema, req.body, 'Invalid bounty closeout');
  const result = await recordBountyMissionCloseout({ ...body, actor: actor(req) });
  res.status(result.replayed ? 200 : 201).json(result);
}));

/**
 * @swagger
 * /api/admin/bounty/lesson-candidates:
 *   post:
 *     tags: [Admin]
 *     summary: Convert a closeout observation into a sanitized pending lesson candidate
 *     operationId: createAdminBountyLessonCandidate
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Candidate admission runs program reflection and stores review-only sanitized bytes; pending bytes are excluded from retrieval and MCP."
 *     x-rorca-mcp: false
 *     responses:
 *       201: { description: Sanitized pending candidate and reflection reason codes }
 *       200: { description: Program-local exact-byte duplicate }
 *       400: { description: Invalid strict candidate payload }
 *       401: { description: Credential-authenticated operator required }
 *       403: { description: Reflection blocked candidate admission }
 *       404: { description: Source closeout not found }
 */
router.post('/lesson-candidates', requireBountyAdmin, route(async (req, res) => {
  const body = parse(CandidateSchema, req.body, 'Invalid bounty lesson candidate');
  const result = await createBountyLessonCandidate({ ...body, actor: actor(req) });
  res.status(result.replayed ? 200 : 201).json(result);
}));

/**
 * @swagger
 * /api/admin/bounty/lesson-candidates/{lineageId}:
 *   get:
 *     tags: [Admin]
 *     summary: Inspect exact sanitized candidate bytes on the explicit review surface
 *     operationId: getAdminBountyLessonCandidateForReview
 *     parameters:
 *       - { in: path, name: lineageId, required: true, schema: { type: string } }
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Pending candidate bytes are visible only to credential-authenticated reviewers on this dedicated review endpoint, never through memory or mission retrieval."
 *     x-rorca-mcp: false
 *     responses:
 *       200: { description: Exact candidate bytes, manifest and review status }
 *       400: { description: Invalid candidate, workspace, or revision }
 *       401: { description: Credential-authenticated reviewer required }
 *       403: { description: Admin required }
 *       404: { description: Candidate revision not found }
 */
router.get('/lesson-candidates/:lineageId', requireBountyAdmin, route(async (req, res) => {
  const lineageId = parse(Id, req.params.lineageId, 'Invalid lesson candidate lineage id');
  const query = parse(z.object({ workspaceId: WorkspaceId, revision: z.coerce.number().int().positive().optional() }).strict(), req.query, 'Invalid lesson candidate review query');
  res.json(await getBountyLessonCandidateForReview({ ...query, lineageId }));
}));

/**
 * @swagger
 * /api/admin/bounty/lesson-candidates/{lineageId}/revisions:
 *   post:
 *     tags: [Admin]
 *     summary: Create a new immutable sanitized candidate revision
 *     operationId: reviseAdminBountyLessonCandidate
 *     parameters:
 *       - { in: path, name: lineageId, required: true, schema: { type: string } }
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Candidate edits and rejected-candidate revisits must create new exact bytes for a fresh review and remain operator-only."
 *     x-rorca-mcp: false
 *     responses:
 *       201: { description: New immutable candidate revision }
 *       200: { description: Exact current-revision replay }
 *       400: { description: Invalid strict revision payload }
 *       401: { description: Credential-authenticated operator required }
 *       403: { description: Admin required }
 *       404: { description: Candidate lineage not found }
 *       409: { description: Edited bytes duplicate another program candidate }
 */
router.post('/lesson-candidates/:lineageId/revisions', requireBountyAdmin, route(async (req, res) => {
  const lineageId = parse(Id, req.params.lineageId, 'Invalid lesson candidate lineage id');
  const body = parse(RevisionSchema, req.body, 'Invalid bounty lesson candidate revision');
  const result = await reviseBountyLessonCandidate({ ...body, lineageId, actor: actor(req) });
  res.status(result.replayed ? 200 : 201).json(result);
}));

/**
 * @swagger
 * /api/admin/bounty/lesson-candidates/{lineageId}/review:
 *   post:
 *     tags: [Admin]
 *     summary: Review exact candidate bytes, redaction manifest, and source closeout
 *     operationId: reviewAdminBountyLessonCandidate
 *     parameters:
 *       - { in: path, name: lineageId, required: true, schema: { type: string } }
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Exact review may promote generalized bytes into cross-program lessons, so it is bound to the credential-authenticated reviewer and excluded from MCP."
 *     x-rorca-mcp: false
 *     responses:
 *       201: { description: Exact approved or rejected review }
 *       200: { description: Exact review replay }
 *       400: { description: Invalid strict review payload }
 *       401: { description: Credential-authenticated reviewer required }
 *       403: { description: Admin required }
 *       404: { description: Candidate revision not found }
 *       409: { description: Reviewed bytes or review authority changed }
 */
router.post('/lesson-candidates/:lineageId/review', requireBountyAdmin, route(async (req, res) => {
  const lineageId = parse(Id, req.params.lineageId, 'Invalid lesson candidate lineage id');
  const body = parse(ReviewSchema, req.body, 'Invalid bounty lesson candidate review');
  const result = await reviewBountyLessonCandidate({ ...body, lineageId, reviewer: actor(req) });
  res.status(result.replayed ? 200 : 201).json(result);
}));

/**
 * @swagger
 * /api/admin/bounty/missions/{missionId}/lesson-pins:
 *   post:
 *     tags: [Admin]
 *     summary: Pin exact reviewed lesson hashes for a later bounty mission
 *     operationId: pinAdminBountyMissionLessons
 *     parameters:
 *       - { in: path, name: missionId, required: true, schema: { type: string } }
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Lesson pinning changes immutable mission context and enforces later-mission-only loading; it is operator-only and excluded from MCP."
 *     x-rorca-mcp: false
 *     responses:
 *       201: { description: Exact lesson hashes pinned }
 *       400: { description: Invalid strict pin payload }
 *       401: { description: Credential-authenticated operator required }
 *       403: { description: Same-mission or non-later loading forbidden }
 *       404: { description: Mission or exact lesson hash not found }
 */
router.post('/missions/:missionId/lesson-pins', requireBountyAdmin, route(async (req, res) => {
  const missionId = parse(Id, req.params.missionId, 'Invalid bounty mission id');
  const body = parse(PinSchema, req.body, 'Invalid bounty lesson pins');
  const result = await pinBountyLessonsForMission({ ...body, missionId, actor: actor(req) });
  res.status(201).json(result);
}));

/**
 * @swagger
 * /api/admin/bounty/missions/{missionId}/lessons:
 *   get:
 *     tags: [Admin]
 *     summary: Retrieve only exact reviewed lessons pinned to a bounty mission
 *     operationId: getAdminBountyMissionLessons
 *     parameters:
 *       - { in: path, name: missionId, required: true, schema: { type: string } }
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Mission lesson retrieval is operator-only and structurally excludes all pending and rejected candidates."
 *     x-rorca-mcp: false
 *     responses:
 *       200: { description: Exact pinned generalized lessons; never pending candidates }
 *       400: { description: Invalid mission or workspace id }
 *       401: { description: Credential-authenticated operator required }
 *       403: { description: Same-mission loading guard failed }
 */
router.get('/missions/:missionId/lessons', requireBountyAdmin, route(async (req, res) => {
  const missionId = parse(Id, req.params.missionId, 'Invalid bounty mission id');
  const workspaceId = parse(WorkspaceId, req.query.workspaceId, 'Invalid workspace id');
  res.json({ missionId, lessons: await loadPinnedBountyLessons({ workspaceId, missionId }) });
}));

export default router;
