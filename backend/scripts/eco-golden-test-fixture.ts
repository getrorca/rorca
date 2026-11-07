/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
/** Commit only the fixture's intended runtime policy, before any source seal. */
export function prepareGoldenTestRepository(workspace:string){
 const git=(args:string[])=>execFileSync('git',args,{cwd:workspace,encoding:'utf8',stdio:'pipe'}).trim();
 git(['init','-b','main']);
 fs.writeFileSync(path.join(workspace,'.gitignore'),'# TEST fixture: native run tracking only\nprogress.txt\n.rorca/run-state.json\n.rorca/memory/health-log.json\n.rorca-runtime-backup-*\n');
 git(['add','.gitignore']);
 git(['-c','user.name=TEST fixture','-c','user.email=test@example.test','commit','-m','TEST fixture runtime ignore policy before source sealing']);
 if(git(['status','--porcelain','--untracked-files=all']))throw Error('TEST fixture must be clean before source sealing');
 return git(['rev-parse','HEAD']);
}
/** TEST ONLY: native export bytes and real compiled plan, no human authority. */
export async function prepareGoldenTestPhase(build:string,workspace:string,source:any,owner:any,db:any){
 const {body}=require('../src/lib/__tests__/fixtures/eco-phase-work.fixture.ts');
 const {sealExternalPhaseWork,contractHash,canonicalJson,hashBytes}=require(path.join(build,'lib/eco-phase-work.js'));
 const row=(await db.query("SELECT plan_json,spec_version,provenance_json FROM ssdlc_compiled_plans WHERE workspace_id='ws' AND spec_slug='parent' AND is_current=TRUE"))[0];
 const plan=row.plan_json;
 const raw=body();
 raw.criteria=raw.criteria.map((c:any)=>({...c,description:'TEST text exact hash and required content',textArtifactCheck:{expectedSha256:'sha256:bfff8c5a059c8897d489273e89c2de4213819da2508c2f8e160e350e50f9f269',requiredContent:['TEST ','for review only.'],minimumBytes:1}}));
 const gate=plan.gates.find((g:any)=>g.phaseId==='development').gateId;
 raw.parentBinding={specId:'parent',specRevision:Number(row.spec_version),planId:plan.planId,planHash:contractHash(plan),gateIds:[gate]};
 raw.criteria=raw.criteria.map((c:any)=>({...c,gateIds:[gate]}));
 const sourcePath=source.exportKitIdentity.artifacts.requirements.path;
 const sourceText=fs.readFileSync(path.join(workspace,sourcePath),'utf8');
 const {createHash}=require('node:crypto');const sha=(s:string)=>`sha256:${createHash('sha256').update(s).digest('hex')}`;
 raw.sourceBindings=[{...raw.sourceBindings[0],producer:'rorca-export-kit',contractVersion:'rorca.export-kit-manifest.v1',hashAlgorithm:'rorca-export-kit-compiler-1',materialHash:source.exportKitIdentity.specMaterialHash,sourcePath,artifactPath:sourcePath,artifactHash:sha(sourceText),packageHash:source.exportKitIdentity.manifestHash,manifestByteHash:sha(fs.readFileSync(path.join(workspace,source.exportKitIdentity.kitPath,'manifest.json'),'utf8'))}];
 raw.effectPolicy={...raw.effectPolicy,allowReadRoots:['forge/export-kits'],allowWriteRoots:['out'],permittedToolClasses:['read','write']};
 raw.budgets={...raw.budgets,tokenizer:'o200k_base:openai-chat-2024-v1',contextTokens:32000,outputBytes:20000,spendMicroUsd:100};
 raw.deliverables=raw.deliverables.map((d:any)=>({...d,maximumBytes:1000}));
 const recipe={contractVersion:'eco.recipe/proposal-v1',id:'TEST-eco24-text-proposal',semanticVersion:'1.0.0',effectPolicy:raw.effectPolicy,budgets:raw.budgets,phases:['development'],workKind:'implementation',executionModes:['rorca-managed'],prompt:'TEST fixture: text proposal, not native execution or acceptance',modelJudgment:['Fixture only'],inputs:[{id:'source',kind:'source-artifact',description:'Native compiler PRD bytes'}],outputs:raw.deliverables.map(({criterionIds,...o}:any)=>o),steps:['inspect','read','collect','write'].map(id=>({id,action:'Typed fixture',toolClass:id==='write'?'write':'read',required:true})),checks:raw.criteria.map((c:any)=>({id:c.id,evaluatorKind:c.evaluatorKind,requirement:c.description})),stop:'artifact-review-submission',onMissingInput:'block',onSourceChange:'require-new-revision',onTimeout:'stop-and-reconcile'};
 raw.recipeBinding={id:recipe.id,semanticVersion:recipe.semanticVersion,contentHash:contractHash(recipe)};
 const phase=sealExternalPhaseWork(raw);
 const put=async(kind:string,key:string,value:any)=>owner.query('INSERT INTO eco_host_records(workspace_id,kind,record_key,canonical_bytes,content_hash) VALUES($1,$2,$3,$4,$5)',['ws',kind,key,canonicalJson(value),contractHash(value)]);
 await put('recipe',raw.recipeBinding.contentHash,recipe);
 for(const s of raw.sourceBindings)await put('source',contractHash(s),s);
 await put('story-mapping',phase.contentHash,{phaseHash:phase.contentHash,parentHash:raw.parentBinding.planHash,specId:'parent',specHash:row.provenance_json.specHash,providerSpecVersion:row.spec_version,storyId:'US-1',specPath:'forge/specs/approved/parent.json'});
 await owner.query("INSERT INTO eco_watcher_owners VALUES('ws','company',$1,'00000000-0000-0000-0000-000000000002','watcher',1,clock_timestamp()+interval '60 seconds',FALSE)",[raw.id]);
 return {binding:{contractVersion:'rorca.phase-work-binding.v1',providerSpecVersion:row.spec_version,phaseWork:phase},sources:{[sourcePath]:sourceText}};
}
