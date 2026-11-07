/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readDispatchByKey, readScopedRunEvents, projectEcoCompiledPlan } from '../eco-provider-read';
import { createHash } from 'node:crypto';
import { compileLifecyclePlan, SSDLC_PLAN_COMPILER_VERSION } from '../ssdlc-plan-compiler';
import { normalizeSsdlcContractJson } from '../ssdlc-contracts';

test('full native compiled plan projection verifies actual schema and hashes all bytes, not inputHash',()=>{
  const plan=compileLifecyclePlan({schemaVersion:1,workspaceId:'ws',canonicalSpec:{specId:'parent',version:'7',contentHash:`sha256:${'b'.repeat(64)}`,json:{userStories:[{id:'US-1',title:'Implement',acceptanceCriteria:['Works']}]}},workspaceTags:[],riskAssignments:[],ownerAssignments:[],policyAnnotations:[],compilerAnnotations:[],compilerVersion:SSDLC_PLAN_COMPILER_VERSION,policyVersion:'test',compiledAt:'2026-10-27T00:00:00.000Z'}).plan;
  const result=projectEcoCompiledPlan({workspaceId:'ws',specId:'parent',providerSpecVersion:'7',snapshotId:`sha256:${'c'.repeat(64)}`,plan});
  assert.deepEqual(result.plan,plan);
  assert.equal(result.planHash,`sha256:${createHash('sha256').update(normalizeSsdlcContractJson(plan)).digest('hex')}`);
  assert.notEqual(result.planHash,plan.inputHash);
  assert.throws(()=>projectEcoCompiledPlan({workspaceId:'foreign',specId:'p',providerSpecVersion:'7',snapshotId:'x',plan}),/scope|snapshot/i);
});

const hash = `sha256:${'a'.repeat(64)}`;
test('original-key reconciliation predicates workspace and literal key without writes', async () => {
  const calls: Array<{sql:string; params:unknown[]}> = [];
  const db = async (sql:string, params:unknown[]) => { calls.push({sql,params}); return [{id:7, workspace_id:'w', status:'queued', idempotency_key:'literal:key', dispatch_request_hash:hash, retried_from_run_id:null, trigger_options:{}, publication_state:'preparing'}]; };
  const result = await readDispatchByKey(db, {workspaceId:'w', idempotencyKey:'literal:key', operation:'trigger'});
  assert.equal(result.runId, 7);
  assert.equal(result.receipt, null);
  assert.equal(result.publicationState, 'preparing');
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /run.workspace_id = \$1/);
  assert.deepEqual(calls[0].params, ['w','literal:key']);
  assert.doesNotMatch(calls[0].sql, /INSERT|UPDATE|DELETE|publish/i);
});
test('retry reconciliation uses the actual preview ledger original key, including pre-run uncertainty',async()=>{
 const calls:Array<{sql:string;params:unknown[]}>=[];
 const db=async(sql:string,params:unknown[])=>{calls.push({sql,params});return sql.includes('pipeline_retry_previews')?[{workspace_id:'w',idempotency_key:'literal:key',retry_run_id:null,original_run_id:7,preview_hash:hash,preview_identity_hash:hash,scope_hash:hash,preparation_state:'preparing',status:'approved'}]:[];};
 const result=await readDispatchByKey(db,{workspaceId:'w',idempotencyKey:'literal:key',operation:'retry'});
 assert.equal(result.runId,null);assert.equal(result.predecessorRunId,7);assert.equal(result.publicationState,'preparing');
 assert.match(calls[0].sql,/preview.workspace_id = \$1/);assert.deepEqual(calls[0].params,['w','literal:key']);
});
test('event pagination scopes both run and workspace, uses lookahead and permits global ID gaps', async () => {
  const calls: Array<{sql:string; params:unknown[]}> = [];
  const db = async (sql:string, params:unknown[]) => { calls.push({sql,params}); if (sql.includes('FROM pipeline_runs')) return [{id:7}]; if (sql.includes('id = $3')) return [{id:4}]; return [{id:10},{id:30},{id:90}]; };
  const result = await readScopedRunEvents(db, {workspaceId:'w',runId:7,afterId:4,limit:2});
  assert.deepEqual(result.events, [{id:10},{id:30}]);
  assert.equal(result.nextCursor, 30); assert.equal(result.hasMore, true);
  assert.match(calls.at(-1)!.sql, /workspace_id = \$1/);
  assert.deepEqual(calls.at(-1)!.params, ['w','7',4,3]);
});
test('foreign run is not disclosed and absent resume cursor expires rather than guessing retention', async () => {
  await assert.rejects(readScopedRunEvents(async () => [], {workspaceId:'w',runId:7,afterId:0,limit:2}), /not found/i);
  let count=0;
  await assert.rejects(readScopedRunEvents(async () => ++count===1?[{id:7}]:[], {workspaceId:'w',runId:7,afterId:4,limit:2}), /CURSOR_EXPIRED/);
  assert.equal(count,2);
});
