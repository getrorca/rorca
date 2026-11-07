/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Pure, deterministic routing for immutable bounty work packages. No model output,
 * clock, randomness, environment value, or I/O participates in a route decision.
 */
import { z } from 'zod';
import { BOUNTY_CAPABILITIES, hashBountyContract } from './bounty-contracts';

const HASH = /^sha256:[a-f0-9]{64}$/;
const HASH_SCHEMA = z.string().regex(HASH);
const ID_SCHEMA = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const MISSION_ID_SCHEMA = z.string().uuid();
const CapabilitySchema = z.enum(BOUNTY_CAPABILITIES);

export const BOUNTY_OBJECTIVE_CLASSES = [
  'program-intake', 'scope-validation', 'asset-inventory', 'surface-enumeration',
  'whitebox-focused-review', 'whitebox-synthesis', 'authentication-testing',
  'authorization-testing', 'input-validation-testing', 'business-logic-testing',
  'configuration-testing', 'dependency-analysis', 'active-verification',
  'evidence-correlation', 'finding-drafting', 'mission-synthesis',
] as const;
export type BountyObjectiveClass = typeof BOUNTY_OBJECTIVE_CLASSES[number];

export const BOUNTY_PHASES = ['intake', 'scope', 'discovery', 'analysis', 'verification', 'synthesis', 'reporting'] as const;
export type BountyPhase = typeof BOUNTY_PHASES[number];
export const BOUNTY_EVIDENCE_TYPES = [
  'program-policy', 'scope-record', 'asset-record', 'http-observation', 'source-code',
  'auth-observation', 'access-control-observation', 'input-observation',
  'workflow-observation', 'configuration-record', 'dependency-record',
  'verification-result', 'correlated-evidence', 'finding-record',
] as const;
export type BountyEvidenceType = typeof BOUNTY_EVIDENCE_TYPES[number];
export type BountyModelTier = 'standard' | 'advanced';

export const ANTI_FALSE_POSITIVE_CLAUSE =
  'ANTI_FALSE_POSITIVE: Treat every claim as unverified until supported by cited evidence; record contrary evidence and do not invent effects.';
const STATIC_PROMPT_PREFIXES = {
  'bounty.intake.v1': `${ANTI_FALSE_POSITIVE_CLAUSE}\nClassify policy and scope only from pinned source evidence.`,
  'bounty.discovery.v1': `${ANTI_FALSE_POSITIVE_CLAUSE}\nObserve only authorized targets and preserve target/evidence identity.`,
  'bounty.analysis.v1': `${ANTI_FALSE_POSITIVE_CLAUSE}\nAnalyze the assigned micro-objective only and separate hypotheses from verified facts.`,
  'bounty.verification.v1': `${ANTI_FALSE_POSITIVE_CLAUSE}\nAttempt only budgeted capabilities and report the actual effect receipt separately.`,
  'bounty.synthesis.v1': `${ANTI_FALSE_POSITIVE_CLAUSE}\nSynthesize only cited evidence and preserve omissions and uncertainty.`,
  'bounty.reporting.v1': `${ANTI_FALSE_POSITIVE_CLAUSE}\nDraft, but never submit, a finding tied to its evidence references.`,
} as const;
export type BountyStaticPrefixId = keyof typeof STATIC_PROMPT_PREFIXES;
export const BOUNTY_STATIC_PREFIX_HASHES = Object.freeze(Object.fromEntries(
  Object.entries(STATIC_PROMPT_PREFIXES).map(([prefixId, prefix]) => [prefixId, hashBountyContract('static-prompt-prefix', prefix)]),
) as Record<BountyStaticPrefixId, string>);

interface RouteDefinition {
  objectiveClass: BountyObjectiveClass;
  phase: BountyPhase;
  evidenceTypes: readonly BountyEvidenceType[];
  capabilities: readonly (typeof BOUNTY_CAPABILITIES[number])[];
  prefixId: BountyStaticPrefixId;
  modelTier: BountyModelTier;
  contextKind: 'ordinary' | 'whitebox-focused' | 'whitebox-synthesis';
  successors: readonly BountyObjectiveClass[];
}

/** The order is policy, not discovery order. Changes require a new policy hash. */
export const BOUNTY_ROUTE_DEFINITIONS: readonly RouteDefinition[] = Object.freeze([
  { objectiveClass: 'program-intake', phase: 'intake', evidenceTypes: ['program-policy'], capabilities: ['repository:read'], prefixId: 'bounty.intake.v1', modelTier: 'standard', contextKind: 'ordinary', successors: ['scope-validation'] },
  { objectiveClass: 'scope-validation', phase: 'scope', evidenceTypes: ['program-policy', 'scope-record'], capabilities: ['repository:read'], prefixId: 'bounty.intake.v1', modelTier: 'standard', contextKind: 'ordinary', successors: ['asset-inventory'] },
  { objectiveClass: 'asset-inventory', phase: 'discovery', evidenceTypes: ['scope-record', 'asset-record'], capabilities: ['target:observe'], prefixId: 'bounty.discovery.v1', modelTier: 'standard', contextKind: 'ordinary', successors: ['surface-enumeration', 'whitebox-focused-review'] },
  { objectiveClass: 'surface-enumeration', phase: 'discovery', evidenceTypes: ['asset-record', 'http-observation'], capabilities: ['target:observe'], prefixId: 'bounty.discovery.v1', modelTier: 'standard', contextKind: 'ordinary', successors: ['authentication-testing', 'authorization-testing', 'input-validation-testing', 'business-logic-testing', 'configuration-testing'] },
  { objectiveClass: 'whitebox-focused-review', phase: 'analysis', evidenceTypes: ['source-code'], capabilities: ['repository:read'], prefixId: 'bounty.analysis.v1', modelTier: 'advanced', contextKind: 'whitebox-focused', successors: ['whitebox-synthesis'] },
  { objectiveClass: 'whitebox-synthesis', phase: 'synthesis', evidenceTypes: ['source-code', 'correlated-evidence'], capabilities: ['repository:read', 'evidence:write'], prefixId: 'bounty.synthesis.v1', modelTier: 'advanced', contextKind: 'whitebox-synthesis', successors: ['evidence-correlation'] },
  { objectiveClass: 'authentication-testing', phase: 'analysis', evidenceTypes: ['auth-observation'], capabilities: ['target:test', 'evidence:write'], prefixId: 'bounty.analysis.v1', modelTier: 'standard', contextKind: 'ordinary', successors: ['active-verification'] },
  { objectiveClass: 'authorization-testing', phase: 'analysis', evidenceTypes: ['access-control-observation'], capabilities: ['target:test', 'evidence:write'], prefixId: 'bounty.analysis.v1', modelTier: 'advanced', contextKind: 'ordinary', successors: ['active-verification'] },
  { objectiveClass: 'input-validation-testing', phase: 'analysis', evidenceTypes: ['input-observation'], capabilities: ['target:test', 'evidence:write'], prefixId: 'bounty.analysis.v1', modelTier: 'standard', contextKind: 'ordinary', successors: ['active-verification'] },
  { objectiveClass: 'business-logic-testing', phase: 'analysis', evidenceTypes: ['workflow-observation'], capabilities: ['target:test', 'evidence:write'], prefixId: 'bounty.analysis.v1', modelTier: 'advanced', contextKind: 'ordinary', successors: ['active-verification'] },
  { objectiveClass: 'configuration-testing', phase: 'analysis', evidenceTypes: ['configuration-record'], capabilities: ['target:observe', 'evidence:write'], prefixId: 'bounty.analysis.v1', modelTier: 'standard', contextKind: 'ordinary', successors: ['active-verification'] },
  { objectiveClass: 'dependency-analysis', phase: 'analysis', evidenceTypes: ['dependency-record'], capabilities: ['repository:read', 'evidence:write'], prefixId: 'bounty.analysis.v1', modelTier: 'standard', contextKind: 'ordinary', successors: ['active-verification'] },
  { objectiveClass: 'active-verification', phase: 'verification', evidenceTypes: ['verification-result'], capabilities: ['target:test', 'evidence:write'], prefixId: 'bounty.verification.v1', modelTier: 'advanced', contextKind: 'ordinary', successors: ['evidence-correlation'] },
  { objectiveClass: 'evidence-correlation', phase: 'synthesis', evidenceTypes: ['verification-result', 'correlated-evidence'], capabilities: ['evidence:write'], prefixId: 'bounty.synthesis.v1', modelTier: 'standard', contextKind: 'ordinary', successors: ['finding-drafting', 'mission-synthesis'] },
  { objectiveClass: 'finding-drafting', phase: 'reporting', evidenceTypes: ['correlated-evidence', 'finding-record'], capabilities: ['finding:draft'], prefixId: 'bounty.reporting.v1', modelTier: 'advanced', contextKind: 'ordinary', successors: ['mission-synthesis'] },
  { objectiveClass: 'mission-synthesis', phase: 'synthesis', evidenceTypes: ['finding-record'], capabilities: ['evidence:write'], prefixId: 'bounty.synthesis.v1', modelTier: 'advanced', contextKind: 'ordinary', successors: [] },
]);

export const BOUNTY_ROUTE_POLICY_HASH = hashBountyContract('route-policy', {
  definitions: BOUNTY_ROUTE_DEFINITIONS,
  prefixes: BOUNTY_STATIC_PREFIX_HASHES,
  ordinaryContext: { targetMinTokens: 25_000, targetTokens: 28_000, targetMaxTokens: 30_000, splitAboveTokens: 40_000 },
  whitebox: { focusedLimitTokens: 8_000, synthesisLimitTokens: 32_000 },
});

const ObjectiveClassSchema = z.enum(BOUNTY_OBJECTIVE_CLASSES);
const PhaseSchema = z.enum(BOUNTY_PHASES);
const EvidenceTypeSchema = z.enum(BOUNTY_EVIDENCE_TYPES);
const SkillManifestSchema = z.object({
  skillId: ID_SCHEMA,
  manifestHash: HASH_SCHEMA,
  contentHash: HASH_SCHEMA,
  objectiveClasses: z.array(ObjectiveClassSchema).min(1).max(16),
  phases: z.array(PhaseSchema).min(1).max(7),
  evidenceTypes: z.array(EvidenceTypeSchema).min(1).max(14),
  capabilities: z.array(CapabilitySchema).max(BOUNTY_CAPABILITIES.length),
  contextTokens: z.number().int().positive().max(40_000),
  priority: z.number().int().min(0).max(10_000),
  staticPromptPrefixId: z.enum(Object.keys(STATIC_PROMPT_PREFIXES) as [BountyStaticPrefixId, ...BountyStaticPrefixId[]]),
  staticPromptPrefixHash: HASH_SCHEMA,
  available: z.boolean(),
}).strict();

const addDuplicateIssues = (
  values: readonly string[],
  path: Array<string | number>,
  ctx: z.RefinementCtx,
): void => {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) ctx.addIssue({ code: 'custom', path: [...path, index], message: `duplicate pinned identity: ${value}` });
    seen.add(value);
  });
};

export const BountyRouteInputSchema = z.object({
  version: z.literal('bounty-route.v1'),
  missionId: MISSION_ID_SCHEMA,
  objective: z.object({ id: ID_SCHEMA, objectiveClass: ObjectiveClassSchema, summaryHash: HASH_SCHEMA }).strict(),
  phase: PhaseSchema,
  role: ID_SCHEMA,
  targets: z.array(z.object({ targetId: ID_SCHEMA, targetKind: z.enum(['repository', 'url', 'service']), targetHash: HASH_SCHEMA }).strict()).min(1).max(256),
  accountRoles: z.array(ID_SCHEMA).max(64),
  evidenceRefs: z.array(z.object({ evidenceId: ID_SCHEMA, evidenceType: EvidenceTypeSchema, evidenceHash: HASH_SCHEMA, contextTokens: z.number().int().nonnegative().max(40_000) }).strict()).min(1).max(256),
  outputSchema: z.object({ schemaId: ID_SCHEMA, schemaHash: HASH_SCHEMA }).strict(),
  effectBudget: z.object({ maxOperations: z.number().int().nonnegative().max(100_000), maxCostCents: z.number().int().nonnegative().max(1_000_000_000), allowedCapabilities: z.array(CapabilitySchema).max(BOUNTY_CAPABILITIES.length) }).strict(),
  availableCapabilities: z.array(CapabilitySchema).max(BOUNTY_CAPABILITIES.length),
  skillManifests: z.array(SkillManifestSchema).min(1).max(128),
  authorityHashes: z.object({ missionHash: HASH_SCHEMA, scopeHash: HASH_SCHEMA, grantHash: HASH_SCHEMA, modelPolicyHash: HASH_SCHEMA, runtimeHash: HASH_SCHEMA }).strict(),
  // Model output is advisory, untrusted text. Do not constrain proposals to the
  // authority enums: an unknown proposal must be ignored, not gain authority or
  // turn into a package-creation denial at the validation boundary.
  modelProposal: z.object({
    objectiveClass: z.string().trim().min(1).max(128).optional(),
    modelTier: z.string().trim().min(1).max(64).optional(),
  }).strict().optional(),
}).strict().superRefine((input, ctx) => {
  addDuplicateIssues(input.targets.map((target) => target.targetId), ['targets'], ctx);
  addDuplicateIssues(input.targets.map((target) => target.targetHash), ['targets'], ctx);
  addDuplicateIssues(input.accountRoles, ['accountRoles'], ctx);
  addDuplicateIssues(input.evidenceRefs.map((evidence) => evidence.evidenceId), ['evidenceRefs'], ctx);
  addDuplicateIssues(input.evidenceRefs.map((evidence) => evidence.evidenceHash), ['evidenceRefs'], ctx);
  addDuplicateIssues(input.effectBudget.allowedCapabilities, ['effectBudget', 'allowedCapabilities'], ctx);
  addDuplicateIssues(input.availableCapabilities, ['availableCapabilities'], ctx);
  addDuplicateIssues(input.skillManifests.map((manifest) => manifest.skillId), ['skillManifests'], ctx);
  addDuplicateIssues(input.skillManifests.map((manifest) => manifest.manifestHash), ['skillManifests'], ctx);
  addDuplicateIssues(input.skillManifests.map((manifest) => manifest.contentHash), ['skillManifests'], ctx);
  input.skillManifests.forEach((manifest, index) => {
    addDuplicateIssues(manifest.objectiveClasses, ['skillManifests', index, 'objectiveClasses'], ctx);
    addDuplicateIssues(manifest.phases, ['skillManifests', index, 'phases'], ctx);
    addDuplicateIssues(manifest.evidenceTypes, ['skillManifests', index, 'evidenceTypes'], ctx);
    addDuplicateIssues(manifest.capabilities, ['skillManifests', index, 'capabilities'], ctx);
  });
});
export type BountyRouteInput = z.infer<typeof BountyRouteInputSchema>;

export type BountyRouteReasonCode =
  | 'ROUTE_SELECTED' | 'PHASE_MISMATCH' | 'EVIDENCE_TYPE_UNSUPPORTED' | 'CAPABILITY_UNAVAILABLE'
  | 'CAPABILITY_UNAUTHORIZED' | 'SKILL_UNAVAILABLE' | 'SKILL_OBJECTIVE_MISMATCH'
  | 'SKILL_PHASE_MISMATCH' | 'SKILL_EVIDENCE_MISMATCH' | 'SKILL_CAPABILITY_UNAVAILABLE'
  | 'SKILL_CAPABILITY_UNAUTHORIZED'
  | 'STATIC_PREFIX_HASH_MISMATCH' | 'NO_ELIGIBLE_SKILL' | 'CONTEXT_LIMIT_EXCEEDED'
  | 'CONTEXT_SPLIT' | 'MODEL_PROPOSAL_IGNORED';

export interface BountyRouteOmission { manifestHash?: string; reasonCode: BountyRouteReasonCode; subject: string }
export interface BountyRouteReports {
  availability: {
    availableManifestHashes: string[];
    unavailableManifestHashes: string[];
    availableCapabilities: string[];
    unavailableRequiredCapabilities: string[];
  };
  routing: { selectedManifestHashes: string[]; omitted: BountyRouteOmission[]; reasonCodes: BountyRouteReasonCode[] };
  authorization: { authorized: boolean; requiredCapabilities: readonly string[]; unauthorizedCapabilities: string[] };
  effects: { status: 'not-executed'; actualOperations: 0; actualCostCents: 0; receiptHashes: [] };
}
export interface BountyRouteTelemetry {
  cache: { routeKey: string; status: 'eligible' | 'blocked' };
  model: {
    selectedTier: BountyModelTier;
    authorityPolicyHash: string;
    routePolicyHash: string;
    escalationPolicyBound: true;
    proposalAuthorized: false;
  };
  context: {
    kind: RouteDefinition['contextKind'];
    selectedSkillTokens: number;
    evidenceTokens: number;
    totalTokens: number;
    targetMinTokens: number;
    targetTokens: number;
    targetMaxTokens: number;
    hardLimitTokens: number;
    splitAboveTokens: number | null;
    plannedPartCount: number;
  };
}
export interface RoutedBountyPackage {
  ordinal: number;
  part: number;
  partCount: number;
  packageHash: string;
  inputHash: string;
  objective: BountyRouteInput['objective'];
  phase: BountyPhase;
  role: string;
  targetTuples: BountyRouteInput['targets'];
  accountRoles: string[];
  evidenceRefs: BountyRouteInput['evidenceRefs'];
  outputSchema: BountyRouteInput['outputSchema'];
  effectBudget: BountyRouteInput['effectBudget'];
  selectedSkills: Array<{ skillId: string; manifestHash: string; contentHash: string; contextTokens: number; staticPromptPrefixId: BountyStaticPrefixId; staticPromptPrefixHash: string }>;
  selectedHashes: string[];
  omissions: BountyRouteOmission[];
  reasonCodes: BountyRouteReasonCode[];
  context: { kind: RouteDefinition['contextKind']; selectedTokens: number; evidenceTokens: number; totalTokens: number; targetMinTokens: number; targetTokens: number; targetMaxTokens: number; hardLimitTokens: number };
  modelTier: BountyModelTier;
  successorObjectiveClasses: readonly BountyObjectiveClass[];
  reports: BountyRouteReports;
  telemetry: {
    cache: { routeKey: string; status: 'eligible' };
    model: { selectedTier: BountyModelTier; authorityPolicyHash: string; routePolicyHash: string; escalationPolicyBound: true; proposalAuthorized: false };
    context: { selectedTokens: number; hardLimitTokens: number; splitAboveTokens: number | null; part: number; partCount: number };
  };
}
interface BountyRouteResultBase {
  inputHash: string;
  routeHash: string;
  policyHash: string;
  reasonCodes: BountyRouteReasonCode[];
  reports: BountyRouteReports;
  telemetry: BountyRouteTelemetry;
}
export type BountyRouteResult =
  | BountyRouteResultBase & { canCreate: true; packages: RoutedBountyPackage[] }
  | BountyRouteResultBase & { canCreate: false; packages: []; omissions: BountyRouteOmission[] };

const lexical = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const uniqueSorted = (values: readonly string[]): string[] => [...new Set(values)].sort(lexical);
const bySkillOrder = (left: BountyRouteInput['skillManifests'][number], right: BountyRouteInput['skillManifests'][number]): number =>
  left.priority - right.priority || lexical(left.skillId, right.skillId) || lexical(left.manifestHash, right.manifestHash);

function contextPolicy(kind: RouteDefinition['contextKind']): { min: number; target: number; max: number; hard: number; splitAbove: number | null } {
  if (kind === 'whitebox-focused') return { min: 0, target: 8_000, max: 8_000, hard: 8_000, splitAbove: null };
  if (kind === 'whitebox-synthesis') return { min: 0, target: 32_000, max: 32_000, hard: 32_000, splitAbove: null };
  return { min: 25_000, target: 28_000, max: 30_000, hard: 40_000, splitAbove: 40_000 };
}

function partitionSkills(skills: BountyRouteInput['skillManifests'], evidenceTokens: number, policy: ReturnType<typeof contextPolicy>): BountyRouteInput['skillManifests'][] {
  if (evidenceTokens + skills.reduce((sum, skill) => sum + skill.contextTokens, 0) <= policy.hard) return [skills];
  const parts: BountyRouteInput['skillManifests'][] = [];
  let current: BountyRouteInput['skillManifests'] = [];
  let tokens = evidenceTokens;
  for (const skill of skills) {
    if (current.length && tokens + skill.contextTokens > policy.max) {
      parts.push(current);
      current = [];
      tokens = evidenceTokens;
    }
    current.push(skill);
    tokens += skill.contextTokens;
  }
  if (current.length) parts.push(current);
  return parts;
}

/**
 * Route from hashes and pinned manifests only. The optional model proposal is
 * recorded as ignored; it never chooses an objective, model, capability, or effect.
 */
export function routeBountyWorkPackages(rawInput: BountyRouteInput): BountyRouteResult {
  const input = BountyRouteInputSchema.parse(rawInput);
  // Policy identity participates in the cache/input key so a policy revision can
  // never return a different route for an otherwise identical pinned input hash.
  const inputHash = hashBountyContract('route-input', { policyHash: BOUNTY_ROUTE_POLICY_HASH, input });
  const definition = BOUNTY_ROUTE_DEFINITIONS.find((candidate) => candidate.objectiveClass === input.objective.objectiveClass)!;
  const omissions: BountyRouteOmission[] = [];
  const blockingReasons: BountyRouteReasonCode[] = [];
  if (definition.phase !== input.phase) {
    blockingReasons.push('PHASE_MISMATCH');
    omissions.push({ reasonCode: 'PHASE_MISMATCH', subject: input.phase });
  }
  const observedEvidenceTypes = new Set(input.evidenceRefs.map((ref) => ref.evidenceType));
  if (!definition.evidenceTypes.some((type) => observedEvidenceTypes.has(type))) {
    blockingReasons.push('EVIDENCE_TYPE_UNSUPPORTED');
    omissions.push({ reasonCode: 'EVIDENCE_TYPE_UNSUPPORTED', subject: uniqueSorted([...observedEvidenceTypes]).join(',') });
  }
  const availableCapabilities = new Set(input.availableCapabilities);
  const authorizedCapabilities = new Set(input.effectBudget.allowedCapabilities);
  for (const capability of definition.capabilities) {
    if (!availableCapabilities.has(capability)) {
      blockingReasons.push('CAPABILITY_UNAVAILABLE');
      omissions.push({ reasonCode: 'CAPABILITY_UNAVAILABLE', subject: capability });
    } else if (!authorizedCapabilities.has(capability)) {
      blockingReasons.push('CAPABILITY_UNAUTHORIZED');
      omissions.push({ reasonCode: 'CAPABILITY_UNAUTHORIZED', subject: capability });
    }
  }

  const manifests = [...input.skillManifests].sort(bySkillOrder);
  const eligible = manifests.filter((manifest) => {
    let reason: BountyRouteReasonCode | undefined;
    if (!manifest.available) reason = 'SKILL_UNAVAILABLE';
    else if (!manifest.objectiveClasses.includes(definition.objectiveClass)) reason = 'SKILL_OBJECTIVE_MISMATCH';
    else if (!manifest.phases.includes(definition.phase)) reason = 'SKILL_PHASE_MISMATCH';
    else if (!manifest.evidenceTypes.some((type) => observedEvidenceTypes.has(type))) reason = 'SKILL_EVIDENCE_MISMATCH';
    else if (manifest.capabilities.some((capability) => !availableCapabilities.has(capability))) reason = 'SKILL_CAPABILITY_UNAVAILABLE';
    else if (manifest.capabilities.some((capability) => !authorizedCapabilities.has(capability))) reason = 'SKILL_CAPABILITY_UNAUTHORIZED';
    else if (manifest.staticPromptPrefixId !== definition.prefixId || BOUNTY_STATIC_PREFIX_HASHES[manifest.staticPromptPrefixId] !== manifest.staticPromptPrefixHash) reason = 'STATIC_PREFIX_HASH_MISMATCH';
    if (reason) omissions.push({ manifestHash: manifest.manifestHash, reasonCode: reason, subject: manifest.skillId });
    return !reason;
  });
  if (!eligible.length) {
    blockingReasons.push('NO_ELIGIBLE_SKILL');
    omissions.push({ reasonCode: 'NO_ELIGIBLE_SKILL', subject: definition.objectiveClass });
  }
  if (input.modelProposal) omissions.push({ reasonCode: 'MODEL_PROPOSAL_IGNORED', subject: 'modelProposal' });

  const orderedOmissions = [...omissions].sort((left, right) => lexical(left.manifestHash ?? '', right.manifestHash ?? '') || lexical(left.reasonCode, right.reasonCode) || lexical(left.subject, right.subject));
  const policy = contextPolicy(definition.contextKind);
  const evidenceTokens = input.evidenceRefs.reduce((sum, ref) => sum + ref.contextTokens, 0);
  const eligibleSkillTokens = eligible.reduce((sum, skill) => sum + skill.contextTokens, 0);
  const unavailableRequiredCapabilities = definition.capabilities.filter((capability) => !availableCapabilities.has(capability));
  const unauthorizedCapabilities = definition.capabilities.filter((capability) => !authorizedCapabilities.has(capability));
  const buildReports = (
    selectedManifestHashes: string[],
    reasonCodes: BountyRouteReasonCode[],
    reportedOmissions: BountyRouteOmission[],
  ): BountyRouteReports => ({
    availability: {
      availableManifestHashes: manifests.filter((manifest) => manifest.available).map((manifest) => manifest.manifestHash),
      unavailableManifestHashes: manifests.filter((manifest) => !manifest.available).map((manifest) => manifest.manifestHash),
      availableCapabilities: uniqueSorted(input.availableCapabilities),
      unavailableRequiredCapabilities,
    },
    routing: { selectedManifestHashes, omitted: reportedOmissions, reasonCodes },
    authorization: { authorized: unauthorizedCapabilities.length === 0, requiredCapabilities: definition.capabilities, unauthorizedCapabilities },
    effects: { status: 'not-executed', actualOperations: 0, actualCostCents: 0, receiptHashes: [] },
  });
  const buildTelemetry = (status: 'eligible' | 'blocked', plannedPartCount: number): BountyRouteTelemetry => ({
    cache: { routeKey: inputHash, status },
    model: {
      selectedTier: definition.modelTier,
      authorityPolicyHash: input.authorityHashes.modelPolicyHash,
      routePolicyHash: BOUNTY_ROUTE_POLICY_HASH,
      escalationPolicyBound: true,
      proposalAuthorized: false,
    },
    context: {
      kind: definition.contextKind,
      selectedSkillTokens: eligibleSkillTokens,
      evidenceTokens,
      totalTokens: eligibleSkillTokens + evidenceTokens,
      targetMinTokens: policy.min,
      targetTokens: policy.target,
      targetMaxTokens: policy.max,
      hardLimitTokens: policy.hard,
      splitAboveTokens: policy.splitAbove,
      plannedPartCount,
    },
  });
  const blockedCodes = uniqueSorted(blockingReasons) as BountyRouteReasonCode[];
  if (blockedCodes.length) {
    const reports = buildReports([], blockedCodes, orderedOmissions);
    const telemetry = buildTelemetry('blocked', 0);
    const routeHash = hashBountyContract('route-result', { inputHash, policyHash: BOUNTY_ROUTE_POLICY_HASH, reasonCodes: blockedCodes, reports, telemetry });
    return { canCreate: false, inputHash, routeHash, policyHash: BOUNTY_ROUTE_POLICY_HASH, packages: [], reasonCodes: blockedCodes, omissions: orderedOmissions, reports, telemetry };
  }

  if (definition.contextKind !== 'ordinary' && evidenceTokens + eligibleSkillTokens > policy.hard) {
    const reasonCodes: BountyRouteReasonCode[] = ['CONTEXT_LIMIT_EXCEEDED'];
    const boundedOmissions = [...orderedOmissions, { reasonCode: 'CONTEXT_LIMIT_EXCEEDED' as const, subject: `${definition.contextKind}:context-limit` }];
    const reports = buildReports([], reasonCodes, boundedOmissions);
    const telemetry = buildTelemetry('blocked', 0);
    const routeHash = hashBountyContract('route-result', { inputHash, policyHash: BOUNTY_ROUTE_POLICY_HASH, reasonCodes, reports, telemetry });
    return { canCreate: false, inputHash, routeHash, policyHash: BOUNTY_ROUTE_POLICY_HASH, packages: [], reasonCodes, omissions: boundedOmissions, reports, telemetry };
  }
  const parts = partitionSkills(eligible, evidenceTokens, policy);
  if (parts.some((part) => evidenceTokens + part.reduce((sum, skill) => sum + skill.contextTokens, 0) > policy.hard)) {
    const reasonCodes: BountyRouteReasonCode[] = ['CONTEXT_LIMIT_EXCEEDED'];
    const boundedOmissions = [...orderedOmissions, { reasonCode: 'CONTEXT_LIMIT_EXCEEDED' as const, subject: `${definition.contextKind}:unsplittable-context` }];
    const reports = buildReports([], reasonCodes, boundedOmissions);
    const telemetry = buildTelemetry('blocked', 0);
    const routeHash = hashBountyContract('route-result', { inputHash, policyHash: BOUNTY_ROUTE_POLICY_HASH, reasonCodes, reports, telemetry });
    return { canCreate: false, inputHash, routeHash, policyHash: BOUNTY_ROUTE_POLICY_HASH, packages: [], reasonCodes, omissions: boundedOmissions, reports, telemetry };
  }
  const routeReasonCodes: BountyRouteReasonCode[] = ['ROUTE_SELECTED', ...(parts.length > 1 ? ['CONTEXT_SPLIT' as const] : []), ...(input.modelProposal ? ['MODEL_PROPOSAL_IGNORED' as const] : [])];
  const packages = parts.map((partSkills, index): RoutedBountyPackage => {
    const selectedSkills = partSkills.map((skill) => ({
      skillId: skill.skillId, manifestHash: skill.manifestHash, contentHash: skill.contentHash,
      contextTokens: skill.contextTokens, staticPromptPrefixId: skill.staticPromptPrefixId,
      staticPromptPrefixHash: skill.staticPromptPrefixHash,
    }));
    const skillTokens = selectedSkills.reduce((sum, skill) => sum + skill.contextTokens, 0);
    const totalTokens = skillTokens + evidenceTokens;
    const partManifestHashes = new Set(selectedSkills.map((skill) => skill.manifestHash));
    const partOmissions = [
      ...orderedOmissions,
      ...eligible.filter((skill) => !partManifestHashes.has(skill.manifestHash)).map((skill) => ({
        manifestHash: skill.manifestHash,
        reasonCode: 'CONTEXT_SPLIT' as const,
        subject: skill.skillId,
      })),
    ].sort((left, right) => lexical(left.manifestHash ?? '', right.manifestHash ?? '') || lexical(left.reasonCode, right.reasonCode) || lexical(left.subject, right.subject));
    const selectedHashes = uniqueSorted([
      inputHash, BOUNTY_ROUTE_POLICY_HASH, input.objective.summaryHash, ...Object.values(input.authorityHashes),
      input.outputSchema.schemaHash, hashBountyContract('effect-budget', input.effectBudget),
      ...input.targets.map((target) => target.targetHash),
      ...input.evidenceRefs.map((ref) => ref.evidenceHash),
      ...selectedSkills.flatMap((skill) => [skill.manifestHash, skill.contentHash, skill.staticPromptPrefixHash]),
    ]);
    const body = {
      ordinal: index + 1, part: index + 1, partCount: parts.length, inputHash,
      objective: input.objective, phase: definition.phase, role: input.role, targetTuples: input.targets,
      accountRoles: uniqueSorted(input.accountRoles), evidenceRefs: input.evidenceRefs,
      outputSchema: input.outputSchema, effectBudget: input.effectBudget, selectedSkills,
      selectedHashes, omissions: partOmissions, reasonCodes: routeReasonCodes,
      context: { kind: definition.contextKind, selectedTokens: skillTokens, evidenceTokens, totalTokens, targetMinTokens: policy.min, targetTokens: policy.target, targetMaxTokens: policy.max, hardLimitTokens: policy.hard },
      modelTier: definition.modelTier, successorObjectiveClasses: definition.successors,
    };
    const packageHash = hashBountyContract('work-package-route', body);
    return {
      ...body,
      packageHash,
      reports: buildReports(selectedSkills.map((skill) => skill.manifestHash), routeReasonCodes, partOmissions),
      telemetry: {
        cache: { routeKey: inputHash, status: 'eligible' },
        model: {
          selectedTier: definition.modelTier,
          authorityPolicyHash: input.authorityHashes.modelPolicyHash,
          routePolicyHash: BOUNTY_ROUTE_POLICY_HASH,
          escalationPolicyBound: true,
          proposalAuthorized: false,
        },
        context: { selectedTokens: totalTokens, hardLimitTokens: policy.hard, splitAboveTokens: policy.splitAbove, part: index + 1, partCount: parts.length },
      },
    };
  });
  const reports = buildReports(eligible.map((skill) => skill.manifestHash), routeReasonCodes, orderedOmissions);
  const telemetry = buildTelemetry('eligible', parts.length);
  const routeHash = hashBountyContract('route-result', { inputHash, policyHash: BOUNTY_ROUTE_POLICY_HASH, packageHashes: packages.map((entry) => entry.packageHash), reasonCodes: routeReasonCodes, reports, telemetry });
  return { canCreate: true, inputHash, routeHash, policyHash: BOUNTY_ROUTE_POLICY_HASH, packages, reasonCodes: routeReasonCodes, reports, telemetry };
}

/** Executable route fixtures: every route has a matching and a non-matching evidence case. */
export const BOUNTY_ROUTE_FIXTURES = Object.freeze(BOUNTY_ROUTE_DEFINITIONS.map((definition) => ({
  objectiveClass: definition.objectiveClass,
  phase: definition.phase,
  positiveEvidenceType: definition.evidenceTypes[0],
  negativeEvidenceType: BOUNTY_EVIDENCE_TYPES.find((type) => !definition.evidenceTypes.includes(type))!,
  successorObjectiveClasses: definition.successors,
})));

export function getBountyStaticPromptPrefix(prefixId: BountyStaticPrefixId): string {
  return STATIC_PROMPT_PREFIXES[prefixId];
}
