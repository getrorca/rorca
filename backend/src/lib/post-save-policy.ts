/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { ValidationError } from './errors';

export const POST_SAVE_POLICY_VERSION = 'v1' as const;

export const POST_SAVE_POLICY_PRESET_IDS = [
  'fast_import',
  'best_effort',
  'skill_first_strict',
  'enterprise_governed',
  'repair_only',
] as const;

export const POST_SAVE_CONTEXT_FIELDS = ['capture', 'skip'] as const;
export const POST_SAVE_ENRICH_FIELDS = ['enqueue', 'skip'] as const;
export const POST_SAVE_SKILLS_FIELDS = ['match', 'skip'] as const;
export const POST_SAVE_MEMORY_FIELDS = ['synthesize', 'skip'] as const;
export const POST_SAVE_FAILURE_FIELDS = ['continue', 'fail'] as const;

export type PostSavePolicyVersion = typeof POST_SAVE_POLICY_VERSION;
export type PostSavePolicyPresetId = typeof POST_SAVE_POLICY_PRESET_IDS[number];
export type PostSaveContextField = typeof POST_SAVE_CONTEXT_FIELDS[number];
export type PostSaveEnrichField = typeof POST_SAVE_ENRICH_FIELDS[number];
export type PostSaveSkillsField = typeof POST_SAVE_SKILLS_FIELDS[number];
export type PostSaveMemoryField = typeof POST_SAVE_MEMORY_FIELDS[number];
export type PostSaveFailureField = typeof POST_SAVE_FAILURE_FIELDS[number];

export interface PostSavePolicy {
  version: PostSavePolicyVersion;
  presetId?: PostSavePolicyPresetId;
  context: PostSaveContextField;
  enrich: PostSaveEnrichField;
  skills: PostSaveSkillsField;
  memory: PostSaveMemoryField;
  onFailure: PostSaveFailureField;
}

export interface PostSaveLegacyOptions {
  enrich: boolean;
  matchSkills: boolean;
  memorySynthesis: boolean;
}

export interface PostSavePolicyObjectInput {
  version?: PostSavePolicyVersion;
  presetId?: PostSavePolicyPresetId;
  preset?: PostSavePolicyPresetId;
  context?: PostSaveContextField;
  enrich?: PostSaveEnrichField | boolean;
  skills?: PostSaveSkillsField;
  memory?: PostSaveMemoryField;
  onFailure?: PostSaveFailureField;
  matchSkills?: boolean;
  memorySynthesis?: boolean;
}

export type PostSavePolicyInput =
  | boolean
  | PostSavePolicyPresetId
  | PostSavePolicyObjectInput
  | null
  | undefined;

export interface PersistedPostSavePolicyMetadata {
  callerPolicy: PostSavePolicyInput;
  effectivePolicy: PostSavePolicy;
  legacyOptions: PostSaveLegacyOptions;
}

export interface ResolvedPostSavePolicy extends PersistedPostSavePolicyMetadata {
  effectivePolicy: PostSavePolicy;
  legacyOptions: PostSaveLegacyOptions;
}

export const POST_SAVE_POLICY_PRESETS: Record<PostSavePolicyPresetId, PostSavePolicy> = {
  fast_import: {
    version: POST_SAVE_POLICY_VERSION,
    presetId: 'fast_import',
    context: 'capture',
    enrich: 'skip',
    skills: 'skip',
    memory: 'skip',
    onFailure: 'continue',
  },
  best_effort: {
    version: POST_SAVE_POLICY_VERSION,
    presetId: 'best_effort',
    context: 'capture',
    enrich: 'enqueue',
    skills: 'match',
    memory: 'synthesize',
    onFailure: 'continue',
  },
  skill_first_strict: {
    version: POST_SAVE_POLICY_VERSION,
    presetId: 'skill_first_strict',
    context: 'capture',
    enrich: 'enqueue',
    skills: 'match',
    memory: 'synthesize',
    onFailure: 'fail',
  },
  enterprise_governed: {
    version: POST_SAVE_POLICY_VERSION,
    presetId: 'enterprise_governed',
    context: 'capture',
    enrich: 'enqueue',
    skills: 'match',
    memory: 'synthesize',
    onFailure: 'fail',
  },
  repair_only: {
    version: POST_SAVE_POLICY_VERSION,
    presetId: 'repair_only',
    context: 'capture',
    enrich: 'enqueue',
    skills: 'match',
    memory: 'skip',
    onFailure: 'continue',
  },
};

const PRESET_IDS = new Set<string>(POST_SAVE_POLICY_PRESET_IDS);

function clonePolicy(policy: PostSavePolicy): PostSavePolicy {
  return { ...policy };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validationError(path: string, value: unknown, allowedValues: readonly string[]): ValidationError {
  return new ValidationError('Invalid postSave policy', {
    field: path,
    value: typeof value === 'string' ? value : JSON.stringify(value) ?? String(value),
    allowedValues: allowedValues.join(','),
    allowedValuesList: [...allowedValues],
  });
}

function assertEnum<T extends string>(
  record: Record<string, unknown>,
  field: string,
  values: readonly T[],
): T | undefined {
  if (!(field in record)) return undefined;
  const value = record[field];
  if (typeof value === 'string' && (values as readonly string[]).includes(value)) return value as T;
  throw validationError(`postSave.${field}`, value, values);
}

function assertBoolean(record: Record<string, unknown>, field: string): boolean | undefined {
  if (!(field in record)) return undefined;
  const value = record[field];
  if (typeof value === 'boolean') return value;
  throw validationError(`postSave.${field}`, value, ['true', 'false']);
}

function resolvePreset(value: unknown, path = 'postSave'): PostSavePolicyPresetId {
  if (typeof value === 'string' && PRESET_IDS.has(value)) return value as PostSavePolicyPresetId;
  throw validationError(path, value, POST_SAVE_POLICY_PRESET_IDS);
}

function legacyOptionsFromPolicy(policy: PostSavePolicy): PostSaveLegacyOptions {
  return {
    enrich: policy.enrich === 'enqueue',
    matchSkills: policy.skills === 'match',
    memorySynthesis: policy.memory === 'synthesize',
  };
}

function applyLegacyOverrides(policy: PostSavePolicy, input: Record<string, unknown>): PostSavePolicy {
  const enrich = assertBoolean(input, 'enrich');
  const matchSkills = assertBoolean(input, 'matchSkills');
  const memorySynthesis = assertBoolean(input, 'memorySynthesis');

  return {
    ...policy,
    ...(enrich !== undefined ? { enrich: enrich ? 'enqueue' : 'skip' } : {}),
    ...(matchSkills !== undefined ? { skills: matchSkills ? 'match' : 'skip' } : {}),
    ...(memorySynthesis !== undefined ? { memory: memorySynthesis ? 'synthesize' : 'skip' } : {}),
  };
}

function applyCanonicalOverrides(policy: PostSavePolicy, input: Record<string, unknown>): PostSavePolicy {
  const version = input.version;
  if (version !== undefined && version !== POST_SAVE_POLICY_VERSION) {
    throw validationError('postSave.version', version, [POST_SAVE_POLICY_VERSION]);
  }

  return {
    ...policy,
    context: assertEnum(input, 'context', POST_SAVE_CONTEXT_FIELDS) ?? policy.context,
    enrich: assertEnum(input, 'enrich', POST_SAVE_ENRICH_FIELDS) ?? policy.enrich,
    skills: assertEnum(input, 'skills', POST_SAVE_SKILLS_FIELDS) ?? policy.skills,
    memory: assertEnum(input, 'memory', POST_SAVE_MEMORY_FIELDS) ?? policy.memory,
    onFailure: assertEnum(input, 'onFailure', POST_SAVE_FAILURE_FIELDS) ?? policy.onFailure,
  };
}

/**
 * Resolve caller post-save input into the canonical v1 policy plus the legacy
 * boolean adapter still used by the existing durable post-save queues.
 */
export function resolvePostSavePolicy(input?: unknown): ResolvedPostSavePolicy {
  if (input === undefined || input === null) {
    const effectivePolicy = clonePolicy(POST_SAVE_POLICY_PRESETS.best_effort);
    return { callerPolicy: input, effectivePolicy, legacyOptions: legacyOptionsFromPolicy(effectivePolicy) };
  }

  if (typeof input === 'boolean') {
    const effectivePolicy = clonePolicy(POST_SAVE_POLICY_PRESETS[input ? 'best_effort' : 'fast_import']);
    return { callerPolicy: input, effectivePolicy, legacyOptions: legacyOptionsFromPolicy(effectivePolicy) };
  }

  if (typeof input === 'string') {
    const effectivePolicy = clonePolicy(POST_SAVE_POLICY_PRESETS[resolvePreset(input)]);
    return { callerPolicy: input as PostSavePolicyPresetId, effectivePolicy, legacyOptions: legacyOptionsFromPolicy(effectivePolicy) };
  }

  if (!isRecord(input)) {
    throw validationError('postSave', input, ['boolean', ...POST_SAVE_POLICY_PRESET_IDS, 'policy object']);
  }

  const presetField = input.presetId !== undefined ? 'presetId' : input.preset !== undefined ? 'preset' : undefined;
  const presetId = presetField ? input[presetField] : undefined;
  let effectivePolicy = clonePolicy(POST_SAVE_POLICY_PRESETS[presetId === undefined ? 'best_effort' : resolvePreset(presetId, `postSave.${presetField}`)]);

  // Legacy boolean objects are accepted for backwards compatibility. If a field
  // is a string, it is treated as canonical and validated by applyCanonicalOverrides.
  const legacyInput = { ...input };
  if (typeof legacyInput.enrich !== 'boolean') delete legacyInput.enrich;
  effectivePolicy = applyLegacyOverrides(effectivePolicy, legacyInput);
  const canonicalInput = { ...input };
  if (typeof canonicalInput.enrich === 'boolean') delete canonicalInput.enrich;
  effectivePolicy = applyCanonicalOverrides(effectivePolicy, canonicalInput);
  effectivePolicy = { ...effectivePolicy, version: POST_SAVE_POLICY_VERSION };

  return {
    callerPolicy: input as PostSavePolicyObjectInput,
    effectivePolicy,
    legacyOptions: legacyOptionsFromPolicy(effectivePolicy),
  };
}
