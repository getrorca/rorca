/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Native eco.recipe/proposal-v1 bytes. No runtime dependency on standalone.
 * Keep this schema and hash algorithm aligned with its actual native producer.
 * Provider publication authority comes from the privileged host record, never
 * from a caller supplying a self-signed recipe body.
 */
import { z } from 'zod';
import { BudgetSchema, contractHash, DENIED_EFFECTS, EffectPolicySchema, RelativePathSchema, type PhaseWork } from './eco-phase-work';
import { ConflictError } from './errors';
const label=z.string().min(1).max(4096);
const name=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const EcoRecipeBodySchema=z.object({
 contractVersion:z.literal('eco.recipe/proposal-v1'),id:name,semanticVersion:z.literal('1.0.0'),
 phases:z.array(z.enum(['planning','requirements','design','development','testing','deployment','maintenance'])).min(1),workKind:name,
 executionModes:z.array(z.enum(['hermes-direct','rorca-managed'])).min(1),prompt:label,modelJudgment:z.array(label).min(1),
 inputs:z.array(z.object({id:name,kind:z.enum(['source-artifact','prerequisite-artifact','failure-observation']),description:label}).strict()).min(1),
 outputs:z.array(z.object({id:name,relativePath:RelativePathSchema,mediaType:label,maximumBytes:z.number().int().safe().positive().max(10*1024*1024)}).strict()).min(1),
 steps:z.array(z.object({id:name,action:label,toolClass:name,required:z.literal(true)}).strict()).min(4),
 checks:z.array(z.object({id:name,evaluatorKind:z.enum(['schema','test','reviewer']),requirement:label}).strict()).min(1),
 effectPolicy:EffectPolicySchema,budgets:BudgetSchema,stop:z.literal('artifact-review-submission'),onMissingInput:z.literal('block'),
 onSourceChange:z.literal('require-new-revision'),onTimeout:z.literal('stop-and-reconcile'),
}).strict();
const fail=(message:string):never=>{throw new ConflictError(`Exact provider recipe ${message}`);};
export function assertEcoRecipeAuthority(raw:unknown,phase:PhaseWork):void{
 const parsed=EcoRecipeBodySchema.safeParse(raw);if(!parsed.success)fail('native body schema differs');const recipe=parsed.data!;
 if(contractHash(recipe)!==phase.recipeBinding.contentHash||recipe.id!==phase.recipeBinding.id||recipe.semanticVersion!==phase.recipeBinding.semanticVersion
  ||!recipe.phases.includes(phase.phase)||recipe.workKind!==phase.workKind||!recipe.executionModes.includes(phase.modes.execution))fail('hash/identity/phase/work kind/mode differs');
 for(const values of [recipe.inputs.map(x=>x.id),recipe.outputs.map(x=>x.id),recipe.outputs.map(x=>x.relativePath),recipe.steps.map(x=>x.id),recipe.checks.map(x=>x.id),recipe.phases,recipe.executionModes])if(new Set(values).size!==values.length)fail('contains duplicate identities');
 if(DENIED_EFFECTS.some(e=>!recipe.effectPolicy.deniedEffects.includes(e))||recipe.steps.some(s=>!recipe.effectPolicy.permittedToolClasses.includes(s.toolClass)))fail('mandatory effect policy differs');
 if(recipe.outputs.reduce((sum,o)=>sum+o.maximumBytes,0)>recipe.budgets.outputBytes)fail('output total exceeds budget');
 for(const field of ['allowReadRoots','allowWriteRoots'] as const)if(phase.effectPolicy[field].some(root=>!recipe.effectPolicy[field].some(ceiling=>root===ceiling||root.startsWith(`${ceiling}/`))))fail('path effect ceiling exceeded');
 for(const field of ['networkDestinations','permittedToolClasses'] as const)if(phase.effectPolicy[field].some(value=>!recipe.effectPolicy[field].includes(value)))fail('effect ceiling exceeded');
 if(recipe.effectPolicy.deniedEffects.some(e=>!phase.effectPolicy.deniedEffects.includes(e))||recipe.steps.some(s=>!phase.effectPolicy.permittedToolClasses.includes(s.toolClass)))fail('required denied effect or tool class differs');
 for(const field of ['wallSeconds','retries','toolCalls','contextTokens','outputBytes','spendMicroUsd'] as const)if(phase.budgets[field]>recipe.budgets[field])fail('budget ceiling exceeded');
 if(phase.budgets.tokenizer!==recipe.budgets.tokenizer)fail('tokenizer differs');
 if(phase.deliverables.length!==recipe.outputs.length||recipe.outputs.some(o=>!phase.deliverables.some(d=>d.id===o.id&&d.relativePath===o.relativePath&&d.mediaType===o.mediaType&&d.maximumBytes<=o.maximumBytes)))fail('output mapping differs');
 for(const check of recipe.checks)if(!phase.criteria.some(c=>c.id===check.id&&c.evaluatorKind===check.evaluatorKind&&c.description===check.requirement))fail('required check obligation omitted or changed');
}
