/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

/** Real closeout caller with isolated authority-read seam; no database/network.
 * The row shape reproduces the actual full-stack receipt, not invented success. */
function caller(authority:unknown){
 const exports:Record<string,any>={};
 const source=fs.readFileSync(path.resolve(__dirname,'../src/lib/run-closeout-authority.ts'),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const unexpected=()=>{throw Error('authority denial must precede persistence');};
 vm.runInNewContext(code,{exports,require:(name:string)=>{
  if(name==='./run-host-authority')return {inspectRunHostAuthority:async()=>authority};
  if(name==='./errors')return {ConflictError:class ConflictError extends Error{}};
  if(name==='./wave-1-stabilization')return {assertNotProtectedWave1Run:()=>{}};
  if(name==='../db/index')return {query:unexpected,transaction:unexpected};
  return new Proxy({},{get:()=>unexpected});
 }});
 return exports.prepareHostRunCloseout as (i:{runId:number;status:string})=>Promise<unknown>;
}
const observed={runId:20260316000001,workspaceId:'ws',specId:'parent',expectedStoryIds:['US-1'],stories:[],acceptedStoryIds:[],authoritativePassedStoryIds:[],complete:false,closeoutEligible:false,releaseEligible:false,terminalRevision:'f38ac9ad89db3ea03408b4c79706e9e6210dd93e',invalidReason:null};
test('existing BIGINT run with null invalidReason and missing story authority is not diagnosed as run not found',async()=>{
 await assert.rejects(caller(observed)({runId:observed.runId,status:'done'}),/frozen story scope is incomplete: US-1/);
});
test('actually missing run remains denied',async()=>{
 await assert.rejects(caller(null)({runId:observed.runId,status:'done'}),/run not found/);
});
for(const reason of ['revoked host authority','stale host attempt fence'])test(`${reason} remains denied without persistence`,async()=>{
 await assert.rejects(caller({...observed,invalidReason:reason})({runId:observed.runId,status:'done'}),new RegExp(reason));
});
