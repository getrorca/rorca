/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { queryOne } from '../db/index';
import { NotFoundError, UnprocessableError, ValidationError } from '../lib/errors';
import { INTERNAL_SERVICE_TOKEN } from '../lib/auth-utils';
import { hermesAuthorityHeaders, requireHermesAction } from '../lib/hermes-authority';
import { bridgeMissionDraft, recompileMissionDraft, type MissionDraftPersistencePort, type PersistSpecDraftPayload } from '../lib/mission-draft-bridge';
import { inspectSourceDrift } from '../lib/source-drift';
import { SourceBundleV1Schema } from '../lib/source-contracts';

export type ExplicitDraftPoster = (payload: PersistSpecDraftPayload, req: Request) => Promise<Record<string, unknown>>;

async function postExplicitDraft(payload: PersistSpecDraftPayload, req: Request): Promise<Record<string, unknown>> {
  requireHermesAction(req.hermesAuthority, 'persist', 'operator-dispatch');
  const port = process.env.PORT || '3030';
  const response = await fetch(`http://127.0.0.1:${port}/api/specs/persist`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${INTERNAL_SERVICE_TOKEN}`,
      'X-Rorca-Service': 'hermes',
      ...hermesAuthorityHeaders(req.hermesAuthority!),
      ...(req.get('x-workspace-id') ? { 'x-workspace-id': req.get('x-workspace-id')! } : {}),
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    throw new UnprocessableError(
      typeof body.error === 'string' ? body.error : 'Explicit-draft persistence failed',
      'EXPLICIT_DRAFT_PERSIST_FAILED',
      { status: response.status },
    );
  }
  return body;
}

export type WorkspaceRootResolver = (workspaceId: string) => Promise<string | undefined>;

async function resolveWorkspaceRoot(workspaceId: string): Promise<string | undefined> {
  return (await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id=$1', [workspaceId]))?.path;
}

export function createHermesMissionDraftRouter(
  poster: ExplicitDraftPoster = postExplicitDraft,
  workspaceRootResolver: WorkspaceRootResolver = resolveWorkspaceRoot,
): Router {
  const router = Router();
  /**
   * @swagger
   * /api/hermes/mission-draft:
   *   post:
   *     summary: Persist a source-verified Hermes mission draft and compile its assurance controls
   *     x-rorca-tier: auth
   *     x-rorca-rationale: "Workspace-owned Hermes drafting is MCP-callable, but remains pending exact-revision assurance and approval."
   *     description: Validates a frozen SourceBundleV1, invokes only POST /api/specs/persist, then compiles US-003/US-004 controls and the AAV assurance profile for the returned exact revision.
   *     responses:
   *       200: { description: Explicit draft persisted and exact-revision assurance compiled }
   *       400: { description: Invalid mission draft contract }
   *       422: { description: Stale, mutated, or mismatched source/assurance context }
   */
  router.post('/', (req: Request, res: Response, next: NextFunction) => {
    requireHermesAction(req.hermesAuthority, 'persist', 'operator-dispatch');
    const persistencePort: MissionDraftPersistencePort = { persist: (payload) => poster(payload, req) };
    bridgeMissionDraft(req.body, persistencePort).then((result) => res.json(result)).catch(next);
  });

  /**
   * @swagger
   * /api/hermes/mission-draft/recompile:
   *   post:
   *     summary: Persist a changed source bundle as a new exact Mission revision requiring re-review
   *     x-rorca-tier: auth
   *     x-rorca-rationale: "Workspace-owned recompilation preserves historical receipts and cannot approve or affect execution without a new review."
   *     responses:
   *       200: { description: New revision and assurance receipt compiled; review remains pending }
   *       422: { description: Drift, revision, source hash, or assurance binding mismatch }
   */
  router.post('/recompile', (req: Request, res: Response, next: NextFunction) => {
    requireHermesAction(req.hermesAuthority, 'persist', 'operator-dispatch');
    const persistencePort: MissionDraftPersistencePort = { persist: (payload) => poster(payload, req) };
    recompileMissionDraft(req.body, persistencePort).then((result) => res.json(result)).catch(next);
  });

  /**
   * @swagger
   * /api/hermes/mission-draft/source-drift:
   *   post:
   *     summary: Re-hash an approved Mission's frozen source bundle
   *     x-rorca-tier: auth
   *     x-rorca-rationale: "Workspace-owned read inspection exposes exact source states and hashes but performs no source or Mission mutation."
   *     responses:
   *       200: { description: Exact source drift report }
   *       400: { description: Invalid frozen bundle }
   *       404: { description: Workspace unavailable }
   */
  router.post('/source-drift', (req: Request, res: Response, next: NextFunction) => {
    requireHermesAction(req.hermesAuthority, 'subscription', 'service-audit');
    (async () => {
      const parsed = SourceBundleV1Schema.safeParse(req.body?.sourceBundle);
      if (!parsed.success) throw new ValidationError('Invalid frozen source bundle', { issues: parsed.error.issues });
      const workspaceId = parsed.data.workspaceRef.workspaceId;
      const workspaceRoot = await workspaceRootResolver(workspaceId);
      if (!workspaceRoot) throw new NotFoundError('Workspace');
      res.json(await inspectSourceDrift(parsed.data, { workspaceRoot }));
    })().catch(next);
  });
  return router;
}

export default createHermesMissionDraftRouter();
