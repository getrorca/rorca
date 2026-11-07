/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import controlsArtifact from '../ssdlc/catalog/controls.json';
import {
  EVIDENCE_DEPTHS,
  parseControl,
  type ControlRecord,
  type EvidenceRequirement,
} from '../ssdlc/schema/control-schema';
import {
  validateAssuranceCandidate,
  type AssuranceCandidateInput,
  type AssuranceCandidateValidation,
} from './assurance-candidate';

export const ASSURANCE_PROFILE_DEFINITION_VERSION = 'rorca.assurance-profile-definition.v1' as const;
export const ASSURANCE_PROFILE_EXTENSION_VERSION = 'rorca.assurance-profile-extension.v1' as const;
export const ASSURANCE_PROFILE_COMPILER_VERSION = 'rorca.assurance-profile-compiler.v1' as const;
export const ASSURANCE_PROFILE_COMPILATION_VERSION = 'rorca.assurance-profile-compilation.v1' as const;

export const ASSURANCE_TRUST_LEVELS = [
  'self-attested',
  'tool-verified',
  'independently-verified',
] as const;
export type AssuranceTrustLevel = typeof ASSURANCE_TRUST_LEVELS[number];
export type AssuranceEvidenceDepth = typeof EVIDENCE_DEPTHS[number];
export type AssuranceProfileResolution = 'resolved' | 'unresolved' | 'blocked';
export type AssuranceControlDisposition = 'required' | 'unresolved' | 'blocked' | 'not_selected';

export interface AssuranceThresholds {
  minimumEvidenceDepth: AssuranceEvidenceDepth;
  minimumTrust: AssuranceTrustLevel;
  minimumEvidenceItems: number;
  maximumEvidenceAgeSeconds: number;
  minimumIndependentReviews: number;
}

export type AssuranceThresholdRefinement = Partial<AssuranceThresholds>;

export interface AssuranceProfileSelector {
  products: string[];
  requirementIds: string[];
  requirementTags: string[];
  riskLevels: string[];
  riskTags: string[];
  architectureDecisionIds: string[];
  architectureTags: string[];
  changeScopes: string[];
  changedPathPrefixes: string[];
}

export interface AssuranceControlRefinement {
  controlId: string;
  rationale: string;
  thresholds: AssuranceThresholdRefinement;
}

export interface AssuranceProfileDefinition {
  schemaVersion: typeof ASSURANCE_PROFILE_DEFINITION_VERSION;
  profileId: string;
  version: string;
  description: string;
  priority: number;
  selector: AssuranceProfileSelector;
  controlIds: string[];
  thresholds: AssuranceThresholdRefinement;
  controlRefinements: AssuranceControlRefinement[];
}

export interface WorkspaceAssuranceExtensionControl {
  controlId: string;
  rationale: string;
  profileIds: string[];
  selector: AssuranceProfileSelector;
  thresholds: AssuranceThresholdRefinement;
}

export interface WorkspaceAssuranceExtensionRegistration {
  schemaVersion: typeof ASSURANCE_PROFILE_EXTENSION_VERSION;
  workspaceId: string;
  namespace: string;
  version: string;
  additiveControls: WorkspaceAssuranceExtensionControl[];
  registrationHash: `sha256:${string}`;
}

export interface AssuranceProfileRequirementInput {
  requirementId: string;
  tags?: readonly string[];
}

export interface AssuranceProfileRiskInput {
  riskId: string;
  level: string;
  tags?: readonly string[];
}

export interface AssuranceProfileArchitectureInput {
  decisionId: string;
  tags?: readonly string[];
}

export interface AssuranceProfileCompilerInput {
  workspaceId: string;
  candidate: AssuranceCandidateInput | null;
  product: { productId: string; productType: string; tags?: readonly string[] } | null;
  requirements?: readonly AssuranceProfileRequirementInput[];
  risks?: readonly AssuranceProfileRiskInput[];
  architectureDecisions?: readonly AssuranceProfileArchitectureInput[];
  changeScope: { kind: string; tags?: readonly string[] } | null;
  profiles?: readonly unknown[] | null;
  extensions?: readonly WorkspaceAssuranceExtensionRegistration[];
}

export interface AssuranceApplicabilityRationale {
  dimension: 'product' | 'requirements' | 'risks' | 'architecture' | 'change-scope';
  inputValues: string[];
  criterionValues: string[];
  matchedValues: string[];
  explanation: string;
}

export interface ActiveAssuranceProfile {
  profileId: string;
  version: string;
  profileIdentity: string;
  description: string;
  priority: number;
  applicabilityRationale: AssuranceApplicabilityRationale[];
}

export interface CompiledAssuranceControl {
  controlId: string;
  namespace: string;
  sources: string[];
  disposition: AssuranceControlDisposition;
  applicabilityRationale: string[];
  effectiveThresholds: AssuranceThresholds;
}

export interface AssuranceProfileConflict {
  kind: 'invalid-profile' | 'profile-selection-conflict' | 'invalid-extension' | 'extension-conflict';
  identities: string[];
  message: string;
}

export interface AssuranceProfileCorrectiveAction {
  code:
    | 'bind-valid-candidate'
    | 'declare-matching-profile'
    | 'repair-profile-fixtures'
    | 'resolve-profile-conflict'
    | 'repair-workspace-extensions';
  message: string;
}

export interface AssuranceProfileCompilation {
  schemaVersion: typeof ASSURANCE_PROFILE_COMPILATION_VERSION;
  compilerVersion: typeof ASSURANCE_PROFILE_COMPILER_VERSION;
  compilationId: string;
  compilationHash: `sha256:${string}`;
  resolution: AssuranceProfileResolution;
  binding: {
    workspaceId: string;
    candidateId: string | null;
    scopeIdentity: string | null;
    specificationId: string | null;
    specificationRevision: string | null;
    productId: string | null;
    productType: string | null;
    changeScope: string | null;
  };
  activeProfile: ActiveAssuranceProfile | null;
  selectedControls: CompiledAssuranceControl[];
  unselectedControls: CompiledAssuranceControl[];
  applicabilityRationale: AssuranceApplicabilityRationale[];
  effectiveThresholds: AssuranceThresholds;
  extensions: Array<{
    namespace: string;
    version: string;
    additiveControlIds: string[];
    registrationHash: `sha256:${string}`;
  }>;
  conflicts: AssuranceProfileConflict[];
  correctiveActions: AssuranceProfileCorrectiveAction[];
}

const nonEmpty = z.string().trim().min(1);
const semver = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'must be a stable semantic version');
const stringList = z.array(nonEmpty);
const ThresholdRefinementSchema = z.object({
  minimumEvidenceDepth: z.enum(EVIDENCE_DEPTHS).optional(),
  minimumTrust: z.enum(ASSURANCE_TRUST_LEVELS).optional(),
  minimumEvidenceItems: z.number().int().positive().optional(),
  maximumEvidenceAgeSeconds: z.number().int().positive().optional(),
  minimumIndependentReviews: z.number().int().nonnegative().optional(),
}).strict();
const SelectorSchema = z.object({
  products: stringList.optional(),
  requirementIds: stringList.optional(),
  requirementTags: stringList.optional(),
  riskLevels: stringList.optional(),
  riskTags: stringList.optional(),
  architectureDecisionIds: stringList.optional(),
  architectureTags: stringList.optional(),
  changeScopes: stringList.optional(),
  changedPathPrefixes: stringList.optional(),
}).strict();
const ControlRefinementSchema = z.object({
  controlId: nonEmpty,
  rationale: nonEmpty,
  thresholds: ThresholdRefinementSchema,
}).strict();
const ProfileDefinitionSchema = z.object({
  schemaVersion: z.literal(ASSURANCE_PROFILE_DEFINITION_VERSION),
  profileId: nonEmpty,
  version: semver,
  description: nonEmpty,
  priority: z.number().int(),
  selector: SelectorSchema,
  controlIds: stringList,
  thresholds: ThresholdRefinementSchema,
  controlRefinements: z.array(ControlRefinementSchema).optional(),
}).strict();
const ExtensionControlSchema = z.object({
  controlId: nonEmpty,
  rationale: nonEmpty,
  profileIds: stringList.optional(),
  selector: SelectorSchema.optional(),
  thresholds: ThresholdRefinementSchema.optional(),
}).strict();
const ExtensionDeclarationSchema = z.object({
  schemaVersion: z.literal(ASSURANCE_PROFILE_EXTENSION_VERSION),
  workspaceId: nonEmpty,
  namespace: nonEmpty,
  version: semver,
  controls: z.array(ExtensionControlSchema).min(1),
}).strict();
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const ExtensionRegistrationSchema = z.object({
  schemaVersion: z.literal(ASSURANCE_PROFILE_EXTENSION_VERSION),
  workspaceId: nonEmpty,
  namespace: nonEmpty,
  version: semver,
  additiveControls: z.array(ExtensionControlSchema).min(1),
  registrationHash: sha256,
}).strict();

const DEPTH_RANK: Readonly<Record<AssuranceEvidenceDepth, number>> = {
  declaration: 0,
  demonstrated: 1,
  'independent-verification': 2,
};
const TRUST_RANK: Readonly<Record<AssuranceTrustLevel, number>> = {
  'self-attested': 0,
  'tool-verified': 1,
  'independently-verified': 2,
};
const NEUTRAL_THRESHOLDS: Readonly<AssuranceThresholds> = Object.freeze({
  minimumEvidenceDepth: 'declaration',
  minimumTrust: 'self-attested',
  minimumEvidenceItems: 1,
  maximumEvidenceAgeSeconds: Number.MAX_SAFE_INTEGER,
  minimumIndependentReviews: 0,
});
const EXTENSION_BASELINE_THRESHOLDS: Readonly<AssuranceThresholds> = Object.freeze({
  ...NEUTRAL_THRESHOLDS,
  maximumEvidenceAgeSeconds: 604800,
});
const coreControls: readonly ControlRecord[] = Object.freeze(controlsArtifact.map((control) => parseControl(control)));
const coreById = new Map(coreControls.map((control) => [control.controlId, control]));
const baselineControlIds = new Set(coreControls.filter((control) => control.applicability.universal).map((control) => control.controlId));

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sortedUnique(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map(text).filter(Boolean))].sort(lexical);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(lexical).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function emptySelector(): AssuranceProfileSelector {
  return {
    products: [],
    requirementIds: [],
    requirementTags: [],
    riskLevels: [],
    riskTags: [],
    architectureDecisionIds: [],
    architectureTags: [],
    changeScopes: [],
    changedPathPrefixes: [],
  };
}

function normalizeSelector(selector: Partial<AssuranceProfileSelector> | undefined): AssuranceProfileSelector {
  const empty = emptySelector();
  return Object.fromEntries(Object.keys(empty).map((key) => [
    key,
    sortedUnique(selector?.[key as keyof AssuranceProfileSelector]),
  ])) as unknown as AssuranceProfileSelector;
}

function normalizeThresholds(input: AssuranceThresholdRefinement | undefined): AssuranceThresholdRefinement {
  if (!input) return {};
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) => lexical(left, right))) as AssuranceThresholdRefinement;
}

function normalizeProfile(input: z.infer<typeof ProfileDefinitionSchema>): AssuranceProfileDefinition {
  return {
    schemaVersion: ASSURANCE_PROFILE_DEFINITION_VERSION,
    profileId: text(input.profileId),
    version: input.version,
    description: text(input.description),
    priority: input.priority,
    selector: normalizeSelector(input.selector),
    controlIds: sortedUnique(input.controlIds),
    thresholds: normalizeThresholds(input.thresholds),
    controlRefinements: (input.controlRefinements ?? []).map((refinement) => ({
      controlId: text(refinement.controlId),
      rationale: text(refinement.rationale),
      thresholds: normalizeThresholds(refinement.thresholds),
    })).sort((left, right) => lexical(left.controlId, right.controlId)),
  };
}

function normalizeExtensionControl(
  input: z.infer<typeof ExtensionControlSchema>,
): WorkspaceAssuranceExtensionControl {
  return {
    controlId: text(input.controlId),
    rationale: text(input.rationale),
    profileIds: sortedUnique(input.profileIds),
    selector: normalizeSelector(input.selector),
    thresholds: normalizeThresholds(input.thresholds),
  };
}

function extensionBody(registration: Omit<WorkspaceAssuranceExtensionRegistration, 'registrationHash'>): unknown {
  return {
    schemaVersion: registration.schemaVersion,
    workspaceId: registration.workspaceId,
    namespace: registration.namespace,
    version: registration.version,
    additiveControls: registration.additiveControls,
  };
}

export class WorkspaceAssuranceExtensionError extends Error {
  constructor(readonly code:
    | 'CORE_MUTATION_FORBIDDEN'
    | 'WORKSPACE_NAMESPACE_MISMATCH'
    | 'CONTROL_NAMESPACE_MISMATCH'
    | 'EXTENSION_CONFLICT'
    | 'INVALID_EXTENSION', message: string) {
    super(message);
    this.name = 'WorkspaceAssuranceExtensionError';
  }
}

/** Register one immutable additive extension; no shared or cross-workspace identity can be targeted. */
export function registerWorkspaceAssuranceExtension(input: {
  workspaceId: string;
  extension: unknown;
  existingExtensions?: readonly WorkspaceAssuranceExtensionRegistration[];
}): Readonly<WorkspaceAssuranceExtensionRegistration> {
  const workspaceId = text(input.workspaceId);
  const raw = input.extension && typeof input.extension === 'object' && !Array.isArray(input.extension)
    ? input.extension as Record<string, unknown>
    : {};
  const mutationKeys = ['removeControlIds', 'replaceControlIds', 'coreMutations', 'mutations', 'overrides']
    .filter((key) => Object.prototype.hasOwnProperty.call(raw, key));
  if (mutationKeys.length) {
    throw new WorkspaceAssuranceExtensionError(
      'CORE_MUTATION_FORBIDDEN',
      `Workspace extensions are additive-only; forbidden mutation fields: ${mutationKeys.sort(lexical).join(', ')}.`,
    );
  }

  const parsed = ExtensionDeclarationSchema.safeParse(input.extension);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || '/'} ${issue.message}`).sort(lexical);
    throw new WorkspaceAssuranceExtensionError('INVALID_EXTENSION', `Invalid workspace assurance extension: ${details.join('; ')}`);
  }
  if (!workspaceId || parsed.data.workspaceId !== workspaceId) {
    throw new WorkspaceAssuranceExtensionError(
      'WORKSPACE_NAMESPACE_MISMATCH',
      `Extension workspace ${JSON.stringify(parsed.data.workspaceId)} does not match ${JSON.stringify(workspaceId)}.`,
    );
  }
  const namespacePrefix = `workspace:${workspaceId}:`;
  const namespaceSuffix = parsed.data.namespace.startsWith(namespacePrefix)
    ? parsed.data.namespace.slice(namespacePrefix.length)
    : '';
  if (!namespaceSuffix || !/^[a-z0-9][a-z0-9._-]*$/.test(namespaceSuffix)) {
    throw new WorkspaceAssuranceExtensionError(
      'WORKSPACE_NAMESPACE_MISMATCH',
      `Extension namespace must be owned by ${namespacePrefix}<extension>.`,
    );
  }

  const additiveControls = parsed.data.controls.map(normalizeExtensionControl)
    .sort((left, right) => lexical(left.controlId, right.controlId));
  const duplicateIds = additiveControls.filter((control, index) => (
    index > 0 && additiveControls[index - 1].controlId === control.controlId
  )).map((control) => control.controlId);
  if (duplicateIds.length) {
    throw new WorkspaceAssuranceExtensionError('EXTENSION_CONFLICT', `Duplicate extension controls: ${sortedUnique(duplicateIds).join(', ')}.`);
  }
  for (const control of additiveControls) {
    if (!control.controlId.startsWith(`${parsed.data.namespace}/`) || control.controlId.length === parsed.data.namespace.length + 1) {
      throw new WorkspaceAssuranceExtensionError(
        'CONTROL_NAMESPACE_MISMATCH',
        `Additive control ${control.controlId} must be owned by namespace ${parsed.data.namespace}/.`,
      );
    }
  }

  const registrationBody: Omit<WorkspaceAssuranceExtensionRegistration, 'registrationHash'> = {
    schemaVersion: ASSURANCE_PROFILE_EXTENSION_VERSION,
    workspaceId,
    namespace: parsed.data.namespace,
    version: parsed.data.version,
    additiveControls,
  };
  const registration: WorkspaceAssuranceExtensionRegistration = {
    ...registrationBody,
    registrationHash: digest(extensionBody(registrationBody)),
  };
  for (const existing of input.existingExtensions ?? []) {
    if (existing.workspaceId !== workspaceId) {
      throw new WorkspaceAssuranceExtensionError(
        'WORKSPACE_NAMESPACE_MISMATCH',
        `Existing extension ${existing.namespace} belongs to another workspace.`,
      );
    }
    if (existing.namespace === registration.namespace && existing.registrationHash !== registration.registrationHash) {
      throw new WorkspaceAssuranceExtensionError(
        'EXTENSION_CONFLICT',
        `Namespace ${registration.namespace} is already registered with different content.`,
      );
    }
    const existingIds = new Set(existing.additiveControls.map((control) => control.controlId));
    const collision = registration.additiveControls.find((control) => existingIds.has(control.controlId));
    if (collision && existing.registrationHash !== registration.registrationHash) {
      throw new WorkspaceAssuranceExtensionError('EXTENSION_CONFLICT', `Control ${collision.controlId} is already registered.`);
    }
  }
  return deepFreeze(registration);
}

interface NormalizedSelectionContext {
  product: string[];
  requirementIds: string[];
  requirementTags: string[];
  riskLevels: string[];
  riskTags: string[];
  architectureDecisionIds: string[];
  architectureTags: string[];
  changeScopes: string[];
  changedPaths: string[];
}

function normalizedContext(
  input: AssuranceProfileCompilerInput,
  candidate: AssuranceCandidateValidation | null,
): NormalizedSelectionContext {
  return {
    product: sortedUnique(input.product
      ? [input.product.productId, input.product.productType, ...(input.product.tags ?? [])]
      : []),
    requirementIds: sortedUnique(input.requirements?.map((requirement) => requirement.requirementId)),
    requirementTags: sortedUnique(input.requirements?.flatMap((requirement) => requirement.tags ?? [])),
    riskLevels: sortedUnique(input.risks?.map((risk) => risk.level)),
    riskTags: sortedUnique(input.risks?.flatMap((risk) => risk.tags ?? [])),
    architectureDecisionIds: sortedUnique(input.architectureDecisions?.map((decision) => decision.decisionId)),
    architectureTags: sortedUnique(input.architectureDecisions?.flatMap((decision) => decision.tags ?? [])),
    changeScopes: sortedUnique(input.changeScope ? [input.changeScope.kind] : []),
    changedPaths: candidate?.scope.changedPaths ?? [],
  };
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function matchesPathPrefix(prefixes: readonly string[], paths: readonly string[]): boolean {
  return prefixes.some((prefix) => paths.some((path) => path === prefix || path.startsWith(`${prefix}/`)));
}

function selectorMatches(selector: AssuranceProfileSelector, context: NormalizedSelectionContext): boolean {
  return (!selector.products.length || intersects(selector.products, context.product))
    && (!selector.requirementIds.length || intersects(selector.requirementIds, context.requirementIds))
    && (!selector.requirementTags.length || intersects(selector.requirementTags, context.requirementTags))
    && (!selector.riskLevels.length || intersects(selector.riskLevels, context.riskLevels))
    && (!selector.riskTags.length || intersects(selector.riskTags, context.riskTags))
    && (!selector.architectureDecisionIds.length || intersects(selector.architectureDecisionIds, context.architectureDecisionIds))
    && (!selector.architectureTags.length || intersects(selector.architectureTags, context.architectureTags))
    && (!selector.changeScopes.length || intersects(selector.changeScopes, context.changeScopes))
    && (!selector.changedPathPrefixes.length || matchesPathPrefix(selector.changedPathPrefixes, context.changedPaths));
}

function selectorSpecificity(selector: AssuranceProfileSelector): number {
  return Object.values(selector).filter((values) => values.length > 0).length;
}

function prefixed(prefix: string, values: readonly string[]): string[] {
  return values.map((value) => `${prefix}:${value}`);
}

function rationaleFor(
  profile: AssuranceProfileDefinition,
  context: NormalizedSelectionContext,
): AssuranceApplicabilityRationale[] {
  const dimensions: Array<{
    dimension: AssuranceApplicabilityRationale['dimension'];
    inputs: string[];
    criteria: string[];
  }> = [
    { dimension: 'product', inputs: context.product, criteria: profile.selector.products },
    {
      dimension: 'requirements',
      inputs: [...prefixed('id', context.requirementIds), ...prefixed('tag', context.requirementTags)].sort(lexical),
      criteria: [...prefixed('id', profile.selector.requirementIds), ...prefixed('tag', profile.selector.requirementTags)].sort(lexical),
    },
    {
      dimension: 'risks',
      inputs: [...prefixed('level', context.riskLevels), ...prefixed('tag', context.riskTags)].sort(lexical),
      criteria: [...prefixed('level', profile.selector.riskLevels), ...prefixed('tag', profile.selector.riskTags)].sort(lexical),
    },
    {
      dimension: 'architecture',
      inputs: [...prefixed('id', context.architectureDecisionIds), ...prefixed('tag', context.architectureTags)].sort(lexical),
      criteria: [...prefixed('id', profile.selector.architectureDecisionIds), ...prefixed('tag', profile.selector.architectureTags)].sort(lexical),
    },
    {
      dimension: 'change-scope',
      inputs: [...prefixed('kind', context.changeScopes), ...prefixed('path', context.changedPaths)].sort(lexical),
      criteria: [...prefixed('kind', profile.selector.changeScopes), ...prefixed('path-prefix', profile.selector.changedPathPrefixes)].sort(lexical),
    },
  ];
  return dimensions.map(({ dimension, inputs, criteria }) => {
    const matchedValues = criteria.filter((criterion) => criterion.startsWith('path-prefix:')
      ? matchesPathPrefix([criterion.slice('path-prefix:'.length)], context.changedPaths)
      : inputs.includes(criterion));
    return {
      dimension,
      inputValues: inputs,
      criterionValues: criteria,
      matchedValues,
      explanation: criteria.length
        ? `${profile.profileId}@${profile.version} matched ${dimension} on ${matchedValues.join(', ')}.`
        : `${profile.profileId}@${profile.version} declares no ${dimension} restriction.`,
    };
  });
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function profileIdentity(profile: AssuranceProfileDefinition): string {
  return `${profile.profileId}@${profile.version}`;
}

function parseProfiles(inputs: readonly unknown[]): {
  profiles: AssuranceProfileDefinition[];
  conflicts: AssuranceProfileConflict[];
} {
  const profiles: AssuranceProfileDefinition[] = [];
  const invalid: string[] = [];
  for (const input of inputs) {
    const parsed = ProfileDefinitionSchema.safeParse(input);
    if (!parsed.success) {
      invalid.push(parsed.error.issues.map((issue) => `${issue.path.join('.') || '/'} ${issue.message}`).sort(lexical).join('; '));
      continue;
    }
    const profile = normalizeProfile(parsed.data);
    const duplicateRefinement = profile.controlRefinements.find((refinement, index) => (
      index > 0 && profile.controlRefinements[index - 1].controlId === refinement.controlId
    ));
    const unknownIds = sortedUnique([
      ...profile.controlIds,
      ...profile.controlRefinements.map((refinement) => refinement.controlId),
    ].filter((controlId) => !coreById.has(controlId)));
    if (duplicateRefinement) invalid.push(`${profileIdentity(profile)} repeats refinement ${duplicateRefinement.controlId}`);
    else if (unknownIds.length) invalid.push(`${profileIdentity(profile)} references unknown core controls: ${unknownIds.join(', ')}`);
    else profiles.push(profile);
  }

  const conflicts: AssuranceProfileConflict[] = [];
  if (invalid.length) {
    conflicts.push({
      kind: 'invalid-profile',
      identities: [],
      message: `Invalid profile fixtures: ${sortedUnique(invalid).join(' | ')}`,
    });
  }
  const byIdentity = new Map<string, AssuranceProfileDefinition[]>();
  for (const profile of profiles) {
    const identity = profileIdentity(profile);
    byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), profile]);
  }
  const deduplicated: AssuranceProfileDefinition[] = [];
  for (const [identity, versions] of [...byIdentity.entries()].sort(([left], [right]) => lexical(left, right))) {
    const hashes = new Set(versions.map(canonicalJson));
    if (hashes.size > 1) {
      conflicts.push({
        kind: 'profile-selection-conflict',
        identities: [identity],
        message: `Profile identity ${identity} is declared with conflicting content.`,
      });
    } else {
      deduplicated.push(versions[0]);
    }
  }
  return { profiles: deduplicated, conflicts };
}

function validateExtensions(
  workspaceId: string,
  inputs: readonly WorkspaceAssuranceExtensionRegistration[],
): { extensions: WorkspaceAssuranceExtensionRegistration[]; conflicts: AssuranceProfileConflict[] } {
  const conflicts: AssuranceProfileConflict[] = [];
  const candidates: WorkspaceAssuranceExtensionRegistration[] = [];
  for (const input of inputs) {
    const parsed = ExtensionRegistrationSchema.safeParse(input);
    if (!parsed.success) {
      conflicts.push({ kind: 'invalid-extension', identities: [], message: 'A workspace extension registration has an invalid shape.' });
      continue;
    }
    const normalizedControls = parsed.data.additiveControls.map(normalizeExtensionControl)
      .sort((left, right) => lexical(left.controlId, right.controlId));
    const normalized: WorkspaceAssuranceExtensionRegistration = {
      schemaVersion: ASSURANCE_PROFILE_EXTENSION_VERSION,
      workspaceId: text(parsed.data.workspaceId),
      namespace: text(parsed.data.namespace),
      version: parsed.data.version,
      additiveControls: normalizedControls,
      registrationHash: parsed.data.registrationHash as `sha256:${string}`,
    };
    const expectedHash = digest(extensionBody(normalized));
    const namespacePrefix = `workspace:${workspaceId}:`;
    const namespaceSuffix = normalized.namespace.startsWith(namespacePrefix)
      ? normalized.namespace.slice(namespacePrefix.length)
      : '';
    const duplicateControlIds = new Set(normalized.additiveControls.map((control) => control.controlId)).size
      !== normalized.additiveControls.length;
    const badNamespace = normalized.workspaceId !== workspaceId
      || !/^[a-z0-9][a-z0-9._-]*$/.test(namespaceSuffix)
      || duplicateControlIds
      || normalized.additiveControls.some((control) => (
        !control.controlId.startsWith(`${normalized.namespace}/`)
        || control.controlId.length === normalized.namespace.length + 1
      ));
    if (badNamespace || expectedHash !== normalized.registrationHash) {
      conflicts.push({
        kind: 'invalid-extension',
        identities: [normalized.namespace],
        message: `Extension ${normalized.namespace} is stale, altered, or outside workspace ${workspaceId}.`,
      });
      continue;
    }
    candidates.push(normalized);
  }

  const byNamespace = new Map<string, WorkspaceAssuranceExtensionRegistration[]>();
  for (const candidate of candidates) {
    const group = byNamespace.get(candidate.namespace) ?? [];
    group.push(candidate);
    byNamespace.set(candidate.namespace, group);
  }
  const uniqueByNamespace = new Map<string, WorkspaceAssuranceExtensionRegistration>();
  for (const [namespace, registrations] of [...byNamespace.entries()].sort(([left], [right]) => lexical(left, right))) {
    const hashes = new Set(registrations.map((registration) => registration.registrationHash));
    if (hashes.size > 1) {
      conflicts.push({
        kind: 'extension-conflict',
        identities: [namespace],
        message: `Extension namespace ${namespace} has conflicting registrations.`,
      });
      continue;
    }
    uniqueByNamespace.set(namespace, registrations[0]);
  }

  const controlOwners = new Map<string, Set<string>>();
  for (const registration of uniqueByNamespace.values()) {
    for (const control of registration.additiveControls) {
      const owners = controlOwners.get(control.controlId) ?? new Set<string>();
      owners.add(registration.namespace);
      controlOwners.set(control.controlId, owners);
    }
  }
  const conflictingNamespaces = new Set<string>();
  for (const [controlId, owners] of [...controlOwners.entries()].sort(([left], [right]) => lexical(left, right))) {
    if (owners.size < 2) continue;
    const namespaces = [...owners].sort(lexical);
    for (const namespace of namespaces) conflictingNamespaces.add(namespace);
    conflicts.push({
      kind: 'extension-conflict',
      identities: [controlId],
      message: `Additive control ${controlId} has more than one namespace owner.`,
    });
  }

  const extensions = [...uniqueByNamespace.values()]
    .filter((registration) => !conflictingNamespaces.has(registration.namespace))
    .sort((left, right) => lexical(left.namespace, right.namespace));
  return {
    extensions,
    conflicts: conflicts.sort((left, right) => lexical(left.message, right.message)),
  };
}

function selectProfile(
  profiles: AssuranceProfileDefinition[],
  context: NormalizedSelectionContext,
): { active: AssuranceProfileDefinition | null; conflict: AssuranceProfileConflict | null } {
  const matching = profiles.filter((profile) => selectorMatches(profile.selector, context));
  if (!matching.length) return { active: null, conflict: null };
  const highestPriority = Math.max(...matching.map((profile) => profile.priority));
  const priorityMatches = matching.filter((profile) => profile.priority === highestPriority);
  const highestSpecificity = Math.max(...priorityMatches.map((profile) => selectorSpecificity(profile.selector)));
  const finalists = priorityMatches.filter((profile) => selectorSpecificity(profile.selector) === highestSpecificity);
  const profileIds = sortedUnique(finalists.map((profile) => profile.profileId));
  if (profileIds.length > 1) {
    const identities = finalists.map(profileIdentity).sort(lexical);
    return {
      active: null,
      conflict: {
        kind: 'profile-selection-conflict',
        identities,
        message: `Profiles ${identities.join(', ')} have equal priority and specificity for the bound candidate.`,
      },
    };
  }
  return {
    active: finalists.reduce((latest, profile) => compareVersions(profile.version, latest.version) > 0 ? profile : latest),
    conflict: null,
  };
}

function strongerDepth(left: AssuranceEvidenceDepth, right: AssuranceEvidenceDepth): AssuranceEvidenceDepth {
  return DEPTH_RANK[left] >= DEPTH_RANK[right] ? left : right;
}

function strongerTrust(left: AssuranceTrustLevel, right: AssuranceTrustLevel): AssuranceTrustLevel {
  return TRUST_RANK[left] >= TRUST_RANK[right] ? left : right;
}

function tightenThresholds(
  baseline: AssuranceThresholds,
  refinement: AssuranceThresholdRefinement | undefined,
): AssuranceThresholds {
  if (!refinement) return { ...baseline };
  return {
    minimumEvidenceDepth: refinement.minimumEvidenceDepth
      ? strongerDepth(baseline.minimumEvidenceDepth, refinement.minimumEvidenceDepth)
      : baseline.minimumEvidenceDepth,
    minimumTrust: refinement.minimumTrust
      ? strongerTrust(baseline.minimumTrust, refinement.minimumTrust)
      : baseline.minimumTrust,
    minimumEvidenceItems: Math.max(baseline.minimumEvidenceItems, refinement.minimumEvidenceItems ?? 0),
    maximumEvidenceAgeSeconds: Math.min(baseline.maximumEvidenceAgeSeconds, refinement.maximumEvidenceAgeSeconds ?? Number.MAX_SAFE_INTEGER),
    minimumIndependentReviews: Math.max(baseline.minimumIndependentReviews, refinement.minimumIndependentReviews ?? 0),
  };
}

function evidenceThresholds(requirements: readonly EvidenceRequirement[]): AssuranceThresholds {
  return requirements.reduce<AssuranceThresholds>((thresholds, requirement) => ({
    minimumEvidenceDepth: strongerDepth(thresholds.minimumEvidenceDepth, requirement.evidenceDepth),
    minimumTrust: strongerTrust(thresholds.minimumTrust, requirement.minimumTrust),
    minimumEvidenceItems: requirements.length,
    maximumEvidenceAgeSeconds: Math.min(thresholds.maximumEvidenceAgeSeconds, requirement.freshness.maxAgeSeconds),
    minimumIndependentReviews: thresholds.minimumIndependentReviews + (
      (requirement.classification === 'review' || requirement.classification === 'approval')
        && requirement.minimumTrust === 'independently-verified' ? 1 : 0
    ),
  }), { ...NEUTRAL_THRESHOLDS });
}

function aggregateThresholds(controls: readonly CompiledAssuranceControl[]): AssuranceThresholds {
  return controls.reduce((thresholds, control) => tightenThresholds(thresholds, control.effectiveThresholds), {
    ...NEUTRAL_THRESHOLDS,
  });
}

function dispositionFor(resolution: AssuranceProfileResolution): Exclude<AssuranceControlDisposition, 'not_selected'> {
  if (resolution === 'resolved') return 'required';
  return resolution;
}

function correctiveActions(
  candidate: AssuranceCandidateValidation | null,
  profileInputs: readonly unknown[],
  active: AssuranceProfileDefinition | null,
  conflicts: readonly AssuranceProfileConflict[],
): AssuranceProfileCorrectiveAction[] {
  const actions: AssuranceProfileCorrectiveAction[] = [];
  if (!candidate?.valid) actions.push({
    code: 'bind-valid-candidate',
    message: 'Bind a complete candidate identity to the exact work-package scope before assurance profile compilation.',
  });
  if (!profileInputs.length || (!active && !conflicts.some((conflict) => conflict.kind === 'invalid-profile' || conflict.kind === 'profile-selection-conflict'))) {
    actions.push({
      code: 'declare-matching-profile',
      message: 'Declare a versioned profile whose selector matches the bound product, requirements, risks, architecture, and change scope.',
    });
  }
  if (conflicts.some((conflict) => conflict.kind === 'invalid-profile')) actions.push({
    code: 'repair-profile-fixtures',
    message: 'Repair invalid profile fixtures and reference only canonical Rorca core control identities.',
  });
  if (conflicts.some((conflict) => conflict.kind === 'profile-selection-conflict')) actions.push({
    code: 'resolve-profile-conflict',
    message: 'Resolve profile identity, priority, or selector conflicts so exactly one active profile is authoritative.',
  });
  if (conflicts.some((conflict) => conflict.kind === 'invalid-extension' || conflict.kind === 'extension-conflict')) actions.push({
    code: 'repair-workspace-extensions',
    message: 'Re-register additive controls under one namespace owned by the bound workspace.',
  });
  return actions;
}

/**
 * Compile one deterministic, non-passing assurance selection for an exact AFM candidate.
 * Existing core records remain read-only: universal controls are always selected and every
 * profile/extension operation is additive or threshold-tightening only.
 */
export function compileAssuranceProfileSelection(
  input: AssuranceProfileCompilerInput,
): Readonly<AssuranceProfileCompilation> {
  const workspaceId = text(input.workspaceId);
  const candidate = input.candidate ? validateAssuranceCandidate(input.candidate) : null;
  const context = normalizedContext(input, candidate);
  const profileInputs = input.profiles ?? [];
  const parsedProfiles = parseProfiles(profileInputs);
  const extensionResult = validateExtensions(workspaceId, input.extensions ?? []);
  const conflicts = [...parsedProfiles.conflicts, ...extensionResult.conflicts];
  const profileFixturesUsable = !parsedProfiles.conflicts.length;
  const selection = profileFixturesUsable
    ? selectProfile(parsedProfiles.profiles, context)
    : { active: null, conflict: null };
  if (selection.conflict) conflicts.push(selection.conflict);
  conflicts.sort((left, right) => lexical(left.message, right.message));
  const active = selection.active;

  const hasBlockingInput = !candidate?.valid || conflicts.length > 0;
  const resolution: AssuranceProfileResolution = hasBlockingInput
    ? 'blocked'
    : active ? 'resolved' : 'unresolved';
  const selectedCoreIds = new Set(baselineControlIds);
  for (const controlId of active?.controlIds ?? []) selectedCoreIds.add(controlId);
  const activeIdentity = active ? profileIdentity(active) : null;
  const activeRefinements = new Map(active?.controlRefinements.map((refinement) => [refinement.controlId, refinement]) ?? []);
  const profileRationale = active ? rationaleFor(active, context) : [];
  const disposition = dispositionFor(resolution);

  const selectedControls: CompiledAssuranceControl[] = coreControls
    .filter((control) => selectedCoreIds.has(control.controlId))
    .map((control) => {
      const refinement = activeRefinements.get(control.controlId);
      const baseline = evidenceThresholds(control.requiredEvidence);
      const profileThreshold = active ? tightenThresholds(baseline, active.thresholds) : baseline;
      const effectiveThresholds = tightenThresholds(profileThreshold, refinement?.thresholds);
      return {
        controlId: control.controlId,
        namespace: 'rorca.core',
        sources: sortedUnique([
          ...(baselineControlIds.has(control.controlId) ? ['rorca.core/baseline'] : []),
          ...(active?.controlIds.includes(control.controlId) || refinement ? [`rorca.core/profile:${activeIdentity}`] : []),
        ]),
        disposition,
        applicabilityRationale: sortedUnique([
          ...(baselineControlIds.has(control.controlId)
            ? ['Canonical applicability marks this control universal; no profile or extension may erase it.']
            : []),
          ...(active?.controlIds.includes(control.controlId)
            ? [`Profile ${activeIdentity} selects this canonical control.`]
            : []),
          ...(refinement ? [refinement.rationale] : []),
        ]),
        effectiveThresholds,
      };
    });

  const unselectedControls: CompiledAssuranceControl[] = coreControls
    .filter((control) => !selectedCoreIds.has(control.controlId))
    .map((control) => ({
      controlId: control.controlId,
      namespace: 'rorca.core',
      sources: ['rorca.core/catalog'],
      disposition: 'not_selected',
      applicabilityRationale: [activeIdentity
        ? `Canonical control is not selected by profile ${activeIdentity} and is not universal.`
        : 'No authoritative profile selected this non-universal canonical control.'],
      effectiveThresholds: evidenceThresholds(control.requiredEvidence),
    }));

  for (const extension of extensionResult.extensions) {
    for (const control of extension.additiveControls) {
      const profileMatches = active !== null && (!control.profileIds.length || control.profileIds.includes(active.profileId)
        || control.profileIds.includes(activeIdentity ?? ''));
      const applies = profileMatches && selectorMatches(control.selector, context);
      const compiled: CompiledAssuranceControl = {
        controlId: control.controlId,
        namespace: extension.namespace,
        sources: [`${extension.namespace}@${extension.version}`],
        disposition: applies ? disposition : 'not_selected',
        applicabilityRationale: [applies
          ? `${control.rationale} Additive extension criteria match profile ${activeIdentity}.`
          : `${control.rationale} Additive extension criteria do not match the active profile and candidate context.`],
        effectiveThresholds: tightenThresholds(
          active
            ? tightenThresholds({ ...EXTENSION_BASELINE_THRESHOLDS }, active.thresholds)
            : { ...EXTENSION_BASELINE_THRESHOLDS },
          control.thresholds,
        ),
      };
      if (applies) selectedControls.push(compiled);
      else unselectedControls.push(compiled);
    }
  }

  selectedControls.sort((left, right) => lexical(left.controlId, right.controlId));
  unselectedControls.sort((left, right) => lexical(left.controlId, right.controlId));
  const activeProfile: ActiveAssuranceProfile | null = active ? {
    profileId: active.profileId,
    version: active.version,
    profileIdentity: activeIdentity as string,
    description: active.description,
    priority: active.priority,
    applicabilityRationale: profileRationale,
  } : null;
  const binding = {
    workspaceId,
    candidateId: candidate?.candidateId ?? null,
    scopeIdentity: candidate?.scope.scopeIdentity ?? null,
    specificationId: text(candidate?.identity.specificationRevision?.specId) || null,
    specificationRevision: text(candidate?.identity.specificationRevision?.revision) || null,
    productId: text(input.product?.productId) || null,
    productType: text(input.product?.productType) || null,
    changeScope: text(input.changeScope?.kind) || null,
  };
  const extensions = extensionResult.extensions.map((extension) => ({
    namespace: extension.namespace,
    version: extension.version,
    additiveControlIds: extension.additiveControls.map((control) => control.controlId),
    registrationHash: extension.registrationHash,
  }));
  const artifactBody = {
    schemaVersion: ASSURANCE_PROFILE_COMPILATION_VERSION,
    compilerVersion: ASSURANCE_PROFILE_COMPILER_VERSION,
    resolution,
    binding,
    activeProfile,
    selectedControls,
    unselectedControls,
    applicabilityRationale: profileRationale,
    effectiveThresholds: aggregateThresholds(selectedControls),
    extensions,
    conflicts,
    correctiveActions: correctiveActions(candidate, profileInputs, active, conflicts),
  };
  const compilationHash = digest(artifactBody);
  return deepFreeze({
    ...artifactBody,
    compilationId: `assurance-profile:${compilationHash.slice(7, 23)}`,
    compilationHash,
  });
}
