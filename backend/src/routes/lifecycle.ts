/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type Request } from 'express';
import { z } from 'zod';
import { queryOne } from '../db/index';
import { ForbiddenError, NotFoundError, ValidationError } from '../lib/errors';
import { generatePhaseAdvice } from '../lib/phase-advisor';
import { requireWorkspaceAdmin, requireWorkspaceMember } from '../lib/auth-utils';
import { isLocalhostAddress } from '../lib/mcp-auth';
import {
  openLifecycleSourceArtifact,
  readLifecycleSourceArtifact,
  type LifecycleSourceMaterial,
} from '../lib/lifecycle-source-material';
import { resolveGenesisSource, type ResolvedGenesisSource } from '../lib/source-adapters/genesis';
import { createGenesisAuthorityBridge } from '../ssdlc/genesis/genesis-authority-bridge';
import { generateLearnCloseoutCandidates } from '../lib/learn-closeout';
import { emitLifecycleInvalidation } from '../lib/lifecycle-mutations';
import { getLifecycleOperationsReport, recordLifecycleEvaluatorError } from '../lib/lifecycle-operations';
import { parsePaginationParams } from '../lib/paginate';
import {
  assertLifecyclePortfolioFilters,
  assertPhaseId,
  assertSnapshotId,
  getLifecycleEvidence,
  getLifecyclePhase,
  getLifecyclePortfolio,
  getLifecycleSpec,
} from '../lib/ssdlc-lifecycle-read';

const router = Router();
const genesisAuthorityBridge = createGenesisAuthorityBridge();
const OpenSourceArtifactBodySchema = z.object({
  relativePath: z.string().trim().min(1).max(2_048),
  action: z.enum(['open', 'reveal']).default('open'),
  line: z.number().int().min(1).max(10_000_000).nullable().optional(),
  column: z.number().int().min(1).max(1_000_000).nullable().optional(),
}).strict();

function queryText(req: Request, name: string, required = false): string | undefined {
  const value = req.query[name];
  if (value === undefined) {
    if (required) throw new ValidationError(`${name} is required`, { field: name });
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`${name} must be a non-empty string`, { field: name });
  return value.trim();
}

function pathText(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${name} must be a non-empty path parameter`, { field: name });
  }
  return value.trim();
}

function requireDirectLocalRequest(req: Request): void {
  const forwarded = [
    'forwarded',
    'via',
    'x-real-ip',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-port',
    'x-forwarded-proto',
  ].some((header) => req.headers[header] !== undefined);
  if (forwarded || req.ips.length > 0
    || !isLocalhostAddress(req.ip) || !isLocalhostAddress(req.socket.remoteAddress)) {
    throw new ForbiddenError('Lifecycle source artifacts are available only to direct local-host requests');
  }
}

async function requireGenesisArtifactClearance(input: {
  req: Request;
  workspaceId: string;
  specId: string;
  sourceMaterial: LifecycleSourceMaterial | undefined;
}): Promise<void> {
  const { sourceMaterial } = input;
  if (!input.req.user || !sourceMaterial || sourceMaterial.state !== 'available') {
    throw new ForbiddenError('Canonical Genesis source artifact authority is required');
  }
  if (sourceMaterial.authority.status !== 'verified' || sourceMaterial.package.authoritative !== true) {
    throw new ForbiddenError('Canonical Genesis source artifact authority is not verified');
  }
  let resolved: ResolvedGenesisSource;
  try {
    resolved = await resolveGenesisSource({
      kind: 'genesis_package',
      id: sourceMaterial.package.packageId,
      principalId: input.req.user.id,
    }, genesisAuthorityBridge);
  } catch (error) {
    if (error instanceof ValidationError && /was not found$/.test(error.message)) {
      throw new NotFoundError(error.message);
    }
    throw error;
  }
  if (resolved.sections.some((section) => section.redacted)) {
    throw new ForbiddenError('Genesis sensitivity clearance does not permit raw artifact access');
  }
  const publication = resolved.genesis.publicationAuthority;
  const authority = sourceMaterial.authority;
  if (!publication
    || publication.workspaceId !== input.workspaceId
    || publication.specSlug !== input.specId
    || publication.packageId !== sourceMaterial.package.packageId
    || publication.receiptId !== authority.receiptId
    || publication.receiptHash !== authority.receiptHash
    || publication.manifestHash !== authority.manifestHash
    || publication.packageHash !== sourceMaterial.package.contentHash
    || publication.previewHash !== sourceMaterial.package.previewHash
    || publication.snapshotHash !== sourceMaterial.package.snapshotHash
    || publication.releaseSubjectHash !== authority.releaseSubject?.value) {
    throw new ForbiddenError('Genesis publication authority does not match the projected source package');
  }
}

async function requireGenesisArtifactPreviewClearance(input: {
  req: Request;
  workspaceId: string;
  specId: string;
  sourceMaterial: LifecycleSourceMaterial | undefined;
}): Promise<void> {
  const { sourceMaterial } = input;
  if (!input.req.user || !sourceMaterial || sourceMaterial.state !== 'available') {
    throw new ForbiddenError('Projected Genesis source artifact authority is required');
  }
  if (sourceMaterial.authority.status === 'context_only'
    && sourceMaterial.package.authoritative === false
    && sourceMaterial.package.publicationStatus === 'draft-not-published') {
    return;
  }
  await requireGenesisArtifactClearance(input);
}

function optionalPositiveInteger(req: Request, name: string): number | null {
  const value = queryText(req, name);
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) throw new ValidationError(`${name} must be a positive integer`, { field: name });
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000_000) {
    throw new ValidationError(`${name} must be a positive bounded integer`, { field: name });
  }
  return parsed;
}


function validatePagination(req: Request, maxLimit: number): void {
  for (const field of ['limit', 'page', 'offset'] as const) {
    const value = req.query[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new ValidationError(`${field} must be an integer`, { field });
    const number = Number(value);
    const minimum = field === 'offset' ? 0 : 1;
    if (!Number.isSafeInteger(number) || number < minimum) throw new ValidationError(`${field} must be at least ${minimum}`, { field });
    if (field === 'limit' && number > maxLimit) throw new ValidationError(`limit must be at most ${maxLimit}`, { field });
  }
  if (req.query.cursor !== undefined) {
    if (typeof req.query.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(req.query.cursor)) {
      throw new ValidationError('cursor must be a bounded opaque base64url string', { field: 'cursor' });
    }
  }
}

function withoutLifecycleSourceBodies<T>(value: T): T {
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const redacted = withoutLifecycleSourceBodies(item);
      changed ||= redacted !== item;
      return redacted;
    });
    return (changed ? items : value) as T;
  }
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  let changed = false;
  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === 'sourceMaterial' && child && typeof child === 'object' && !Array.isArray(child)) {
      const material = child as Record<string, unknown>;
      const synthesis = material.synthesis;
      if (synthesis && typeof synthesis === 'object' && !Array.isArray(synthesis)) {
        const synthesisRecord = synthesis as Record<string, unknown>;
        if (Array.isArray(synthesisRecord.sections)) {
          let sectionsChanged = false;
          const sections = synthesisRecord.sections.map((section) => {
            if (!section || typeof section !== 'object' || Array.isArray(section)
              || !Object.prototype.hasOwnProperty.call(section, 'content')) return section;
            const metadata = { ...(section as Record<string, unknown>) };
            delete metadata.content;
            sectionsChanged = true;
            return metadata;
          });
          if (sectionsChanged) {
            redacted[key] = {
              ...material,
              synthesis: { ...synthesisRecord, sections },
            };
            changed = true;
            continue;
          }
        }
      }
    }
    const nextChild = withoutLifecycleSourceBodies(child);
    changed ||= nextChild !== child;
    redacted[key] = nextChild;
  }
  return (changed ? redacted : value) as T;
}

/**
 * @swagger
 * /api/lifecycle:
 *   get:
 *     tags: [Lifecycle]
 *     summary: Read one paginated evaluated lifecycle portfolio
 *     operationId: getLifecyclePortfolio
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "The aggregate contains workspace-owned delivery, risk, assignment, blocker, and run-liveness metadata; workspace membership is required and source-pack body bytes are never embedded."
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: search
 *         schema: { type: string, maxLength: 200 }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [not_started, in_progress, blocked, awaiting_approval, passed, deferred, not_applicable, stale, needs_compilation] }
 *       - in: query
 *         name: specStatus
 *         schema: { type: string, enum: [pending, approved, completed, rejected] }
 *       - in: query
 *         name: phase
 *         schema: { type: string, enum: [planning, requirements, design, development, testing, deployment, maintenance] }
 *       - in: query
 *         name: risk
 *         schema: { type: string, enum: [low, medium, high, critical] }
 *       - in: query
 *         name: owner
 *         schema: { type: string }
 *       - in: query
 *         name: blocked
 *         schema: { type: boolean }
 *       - in: query
 *         name: disposition
 *         schema: { type: string, enum: [required, deferred, not_applicable] }
 *       - in: query
 *         name: sort
 *         schema: { type: string, enum: [current_view, updated_desc, title_asc, risk_desc, readiness_desc, owner_asc], default: current_view }
 *       - in: query
 *         name: snapshotId
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 25 }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *     responses:
 *       200: { description: Paginated lifecycle portfolio with one evaluator snapshot set and no embedded source body bytes }
 *       400: { description: Invalid workspace, filter, sort, or pagination boundary }
 *       403: { description: Workspace membership required }
 *       404: { description: Workspace not found }
 *       409: { description: Requested snapshot is stale or the bounded view must be narrowed }
 */
router.get('/', requireWorkspaceMember(), async (req, res, next) => {
  try {
    const workspaceId = queryText(req, 'workspaceId', true)!;
    validatePagination(req, 100);
    const filters = assertLifecyclePortfolioFilters({
      search: req.query.search,
      status: req.query.status,
      specStatus: req.query.specStatus,
      phase: req.query.phase,
      stage: req.query.stage,
      risk: req.query.risk,
      owner: req.query.owner,
      blocked: req.query.blocked,
      disposition: req.query.disposition,
      sort: req.query.sort,
      snapshotId: req.query.snapshotId,
    });
    const result = await getLifecyclePortfolio({
      workspaceId,
      ...filters,
      pagination: parsePaginationParams(req, { limit: 25, maxLimit: 100 }),
    });
    res.json(withoutLifecycleSourceBodies(result));
  } catch (error) {
    await recordLifecycleEvaluatorError({
      workspaceId: typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined,
      operation: 'portfolio',
      error,
    });
    next(error);
  }
});

/**
 * @swagger
 * /api/lifecycle/operations:
 *   get:
 *     tags: [Lifecycle]
 *     summary: Read bounded Lifecycle rollout progress and health counters
 *     operationId: getLifecycleOperations
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Workspace-wide compiler, evidence-adapter, denial, and rollout diagnostics require workspace administrator authority and never include evidence payloads."
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Bounded plan coverage, backfill progress, blocked phases, retry actions, and redacted 24-hour health counters }
 *       400: { description: Invalid workspace scope }
 *       403: { description: Workspace administrator authority required }
 *       404: { description: Workspace not found }
 *       409: { description: Workspace exceeds the bounded rollout view }
 */
router.get('/operations', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    const workspaceId = queryText(req, 'workspaceId', true)!;
    res.json(await getLifecycleOperationsReport({ workspaceId }));
  } catch (error) {
    await recordLifecycleEvaluatorError({
      workspaceId: typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined,
      operation: 'operations',
      error,
    });
    next(error);
  }
});

/**
 * @swagger
 * /api/lifecycle/specs/{specId}:
 *   get:
 *     tags: [Lifecycle]
 *     summary: Read one evaluated lifecycle spec aggregate
 *     operationId: getLifecycleSpec
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Spec lifecycle traceability, provenance, decisions, and current-run context are workspace-owned delivery metadata available only to workspace members; source-pack body bytes are never embedded."
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: snapshotId
 *         schema: { type: string }
 *     responses:
 *       200: { description: Evaluated spec detail or stable needs_compilation shape without embedded source body bytes }
 *       400: { description: Invalid scope }
 *       403: { description: Workspace membership required }
 *       404: { description: Workspace or spec not found }
 *       409: { description: Requested snapshot is stale and refresh is required }
 */
router.get('/specs/:specId', requireWorkspaceMember(), async (req, res, next) => {
  try {
    const workspaceId = queryText(req, 'workspaceId', true)!;
    const specId = pathText(req, 'specId');
    const snapshotId = assertSnapshotId(req.query.snapshotId);
    res.json(withoutLifecycleSourceBodies(await getLifecycleSpec({ workspaceId, specId, expectedSnapshotId: snapshotId })));
  } catch (error) {
    await recordLifecycleEvaluatorError({
      workspaceId: typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined,
      specId: typeof req.params.specId === 'string' ? req.params.specId : undefined,
      operation: 'spec',
      error,
    });
    next(error);
  }
});

/**
 * @swagger
 * /api/lifecycle/specs/{specId}/phases/{phaseId}:
 *   get:
 *     tags: [Lifecycle]
 *     summary: Read one evaluated lifecycle phase with bounded evidence
 *     operationId: getLifecyclePhase
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Phase blockers, governed decisions, and evidence provenance are workspace-owned delivery metadata available only to workspace members; source-pack metadata remains visible but source body bytes are never embedded."
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: phaseId
 *         required: true
 *         schema: { type: string, enum: [planning, requirements, design, development, testing, deployment, maintenance] }
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: snapshotId
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 25 }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *     responses:
 *       200: { description: Evaluated phase detail with deterministic paginated evidence, provenance summaries, and no embedded source body bytes }
 *       400: { description: Invalid phase, scope, snapshot, or pagination boundary }
 *       403: { description: Workspace membership required }
 *       404: { description: Workspace, spec, or phase not found }
 *       409: { description: Requested snapshot is stale and refresh is required }
 */
router.get('/specs/:specId/phases/:phaseId', requireWorkspaceMember(), async (req, res, next) => {
  try {
    const workspaceId = queryText(req, 'workspaceId', true)!;
    const specId = pathText(req, 'specId');
    const phaseId = assertPhaseId(pathText(req, 'phaseId'));
    const snapshotId = assertSnapshotId(req.query.snapshotId);
    validatePagination(req, 100);
    res.json(withoutLifecycleSourceBodies(await getLifecyclePhase({
      workspaceId,
      specId,
      phaseId,
      expectedSnapshotId: snapshotId,
      evidencePagination: parsePaginationParams(req, { limit: 25, maxLimit: 100 }),
    })));
  } catch (error) {
    await recordLifecycleEvaluatorError({
      workspaceId: typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined,
      specId: typeof req.params.specId === 'string' ? req.params.specId : undefined,
      operation: 'phase',
      error,
    });
    next(error);
  }
});

/**
 * @swagger
 * /api/lifecycle/specs/{specId}/source-artifacts/content:
 *   get:
 *     tags: [Lifecycle]
 *     summary: Read one bounded projected Genesis export artifact
 *     operationId: readLifecycleSourceArtifact
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Workspace members making a direct, unforwarded local-host request may preview a bounded artifact from the exact projected draft package; path, size, and content hash are revalidated on every read. Canonical publication and Genesis sensitivity clearance remain mandatory for editor open or folder reveal."
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: relativePath
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: startLine
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: endLine
 *         schema: { type: integer, minimum: 1 }
 *     responses:
 *       200: { description: Bounded text preview with source hashes and line range }
 *       400: { description: Invalid, binary, oversized, or non-projected artifact path }
 *       403: { description: Workspace membership and a direct unforwarded local-host request are required; non-draft packages must also have canonical publication authority and Genesis sensitivity clearance }
 *       404: { description: Workspace, spec, registered canonical source package, or artifact not found }
 */
router.get('/specs/:specId/source-artifacts/content', requireWorkspaceMember(), async (req, res, next) => {
  try {
    requireDirectLocalRequest(req);
    const workspaceId = queryText(req, 'workspaceId', true)!;
    const specId = pathText(req, 'specId');
    const relativePath = queryText(req, 'relativePath', true)!;
    const startLine = optionalPositiveInteger(req, 'startLine');
    const endLine = optionalPositiveInteger(req, 'endLine');
    if (startLine !== null && endLine !== null && endLine < startLine) {
      throw new ValidationError('endLine must be at or after startLine', { field: 'endLine' });
    }
    const phase = await getLifecyclePhase({
      workspaceId,
      specId,
      phaseId: 'planning',
      evidencePagination: { limit: 1, offset: 0, cursor: null, usedCursor: false },
    });
    await requireGenesisArtifactPreviewClearance({ req, workspaceId, specId, sourceMaterial: phase.sourceMaterial });
    if (!phase.sourceMaterial || phase.sourceMaterial.state !== 'available') {
      throw new NotFoundError('Lifecycle source package', specId);
    }
    const workspace = await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id = $1', [workspaceId]);
    if (!workspace) throw new NotFoundError('Workspace', workspaceId);
    res.json(await readLifecycleSourceArtifact({
      workspacePath: workspace.path,
      artifacts: phase.sourceMaterial.artifacts,
      relativePath,
      startLine,
      endLine,
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/lifecycle/specs/{specId}/source-artifacts/open:
 *   post:
 *     tags: [Lifecycle]
 *     summary: Open one projected Genesis export artifact in the local editor
 *     operationId: openLifecycleSourceArtifact
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Launching a local editor or file-manager process is an operator-only host side effect, restricted to workspace administrators making a direct, unforwarded local-host request after the Genesis bridge grants that exact principal sensitivity clearance and canonical publication authority matches the projected package."
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [relativePath]
 *             properties:
 *               relativePath: { type: string }
 *               action: { type: string, enum: [open, reveal], default: open }
 *               line: { type: integer, minimum: 1, nullable: true }
 *               column: { type: integer, minimum: 1, nullable: true }
 *     responses:
 *       200: { description: Local editor launch accepted }
 *       400: { description: Invalid or non-projected artifact path }
 *       403: { description: Workspace administrator, direct unforwarded local-host authority, canonical publication binding, and Genesis sensitivity clearance required }
 *       404: { description: Workspace, spec, registered canonical source package, or artifact not found }
 */
router.post('/specs/:specId/source-artifacts/open', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    requireDirectLocalRequest(req);
    const workspaceId = queryText(req, 'workspaceId', true)!;
    const specId = pathText(req, 'specId');
    const body = OpenSourceArtifactBodySchema.parse(req.body);
    const phase = await getLifecyclePhase({
      workspaceId,
      specId,
      phaseId: 'planning',
      evidencePagination: { limit: 1, offset: 0, cursor: null, usedCursor: false },
    });
    await requireGenesisArtifactClearance({ req, workspaceId, specId, sourceMaterial: phase.sourceMaterial });
    if (!phase.sourceMaterial || phase.sourceMaterial.state !== 'available') {
      throw new NotFoundError('Lifecycle source package', specId);
    }
    const workspace = await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id = $1', [workspaceId]);
    if (!workspace) throw new NotFoundError('Workspace', workspaceId);
    res.json(await openLifecycleSourceArtifact({
      workspacePath: workspace.path,
      artifacts: phase.sourceMaterial.artifacts,
      relativePath: body.relativePath,
      action: body.action,
      line: body.line,
      column: body.column,
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/lifecycle/specs/{specId}/advice:
 *   post:
 *     tags: [Lifecycle]
 *     summary: Generate ephemeral advisory suggestions for one phase (never persisted)
 *     operationId: generateLifecyclePhaseAdvice
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Model-backed advisory suggestions for a workspace-owned spec phase are read-only and never persisted as evidence, so workspace members may trigger them but public/MCP automation cannot spend model budget."
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [phaseId]
 *             properties:
 *               phaseId: { type: string, enum: [planning, requirements, design, development, testing, deployment, maintenance] }
 *               storyId: { type: string }
 *     responses:
 *       200: { description: Advisory suggestions with citations; advisory is always true and nothing is persisted }
 *       400: { description: Invalid phase, scope, or story reference }
 *       403: { description: Workspace membership required }
 *       404: { description: Workspace or spec not found }
 *       422: { description: Advisor output did not satisfy the cited-suggestion contract }
 */
router.post('/specs/:specId/advice', requireWorkspaceMember(), async (req, res, next) => {
  try {
    const workspaceId = queryText(req, 'workspaceId', true)!;
    const specId = pathText(req, 'specId');
    const phaseId = assertPhaseId(req.body?.phaseId);
    let storyId: string | undefined;
    if (req.body?.storyId !== undefined) {
      if (typeof req.body.storyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(req.body.storyId)) {
        throw new ValidationError('storyId must be a stable story id', { field: 'storyId' });
      }
      storyId = req.body.storyId;
    }
    res.json(await generatePhaseAdvice({ workspaceId, specId, phaseId, storyId }));
  } catch (error) {
    await recordLifecycleEvaluatorError({
      workspaceId: typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined,
      specId: typeof req.params.specId === 'string' ? req.params.specId : undefined,
      operation: 'advice',
      error,
    });
    next(error);
  }
});

/**
 * @swagger
 * /api/lifecycle/specs/{specId}/runs/{runId}/learn-closeout:
 *   post:
 *     tags: [Lifecycle]
 *     summary: Retry governed Learn closeout candidate generation for a terminal run
 *     operationId: generateLifecycleLearnCloseout
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Closeout generation stages workspace-owned review candidates and lifecycle evidence, so it is a local operator-only recovery action."
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               modelSummarization: { type: boolean, default: false }
 *     responses:
 *       200: { description: Deterministic candidates generated or deduplicated }
 *       400: { description: Invalid scope }
 *       404: { description: Workspace-scoped run not found }
 *       403: { description: Workspace administrator authority required }
 *       409: { description: Run is not terminal }
 */
router.post('/specs/:specId/runs/:runId/learn-closeout', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    const workspaceId = queryText(req, 'workspaceId', true)!;
    const specId = pathText(req, 'specId');
    const runId = Number(pathText(req, 'runId'));
    if (!Number.isSafeInteger(runId) || runId <= 0) throw new ValidationError('runId must be a positive integer', { field: 'runId' });
    if (req.body?.modelSummarization !== undefined && typeof req.body.modelSummarization !== 'boolean') {
      throw new ValidationError('modelSummarization must be a boolean', { field: 'modelSummarization' });
    }
    const result = await generateLearnCloseoutCandidates({
      workspaceId,
      specId,
      runId,
      modelSummarization: req.body?.modelSummarization === true,
    });
    await emitLifecycleInvalidation({ workspaceId, specId, phaseId: 'maintenance', runId, changeKind: 'evidence_persisted' });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/lifecycle/evidence/{evidenceId}:
 *   get:
 *     tags: [Lifecycle]
 *     summary: Read redacted normalized lifecycle evidence pinned to an evaluator snapshot
 *     operationId: getLifecycleEvidence
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Evidence provenance and raw-reference locations are sensitive workspace-owned audit metadata; workspace members receive sanitized fields and never embedded raw payloads."
 *     parameters:
 *       - in: path
 *         name: evidenceId
 *         required: true
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: snapshotId
 *         schema: { type: string }
 *     responses:
 *       200: { description: Redacted immutable evidence metadata and raw-reference permission }
 *       400: { description: Invalid workspace or evidence identity }
 *       403: { description: Workspace membership required }
 *       404: { description: Workspace-scoped evidence not found }
 *       409: { description: Caller snapshot changed; refresh is required and no evidence item was silently substituted }
 */
router.get('/evidence/:evidenceId', requireWorkspaceMember(), async (req, res, next) => {
  try {
    const workspaceId = queryText(req, 'workspaceId', true)!;
    const snapshotId = assertSnapshotId(req.query.snapshotId);
    res.json(await getLifecycleEvidence({ workspaceId, evidenceId: pathText(req, 'evidenceId'), expectedSnapshotId: snapshotId }));
  } catch (error) {
    await recordLifecycleEvaluatorError({
      workspaceId: typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined,
      operation: 'evidence',
      error,
    });
    next(error);
  }
});

export default router;
