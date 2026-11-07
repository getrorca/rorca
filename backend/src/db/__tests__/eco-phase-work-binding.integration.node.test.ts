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
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { bindEcoPhaseWork, sealExternalPhaseWork, readEcoPhaseWork } from '../../lib/eco-phase-work';
import { body, plan, h } from '../../lib/__tests__/fixtures/eco-phase-work.fixture';

/** Completely new disposable cluster, Unix socket ONLY. No env DB URL, existing
 * database/server, migration runner, worker or production config is consulted. */
test('real PostgreSQL: migration, exact replay, conflicting claims, immutable history, RLS and rollback', {timeout:90000}, async()=>{
 const root=fs.mkdtempSync(path.resolve(__dirname,'../../../../tmp/eco-pg-'));
 const data=path.join(root,'data');let started=false;
 const run=(bin:string,args:string[])=>execFileSync(bin,args,{encoding:'utf8',stdio:'pipe'});
 const client=new Client({host:root,port:55492,database:'postgres',user:'eco_test'});
 try {
  run('/usr/local/bin/initdb',['-D',data,'-U','eco_test','-A','trust','--no-locale']);
  run('/usr/local/bin/pg_ctl',['-D',data,'-l',path.join(root,'log'),'-o',`-k ${root} -h '' -p 55492`,'-w','start']);started=true;
  await client.connect();
  await client.query(`CREATE SCHEMA rorca; SET search_path=rorca,public; CREATE EXTENSION pgcrypto;
    CREATE ROLE eco_runtime; SELECT set_config('rorca.runtime_database_user','eco_runtime',FALSE);
    GRANT USAGE ON SCHEMA rorca TO eco_runtime;
    CREATE TABLE workspaces(id TEXT PRIMARY KEY);
    CREATE TABLE ssdlc_lifecycle_dispatch_claims(claim_id UUID PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id));
    CREATE TABLE ssdlc_compiled_plans(id BIGINT PRIMARY KEY,workspace_id TEXT,spec_slug TEXT,plan_json JSONB,spec_version TEXT,is_current BOOLEAN,validation_status TEXT,provenance_json JSONB);
    CREATE TABLE spec_versions(workspace_id TEXT,spec_slug TEXT,version INTEGER);
    INSERT INTO spec_versions VALUES('ws','parent',7);
    INSERT INTO workspaces VALUES('ws'),('foreign');`);
  await client.query(fs.readFileSync(path.resolve(__dirname,'../pg-migrations/20261027120000_eco_phase_work_binding.sql'),'utf8'));
  await client.query('INSERT INTO ssdlc_compiled_plans VALUES(1,$1,$2,$3,$4,TRUE,$5,$6)',['ws','parent',JSON.stringify(plan),'7','validated',JSON.stringify({specHash:h})]);
  const claim={schemaVersion:'lifecycle-dispatch-claim.v1' as const,claimId:'a97719cf-df5e-4a4a-a3e3-043ce739209b',workspaceId:'ws',specId:'parent',compiledPlanId:'1',requestIdentity:'pipeline:key',requestHash:h,specHash:h};
  const binding={contractVersion:'rorca.phase-work-binding.v1',phaseWork:sealExternalPhaseWork(body()),providerSpecVersion:'7'};
  await client.query('INSERT INTO ssdlc_lifecycle_dispatch_claims VALUES($1,$2)',[claim.claimId,'ws']);
  const bind=async(c=claim,b=binding)=>{await client.query('BEGIN');try {await bindEcoPhaseWork(client,c,b);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}};
  await bind();await bind();
  const readback=await readEcoPhaseWork(client,{workspaceId:'ws',phaseWorkId:body().id,revision:1});
  assert.equal(readback.phaseWork.contentHash,binding.phaseWork.contentHash);
  assert.equal(readback.acceptanceAuthority,'none');
  await assert.rejects(readEcoPhaseWork(client,{workspaceId:'foreign',phaseWorkId:body().id,revision:1}),/not found/i);
  assert.equal((await client.query('SELECT count(*) FROM eco_phase_work_revisions')).rows[0].count,'1');
  await assert.rejects(client.query("UPDATE eco_phase_work_revisions SET revision=2"),/immutable/);
  await assert.rejects(client.query('TRUNCATE eco_phase_dispatch_bindings'),/immutable/);
  const competitor={...claim,claimId:'a97719cf-df5e-4a4a-a3e3-043ce739209c'};
  await client.query('INSERT INTO ssdlc_lifecycle_dispatch_claims VALUES($1,$2)',[competitor.claimId,'ws']);
  await assert.rejects(bind(competitor),/unique|duplicate/i);
  const changed=body();changed.objective='Conflicting source/recipe semantic revision';
  await assert.rejects(bind(claim,{...binding,phaseWork:sealExternalPhaseWork(changed)}),/foreign key|conflicts/i);
  const next=body();next.id='6760e13e-cf37-42be-b7d8-7c24b2148e12';
  await client.query('BEGIN');await bindEcoPhaseWork(client,competitor,{...binding,phaseWork:sealExternalPhaseWork(next)});await client.query('ROLLBACK');
  assert.equal((await client.query('SELECT count(*) FROM eco_phase_work_revisions')).rows[0].count,'1');
  await client.query("SET ROLE eco_runtime; SELECT set_config('rorca.workspace_id','foreign',FALSE)");
  assert.equal((await client.query('SELECT count(*) FROM eco_phase_work_revisions')).rows[0].count,'0');
  await client.query("SELECT set_config('rorca.workspace_id','ws',FALSE)");
  assert.equal((await client.query('SELECT count(*) FROM eco_phase_work_revisions')).rows[0].count,'1');
 } finally {
  await client.end();
  if(started)run('/usr/local/bin/pg_ctl',['-D',data,'-m','immediate','-w','stop']);
  fs.rmSync(root,{recursive:true,force:true});
 }
});
