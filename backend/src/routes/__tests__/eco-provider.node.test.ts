/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import { createEcoProviderRouter } from '../eco-provider';
import { errorHandler } from '../../lib/error-handler';

function app(authSource?:string, member=true) {
  const calls:string[]=[];
  const instance=express();
  instance.use((req,_res,next)=>{req.user={id:'user',email:'u@example.test',supabaseId:'subject',role:'user'} as Express.UserShape;req.authSource=authSource as any;next();});
  instance.use('/api/pipeline/provider/v1',createEcoProviderRouter({
    read:async(sql)=>{calls.push(sql);if(sql.includes('workspace_members'))return member?[{role:'member'}]:[];return [];},
    phaseWork:async()=>({status:'immutable-reference',acceptanceAuthority:'none'}),
    plan:async(input)=>({workspaceId:input.workspaceId,specId:input.specId,plan:{planId:'canonical'}}),
  }));
  instance.use(errorHandler);return {instance,calls};
}
test('new provider reads reject unauthenticated local fallback before lookup', async()=>{
  for(const source of [undefined,'local-fallback']) {const {instance,calls}=app(source);assert.equal((await request(instance).get('/api/pipeline/provider/v1/capabilities?workspaceId=w')).status,401);assert.deepEqual(calls,[]);}
});
test('credential-authenticated scope is checked before plan lookup',async()=>{
  const denied=app('bearer',false);assert.equal((await request(denied.instance).get('/api/pipeline/provider/v1/plans/p?workspaceId=w')).status,404);
  const allowed=app('internal');const response=await request(allowed.instance).get('/api/pipeline/provider/v1/plans/p?workspaceId=w');assert.equal(response.status,200);assert.equal(response.body.plan.planId,'canonical');
});
test('capabilities do not advertise unimplemented artifact acceptance or managed enforcement',async()=>{
  const {instance}=app('bearer');const response=await request(instance).get('/api/pipeline/provider/v1/capabilities?workspaceId=w');assert.equal(response.status,200);assert.equal(response.body.fullCompiledPlanRead,true);assert.equal(response.body.artifactExecution,false);assert.equal(response.body.managedAdmission,false);
});
test('immutable phase-work pins have scoped readback without fabricated acceptance',async()=>{
  const {instance}=app('bearer');const response=await request(instance).get('/api/pipeline/provider/v1/phase-work/6760e13e-cf37-42be-b7d8-7c24b2148e11/revisions/1?workspaceId=w');
  assert.equal(response.status,200);assert.equal(response.body.status,'immutable-reference');assert.equal(response.body.acceptanceAuthority,'none');
});
test('query parsing rejects duplicate scope, malformed cursor and lookup key without normalization',async()=>{
  const {instance}=app('bearer');
  for(const path of ['/capabilities?workspaceId=w&workspaceId=x','/runs/7/events?workspaceId=w&afterId=01','/dispatches/by-key?workspaceId=w&operation=trigger&idempotencyKey=%20literal:key'])assert.equal((await request(instance).get('/api/pipeline/provider/v1'+path)).status,400);
});
