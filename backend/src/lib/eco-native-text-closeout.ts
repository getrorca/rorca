/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Host composition for declarative text-only artifacts. No arbitrary code execution. */
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import type {PoolClient} from 'pg';
import {query,queryOne} from '../db/index';
import type {EcoManagedInput} from './eco-managed-admission';
import {contractHash,canonicalJson} from './eco-phase-work';
import {HOST_TEXT_VALIDATOR,HostTextCheckSchema} from './eco-text-validation-contract';
import {deriveStoryContractRevision,verifyStoryExecutionManifest,type ImmutableStoryExecutionManifest} from './story-execution-packet';
import {durableAtomicWriteFile} from './run-spec-snapshot';
import {relayTrustedWalEvent} from './trusted-wal';
import {persistHostAttemptLaunches,finalizeHostStoryAttempt,requireSuccessfulHostStoryAttempt} from './host-story-attempt-envelope';
import {runHostValidationRequirement} from './story-host-validation';
import {createStoryAttemptResult,evaluateStoryCloseout,adaptStoryCloseoutEvidence,persistStoryCloseoutBundle,type StoryCloseoutHostFacts} from './story-closeout';
import {recordCheckpointValidationAttestation} from './checkpoint-reconciliation';
import {persistNativeTextStoryResult} from './story-result-persistence';

export async function prepareEcoNativeTextAttempt(runId:number,scope:EcoManagedInput,workerId:string,readArtifact:(deliverableId:string)=>Promise<any>,guard:(client:PoolClient)=>Promise<void>){
 const run=await queryOne<any>('SELECT * FROM pipeline_runs WHERE id=$1',[runId]);
 const manifests=(await query<{payload:ImmutableStoryExecutionManifest}>('SELECT payload FROM story_execution_manifests WHERE run_id=$1 ORDER BY story_id,attempt',[runId])).map(r=>r.payload);
 if(!run||manifests.length!==1||manifests[0].identity.storyId!==scope.storyId)throw Error('Native text path requires exact single frozen story');
 const manifest=manifests[0];
 if(!verifyStoryExecutionManifest(manifest)||manifest.repositoryProfile.changePolicy!=='no_code_allowed'
  ||!manifest.validationPlan.length||manifest.validationPlan.some(r=>r.command!==HOST_TEXT_VALIDATOR))throw Error('Native text path lacks declarative frozen validation capability');
 const phase=scope.binding.phaseWork;
 // Re-derive checks from the admitted phase, not from arbitrary manifest labels.
 const expected=phase.criteria.flatMap(c=>{
  if(!c.textArtifactCheck||c.evaluatorKind==='reviewer'||c.requiredEvidenceKinds.some(k=>!['schema','test','validation'].includes(k)))throw Error('Native text path cannot evaluate human/untyped criteria');
  return phase.deliverables.filter(d=>d.criterionIds.includes(c.id)).map(d=>({id:`text-${c.id}-${d.id}`,args:[JSON.stringify({...c.textArtifactCheck,deliverableId:d.id,relativePath:d.relativePath,mediaType:d.mediaType,maximumBytes:d.maximumBytes})]}));
 });
 if(expected.length!==manifest.validationPlan.length||expected.some(e=>!manifest.validationPlan.some(r=>r.id===e.id&&canonicalJson(r.args)===canonicalJson(e.args)&&r.required&&r.revisionSensitive))
  ||manifest.evidenceExpectations.length!==phase.criteria.length||manifest.evidenceExpectations.some(e=>!phase.criteria.some(c=>c.description===e.description)))throw Error('Native text manifest/phase criteria differ');
 const cwd=run.execution_worktree_path;
 const git=(args:string[])=>{const raw=execFileSync('git',args,{cwd,encoding:'utf8',stdio:'pipe'});return args[0]==='status'?raw.trimEnd():raw.trim();};
 const head=git(['rev-parse','HEAD']);const branch=git(['branch','--show-current']);
 const generation=randomUUID();
 const receipt=await persistHostAttemptLaunches({workspaceId:phase.workspaceId,runId,launchGeneration:generation,cancellationFence:run.dispatch_fence,
  canonicalSpecPath:run.spec_path,runSpecPath:run.run_spec_path,repositoryPath:run.execution_workspace_path,worktreePath:cwd,
  expectedGitSha:head,expectedGitBranch:branch,runtime:{processRole:'worker-engine',workerId,engineEntrypoint:__filename,agent:'host-typed-text-artifact',model:null,terminalMode:'none',processPid:process.pid},manifests});
 return {async finish(recheck:()=>Promise<void>){
  await recheck();
  const validations=[];
  for(const requirement of manifest.validationPlan){
   const check=HostTextCheckSchema.parse(JSON.parse(requirement.args[0]));
   const row=await readArtifact(check.deliverableId);
   const proposal=row?JSON.parse(row.canonical_bytes):undefined;
   if(!proposal||contractHash(proposal)!==row.content_hash||proposal.runId!==runId||proposal.phaseHash!==phase.contentHash||proposal.relativePath!==check.relativePath||proposal.acceptanceAuthority!=='none')throw Error('Native text proposal missing or exact pins/hash differ');
   const criterion=phase.criteria.find(c=>requirement.id===`text-${c.id}-${check.deliverableId}`)!;
   const criterionIds=manifest.evidenceExpectations.filter(e=>e.description===criterion.description).map(e=>e.criterionId);
   validations.push(runHostValidationRequirement(manifest,requirement,{artifactText:proposal.text,criterionIds}));
  }
  const good=validations.every(v=>v.classification==='passed');
  await recheck();
  await finalizeHostStoryAttempt({workspaceId:phase.workspaceId,runId,storyId:manifest.identity.storyId,attempt:manifest.identity.attempt,launchGeneration:generation,cancellationFence:run.dispatch_fence,manifestHash:manifest.manifestHash,outcome:good?'success':'nonzero_exit',provenance:'host_process',exitCode:good?0:1});
  const changedFiles=git(['status','--porcelain','--untracked-files=all']).split('\n').filter(Boolean).map(l=>l.slice(3));
  const runtimeMetadataFiles=changedFiles.filter(p=>p.startsWith('.rorca/')||p.startsWith('forge/specs/'));
  const host:StoryCloseoutHostFacts={identity:manifest.identity,activeSubjectRevision:{commitSha:git(['rev-parse','HEAD']),worktreePath:cwd,branch:git(['branch','--show-current'])},repository:{worktreeClean:changedFiles.length===runtimeMetadataFiles.length,changedFiles,runtimeMetadataFiles,headBeforeValidation:head,headAfterValidation:git(['rev-parse','HEAD'])},validations,criterionEvidence:[],storyCommits:[],progress:null,storyResult:null};
  const evidence=adaptStoryCloseoutEvidence(manifest,host);
  host.criterionEvidence=manifest.evidenceExpectations.map(e=>({criterionId:e.criterionId,evidenceReferences:evidence.filter(v=>(v.details?.criterionIds as string[]|undefined)?.includes(e.criterionId)).map(v=>`EVD-sha256:${v.payloadHash}`),subjectRevision:head,observedBy:'rorca_host'}));
  const packet={manifestHash:manifest.manifestHash,identity:manifest.identity,revisions:manifest.revisions,proposal:'complete' as const,summary:'Typed text artifact submitted; host executes only declared content/hash checks, no code execution or human review.',criterionEvidence:manifest.evidenceExpectations.map(e=>({criterionId:e.criterionId,evidenceReferences:[]}))};
  const attempt=createStoryAttemptResult({identity:manifest.identity,revisions:manifest.revisions,manifestHash:manifest.manifestHash,agentProcess:{agent:'host-typed-text-artifact',model:null,effort:null,processId:process.pid,sessionId:null},startedAt:validations[0].startedAt,finishedAt:validations.at(-1)!.finishedAt,termination:{kind:'exited',exitCode:good?0:1},outputReferences:validations.map(v=>v.output),proposedCompletionPacket:packet,observedFiles:[],observedCommits:[],hostValidationObservations:validations,knownIssues:[]});
  const decision=evaluateStoryCloseout({manifest,attempt,host});
  await recheck();await persistStoryCloseoutBundle({manifest,attempt,decision,evidence});
  if(decision.status!=='accepted')throw Error(`Native text host closeout blocked: ${decision.reasonCodes.join(',')}`);
  await requireSuccessfulHostStoryAttempt({workspaceId:phase.workspaceId,runId,storyId:manifest.identity.storyId,attempt:manifest.identity.attempt,launchGeneration:generation,cancellationFence:run.dispatch_fence,manifestHash:manifest.manifestHash});
  const passedAt=new Date();const id=randomUUID();const digest=createHash('sha256').update(canonicalJson({manifestHash:manifest.manifestHash,decisionId:decision.decisionId,artifactObservations:validations,phaseHash:phase.contentHash,dispatchFence:run.dispatch_fence,generation,head,branch})).digest('hex');
  await recordCheckpointValidationAttestation({id,workspaceId:phase.workspaceId,runId,storyId:manifest.identity.storyId,branch,checkpointSha:head,validationGate:'execution-engine',evidenceDigest:digest,passedAt:passedAt.toISOString(),expiresAt:new Date(passedAt.getTime()+3600000).toISOString()});
  await recheck();
  const result=await persistNativeTextStoryResult({runId,storyId:manifest.identity.storyId,status:'pass',integrated:true,commitSha:head,commitMessage:'Host-validated no-code text artifact at exact canonical run checkout',worktreePath:cwd,worktreeBranch:branch,idempotencyKey:`eco-text:${runId}:${manifest.manifestHash}`,completionPacket:packet,trustedPassOutbox:{payload:{run_id:runId,story_id:manifest.identity.storyId,integrated:true,commit_sha:head,integrated_branch:branch,checkpoint_attestation_id:id,checkpoint_attestation_digest:digest,checkpoint_attestation_passed_at:passedAt.toISOString(),checkpoint_attestation_expires_at:new Date(passedAt.getTime()+3600000).toISOString(),code_execution:'not-performed'}}},guard);
  // Same host ordering as integrated engine finalization: accepted result,
  // durable run-local lifecycle projection, THEN release its exact outbox.
  // Canonical source remains unchanged; preserve every semantic byte/value.
  await recheck();
  const projection=JSON.parse(fs.readFileSync(run.run_spec_path,'utf8'));
  if(deriveStoryContractRevision(projection)!==manifest.revisions.specRevision)throw Error('Run text spec revision changed before pass projection');
  const stories=projection.userStories ?? projection.phases?.flatMap((p:any)=>p.stories??[]);
  const matches=stories?.filter((s:any)=>s.id===manifest.identity.storyId);
  if(matches?.length!==1)throw Error('Run text spec story projection differs');
  matches[0].passes=true;
  durableAtomicWriteFile(run.run_spec_path,JSON.stringify(projection,null,2)+'\n');
  if(!result.trustedWal)throw Error('Native text result has no exact pass outbox');
  await relayTrustedWalEvent(result.trustedWal);
  console.log(JSON.stringify({event:'eco-native-text-host-result',runId,manifestHash:manifest.manifestHash,generation,dispatchFence:run.dispatch_fence,envelopeIds:receipt.envelopeIds,decisionId:decision.decisionId,result,artifactObservations:validations}));
 }};
}
