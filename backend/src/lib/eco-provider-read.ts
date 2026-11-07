/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'node:crypto';
import { LifecyclePlanSchema, normalizeSsdlcContractJson } from './ssdlc-contracts';
import { ExecutionReceiptV1Schema } from './mission-contracts';

export function projectEcoCompiledPlan(input:{workspaceId:string;specId:string;providerSpecVersion:string;snapshotId:string;plan:unknown}) {
  const plan=LifecyclePlanSchema.parse(input.plan);
  if(plan.workspaceId!==input.workspaceId || plan.specId!==input.specId || !/^sha256:[0-9a-f]{64}$/.test(input.snapshotId))throw new ConflictError('Compiled plan scope or snapshot differs');
  return {contractVersion:'rorca.provider-read.v1',workspaceId:input.workspaceId,specId:input.specId,
    providerSpecVersion:input.providerSpecVersion,snapshotId:input.snapshotId,plan,
    planHash:`sha256:${createHash('sha256').update(normalizeSsdlcContractJson(plan),'utf8').digest('hex')}`,
    // Numeric phase revision is not inferred from a provider string version.
    revisionMapping:'host-explicit-required'};
}
import { AppError, ConflictError, NotFoundError, ValidationError } from './errors';

/** Injected reader deliberately exposes no execute/transaction/publication API. */
export type EcoReader = (sql: string, params: unknown[]) => Promise<Record<string, any>[]>;
export class EcoCursorExpired extends AppError {
  readonly statusCode = 410;
  constructor() { super('CURSOR_EXPIRED: reconcile the canonical run snapshot before restarting observation', 'CURSOR_EXPIRED'); }
}
function positive(value:number, minimum=1): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new ValidationError('Expected a canonical safe integer');
}
export async function readDispatchByKey(db:EcoReader, input:{workspaceId:string; idempotencyKey:string; operation:'trigger'|'retry'}) {
  if (!input.workspaceId || !/^[A-Za-z0-9:._-]{8,256}$/.test(input.idempotencyKey) || !['trigger','retry'].includes(input.operation)) throw new ValidationError('Invalid dispatch lookup');
  if(input.operation==='retry') {
    const rows=await db(`SELECT preview.workspace_id,preview.idempotency_key,preview.retry_run_id,preview.original_run_id,
      preview.preview_hash,preview.preview_identity_hash,preview.scope_hash,preview.preparation_state,preview.status,
      run.status AS run_status FROM pipeline_retry_previews preview
      LEFT JOIN pipeline_runs run ON run.id=preview.retry_run_id AND run.workspace_id=preview.workspace_id
      WHERE preview.workspace_id = $1 AND preview.idempotency_key = $2`,[input.workspaceId,input.idempotencyKey]);
    const row=rows[0];if(!row)throw new NotFoundError('Dispatch');
    positive(Number(row.original_run_id));if(row.retry_run_id!=null)positive(Number(row.retry_run_id));
    return {contractVersion:'rorca.provider-read.v1',workspaceId:input.workspaceId,operation:input.operation,idempotencyKey:input.idempotencyKey,
      runId:row.retry_run_id==null?null:Number(row.retry_run_id),predecessorRunId:Number(row.original_run_id),status:row.run_status??null,
      publicationState:row.preparation_state,previewStatus:row.status,previewHash:row.preview_hash,
      previewIdentityHash:row.preview_identity_hash??null,scopeHash:row.scope_hash,requestHash:null,receipt:null,
      reconciliation:'retained-retry-identity'};
  }
  const rows = await db(`SELECT run.id, run.workspace_id, run.status, run.idempotency_key,
    run.dispatch_request_hash, run.retried_from_run_id, run.trigger_options,
    publication.state AS publication_state
    FROM pipeline_runs run LEFT JOIN pipeline_dispatch_publications publication ON publication.run_id = run.id
    WHERE run.workspace_id = $1 AND run.idempotency_key = $2`, [input.workspaceId,input.idempotencyKey]);
  const row=rows[0];
  if (!row || row.retried_from_run_id != null) throw new NotFoundError('Dispatch');
  positive(Number(row.id));
  const options=typeof row.trigger_options==='string'?JSON.parse(row.trigger_options):row.trigger_options;
  const parsed=ExecutionReceiptV1Schema.safeParse(options?.executionReceipt);
  if (parsed.success && (parsed.data.returnedEntity.id !== String(row.id) || parsed.data.workspaceId !== input.workspaceId || parsed.data.idempotencyKey !== input.idempotencyKey)) throw new ConflictError('Stored execution receipt identity differs');
  return {contractVersion:'rorca.provider-read.v1',workspaceId:input.workspaceId,operation:input.operation,idempotencyKey:input.idempotencyKey,
    runId:Number(row.id),status:row.status,requestHash:row.dispatch_request_hash??null,publicationState:row.publication_state??null,
    predecessorRunId:row.retried_from_run_id==null?null:Number(row.retried_from_run_id),receipt:parsed.success?parsed.data:null,
    // Missing historical receipt is explicit, never synthesized or retried.
    reconciliation:parsed.success?'retained-receipt':'identity-only'};
}
export async function readScopedRunEvents(db:EcoReader,input:{workspaceId:string;runId:number;afterId:number;limit:number}) {
  positive(input.runId); positive(input.afterId,0);positive(input.limit);
  if (!input.workspaceId || input.limit>1000) throw new ValidationError('Invalid event window');
  const run=await db('SELECT id FROM pipeline_runs WHERE workspace_id = $1 AND id = $2',[input.workspaceId,input.runId]);
  if (!run[0]) throw new NotFoundError('Run');
  // A persisted global ID must still belong to this exact stream. Numeric gaps
  // are legal; absence (including retention) cannot be treated as resumable.
  if (input.afterId>0) {
    const cursor=await db("SELECT id FROM wal_events WHERE workspace_id = $1 AND payload->>'run_id' = $2 AND id = $3",[input.workspaceId,String(input.runId),input.afterId]);
    if (!cursor[0]) throw new EcoCursorExpired();
  }
  const rows=await db(`SELECT id, ts, event_type, workspace_id, spec_id, story_id, actor, payload FROM wal_events
    WHERE workspace_id = $1 AND payload->>'run_id' = $2 AND id > $3 ORDER BY id ASC LIMIT $4`,[input.workspaceId,String(input.runId),input.afterId,input.limit+1]);
  const events=rows.slice(0,input.limit);
  return {contractVersion:'rorca.provider-read.v1',workspaceId:input.workspaceId,runId:input.runId,events,
    nextCursor:events.length?Number(events.at(-1)!.id):input.afterId,hasMore:rows.length>input.limit,
    retention:{resume:'exact-cursor-required',recovery:'read-run-snapshot-then-explicitly-restart'}};
}
