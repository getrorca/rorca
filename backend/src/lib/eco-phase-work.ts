/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// Provider-owned validator for the frozen external ECO phase-work body.
// Kept independent of standalone at runtime; body hash semantics are unchanged.
import { z } from 'zod';
import { TextArtifactCheckSchema } from './eco-text-validation-contract';
import { createHash } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from './errors';
import { LifecyclePlanSchema, normalizeSsdlcContractJson } from './ssdlc-contracts';
import type { LifecycleDispatchClaim } from './lifecycle-dispatch-claim';
const CANONICAL_PHASES=['planning','requirements','design','development','testing','deployment','maintenance'] as const;
const NativeHashSchema=z.string().regex(/^sha256:[0-9a-f]{64}$/);
const hashBytes=(v:string)=>`sha256:${createHash('sha256').update(v,'utf8').digest('hex')}`;
const immutable=<T>(v:T):T=>structuredClone(v);
export const PHASE_WORK_CONTRACT = 'eco.phase-work/proposal-v1' as const;
const text = z.string().min(1).max(4096);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const integer = z.number().int().safe();
export const RelativePathSchema = z.string().min(1).max(1024).refine((p) => !p.includes('\\') && !p.includes('\0') && !p.startsWith('/') && !p.includes(':') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..'), 'Expected normalized relative POSIX path');
export const RecipeBindingSchema = z.object({ id, semanticVersion: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/), contentHash: NativeHashSchema }).strict();
export const SourceBindingSchema = z.object({
  producer: z.enum(['genesis-package', 'rorca-export-kit', 'local-document']), contractVersion: text, hashAlgorithm: text,
  packageHash: NativeHashSchema, sourceId: id, sourcePath: RelativePathSchema, manifestByteHash: NativeHashSchema, materialHash: NativeHashSchema.nullable(),
  artifactPath: RelativePathSchema, artifactHash: NativeHashSchema, citationRefs: z.array(text).max(1000),
}).strict();
export const DENIED_EFFECTS = Object.freeze(['deployment', 'credential-mutation', 'production-db-write', 'merge', 'phase-advance', 'lifecycle-acceptance'] as const);
export const EffectPolicySchema = z.object({
  allowReadRoots: z.array(RelativePathSchema).max(100), allowWriteRoots: z.array(RelativePathSchema).max(100),
  networkDestinations: z.array(z.string().url().refine((v) => { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash && u.origin === v; })).max(100),
  permittedToolClasses: z.array(id).max(100), deniedEffects: z.array(id).max(100),
}).strict();
export const BudgetSchema = z.object({
  wallSeconds: integer.min(60).max(14400), retries: integer.min(0).max(3), toolCalls: integer.min(1).max(100),
  contextTokens: integer.min(1).max(32000), tokenizer: text, outputBytes: integer.min(1).max(100 * 1024 * 1024), spendMicroUsd: integer.min(0),
}).strict();
const prerequisite = z.object({ phaseWorkId: z.string().uuid(), revision: integer.positive(), deliverableId: id, artifactHash: NativeHashSchema }).strict();
const parent = z.object({ specId: id, specRevision: integer.positive(), planId: id, planHash: NativeHashSchema, gateIds: z.array(id).min(1).max(200) }).strict();
export const PhaseWorkBodySchema = z.object({
  contractVersion: z.literal(PHASE_WORK_CONTRACT), id: z.string().uuid(), workspaceId: id, revision: integer.positive(),
  phase: z.enum(CANONICAL_PHASES), workKind: id,
  modes: z.object({ execution: z.enum(['hermes-direct', 'rorca-managed']), knowledge: z.enum(['connected', 'snapshot']), governance: z.enum(['enrolled', 'local-proposal']) }).strict(),
  parentBinding: parent.nullable(), sourceBindings: z.array(SourceBindingSchema).min(1).max(100), recipeBinding: RecipeBindingSchema, objective: text,
  deliverables: z.array(z.object({ id, mediaType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/), relativePath: RelativePathSchema, maximumBytes: integer.positive().max(10 * 1024 * 1024), criterionIds: z.array(id).min(1).max(200) }).strict()).min(1).max(100),
  criteria: z.array(z.object({ id, description: text, evaluatorKind: z.enum(['schema', 'test', 'reviewer']), textArtifactCheck: TextArtifactCheckSchema.optional(), requiredEvidenceKinds: z.array(id).min(1).max(100), gateIds: z.array(id).max(200) }).strict()).min(1).max(200),
  prerequisites: z.array(prerequisite).max(100), effectPolicy: EffectPolicySchema, budgets: BudgetSchema,
}).strict();
export type PhaseWorkBody = z.infer<typeof PhaseWorkBodySchema>;
export type PhaseWork = PhaseWorkBody & { contentHash: string };
/** Reject non-JSON values rather than allowing JSON.stringify to erase identity. */
export function canonicalJson(value: unknown): string {
  const visit = (v: unknown, depth: number): string => {
    if (depth > 48) throw new Error('INPUT_UNSAFE: JSON nesting limit');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (Array.isArray(v)) {
      if (Object.keys(v).length !== v.length) throw new Error('INPUT_UNSAFE: sparse or decorated array');
      return `[${v.map((x) => visit(x, depth + 1)).join(',')}]`;
    }
    if (v && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v))) {
      const keys = Reflect.ownKeys(v);
      if (keys.some((k) => typeof k !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(v, k)!, 'value'))) throw new Error('INPUT_UNSAFE: non-JSON property');
      return `{${(keys as string[]).sort().map((k) => `${JSON.stringify(k)}:${visit((v as Record<string, unknown>)[k], depth + 1)}`).join(',')}}`;
    }
    throw new Error('INPUT_UNSAFE: non-JSON value');
  };
  return visit(value, 0);
}
export function contractHash(value: unknown): string { return hashBytes(canonicalJson(value)); }
function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`INPUT_UNSAFE: duplicate ${label}`);
}
export function sealPhaseWork(input: unknown) {
  const bytes = canonicalJson(input);
  if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error('INPUT_UNSAFE: phase spec exceeds 1 MiB');
  const body = PhaseWorkBodySchema.parse(JSON.parse(bytes));
  validateSemantics(body);
  return immutable({ ...body, contentHash: contractHash(body) });
}
export interface ValidationContext {
  /** Trusted authorized snapshots; provider must resolve/read these in its admission transaction. */
  parentPlans?: readonly (z.infer<typeof parent> & { workspaceId: string })[];
  dependencies?: readonly DependencySnapshot[];
}
export interface DependencySnapshot {
  workspaceId: string; phaseWorkId: string; revision: number;
  artifacts: readonly { deliverableId: string; artifactHash: string }[];
  prerequisites: readonly z.infer<typeof prerequisite>[];
}
function validateSemantics(body: PhaseWorkBody): void {
  const { execution, knowledge, governance } = body.modes;
  if ((execution === 'rorca-managed' && (knowledge !== 'connected' || governance !== 'enrolled')) || (knowledge === 'snapshot' && (execution !== 'hermes-direct' || governance !== 'local-proposal'))) throw new Error('CAPABILITY_UNSUPPORTED: invalid mode tuple');
  if ((governance === 'enrolled') !== (body.parentBinding !== null)) throw new Error('INPUT_UNSAFE: parent binding must match governance');
  if (body.workKind === 'analysis' && !['planning', 'requirements'].includes(body.phase)) throw new Error('INPUT_UNSAFE: analysis must explicitly select planning or requirements');
  unique(body.deliverables.map((d) => d.id), 'deliverable IDs'); unique(body.deliverables.map((d) => d.relativePath), 'output paths'); unique(body.criteria.map((c) => c.id), 'criterion IDs');
  unique(body.sourceBindings.map((s) => `${s.producer}:${s.sourceId}:${s.sourcePath}:${s.artifactPath}`), 'source bindings');
  for (const s of body.sourceBindings) {
    const supported = s.producer === 'rorca-export-kit' ? s.contractVersion === 'rorca.export-kit-manifest.v1' && s.hashAlgorithm === 'rorca-export-kit-compiler-1' && s.materialHash !== null : s.producer === 'genesis-package' ? s.contractVersion === 'genesis-package.v2' && s.hashAlgorithm === 'genesis.package-content/v2' && s.materialHash === null : s.contractVersion === 'eco.local-document/v1' && s.hashAlgorithm === 'sha256-bytes' && s.packageHash === s.artifactHash && s.citationRefs.length === 0;
    if (!supported) throw new Error('CAPABILITY_UNSUPPORTED: unsupported source contract/algorithm');
    unique(s.citationRefs, 'citation refs');
  }
  const gates = body.parentBinding?.gateIds ?? []; unique(gates, 'parent gates');
  for (const c of body.criteria) {
    if(c.textArtifactCheck && (c.evaluatorKind==='reviewer'||c.requiredEvidenceKinds.some(k=>!['test','validation','schema'].includes(k))))throw new Error('INPUT_UNSAFE: text checks cannot satisfy human or non-text evidence');
    unique(c.gateIds, 'criterion gates'); unique(c.requiredEvidenceKinds, 'evidence kinds');
    if (c.gateIds.some((g) => !gates.includes(g)) || (governance === 'enrolled' && c.gateIds.length === 0)) throw new Error('INPUT_UNSAFE: criterion gate outside parent plan');
    if (!body.deliverables.some((d) => d.criterionIds.includes(c.id))) throw new Error('INPUT_UNSAFE: unmapped criterion');
  }
  for (const d of body.deliverables) {
    unique(d.criterionIds, 'deliverable criteria');
    if (d.criterionIds.some((c) => !body.criteria.some((x) => x.id === c))) throw new Error('INPUT_UNSAFE: missing criterion');
    if (d.maximumBytes > body.budgets.outputBytes) throw new Error('QUOTA_EXHAUSTED: output contract exceeds total budget');
  }
  unique(body.prerequisites.map((p) => `${p.phaseWorkId}:${p.revision}:${p.deliverableId}`), 'prerequisites');
  if (body.prerequisites.some((p) => p.phaseWorkId === body.id)) throw new Error('DEPENDENCY_CYCLE: self dependency');
  for (const values of Object.values(body.effectPolicy)) unique(values, 'effect policy entry');
  if (DENIED_EFFECTS.some((e) => !body.effectPolicy.deniedEffects.includes(e))) throw new Error('EFFECT_DENIED: mandatory denied effect missing');
}
export const sealExternalPhaseWork=sealPhaseWork;
export const EcoPhaseWorkBindingSchema=z.object({
  contractVersion:z.literal('rorca.phase-work-binding.v1'),
  phaseWork:z.object({...PhaseWorkBodySchema.shape,contentHash:NativeHashSchema}).strict(),
  providerSpecVersion:z.string().min(1).max(256),
}).strict();
export type EcoPhaseWorkBinding=z.infer<typeof EcoPhaseWorkBindingSchema>;
export type EcoBindingClient={query:(sql:string,params:any[])=>Promise<{rows:any[]}>};
export async function readEcoPhaseWork(client:EcoBindingClient,input:{workspaceId:string;phaseWorkId:string;revision:number}) {
  const result=await client.query(`SELECT revision.canonical_body,revision.content_hash,revision.recipe_hash,revision.source_set_hash,
    binding.claim_id,binding.provider_spec_version FROM eco_phase_work_revisions revision
    LEFT JOIN eco_phase_dispatch_bindings binding ON binding.workspace_id=revision.workspace_id
      AND binding.phase_work_id=revision.phase_work_id AND binding.revision=revision.revision
    WHERE revision.workspace_id=$1 AND revision.phase_work_id=$2::uuid AND revision.revision=$3`,[input.workspaceId,input.phaseWorkId,input.revision]);
  const row=result.rows[0];if(!row)throw new NotFoundError('Phase-work revision');
  const phaseWork=sealExternalPhaseWork(row.canonical_body);
  if(phaseWork.contentHash!==row.content_hash)throw new ConflictError('Stored phase-work integrity differs');
  return {contractVersion:'rorca.phase-work-binding.v1',workspaceId:input.workspaceId,status:'immutable-reference',
    phaseWork,recipeHash:row.recipe_hash,sourceSetHash:row.source_set_hash,claimId:row.claim_id??null,
    providerSpecVersion:row.provider_spec_version??null,acceptanceAuthority:'none',sourceAuthority:'unverified-reference-pins'};
}
/** Runs INSIDE the existing lifecycle claim transaction. Pins are not grants.
 * This deliberately does not claim recipe effect/budget enforcement, accepted
 * artifacts or source-publication authority that the existing engine lacks.
 */
export async function assertEcoPhaseWorkParent(client:EcoBindingClient,claim:LifecycleDispatchClaim,binding:unknown,validateAcceptedPrerequisites?:()=>Promise<void>) {
  const parsed=EcoPhaseWorkBindingSchema.safeParse(binding);
  if(!parsed.success)throw new ValidationError('Invalid versioned external phase-work binding');
  const {phaseWork,providerSpecVersion}=parsed.data;
  const {contentHash,...body}=phaseWork;
  if(sealExternalPhaseWork(body).contentHash!==contentHash)throw new ConflictError('Phase-work content hash differs');
  if(body.workspaceId!==claim.workspaceId || body.parentBinding?.specId!==claim.specId)throw new ConflictError('Phase-work parent scope differs');
  // No semantically accepted ECO artifact records exist yet. Do not relabel
  // generic evidence, a run pass or a hash as accepted prerequisite authority.
  if(body.prerequisites.length){
    if(!validateAcceptedPrerequisites)throw new ConflictError('Canonical accepted prerequisite artifact capability is unavailable');
    await validateAcceptedPrerequisites();
  }
  const result=await client.query(`SELECT plan.plan_json,plan.spec_version,version.version AS spec_revision
    FROM ssdlc_compiled_plans plan
    JOIN spec_versions version ON version.workspace_id=plan.workspace_id AND version.spec_slug=plan.spec_slug
      AND version.version::text=plan.spec_version
    WHERE plan.workspace_id=$1 AND plan.spec_slug=$2 AND plan.id=$3::bigint AND plan.is_current=TRUE AND plan.validation_status='validated'
      AND plan.provenance_json->>'specHash'=$4 FOR SHARE OF plan,version`,[claim.workspaceId,claim.specId,claim.compiledPlanId,claim.specHash]);
  const row=result.rows[0];
  if(!row)throw new ConflictError('Phase-work parent is no longer current');
  const plan=LifecyclePlanSchema.parse(row.plan_json);
  const parent=body.parentBinding!;
  if(!Number.isSafeInteger(Number(row.spec_revision)) || Number(row.spec_revision)!==parent.specRevision
    || row.spec_version!==providerSpecVersion || plan.workspaceId!==claim.workspaceId || plan.specId!==claim.specId
    || plan.planId!==parent.planId || hashBytes(normalizeSsdlcContractJson(plan))!==parent.planHash
    || parent.gateIds.some(id=>!plan.gates.some(g=>g.gateId===id && g.phaseId===body.phase)))throw new ConflictError('Phase-work exact parent plan, phase, gate or provider revision differs');
  return parsed.data;
}
export async function bindEcoPhaseWork(client:EcoBindingClient,claim:LifecycleDispatchClaim,binding:unknown,validateAcceptedPrerequisites?:()=>Promise<void>):Promise<void> {
  const {phaseWork,providerSpecVersion}=await assertEcoPhaseWorkParent(client,claim,binding,validateAcceptedPrerequisites);
  const {contentHash,...body}=phaseWork;
  // Immutable revision with exact-byte replay detection. No mutable latest or
  // lifecycle state is created. The existing claim FK remains admission owner.
  const canonicalBytes=canonicalJson(body);
  await client.query(`INSERT INTO eco_phase_work_revisions
    (workspace_id,phase_work_id,revision,content_hash,canonical_body,canonical_bytes,recipe_hash,source_set_hash)
    VALUES($1,$2::uuid,$3,$4,$5::jsonb,$6,$7,$8)
    ON CONFLICT(workspace_id,phase_work_id,revision) DO NOTHING`,
    [body.workspaceId,body.id,body.revision,contentHash,JSON.stringify(body),canonicalBytes,body.recipeBinding.contentHash,contractHash(body.sourceBindings)]);
  await client.query(`INSERT INTO eco_phase_dispatch_bindings
    (claim_id,workspace_id,phase_work_id,revision,content_hash,provider_spec_version)
    VALUES($1::uuid,$2,$3::uuid,$4,$5,$6)
    ON CONFLICT(claim_id) DO NOTHING`,[claim.claimId,body.workspaceId,body.id,body.revision,contentHash,providerSpecVersion]);
  // The database unique/FK/guard constraints reject conflicting replay and
  // competing claim IDs for this exact canonical revision across principals.
  const exact=await client.query(`SELECT 1 FROM eco_phase_dispatch_bindings
    WHERE claim_id=$1::uuid AND workspace_id=$2 AND phase_work_id=$3::uuid
      AND revision=$4 AND content_hash=$5 AND provider_spec_version=$6`,
    [claim.claimId,body.workspaceId,body.id,body.revision,contentHash,providerSpecVersion]);
  if(!exact.rows[0])throw new ConflictError('Phase-work immutable dispatch binding conflicts');
}
