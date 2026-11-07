/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { compileLifecyclePlan, SSDLC_PLAN_COMPILER_VERSION } from '../../ssdlc-plan-compiler';
import { createHash } from 'node:crypto';
import { normalizeSsdlcContractJson } from '../../ssdlc-contracts';
export const h=`sha256:${'a'.repeat(64)}`;
export const plan=compileLifecyclePlan({schemaVersion:1,workspaceId:'ws',canonicalSpec:{specId:'parent',version:'7',contentHash:h,json:{userStories:[{id:'US-1',title:'Implement',acceptanceCriteria:['Works']}]}},workspaceTags:[],riskAssignments:[],ownerAssignments:[],policyAnnotations:[],compilerAnnotations:[],compilerVersion:SSDLC_PLAN_COMPILER_VERSION,policyVersion:'test',compiledAt:'2026-10-27T00:00:00.000Z'}).plan;
export const digest=(v:unknown)=>`sha256:${createHash('sha256').update(normalizeSsdlcContractJson(v)).digest('hex')}`;
export function body(){const gate=plan.gates.find(g=>g.phaseId==='development')!.gateId;return {
 contractVersion:'eco.phase-work/proposal-v1',id:'6760e13e-cf37-42be-b7d8-7c24b2148e11',workspaceId:'ws',revision:1,phase:'development',workKind:'implementation',
 modes:{execution:'rorca-managed',knowledge:'connected',governance:'enrolled'},parentBinding:{specId:'parent',specRevision:7,planId:plan.planId,planHash:digest(plan),gateIds:[gate]},
 sourceBindings:[{producer:'local-document',contractVersion:'eco.local-document/v1',hashAlgorithm:'sha256-bytes',packageHash:h,sourceId:'source',sourcePath:'source.md',manifestByteHash:h,materialHash:null,artifactPath:'source.md',artifactHash:h,citationRefs:[]}],
 recipeBinding:{id:'implement-spec',semanticVersion:'1.0.0',contentHash:h},objective:'Implement bounded work',
 deliverables:[{id:'code',mediaType:'text/plain',relativePath:'out/code.txt',maximumBytes:100,criterionIds:['criterion']}],
 criteria:[{id:'criterion',description:'Works',evaluatorKind:'test',requiredEvidenceKinds:['test'],gateIds:[gate]}],prerequisites:[],
 effectPolicy:{allowReadRoots:['src'],allowWriteRoots:['src'],networkDestinations:[],permittedToolClasses:['read'],deniedEffects:['deployment','credential-mutation','production-db-write','merge','phase-advance','lifecycle-acceptance']},
 budgets:{wallSeconds:1800,retries:0,toolCalls:100,contextTokens:32000,tokenizer:'test',outputBytes:100,spendMicroUsd:0},
};}
