/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { bindEcoPhaseWork, sealExternalPhaseWork } from '../eco-phase-work';
import { h, plan, digest, body } from './fixtures/eco-phase-work.fixture';
test('provider validates the complete frozen external work body and digest, not a bag of hashes',()=>{
 const value=sealExternalPhaseWork(body());assert.equal(value.contentHash,digest(body()));
 assert.throws(()=>sealExternalPhaseWork({...body(),approved:true}));
 assert.throws(()=>sealExternalPhaseWork({...body(),phase:'intake'}));
});
test('binding atomically pins full phase/source/recipe/parent to existing dispatch claim, without acceptance',async()=>{
 const calls:Array<{sql:string;params:any[]}>=[];
 const client={query:async(sql:string,params:any[])=>{calls.push({sql,params});return {rows:sql.includes('ssdlc_compiled_plans')?[{plan_json:plan,spec_version:'7',spec_revision:7}]:sql.includes('SELECT 1')?[{'?column?':1}]:[]};}};
 const work=sealExternalPhaseWork(body());
 await bindEcoPhaseWork(client,{schemaVersion:'lifecycle-dispatch-claim.v1' as const,claimId:'a97719cf-df5e-4a4a-a3e3-043ce739209b',workspaceId:'ws',specId:'parent',compiledPlanId:'1',requestIdentity:'pipeline:key',requestHash:h,specHash:h}, {contractVersion:'rorca.phase-work-binding.v1',phaseWork:work,providerSpecVersion:'7'});
 assert.match(calls[0].sql,/FOR SHARE/);
 assert.ok(calls.some(c=>c.sql.includes('INSERT INTO eco_phase_work_revisions')));
 assert.ok(calls.some(c=>c.sql.includes('INSERT INTO eco_phase_dispatch_bindings')));
 assert.doesNotMatch(calls.map(c=>c.sql).join('\n'),/approval|execution_leases|pgboss|accepted/i);
});
test('foreign parent, changed source hash and missing accepted prerequisite block binding',async()=>{
 const claim={schemaVersion:'lifecycle-dispatch-claim.v1' as const,claimId:'a97719cf-df5e-4a4a-a3e3-043ce739209b',workspaceId:'ws',specId:'parent',compiledPlanId:'1',requestIdentity:'pipeline:key',requestHash:h,specHash:h};
 const client={query:async()=>({rows:[{plan_json:plan,spec_version:'7',spec_revision:7}]})};
 await assert.rejects(bindEcoPhaseWork(client,claim,{contractVersion:'rorca.phase-work-binding.v1',phaseWork:sealExternalPhaseWork({...body(),parentBinding:{...body().parentBinding,specRevision:99}}),providerSpecVersion:'7'}),/revision|parent/i);
 const original=sealExternalPhaseWork(body());
 await assert.rejects(bindEcoPhaseWork(client,claim,{contractVersion:'rorca.phase-work-binding.v1',phaseWork:{...original,sourceBindings:[]},providerSpecVersion:'7'}));
 await assert.rejects(bindEcoPhaseWork(client,{...claim,workspaceId:'foreign'},{contractVersion:'rorca.phase-work-binding.v1',phaseWork:original,providerSpecVersion:'7'}));
 const dependency=body();dependency.prerequisites.push({phaseWorkId:'bbb1914e-aa58-4f8c-acb1-91efaac8f691',revision:1,deliverableId:'design',artifactHash:h} as never);
 await assert.rejects(bindEcoPhaseWork(client,claim,{contractVersion:'rorca.phase-work-binding.v1',phaseWork:sealExternalPhaseWork(dependency),providerSpecVersion:'7'}),/accepted prerequisite/i);
});
