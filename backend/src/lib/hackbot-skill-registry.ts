/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Strict, separately loaded registry for governed HackBot guidance.
 *
 * This module deliberately does not add HackBot packages to SkillRegistry.
 * Source snapshots are provenance data, adapted SKILL.md files are inert text,
 * and only this registry may interpret the governance metadata. Neither a
 * manifest row nor skill text grants route or target-effect authority.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ValidationError } from './errors';

export const HACKBOT_MANIFEST_SCHEMA = 'hackbot-skill-manifest.v1' as const;
export const HACKBOT_SKILL_COUNT = 16;
export const HACKBOT_REGISTRY_PRECEDENCE = [
  'governed-manifest',
  'workspace-package',
  'database',
  'ordinary',
] as const;

export type HackbotReleaseStatus = 'active' | 'candidate' | 'disabled';
export type HackbotPersonaRole = 'orchestrator' | 'hunter' | 'validator' | 'reporter' | 'specialist';
export type HackbotRegistrySource = typeof HACKBOT_REGISTRY_PRECEDENCE[number];

export interface HackbotSkillProvenance {
  sourcePath: string;
  sourceSha256: string;
  adaptedPath: string;
  adaptedSha256: string;
  reviewDiff: { summary: string; sha256: string };
  unsafeSourceInstructions: string[];
}

export interface HackbotSkillRow {
  id: string;
  sourceName: string;
  packageName: string;
  triggers: string[];
  objectives: string[];
  prerequisites: string[];
  schemas: { input: string; output: string };
  contextLimits: { maxInputTokens: number; maxEvidenceItems: number };
  localTools: string[];
  brokerCapabilities: string[];
  credentials: string[];
  sensitivity: string[];
  conflicts: string[];
  successors: string[];
  oracle: { id: string; required: boolean; negativeControl: string };
  controls: {
    exactMissionControlsRequired: boolean;
    sourceInstructionsInert: boolean;
    brokerOnly: boolean;
    effectsDefaultDenied: boolean;
  };
  releaseStatus: HackbotReleaseStatus;
  availability: { listed: boolean; reason: string };
  routeEligibility: { defaultEligible: boolean; allowWhenControlsMatch: boolean };
  effectAuthorization: { defaultAuthorized: boolean; mode: 'none' | 'broker-only' };
  provenance: HackbotSkillProvenance;
}

export interface HackbotPersona {
  name: string;
  role: HackbotPersonaRole;
  allowedContext: string[];
  excludedContext: string[];
  localTools: string[];
  brokerCapabilities: string[];
  credentials: string[];
  canSubmit: boolean;
  canCauseEffects: boolean;
}

export interface HackbotSkillManifest {
  schema: typeof HACKBOT_MANIFEST_SCHEMA;
  version: string;
  registryPrecedence: HackbotRegistrySource[];
  skills: HackbotSkillRow[];
  personas: HackbotPersona[];
}

export interface HackbotRouteContext {
  objective: string;
  availablePrerequisites: string[];
  grantedBrokerCapabilities: string[];
  credentialRoles: string[];
  exactMissionControls: boolean;
}

export interface HackbotSkillDecision {
  availability: { available: boolean; reasons: string[] };
  routeEligibility: { eligible: boolean; reasons: string[] };
  effectAuthorization: { authorized: boolean; reasons: string[] };
}

export interface HackbotSkillCandidate<T = unknown> {
  source: HackbotRegistrySource;
  value: T;
}

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const SNAKE_NAME_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const KEBAB_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MANIFEST_KEYS = ['schema', 'version', 'registryPrecedence', 'skills', 'personas'] as const;
const SKILL_KEYS = [
  'id', 'sourceName', 'packageName', 'triggers', 'objectives', 'prerequisites',
  'schemas', 'contextLimits', 'localTools', 'brokerCapabilities', 'credentials',
  'sensitivity', 'conflicts', 'successors', 'oracle', 'controls', 'releaseStatus',
  'availability', 'routeEligibility', 'effectAuthorization', 'provenance',
] as const;
const PERSONA_KEYS = [
  'name', 'role', 'allowedContext', 'excludedContext', 'localTools',
  'brokerCapabilities', 'credentials', 'canSubmit', 'canCauseEffects',
] as const;

function repoRootFromModule(): string {
  return path.resolve(__dirname, '..', '..', '..');
}

export function defaultHackbotManifestPath(): string {
  return path.join(repoRootFromModule(), 'config', 'hackbot', 'hackbot-skill-manifest.v1.json');
}

function fail(message: string): never {
  throw new ValidationError(`Invalid HackBot skill manifest: ${message}`);
}

function record(value: unknown, location: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${location} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], location: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${location} fields must be exactly ${wanted.join(', ')}`);
  }
}

function text(value: unknown, location: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${location} must be a non-empty string`);
  return value;
}

function boolean(value: unknown, location: string): boolean {
  if (typeof value !== 'boolean') fail(`${location} must be boolean`);
  return value;
}

function positiveInteger(value: unknown, location: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail(`${location} must be a positive safe integer`);
  return Number(value);
}

function stringList(value: unknown, location: string, allowEmpty = true): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    fail(`${location} must be a string array`);
  }
  if (!allowEmpty && value.length === 0) fail(`${location} must not be empty`);
  if (new Set(value).size !== value.length) fail(`${location} must not contain duplicates`);
  return value as string[];
}

function sha256(content: string | Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function snakeToKebab(name: string): string {
  return name.replace(/_/g, '-');
}

function resolveCheckedPath(repoRoot: string, relativePath: string, location: string): string {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) fail(`${location} must be a repository-relative path`);
  const resolved = path.resolve(repoRoot, relativePath);
  const relative = path.relative(repoRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail(`${location} escapes the repository`);
  return resolved;
}

function verifyFileHash(repoRoot: string, relativePath: string, expected: string, location: string): Buffer {
  if (!SHA256_RE.test(expected)) fail(`${location} must be a lowercase sha256 digest`);
  const filePath = resolveCheckedPath(repoRoot, relativePath, `${location} path`);
  let content: Buffer;
  try {
    content = fs.readFileSync(filePath);
  } catch {
    fail(`${location} file is missing: ${relativePath}`);
  }
  if (sha256(content) !== expected) fail(`${location} hash drift for ${relativePath}`);
  return content;
}

function parseSkill(value: unknown, index: number, repoRoot: string): HackbotSkillRow {
  const location = `skills[${index}]`;
  const row = record(value, location);
  exactKeys(row, SKILL_KEYS, location);

  const sourceName = text(row['sourceName'], `${location}.sourceName`);
  const packageName = text(row['packageName'], `${location}.packageName`);
  if (!SNAKE_NAME_RE.test(sourceName)) fail(`${location}.sourceName must be snake_case`);
  if (!KEBAB_NAME_RE.test(packageName) || snakeToKebab(sourceName) !== packageName) {
    fail(`${location}.packageName must be the kebab-case sourceName`);
  }

  const schemas = record(row['schemas'], `${location}.schemas`);
  exactKeys(schemas, ['input', 'output'], `${location}.schemas`);
  const contextLimits = record(row['contextLimits'], `${location}.contextLimits`);
  exactKeys(contextLimits, ['maxInputTokens', 'maxEvidenceItems'], `${location}.contextLimits`);
  const oracle = record(row['oracle'], `${location}.oracle`);
  exactKeys(oracle, ['id', 'required', 'negativeControl'], `${location}.oracle`);
  const controls = record(row['controls'], `${location}.controls`);
  exactKeys(controls, ['exactMissionControlsRequired', 'sourceInstructionsInert', 'brokerOnly', 'effectsDefaultDenied'], `${location}.controls`);
  const availability = record(row['availability'], `${location}.availability`);
  exactKeys(availability, ['listed', 'reason'], `${location}.availability`);
  const routeEligibility = record(row['routeEligibility'], `${location}.routeEligibility`);
  exactKeys(routeEligibility, ['defaultEligible', 'allowWhenControlsMatch'], `${location}.routeEligibility`);
  const effectAuthorization = record(row['effectAuthorization'], `${location}.effectAuthorization`);
  exactKeys(effectAuthorization, ['defaultAuthorized', 'mode'], `${location}.effectAuthorization`);
  const provenance = record(row['provenance'], `${location}.provenance`);
  exactKeys(provenance, ['sourcePath', 'sourceSha256', 'adaptedPath', 'adaptedSha256', 'reviewDiff', 'unsafeSourceInstructions'], `${location}.provenance`);
  const reviewDiff = record(provenance['reviewDiff'], `${location}.provenance.reviewDiff`);
  exactKeys(reviewDiff, ['summary', 'sha256'], `${location}.provenance.reviewDiff`);

  const releaseStatus = text(row['releaseStatus'], `${location}.releaseStatus`);
  if (!['active', 'candidate', 'disabled'].includes(releaseStatus)) fail(`${location}.releaseStatus is unsupported`);
  const effectMode = text(effectAuthorization['mode'], `${location}.effectAuthorization.mode`);
  if (!['none', 'broker-only'].includes(effectMode)) fail(`${location}.effectAuthorization.mode is unsupported`);
  const sourcePath = text(provenance['sourcePath'], `${location}.provenance.sourcePath`);
  const sourceSha256 = text(provenance['sourceSha256'], `${location}.provenance.sourceSha256`);
  const adaptedPath = text(provenance['adaptedPath'], `${location}.provenance.adaptedPath`);
  const adaptedSha256 = text(provenance['adaptedSha256'], `${location}.provenance.adaptedSha256`);
  const reviewSummary = text(reviewDiff['summary'], `${location}.provenance.reviewDiff.summary`);
  const reviewSha256 = text(reviewDiff['sha256'], `${location}.provenance.reviewDiff.sha256`);
  if (sha256(reviewSummary) !== reviewSha256) fail(`${location}.provenance.reviewDiff hash drift`);
  if (sourcePath !== `config/hackbot/provenance/${sourceName}.md`) fail(`${location}.provenance.sourcePath does not match sourceName`);
  if (adaptedPath !== `config/hackbot/skills/${packageName}/SKILL.md`) fail(`${location}.provenance.adaptedPath does not match packageName`);
  const sourceContent = verifyFileHash(repoRoot, sourcePath, sourceSha256, `${location}.provenance.source`).toString('utf8');
  const adaptedContent = verifyFileHash(repoRoot, adaptedPath, adaptedSha256, `${location}.provenance.adapted`).toString('utf8');
  const unsafeSourceInstructions = stringList(provenance['unsafeSourceInstructions'], `${location}.provenance.unsafeSourceInstructions`);
  for (const instruction of unsafeSourceInstructions) {
    if (!sourceContent.includes(instruction)) fail(`${location} unsafe source instruction is not provenance-visible`);
    if (adaptedContent.includes(instruction)) fail(`${location} unsafe source instruction leaked into adapted guidance`);
  }
  if (!adaptedContent.includes(`name: ${packageName}\n`)
    || !adaptedContent.includes('disable-model-invocation: true')
    || !adaptedContent.includes('manifest: hackbot-skill-manifest.v1')
    || !adaptedContent.includes(`source-name: ${sourceName}\n`)) {
    fail(`${location}.provenance.adapted metadata does not match the governed row`);
  }

  const parsed: HackbotSkillRow = {
    id: text(row['id'], `${location}.id`),
    sourceName,
    packageName,
    triggers: stringList(row['triggers'], `${location}.triggers`, false),
    objectives: stringList(row['objectives'], `${location}.objectives`, false),
    prerequisites: stringList(row['prerequisites'], `${location}.prerequisites`),
    schemas: {
      input: text(schemas['input'], `${location}.schemas.input`),
      output: text(schemas['output'], `${location}.schemas.output`),
    },
    contextLimits: {
      maxInputTokens: positiveInteger(contextLimits['maxInputTokens'], `${location}.contextLimits.maxInputTokens`),
      maxEvidenceItems: positiveInteger(contextLimits['maxEvidenceItems'], `${location}.contextLimits.maxEvidenceItems`),
    },
    localTools: stringList(row['localTools'], `${location}.localTools`),
    brokerCapabilities: stringList(row['brokerCapabilities'], `${location}.brokerCapabilities`),
    credentials: stringList(row['credentials'], `${location}.credentials`),
    sensitivity: stringList(row['sensitivity'], `${location}.sensitivity`, false),
    conflicts: stringList(row['conflicts'], `${location}.conflicts`),
    successors: stringList(row['successors'], `${location}.successors`),
    oracle: {
      id: text(oracle['id'], `${location}.oracle.id`),
      required: boolean(oracle['required'], `${location}.oracle.required`),
      negativeControl: text(oracle['negativeControl'], `${location}.oracle.negativeControl`),
    },
    controls: {
      exactMissionControlsRequired: boolean(controls['exactMissionControlsRequired'], `${location}.controls.exactMissionControlsRequired`),
      sourceInstructionsInert: boolean(controls['sourceInstructionsInert'], `${location}.controls.sourceInstructionsInert`),
      brokerOnly: boolean(controls['brokerOnly'], `${location}.controls.brokerOnly`),
      effectsDefaultDenied: boolean(controls['effectsDefaultDenied'], `${location}.controls.effectsDefaultDenied`),
    },
    releaseStatus: releaseStatus as HackbotReleaseStatus,
    availability: {
      listed: boolean(availability['listed'], `${location}.availability.listed`),
      reason: text(availability['reason'], `${location}.availability.reason`),
    },
    routeEligibility: {
      defaultEligible: boolean(routeEligibility['defaultEligible'], `${location}.routeEligibility.defaultEligible`),
      allowWhenControlsMatch: boolean(routeEligibility['allowWhenControlsMatch'], `${location}.routeEligibility.allowWhenControlsMatch`),
    },
    effectAuthorization: {
      defaultAuthorized: boolean(effectAuthorization['defaultAuthorized'], `${location}.effectAuthorization.defaultAuthorized`),
      mode: effectMode as 'none' | 'broker-only',
    },
    provenance: {
      sourcePath,
      sourceSha256,
      adaptedPath,
      adaptedSha256,
      reviewDiff: { summary: reviewSummary, sha256: reviewSha256 },
      unsafeSourceInstructions,
    },
  };

  if (!parsed.controls.sourceInstructionsInert || !parsed.controls.effectsDefaultDenied
    || parsed.routeEligibility.defaultEligible || parsed.effectAuthorization.defaultAuthorized) {
    fail(`${location} must keep source text inert and route/effects default-denied`);
  }
  if (parsed.brokerCapabilities.length === 0 && parsed.effectAuthorization.mode !== 'none') {
    fail(`${location} without broker capabilities must use effect mode none`);
  }
  return parsed;
}

function parsePersona(value: unknown, index: number): HackbotPersona {
  const location = `personas[${index}]`;
  const row = record(value, location);
  exactKeys(row, PERSONA_KEYS, location);
  const role = text(row['role'], `${location}.role`);
  if (!['orchestrator', 'hunter', 'validator', 'reporter', 'specialist'].includes(role)) fail(`${location}.role is unsupported`);
  return {
    name: text(row['name'], `${location}.name`),
    role: role as HackbotPersonaRole,
    allowedContext: stringList(row['allowedContext'], `${location}.allowedContext`, false),
    excludedContext: stringList(row['excludedContext'], `${location}.excludedContext`),
    localTools: stringList(row['localTools'], `${location}.localTools`),
    brokerCapabilities: stringList(row['brokerCapabilities'], `${location}.brokerCapabilities`),
    credentials: stringList(row['credentials'], `${location}.credentials`),
    canSubmit: boolean(row['canSubmit'], `${location}.canSubmit`),
    canCauseEffects: boolean(row['canCauseEffects'], `${location}.canCauseEffects`),
  };
}

function validateCrossReferences(manifest: HackbotSkillManifest): void {
  if (manifest.skills.length !== HACKBOT_SKILL_COUNT) fail(`skills must contain exactly ${HACKBOT_SKILL_COUNT} rows`);
  for (const key of ['id', 'sourceName', 'packageName'] as const) {
    if (new Set(manifest.skills.map(skill => skill[key])).size !== HACKBOT_SKILL_COUNT) fail(`skills.${key} values must be unique`);
  }
  const packageNames = new Set(manifest.skills.map(skill => skill.packageName));
  const objectives = new Set<string>();
  for (const skill of manifest.skills) {
    for (const objective of skill.objectives) {
      if (objectives.has(objective)) fail(`objective overlap is ambiguous: ${objective}`);
      objectives.add(objective);
    }
    for (const reference of [...skill.conflicts, ...skill.successors]) {
      if (!packageNames.has(reference)) fail(`${skill.packageName} references unknown skill ${reference}`);
      if (reference === skill.packageName) fail(`${skill.packageName} cannot reference itself`);
    }
  }

  const expectedRoles: HackbotPersonaRole[] = ['orchestrator', 'hunter', 'validator', 'reporter', 'specialist'];
  if (manifest.personas.length !== expectedRoles.length
    || expectedRoles.some(role => manifest.personas.filter(persona => persona.role === role).length !== 1)) {
    fail(`personas must contain exactly one ${expectedRoles.join(', ')}`);
  }
  const validator = manifest.personas.find(persona => persona.role === 'validator')!;
  if (!validator.excludedContext.includes('hunter-narrative') || !validator.excludedContext.includes('hunter-severity')) {
    fail('validator must exclude hunter narrative and severity');
  }
  const reporter = manifest.personas.find(persona => persona.role === 'reporter')!;
  if (reporter.canCauseEffects || reporter.canSubmit || reporter.brokerCapabilities.length > 0 || reporter.credentials.length > 0) {
    fail('reporter must have no effect, submission, broker, or credential capability');
  }
}

/** Load and fully verify strict metadata and every checked-in content digest. */
export function loadHackbotSkillManifest(manifestPath = defaultHackbotManifestPath()): HackbotSkillManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    fail(`cannot read JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = record(raw, 'manifest');
  exactKeys(root, MANIFEST_KEYS, 'manifest');
  if (root['schema'] !== HACKBOT_MANIFEST_SCHEMA) fail(`schema must be ${HACKBOT_MANIFEST_SCHEMA}`);
  const precedence = stringList(root['registryPrecedence'], 'manifest.registryPrecedence', false);
  if (precedence.join('|') !== HACKBOT_REGISTRY_PRECEDENCE.join('|')) fail('registryPrecedence does not match the governed order');
  if (!Array.isArray(root['skills'])) fail('skills must be an array');
  if (!Array.isArray(root['personas'])) fail('personas must be an array');

  const repoRoot = path.resolve(path.dirname(manifestPath), '..', '..');
  const manifest: HackbotSkillManifest = {
    schema: HACKBOT_MANIFEST_SCHEMA,
    version: text(root['version'], 'manifest.version'),
    registryPrecedence: precedence as HackbotRegistrySource[],
    skills: root['skills'].map((skill, index) => parseSkill(skill, index, repoRoot)),
    personas: root['personas'].map((persona, index) => parsePersona(persona, index)),
  };
  validateCrossReferences(manifest);
  return manifest;
}

/** Deterministic collision winner; governed rows cannot be shadowed by workspace or DB text. */
export function resolveHackbotCandidate<T>(candidates: HackbotSkillCandidate<T>[]): HackbotSkillCandidate<T> | undefined {
  return [...candidates].sort((left, right) => (
    HACKBOT_REGISTRY_PRECEDENCE.indexOf(left.source) - HACKBOT_REGISTRY_PRECEDENCE.indexOf(right.source)
  ))[0];
}

/**
 * Evaluate three separate decisions. Availability never implies routing, and
 * routing never implies authority to cause a target effect.
 */
export function evaluateHackbotSkill(skill: HackbotSkillRow, context: HackbotRouteContext): HackbotSkillDecision {
  const availabilityReasons: string[] = [];
  if (!skill.availability.listed) availabilityReasons.push('skill_not_listed');
  if (skill.releaseStatus !== 'active') availabilityReasons.push('skill_not_active');
  const available = availabilityReasons.length === 0;

  const routeReasons: string[] = [];
  if (!available) routeReasons.push('skill_unavailable');
  if (!skill.objectives.includes(context.objective)) routeReasons.push('objective_mismatch');
  const prerequisites = new Set(context.availablePrerequisites);
  if (skill.prerequisites.some(required => !prerequisites.has(required))) routeReasons.push('missing_prerequisite');
  if (!skill.routeEligibility.allowWhenControlsMatch) routeReasons.push('routing_disabled');
  if (skill.controls.exactMissionControlsRequired && !context.exactMissionControls) {
    routeReasons.push('exact_mission_controls_required');
  }
  if (skill.provenance.unsafeSourceInstructions.length > 0 && !context.exactMissionControls) {
    routeReasons.push('unsafe_source_requires_exact_mission_controls');
  }
  const eligible = routeReasons.length === 0;

  const effectReasons: string[] = [];
  if (!eligible) effectReasons.push('route_ineligible');
  if (skill.effectAuthorization.mode === 'none' || skill.brokerCapabilities.length === 0) effectReasons.push('skill_has_no_effect_capability');
  if (!context.exactMissionControls) effectReasons.push('exact_mission_controls_required');
  const grants = new Set(context.grantedBrokerCapabilities);
  if (skill.brokerCapabilities.some(capability => !grants.has(capability))) effectReasons.push('missing_broker_capability');
  const credentialRoles = new Set(context.credentialRoles);
  if (skill.credentials.some(role => !credentialRoles.has(role))) effectReasons.push('missing_credential_role');
  const authorized = effectReasons.length === 0;

  return {
    availability: { available, reasons: availabilityReasons },
    routeEligibility: { eligible, reasons: routeReasons },
    effectAuthorization: { authorized, reasons: effectReasons },
  };
}
