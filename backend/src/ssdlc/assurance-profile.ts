/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import controlsArtifact from './catalog/controls.json';
import { EntityRefV1Schema, RevisionRefV1Schema, type EntityRefV1, type RevisionRefV1 } from '../lib/mission-contracts';
import { SourceBundleV1Schema, type SourceBundleV1 } from '../lib/source-contracts';
import {
  EvidenceRequirementSchema,
  MISSION_STAGE_BY_PHASE,
  parseControl,
  PHASES,
  type ControlRecord,
  type EvidenceRequirement,
} from './schema/control-schema';
import { MISSION_STAGES, type GateCompilation } from './gates/gate-compiler';
import type { ApplicabilityResolution } from './applicability/resolver';

export const ASSURANCE_PROFILE_VERSION = 'rorca.assurance-profile.v1' as const;
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'must be a lowercase sha256 digest');
const nonEmpty = z.string().trim().min(1);
const revisionEquals = (left: RevisionRefV1, right: RevisionRefV1): boolean => left.kind === right.kind && left.value === right.value;

const MechanismBindingSchema = z.object({
  mechanismId: nonEmpty,
  kind: z.enum(['command', 'repository-path', 'skill', 'workflow', 'review']),
  locator: nonEmpty,
}).strict();

const ControlInstanceSchema = z.object({
  controlId: nonEmpty,
  mechanismBindings: z.array(MechanismBindingSchema).min(1)
    .refine((items) => new Set(items.map(({ mechanismId }) => mechanismId)).size === items.length, 'mechanismIds must be unique per control'),
  criteria: z.array(z.object({
    criterionId: nonEmpty,
    description: nonEmpty,
    evaluator: z.enum(['exit-code', 'artifact-match', 'finding-count', 'human-decision']),
    expected: nonEmpty,
  }).strict()).min(1).refine((items) => new Set(items.map(({ criterionId }) => criterionId)).size === items.length, 'criterionIds must be unique per control'),
  evidenceRequirements: z.array(EvidenceRequirementSchema).min(1),
  enforcement: z.enum(['required', 'preferred']).optional(),
}).strict();

const ProfileCoreSchema = z.object({
  schemaVersion: z.literal(ASSURANCE_PROFILE_VERSION),
  profileKind: z.enum(['compiled', 'default']),
  profileId: nonEmpty,
  specRef: EntityRefV1Schema,
  specRevision: RevisionRefV1Schema,
  repositoryContextHash: sha256,
  sourceContext: z.object({
    bundleId: nonEmpty,
    bundleHash: sha256,
    specRevision: RevisionRefV1Schema,
  }).strict().nullable(),
  riskProfile: z.object({
    level: z.enum(['none', 'low', 'medium', 'high', 'critical']),
    tags: z.array(nonEmpty).refine((tags) => new Set(tags).size === tags.length, 'risk tags must be unique'),
    rationale: nonEmpty,
  }).strict(),
  selectionContext: z.object({
    applicabilityControlIds: z.array(nonEmpty).refine((ids) => new Set(ids).size === ids.length, 'active controlIds must be unique'),
    phaseGroups: z.array(z.object({ phase: z.enum(PHASES), controlIds: z.array(nonEmpty) }).strict()),
    stageProjection: z.array(z.object({
      stage: z.enum(MISSION_STAGES),
      phases: z.array(z.enum(PHASES)),
      controlIds: z.array(nonEmpty),
    }).strict()),
  }).strict().optional(),
  controlInstances: z.array(ControlInstanceSchema)
    .refine((instances) => new Set(instances.map(({ controlId }) => controlId)).size === instances.length, 'controlIds must be unique'),
  compilationReceiptHash: sha256.nullable(),
}).strict().superRefine((profile, context) => {
  if (profile.specRef.kind !== 'spec') context.addIssue({ code: 'custom', path: ['specRef', 'kind'], message: 'assurance profiles attach only to specs' });
  if (!profile.specRef.revision || !revisionEquals(profile.specRef.revision, profile.specRevision)) {
    context.addIssue({ code: 'custom', path: ['specRevision'], message: 'specRef revision must exactly match specRevision' });
  }
  if (profile.sourceContext && !revisionEquals(profile.sourceContext.specRevision, profile.specRevision)) {
    context.addIssue({ code: 'custom', path: ['sourceContext', 'specRevision'], message: 'source bundle must be persisted against this exact spec revision' });
  }
  if (profile.profileKind === 'compiled' && !profile.compilationReceiptHash) context.addIssue({ code: 'custom', path: ['compilationReceiptHash'], message: 'compiled profiles require a receipt' });
  if (profile.profileKind === 'default' && (profile.compilationReceiptHash !== null || profile.sourceContext !== null || profile.controlInstances.length > 0)) {
    context.addIssue({ code: 'custom', path: ['profileKind'], message: 'default profiles must be explicit, empty, and uncompiled' });
  }
});

/** Public runtime schema for the immutable assurance-profile v1 artifact. */
export const AssuranceProfileV1Schema = ProfileCoreSchema;
export type AssuranceProfile = z.infer<typeof AssuranceProfileV1Schema>;
export type ControlInstance = z.infer<typeof ControlInstanceSchema>;
export type RiskProfile = AssuranceProfile['riskProfile'];
export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

const canonicalControls: readonly DeepReadonly<ControlRecord>[] = Object.freeze(controlsArtifact.map((control) => deepFreeze(parseControl(control))));
const controlsById = new Map(canonicalControls.map((control) => [control.controlId, control]));

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function receiptFor(profile: Omit<AssuranceProfile, 'compilationReceiptHash'>): string {
  return `sha256:${createHash('sha256').update(canonicalJson(profile)).digest('hex')}`;
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach((child) => deepFreeze(child));
  }
  return value as DeepReadonly<T>;
}

const EVIDENCE_DEPTH_RANK: Readonly<Record<EvidenceRequirement['evidenceDepth'], number>> = {
  declaration: 0,
  demonstrated: 1,
  'independent-verification': 2,
};

function evidenceWithoutDepth(requirement: EvidenceRequirement | DeepReadonly<EvidenceRequirement>): unknown {
  const { evidenceDepth: _evidenceDepth, ...rest } = requirement;
  return rest;
}

function assertCanonicalControlInstances(instances: readonly ControlInstance[]): void {
  for (const instance of instances) {
    const control = controlsById.get(instance.controlId);
    if (!control) throw new AssuranceProfileMismatchError('UNKNOWN_CONTROL_ID', `controlId ${instance.controlId} is absent from canonical controls.json`);
    if (!control.exceptionPolicy.allowed && instance.enforcement === 'preferred') {
      throw new AssuranceProfileMismatchError('WEAKENED_CONTROL', `controlId ${instance.controlId} is non-overridable and cannot be reduced to a preference`);
    }
    const structurallyCanonical = instance.evidenceRequirements.length === control.requiredEvidence.length
      && instance.evidenceRequirements.every((requirement, index) => (
        canonicalJson(evidenceWithoutDepth(requirement)) === canonicalJson(evidenceWithoutDepth(control.requiredEvidence[index]))
      ));
    if (!structurallyCanonical) {
      throw new AssuranceProfileMismatchError('CONTROL_EVIDENCE_MISMATCH', `controlId ${instance.controlId} evidence requirements differ structurally from US-008 controls.json`);
    }
    if (!control.exceptionPolicy.allowed && instance.evidenceRequirements.some((requirement, index) => (
      EVIDENCE_DEPTH_RANK[requirement.evidenceDepth] < EVIDENCE_DEPTH_RANK[control.requiredEvidence[index].evidenceDepth]
    ))) {
      throw new AssuranceProfileMismatchError('WEAKENED_CONTROL', `controlId ${instance.controlId} is non-overridable and its canonical evidence depth cannot be weakened`);
    }
  }
}

export class AssuranceProfileMismatchError extends Error {
  constructor(readonly code:
    | 'UNKNOWN_CONTROL_ID'
    | 'CONTROL_EVIDENCE_MISMATCH'
    | 'SPEC_REVISION_MISMATCH'
    | 'SOURCE_BUNDLE_MISMATCH'
    | 'REPOSITORY_CONTEXT_MISMATCH'
    | 'COMPILATION_RECEIPT_MISMATCH'
    | 'ACTIVE_CONTROL_MISMATCH'
    | 'MISSING_CONTROL_BINDING'
    | 'INVALID_MECHANISM'
    | 'WEAKENED_CONTROL'
    | 'MODEL_CONTEXT_MISMATCH', message: string) {
    super(message);
    this.name = 'AssuranceProfileMismatchError';
  }
}

export interface AssuranceMechanism {
  mechanismId: string;
  kind: ControlInstance['mechanismBindings'][number]['kind'];
  locator: string;
}

export interface AssuranceModelProposal {
  specRevision: RevisionRefV1;
  sourceBundleHash: string | null;
  controlBindings: Array<ControlInstance & { enforcement: 'required' | 'preferred' }>;
}

export interface BindAssuranceProfileInput {
  profileId: string;
  specRef: EntityRefV1;
  specRevision: RevisionRefV1;
  persistedSourceContext?: { bundle: SourceBundleV1; specRevision: RevisionRefV1 };
  repositoryContext: { contextHash: string; mechanisms: readonly AssuranceMechanism[] };
  riskProfile: RiskProfile;
  /** Authoritative US-003 result. The binder does not calculate or add control IDs. */
  applicability: Pick<ApplicabilityResolution, 'activeControlIds'>;
  /** Authoritative US-004 phase groups and stage projection. */
  gateCompilation: Pick<GateCompilation, 'phaseGroups' | 'readiness'>;
  modelProposal: AssuranceModelProposal;
}

export interface CompileAssuranceProfileInput {
  profileId: string;
  specRef: EntityRefV1;
  specRevision: RevisionRefV1;
  repositoryContextHash: string;
  persistedSourceContext?: { bundle: SourceBundleV1; specRevision: RevisionRefV1 };
  riskProfile: RiskProfile;
  controlInstances: ControlInstance[];
  selectionContext?: AssuranceProfile['selectionContext'];
}

function sameControlSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every((id) => right.includes(id));
}

function projectedEvidence(
  compilation: BindAssuranceProfileInput['gateCompilation'],
  controlId: string,
): EvidenceRequirement[] {
  return compilation.phaseGroups.flatMap((group) => group.evidenceRequirements
    .filter((requirement) => requirement.controlId === controlId)
    .map(({ controlId: _controlId, sourceReferences: _sourceReferences, ...requirement }) => requirement));
}

function assertCanonicalProjection(compilation: BindAssuranceProfileInput['gateCompilation']): void {
  for (const group of compilation.phaseGroups) {
    for (const controlId of group.controlIds) {
      const control = controlsById.get(controlId);
      if (control && control.phase !== group.phase) {
        throw new AssuranceProfileMismatchError(
          'ACTIVE_CONTROL_MISMATCH',
          `US-004 phase projection places controlId ${controlId} in ${group.phase}; canonical US-008 phase is ${control.phase}`,
        );
      }
    }
  }
  for (const projection of compilation.readiness) {
    const invalidPhase = projection.phases.find((phase) => MISSION_STAGE_BY_PHASE[phase] !== projection.stage);
    if (invalidPhase) {
      throw new AssuranceProfileMismatchError(
        'ACTIVE_CONTROL_MISMATCH',
        `US-004 stage ${projection.stage} includes phase ${invalidPhase}, which projects to ${MISSION_STAGE_BY_PHASE[invalidPhase]}`,
      );
    }
    for (const controlId of projection.controlIds) {
      const control = controlsById.get(controlId);
      if (control && (MISSION_STAGE_BY_PHASE[control.phase] !== projection.stage || !projection.phases.includes(control.phase))) {
        throw new AssuranceProfileMismatchError(
          'ACTIVE_CONTROL_MISMATCH',
          `US-004 stage projection places controlId ${controlId} outside its canonical ${control.phase}/${MISSION_STAGE_BY_PHASE[control.phase]} projection`,
        );
      }
    }
  }
}

function assertPersistedSourceContext(
  source: BindAssuranceProfileInput['persistedSourceContext'],
  specRef: EntityRefV1,
  specRevision: RevisionRefV1,
): void {
  if (!source) return;
  const parsed = SourceBundleV1Schema.safeParse(source.bundle);
  if (!parsed.success) {
    throw new AssuranceProfileMismatchError('SOURCE_BUNDLE_MISMATCH', 'HMG-persisted source bundle is not a canonical SourceBundleV1; persist a valid bundle before assurance binding');
  }
  if (!revisionEquals(source.specRevision, specRevision)) {
    throw new AssuranceProfileMismatchError('SPEC_REVISION_MISMATCH', 'source bundle was persisted against a different spec revision');
  }
  if (parsed.data.workspaceRef.workspaceId !== specRef.workspaceId) {
    throw new AssuranceProfileMismatchError('SOURCE_BUNDLE_MISMATCH', 'source bundle belongs to a different workspace');
  }
}

/**
 * Bind a model proposal to authoritative US-003/US-004 selections and repository mechanisms.
 * This function deliberately has no applicability inputs from which it could select controls.
 */
export function bindAssuranceProfile(input: BindAssuranceProfileInput): DeepReadonly<AssuranceProfile> {
  assertPersistedSourceContext(input.persistedSourceContext, input.specRef, input.specRevision);
  const activeIds = input.applicability.activeControlIds;
  const phaseIds = input.gateCompilation.phaseGroups.flatMap(({ controlIds }) => controlIds);
  const stageIds = [...new Set(input.gateCompilation.readiness.flatMap(({ controlIds }) => controlIds))];
  if (!sameControlSet(activeIds, phaseIds) || !sameControlSet(activeIds, stageIds)) {
    throw new AssuranceProfileMismatchError(
      'ACTIVE_CONTROL_MISMATCH',
      'US-003 activeControlIds must exactly match the US-004 phase groups and stage projection; recompile US-004 before assurance binding',
    );
  }
  assertCanonicalProjection(input.gateCompilation);

  const expectedBundleHash = input.persistedSourceContext?.bundle.bundleHash ?? null;
  if (!revisionEquals(input.modelProposal.specRevision, input.specRevision)) {
    throw new AssuranceProfileMismatchError('MODEL_CONTEXT_MISMATCH', 'model proposal targets a different spec revision; regenerate the proposal for the persisted revision');
  }
  if (input.modelProposal.sourceBundleHash !== expectedBundleHash) {
    throw new AssuranceProfileMismatchError('MODEL_CONTEXT_MISMATCH', 'model proposal source bundle hash does not match the HMG-persisted SourceBundleV1');
  }

  const proposals = new Map(input.modelProposal.controlBindings.map((binding) => [binding.controlId, binding]));
  if (proposals.size !== input.modelProposal.controlBindings.length || !sameControlSet(activeIds, [...proposals.keys()])) {
    const missing = activeIds.filter((id) => !proposals.has(id));
    const extra = [...proposals.keys()].filter((id) => !activeIds.includes(id));
    throw new AssuranceProfileMismatchError(
      'MISSING_CONTROL_BINDING',
      `proposal must bind every and only US-003/US-004 control (missing: ${missing.join(', ') || 'none'}; unselected: ${extra.join(', ') || 'none'})`,
    );
  }

  const mechanismInventory = new Map<string, AssuranceMechanism>();
  for (const candidate of input.repositoryContext.mechanisms) {
    const parsed = MechanismBindingSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new AssuranceProfileMismatchError(
        'INVALID_MECHANISM',
        `repository mechanism ${candidate.mechanismId || '<missing-id>'} is invalid: ${parsed.error.issues.map(({ path, message }) => `${path.join('.') || 'value'} ${message}`).join('; ')}`,
      );
    }
    const mechanism = parsed.data;
    if (mechanismInventory.has(mechanism.mechanismId)) {
      throw new AssuranceProfileMismatchError('INVALID_MECHANISM', `repository mechanismId ${mechanism.mechanismId} is duplicated`);
    }
    mechanismInventory.set(mechanism.mechanismId, mechanism);
  }

  const normalizedInstances = activeIds.map((controlId): ControlInstance => {
    const binding = proposals.get(controlId)!;
    const control = controlsById.get(controlId);
    if (!control) throw new AssuranceProfileMismatchError('UNKNOWN_CONTROL_ID', `controlId ${controlId} is absent from canonical US-008 controls.json`);
    if (!Array.isArray(binding.mechanismBindings) || binding.mechanismBindings.length === 0) {
      throw new AssuranceProfileMismatchError('MISSING_CONTROL_BINDING', `controlId ${controlId} has no repository mechanism binding; add an allowed command, path, skill, workflow, or review`);
    }
    if (!Array.isArray(binding.criteria) || binding.criteria.length === 0) {
      throw new AssuranceProfileMismatchError('MISSING_CONTROL_BINDING', `controlId ${controlId} has no acceptance criteria; add at least one deterministic criterion`);
    }
    if (!Array.isArray(binding.evidenceRequirements) || binding.evidenceRequirements.length === 0) {
      throw new AssuranceProfileMismatchError('MISSING_CONTROL_BINDING', `controlId ${controlId} has no structured evidence binding; bind every US-004 evidence requirement`);
    }
    for (const mechanism of binding.mechanismBindings) {
      const allowed = mechanismInventory.get(mechanism.mechanismId);
      if (!allowed || canonicalJson(allowed) !== canonicalJson(mechanism)) {
        throw new AssuranceProfileMismatchError('INVALID_MECHANISM', `controlId ${controlId} references mechanism ${mechanism.mechanismId} that is not present exactly in repository context`);
      }
    }
    const expectedEvidence = projectedEvidence(input.gateCompilation, controlId);
    if (expectedEvidence.length === 0 || canonicalJson(binding.evidenceRequirements) !== canonicalJson(expectedEvidence)) {
      throw new AssuranceProfileMismatchError('CONTROL_EVIDENCE_MISMATCH', `controlId ${controlId} must bind every structured US-004 evidence requirement exactly`);
    }
    if (!control.exceptionPolicy.allowed && binding.enforcement !== 'required') {
      throw new AssuranceProfileMismatchError('WEAKENED_CONTROL', `controlId ${controlId} is non-overridable and cannot be reduced to a preference`);
    }
    return {
      ...binding,
      mechanismBindings: [...binding.mechanismBindings].sort((a, b) => a.mechanismId.localeCompare(b.mechanismId)),
      criteria: [...binding.criteria].sort((a, b) => a.criterionId.localeCompare(b.criterionId)),
      evidenceRequirements: expectedEvidence,
    };
  });

  return compileAssuranceProfile({
    profileId: input.profileId,
    specRef: input.specRef,
    specRevision: input.specRevision,
    repositoryContextHash: input.repositoryContext.contextHash,
    persistedSourceContext: input.persistedSourceContext,
    riskProfile: input.riskProfile,
    selectionContext: {
      applicabilityControlIds: [...activeIds],
      phaseGroups: input.gateCompilation.phaseGroups.map(({ phase, controlIds }) => ({ phase, controlIds: [...controlIds] })),
      stageProjection: input.gateCompilation.readiness.map(({ stage, phases, controlIds }) => ({ stage, phases: [...phases], controlIds: [...controlIds] })),
    },
    controlInstances: normalizedInstances,
  });
}

/** Compile and recursively freeze a profile without adding lifecycle boilerplate to product stories. */
export function compileAssuranceProfile(input: CompileAssuranceProfileInput): DeepReadonly<AssuranceProfile> {
  const source = input.persistedSourceContext;
  assertPersistedSourceContext(source, input.specRef, input.specRevision);
  assertCanonicalControlInstances(input.controlInstances);
  const withoutReceipt = {
    schemaVersion: ASSURANCE_PROFILE_VERSION,
    profileKind: 'compiled' as const,
    profileId: input.profileId,
    specRef: input.specRef,
    specRevision: input.specRevision,
    repositoryContextHash: input.repositoryContextHash,
    sourceContext: source ? { bundleId: source.bundle.bundleId, bundleHash: source.bundle.bundleHash, specRevision: source.specRevision } : null,
    riskProfile: input.riskProfile,
    ...(input.selectionContext ? { selectionContext: input.selectionContext } : {}),
    controlInstances: input.controlInstances,
  };
  return deepFreeze(ProfileCoreSchema.parse({ ...withoutReceipt, compilationReceiptHash: receiptFor(withoutReceipt) }));
}

export interface CurrentAssuranceContext {
  specRef: EntityRefV1;
  specRevision: RevisionRefV1;
  repositoryContextHash: string;
  sourceBundle?: SourceBundleV1;
}

function sameEntity(left: EntityRefV1, right: EntityRefV1): boolean {
  return left.workspaceId === right.workspaceId && left.kind === right.kind && left.id === right.id;
}

function assertExactCurrentContext(current: CurrentAssuranceContext): SourceBundleV1 | undefined {
  const specRef = EntityRefV1Schema.safeParse(current.specRef);
  const specRevision = RevisionRefV1Schema.safeParse(current.specRevision);
  if (!specRef.success || !specRevision.success || specRef.data.kind !== 'spec'
    || !specRef.data.revision || !revisionEquals(specRef.data.revision, specRevision.data)) {
    throw new AssuranceProfileMismatchError('SPEC_REVISION_MISMATCH', 'current context must identify one exact spec EntityRefV1 and matching RevisionRefV1');
  }
  if (!current.sourceBundle) return undefined;
  const sourceBundle = SourceBundleV1Schema.safeParse(current.sourceBundle);
  if (!sourceBundle.success || sourceBundle.data.workspaceRef.workspaceId !== specRef.data.workspaceId) {
    throw new AssuranceProfileMismatchError('SOURCE_BUNDLE_MISMATCH', 'current source context must be a canonical SourceBundleV1 from the spec workspace');
  }
  return sourceBundle.data;
}

/** Validate a persisted profile against the current exact spec/source revision, or reject it as stale. */
export function assertCurrentAssuranceProfile(profileInput: unknown, current: CurrentAssuranceContext): DeepReadonly<AssuranceProfile> {
  const currentBundle = assertExactCurrentContext(current);
  const profile = ProfileCoreSchema.parse(profileInput);
  if (!sameEntity(profile.specRef, current.specRef) || !revisionEquals(profile.specRevision, current.specRevision)) throw new AssuranceProfileMismatchError('SPEC_REVISION_MISMATCH', 'assurance profile belongs to a different spec revision');
  if (profile.repositoryContextHash !== current.repositoryContextHash) throw new AssuranceProfileMismatchError('REPOSITORY_CONTEXT_MISMATCH', 'repository context changed; recompile the assurance profile');
  if ((profile.sourceContext?.bundleId ?? null) !== (currentBundle?.bundleId ?? null)
    || (profile.sourceContext?.bundleHash ?? null) !== (currentBundle?.bundleHash ?? null)) {
    throw new AssuranceProfileMismatchError('SOURCE_BUNDLE_MISMATCH', 'persisted source bundle changed; recompile the assurance profile');
  }
  if (profile.profileKind === 'compiled') {
    assertCanonicalControlInstances(profile.controlInstances);
    const { compilationReceiptHash, ...withoutReceipt } = profile;
    if (compilationReceiptHash !== receiptFor(withoutReceipt)) throw new AssuranceProfileMismatchError('COMPILATION_RECEIPT_MISMATCH', 'profile content changed after compilation');
  }
  return deepFreeze(profile);
}

/** Preserve readability for legacy specs while making absence explicit and non-authoritative. */
export function defaultAssuranceProfile(current: CurrentAssuranceContext): DeepReadonly<AssuranceProfile> {
  assertExactCurrentContext(current);
  return deepFreeze(ProfileCoreSchema.parse({
    schemaVersion: ASSURANCE_PROFILE_VERSION,
    profileKind: 'default',
    profileId: `default:${current.specRef.id}:${current.specRevision.kind}:${current.specRevision.value}`,
    specRef: { ...current.specRef, revision: current.specRevision },
    specRevision: current.specRevision,
    repositoryContextHash: current.repositoryContextHash,
    sourceContext: null,
    riskProfile: { level: 'none', tags: [], rationale: 'No assurance profile has been compiled for this existing spec.' },
    controlInstances: [],
    compilationReceiptHash: null,
  }));
}

export function resolveAssuranceProfile(profile: unknown | null | undefined, current: CurrentAssuranceContext): DeepReadonly<AssuranceProfile> {
  return profile == null ? defaultAssuranceProfile(current) : assertCurrentAssuranceProfile(profile, current);
}

export function getCanonicalControl(controlId: string): DeepReadonly<ControlRecord> | undefined {
  return controlsById.get(controlId);
}
