/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createStoryExecutionManifest,deriveStoryCommandHash,deriveStoryContractRevision} from '../src/lib/story-execution-packet';
import {runHostValidationRequirement} from '../src/lib/story-host-validation';
import {HOST_TEXT_VALIDATOR} from '../src/lib/eco-text-validation-contract';
import {createStoryAttemptResult,evaluateStoryCloseout} from '../src/lib/story-closeout';
import {storyLifecycleFixture} from '../src/lib/__tests__/fixtures/story-execution-manifest.fixture';

/** Explicit TEST-only qualification: a real native validator is not a model
 * process, integrated story pass, reviewer approval or run-closeout issuer. */
test('actual native text check binds content/hash and subject; exit zero cannot accept missing completion/human evidence',()=>{
 const scratch=path.join(os.homedir(),'.hermes/cache/scratch');
 const root=fs.mkdtempSync(path.join(scratch,'eco25-native-validator-'));
 try {
  const git=(args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:'pipe'}).trim();
  git(['init','-b','main']);fs.writeFileSync(path.join(root,'README.md'),'TEST native validator fixture\n');git(['add','.']);git(['-c','user.name=TEST fixture','-c','user.email=test@example.test','commit','-m','TEST isolated source']);
  const head=git(['rev-parse','HEAD']);
  const text='TEST text proposal for review only.';
  const sha=(s:string)=>`sha256:${createHash('sha256').update(s).digest('hex')}`;
  const expected=sha(text);
  const program="const assert=require('node:assert/strict'),crypto=require('node:crypto');const [text,expected]=process.argv.slice(1);const hash='sha256:'+crypto.createHash('sha256').update(text).digest('hex');assert.equal(hash,expected);assert.ok(text.startsWith('TEST '));assert.ok(text.includes('for review only.'));assert.ok(Buffer.byteLength(text)>0&&Buffer.byteLength(text)<=1000);process.stdout.write(JSON.stringify({artifactHash:hash,byteLength:Buffer.byteLength(text),checks:['sha256','TEST-prefix','required-content','byte-bounds']}));";
  const args=[JSON.stringify({expectedSha256:expected,requiredContent:['TEST ','for review only.'],minimumBytes:1,maximumBytes:1000,deliverableId:'text',relativePath:'out/text.txt',mediaType:'text/plain'})];
  const requirement={id:'TEST-text-content',kind:'test' as const,command:HOST_TEXT_VALIDATOR,args,commandHash:deriveStoryCommandHash(HOST_TEXT_VALIDATOR,args),required:true,timeoutMs:10000,revisionSensitive:true};
  const manifest=createStoryExecutionManifest({identity:{workspaceId:'ws',specId:'parent',storyId:'US-1',runId:20260316000001,attempt:1},revisions:{specRevision:sha('TEST spec'),storyRevision:sha('TEST story')},executionMode:'qa',lifecycle:storyLifecycleFixture('ws','parent','US-1'),execution:{agent:'claude',model:null,effort:null,terminal:'ansi-html',worktree:{enabled:true,path:root,branch:'main',baseRevision:head},merge:{enabled:false,strategy:'branch-only',targetBranch:null}},validationPlan:[requirement],evidenceExpectations:[{criterionId:'TEST-text',description:'Exact TEST text/hash and required content',requiredEvidenceKinds:['validation']},{criterionId:'reviewer',description:'Independent human review remains required',requiredEvidenceKinds:['qa']}],repositoryProfile:{profileId:'TEST-text-validator-only',changePolicy:'no_code_allowed',noCodeReason:'TEST diagnostic only, not integrated implementation acceptance',runtimeMetadataPaths:[]},commandSafety:{profileId:'autonomous-command-guard-v1',guardVersion:'1',guardedWorkingDirectory:root,allowedWorkingDirectories:[root],blockedCommandPatterns:[],redactedEnvironmentKeys:['DATABASE_URL'],allowBackendJest:false,baselineFailurePolicy:'block'}});
  const observed=runHostValidationRequirement(manifest,manifest.validationPlan[0],{criterionIds:['TEST-text'],artifactText:text});
  assert.equal(observed.classification,'passed',JSON.stringify(observed));
  assert.deepEqual(observed.termination,{kind:'exited',exitCode:0});
  const actual=JSON.parse(observed.output.redactedExcerpt!);assert.equal(actual.artifactHash,expected);assert.equal(actual.byteLength,Buffer.byteLength(text));
  const subject={commitSha:head,worktreePath:root,branch:'main'};
  const attempt=createStoryAttemptResult({identity:manifest.identity,revisions:manifest.revisions,manifestHash:manifest.manifestHash,agentProcess:{agent:'TEST-host-validator-not-model',model:null,effort:null,processId:null,sessionId:null},startedAt:observed.startedAt,finishedAt:observed.finishedAt,termination:observed.termination,outputReferences:[observed.output],proposedCompletionPacket:null,observedFiles:[],observedCommits:[],hostValidationObservations:[observed],knownIssues:['TEST diagnostic: no model process launch envelope, no integrated result, no human review']});
  const host={identity:manifest.identity,activeSubjectRevision:subject,repository:{worktreeClean:true,changedFiles:[],runtimeMetadataFiles:[],headBeforeValidation:head,headAfterValidation:head},validations:[observed],criterionEvidence:[{criterionId:'TEST-text',evidenceReferences:[observed.output.reference],subjectRevision:head,observedBy:'rorca_host' as const}],storyCommits:[],progress:null,storyResult:null};
  const decision=evaluateStoryCloseout({manifest,attempt,host});
  assert.equal(decision.status,'blocked');assert.ok(decision.reasonCodes.includes('MISSING_COMPLETION_PACKET'));assert.equal(decision.acceptanceCriteria.find(c=>c.criterionId==='reviewer')!.status,'blocked');
  const stale=evaluateStoryCloseout({manifest,attempt,host:{...host,activeSubjectRevision:{...subject,commitSha:'f'.repeat(40)}}});assert.equal(stale.status,'blocked');assert.ok(stale.reasonCodes.includes('STALE_VALIDATION_REVISION'));
  const denied=runHostValidationRequirement(manifest,manifest.validationPlan[0],{criterionIds:['TEST-text'],artifactText:'TEST wrong content'});assert.equal(denied.classification,'story_caused_failure');
  const missing=runHostValidationRequirement(manifest,manifest.validationPlan[0],{criterionIds:['TEST-text']});assert.equal(missing.classification,'story_caused_failure');
  const wrongHash=runHostValidationRequirement(manifest,manifest.validationPlan[0],{artifactText:text+' extra'});assert.equal(wrongHash.classification,'story_caused_failure');
  if(process.platform==='darwin'){
   const commandRequirement={...requirement,command:process.execPath,args:['-e',program,text,expected],commandHash:deriveStoryCommandHash(process.execPath,['-e',program,text,expected])};
   const {manifestHash:_,...manifestBody}=manifest;
   const commandManifest=createStoryExecutionManifest({...JSON.parse(JSON.stringify(manifestBody)),validationPlan:[commandRequirement]});
   const blocked=runHostValidationRequirement(commandManifest,commandManifest.validationPlan[0],{env:{RORCA_AUTONOMOUS_ISOLATION:'local-dev'}});
   assert.equal(blocked.classification,'environment_unavailable');assert.notEqual(blocked.termination.kind,'exited');
   console.log(JSON.stringify({label:'actual-unsupported-command-launch',validation:blocked,checksExecuted:false}));
  }
  console.log(JSON.stringify({label:'TEST-only-actual-native-validator',runId:manifest.identity.runId,manifestHash:manifest.manifestHash,attemptResultId:attempt.attemptResultId,decisionId:decision.decisionId,artifactHash:expected,validation:observed,decision,staleReasonCodes:stale.reasonCodes,invalidText:denied.classification,authorityIssued:false}));
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
