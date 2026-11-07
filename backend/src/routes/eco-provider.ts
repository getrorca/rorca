/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type Request } from 'express';
import { z } from 'zod';
import { AuthError, NotFoundError, ValidationError } from '../lib/errors';
import { readDispatchByKey, readScopedRunEvents, type EcoReader } from '../lib/eco-provider-read';
import { SSDLC_PLAN_COMPILER_VERSION } from '../lib/ssdlc-plan-compiler';
import { GENERAL_SDLC_7_PROFILE } from '../ssdlc/profiles/general-sdlc-7';

const literal=z.string().min(1).max(256).refine(v=>v===v.trim());
const integer=z.string().regex(/^(0|[1-9][0-9]*)$/).transform(Number).refine(Number.isSafeInteger);
function parse<T>(schema:z.ZodType<T>,value:unknown):T {const result=schema.safeParse(value);if(!result.success)throw new ValidationError('Invalid provider read request');return result.data;}
export interface EcoProviderReadDependencies {
  read:EcoReader;
  events?:(input:{workspaceId:string;runId:number;afterId:number;limit:number})=>Promise<unknown>;
  phaseWork?:(input:{workspaceId:string;phaseWorkId:string;revision:number})=>Promise<unknown>;
  plan:(input:{workspaceId:string;specId:string;snapshotId?:string})=>Promise<unknown>;
}
export async function authorizeEcoWorkspace(req:Request, read:EcoReader, value:unknown):Promise<string> {
  if(!req.user || !['bearer','internal'].includes(req.authSource??''))throw new AuthError('Credential authentication required; local fallback is not supported');
  const workspaceId=parse(literal,value);
  const membership=await read('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_auth_id = $2',[workspaceId,req.user.supabaseId]);
  if(!membership[0])throw new NotFoundError('Workspace');
  return workspaceId;
}
/** Mounted under the existing authenticated pipeline router, not a public server. */
export function createEcoProviderRouter(deps:EcoProviderReadDependencies) {
  const router=Router({strict:true,caseSensitive:true});
  router.use(async(req,_res,next)=>{try {
    await authorizeEcoWorkspace(req,deps.read,req.query.workspaceId);
    next();
  }catch(error){next(error);}});
  /**
   * @swagger
   * /api/pipeline/provider/v1/capabilities:
   *   get:
   *     operationId: getEcoProviderCapabilitiesV1
   *     summary: Read the implemented scoped ECO provider contracts
   *     x-rorca-tier: auth
   *     x-rorca-mcp: false
   *     x-rorca-rationale: Credential-authenticated exact workspace membership; no execution or approval authority.
   *     responses:
   *       200: { description: Implemented contracts and explicit unsupported capabilities }
   */
  router.get('/capabilities',(req,res,next)=>{try{
    const input=parse(z.object({workspaceId:literal}).strict(),req.query);
    res.json({contractVersion:'rorca.provider-read.v1',workspaceId:input.workspaceId,
      phases:['planning','requirements','design','development','testing','deployment','maintenance'],
      compilerVersion:SSDLC_PLAN_COMPILER_VERSION,profileHash:GENERAL_SDLC_7_PROFILE.contentHash,buildIdentity:null,
      fullCompiledPlanRead:true,dispatchByOriginalKey:true,scopedPaginatedEvents:true,phaseWorkBinding:'pin-only-v1',
      managedAdmission:false,artifactExecution:false,acceptedPhaseArtifacts:false,
      managedAdmissionTransport:'prepared-v1',managedExecutionQualification:'no-qualified-production-bounded-executor',
      authorityTransport:'existing-rest-credential-plus-exact-workspace-membership',
      limits:{eventPage:1000},deploymentQualification:'not-observed'});
  }catch(error){next(error);}});
  /**
   * @swagger
   * /api/pipeline/provider/v1/plans/{specId}:
   *   get:
   *     operationId: getEcoCompiledPlanV1
   *     summary: Read exact current validated compiled plan bytes and full native hash
   *     x-rorca-tier: auth
   *     x-rorca-mcp: false
   *     x-rorca-rationale: Credential and workspace-scoped canonical read; never compiles or changes a lifecycle.
   *     parameters:
   *       - in: path
   *         name: specId
   *         required: true
   *         schema: { type: string }
   *         description: specId identifier scoped to the credential's workspace.
   *     responses:
   *       200: { description: Full compiled plan with canonical evaluator snapshot }
   *       409: { description: Missing current plan or changed snapshot }
   */
  router.get('/plans/:specId',async(req,res,next)=>{try{
    const input=parse(z.object({workspaceId:literal,snapshotId:z.string().regex(/^sha256:[0-9a-f]{64}$/).optional()}).strict(),req.query);
    res.json(await deps.plan({...input,specId:parse(literal,req.params.specId)}));
  }catch(error){next(error);}});
  /**
   * @swagger
   * /api/pipeline/provider/v1/dispatches/by-key:
   *   get:
   *     operationId: getEcoDispatchByKeyV1
   *     summary: Reconcile retained dispatch identity without resuming publication
   *     x-rorca-tier: auth
   *     x-rorca-mcp: false
   *     x-rorca-rationale: Exact credential workspace scope; reads original key only, never retries a mutation.
   *     responses:
   *       200: { description: Retained identity, publication state and native receipt if available }
   *       404: { description: No matching scoped dispatch }
   */
  router.get('/dispatches/by-key',async(req,res,next)=>{try{
    res.json(await readDispatchByKey(deps.read,parse(z.object({workspaceId:literal,operation:z.enum(['trigger','retry']),idempotencyKey:z.string().regex(/^[A-Za-z0-9:._-]{8,256}$/)}).strict(),req.query)));
  }catch(error){next(error);}});
  /**
   * @swagger
   * /api/pipeline/provider/v1/runs/{runId}/events:
   *   get:
   *     operationId: getEcoRunEventsV1
   *     summary: Read a bounded workspace and run-scoped durable event window
   *     x-rorca-tier: auth
   *     x-rorca-mcp: false
   *     x-rorca-rationale: Credential membership before lookup, exact scoped cursor and read-only replay.
   *     parameters:
   *       - in: path
   *         name: runId
   *         required: true
   *         schema: { type: string }
   *         description: runId identifier scoped to the credential's workspace.
   *     responses:
   *       200: { description: Ordered events with nextCursor and hasMore }
   *       410: { description: CURSOR_EXPIRED; read run snapshot and explicitly restart observation }
   */
  router.get('/runs/:runId/events',async(req,res,next)=>{try{
    const input=parse(z.object({workspaceId:literal,afterId:integer.default(0),limit:integer.refine(v=>v>=1&&v<=1000).default(100)}).strict(),req.query);
    const window={...input,runId:parse(integer.refine(v=>v>0),req.params.runId)};
    res.json(await (deps.events?deps.events(window):readScopedRunEvents(deps.read,window)));
  }catch(error){next(error);}});
  /**
   * @swagger
   * /api/pipeline/provider/v1/runs/{runId}:
   *   get:
   *     operationId: getEcoRunSnapshotV1
   *     summary: Read scoped canonical run status for reconciliation
   *     x-rorca-tier: auth
   *     x-rorca-mcp: false
   *     x-rorca-rationale: Minimal status projection after credential membership; no runtime secrets or arbitrary metadata.
   *     parameters:
   *       - in: path
   *         name: runId
   *         required: true
   *         schema: { type: string }
   *         description: runId identifier scoped to the credential's workspace.
   *     responses:
   *       200: { description: Scoped canonical status snapshot }
   *       404: { description: Run is not in authorized workspace }
   */
  router.get('/runs/:runId',async(req,res,next)=>{try{
    const input=parse(z.object({workspaceId:literal}).strict(),req.query);
    const runId=parse(integer.refine(v=>v>0),req.params.runId);
    const rows=await deps.read('SELECT id, workspace_id, status, spec_path, idempotency_key, retried_from_run_id FROM pipeline_runs WHERE workspace_id = $1 AND id = $2',[input.workspaceId,runId]);
    if(!rows[0])throw new NotFoundError('Run');res.json({contractVersion:'rorca.provider-read.v1',run:rows[0]});
  }catch(error){next(error);}});
  /**
   * @swagger
   * /api/pipeline/provider/v1/phase-work/{phaseWorkId}/revisions/{revision}:
   *   get:
   *     operationId: getEcoPhaseWorkRevisionV1
   *     summary: Read immutable provider-owned phase-work reference pins
   *     x-rorca-tier: auth
   *     x-rorca-mcp: false
   *     x-rorca-rationale: Exact credential workspace scope; does not imply acceptance or execution authority.
   *     parameters:
   *       - in: path
   *         name: phaseWorkId
   *         required: true
   *         schema: { type: string }
   *         description: phaseWorkId identifier scoped to the credential's workspace.
   *       - in: path
   *         name: revision
   *         required: true
   *         schema: { type: string }
   *         description: revision identifier scoped to the credential's workspace.
   *     responses:
   *       200: { description: Immutable external work body, source and recipe hashes and existing claim reference }
   *       404: { description: Scoped revision not found }
   */
  router.get('/phase-work/:phaseWorkId/revisions/:revision',async(req,res,next)=>{try{
    const input=parse(z.object({workspaceId:literal}).strict(),req.query);
    const phaseWorkId=parse(z.string().uuid(),req.params.phaseWorkId);
    const revision=parse(integer.refine(v=>v>0),req.params.revision);
    if(!deps.phaseWork)throw new NotFoundError('Phase-work reader');
    res.json(await deps.phaseWork({...input,phaseWorkId,revision}));
  }catch(error){next(error);}});
  return router;
}
