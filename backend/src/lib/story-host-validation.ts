
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Bounded host command observer for LFC-008. It executes one manifest command. */

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  canonicalizeStoryContract,
  deriveStoryCommandHash,
  deriveStoryContractRevision,
  verifyStoryExecutionManifest,
  type ImmutableStoryExecutionManifest,
  type StoryExecutionManifest,
  type StoryValidationRequirement,
} from './story-execution-packet';
import { createAutonomousCommandGuard } from './autonomous-command-guard';
import { sanitizeCapturePayload } from './context-safety';
import {
  createHostValidationObservation,
  MAX_CLOSEOUT_OUTPUT_EXCERPT_BYTES,
  type HostValidationObservation,
  type StoryValidationClassification,
} from './story-closeout';

const HOST_VALIDATION_MAX_BUFFER = 1024 * 1024;

export type HostValidationRequirement = Readonly<Omit<StoryValidationRequirement, 'args'>> & {
  readonly args: readonly string[];
};

export interface HostValidationRunnerOptions {
  env?: Record<string, string>;
  outputReference?: string;
  criterionIds?: string[];
  now?: () => Date;
  classifyFailure?: (facts: {
    requirement: HostValidationRequirement;
    exitCode: number | null;
    output: string;
    revisionBefore: string;
    revisionAfter: string;
  }) => {
    classification: Extract<StoryValidationClassification, 'story_caused_failure' | 'unrelated_baseline'>;
    baselineEvidenceReferences?: string[];
    policyTreatmentReference?: string | null;
  };
}

function gitValue(cwd: string, args: string[], fallback: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim() || fallback;
  } catch {
    return fallback;
  }
}

function boundedUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const source = Buffer.from(value, 'utf8');
  if (source.byteLength <= maxBytes) return { value, truncated: false };

  const suffix = Buffer.from('…', 'utf8');
  let end = Math.max(0, maxBytes - suffix.byteLength);
  while (end > 0 && (source[end] & 0xc0) === 0x80) end -= 1;
  return {
    value: `${source.subarray(0, end).toString('utf8')}${suffix.byteLength <= maxBytes ? '…' : ''}`,
    truncated: true,
  };
}

function redactedOutput(stdout: string, stderr: string): { value: string; truncated: boolean } {
  const sanitized = sanitizeCapturePayload({ value: `${stdout}${stderr}` }).payload;
  const output = sanitized && typeof sanitized === 'object' && typeof (sanitized as { value?: unknown }).value === 'string'
    ? (sanitized as { value: string }).value
    : '';
  return boundedUtf8(output, MAX_CLOSEOUT_OUTPUT_EXCERPT_BYTES);
}

function environmentProfile(
  manifest: StoryExecutionManifest | ImmutableStoryExecutionManifest,
  env: Record<string, string>,
): HostValidationObservation['environment'] {
  const redactedKeys = [...manifest.commandSafety.redactedEnvironmentKeys];
  const visibleProfile = Object.keys(env)
    .filter((key) => !redactedKeys.includes(key))
    .sort()
    .map((key) => ({ key, present: env[key] !== undefined }));
  return {
    profileId: manifest.commandSafety.profileId,
    fingerprint: deriveStoryContractRevision({
      guardVersion: manifest.commandSafety.guardVersion,
      visibleProfile,
      redactedKeys: [...redactedKeys].sort(),
    }),
    redactedKeys,
  };
}

function observationId(
  manifest: StoryExecutionManifest | ImmutableStoryExecutionManifest,
  requirement: HostValidationRequirement,
  startedAt: string,
): string {
  return deriveStoryContractRevision({
    manifestHash: manifest.manifestHash,
    requirementId: requirement.id,
    commandHash: requirement.commandHash,
    startedAt,
  });
}

/**
 * Run exactly one pre-resolved validation requirement in its guarded story
 * worktree. Blocked/unavailable commands remain typed observations.
 */
export function runHostValidationRequirement(
  manifest: StoryExecutionManifest | ImmutableStoryExecutionManifest,
  requirement: HostValidationRequirement,
  options: HostValidationRunnerOptions = {},
): HostValidationObservation {
  if (!verifyStoryExecutionManifest(manifest)) throw new TypeError('Cannot validate against a stale execution manifest');
  const expected = manifest.validationPlan.find((item) => item.id === requirement.id);
  if (!expected || canonicalizeStoryContract(expected) !== canonicalizeStoryContract(requirement)) {
    throw new TypeError(`Validation requirement ${requirement.id} is not the immutable manifest requirement`);
  }
  const commandHash = deriveStoryCommandHash(requirement.command, requirement.args);
  if (commandHash !== requirement.commandHash) throw new TypeError('Validation command hash is stale');

  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const cwd = manifest.commandSafety.guardedWorkingDirectory;
  const baseEnv = { ...(process.env as Record<string, string>), ...(options.env ?? {}) };
  const environment = environmentProfile(manifest, baseEnv);
  const fallbackRevision = manifest.execution.worktree.baseRevision;
  let revisionBefore = fallbackRevision;
  let revisionAfter = fallbackRevision;
  let branch = manifest.execution.worktree.branch ?? 'unknown';
  let classification: StoryValidationClassification = 'environment_unavailable';
  let termination: HostValidationObservation['termination'] = { kind: 'cancelled', reason: 'guarded_working_directory_unavailable' };
  let output = { value: '', truncated: false };
  let outputBytes = 0;
  let remediation: string | null = 'Restore the guarded story worktree and rerun the required validation.';
  let baselineEvidenceReferences: string[] = [];
  let policyTreatmentReference: string | null = null;
  let guardBinDir: string | null = null;

  try {
    const actualCwd = fs.realpathSync(cwd);
    const allowed = manifest.commandSafety.allowedWorkingDirectories.map((item) => fs.realpathSync(item));
    if (!allowed.includes(actualCwd)) throw new Error('guarded_working_directory_not_allowed');
    revisionBefore = gitValue(actualCwd, ['rev-parse', 'HEAD'], fallbackRevision);
    branch = gitValue(actualCwd, ['branch', '--show-current'], branch);
    const guard = createAutonomousCommandGuard({ cwd: actualCwd, env: baseEnv });
    guardBinDir = guard.guardBinDir;
    const result = spawnSync(requirement.command, [...requirement.args], {
      cwd: actualCwd,
      env: guard.env,
      encoding: 'utf8',
      timeout: requirement.timeoutMs,
      maxBuffer: HOST_VALIDATION_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    outputBytes = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
    output = redactedOutput(stdout, stderr);
    revisionAfter = gitValue(actualCwd, ['rev-parse', 'HEAD'], revisionBefore);

    if (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      classification = 'environment_unavailable';
      termination = { kind: 'timed_out', timeoutMs: requirement.timeoutMs };
      remediation = 'Increase the governed timeout or make the required validation bounded, then rerun it.';
    } else if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      classification = 'environment_unavailable';
      termination = { kind: 'cancelled', reason: 'command_unavailable' };
      remediation = `Install or configure ${requirement.command}, then rerun validation in the guarded worktree.`;
    } else if (result.status === 126 || output.value.includes('[Rorca autonomous command guard] Blocked')) {
      classification = 'blocked_by_policy';
      termination = { kind: 'exited', exitCode: result.status ?? 126 };
      remediation = 'Route backend tests to an isolated *_test database or choose a safe validation command; do not mark this check skipped.';
    } else if (result.signal) {
      classification = 'environment_unavailable';
      termination = { kind: 'signaled', signal: result.signal };
      remediation = 'Inspect the host termination reason and rerun the required validation.';
    } else {
      const exitCode = result.status ?? 1;
      termination = { kind: 'exited', exitCode };
      if (exitCode === 0) {
        classification = 'passed';
        remediation = null;
      } else if (options.classifyFailure) {
        const classified = options.classifyFailure({
          requirement,
          exitCode,
          output: output.value,
          revisionBefore,
          revisionAfter,
        });
        classification = classified.classification;
        baselineEvidenceReferences = classified.baselineEvidenceReferences ?? [];
        policyTreatmentReference = classified.policyTreatmentReference ?? null;
        remediation = classification === 'unrelated_baseline'
          ? 'Apply the named baseline policy treatment while preserving supporting host evidence.'
          : 'Fix the story-caused validation failure and rerun against the active revision.';
      } else {
        classification = 'story_caused_failure';
        remediation = 'Fix the story-caused validation failure and rerun against the active revision.';
      }
    }
  } catch (error) {
    output = redactedOutput('', error instanceof Error ? error.message : String(error));
    outputBytes = Buffer.byteLength(output.value);
  } finally {
    if (guardBinDir) fs.rmSync(guardBinDir, { recursive: true, force: true });
  }

  const finishedAt = now().toISOString();
  return createHostValidationObservation({
    observationId: observationId(manifest, requirement, startedAt),
    requirementId: requirement.id,
    observer: 'rorca_host',
    command: requirement.command,
    args: [...requirement.args],
    commandHash,
    guardedWorkingDirectory: cwd,
    environment,
    startedAt,
    finishedAt,
    termination,
    classification,
    output: {
      kind: 'validation_output',
      reference: options.outputReference ?? `host-validation:${manifest.identity.runId}:${manifest.identity.storyId}:${requirement.id}`,
      byteLength: outputBytes,
      sha256: deriveStoryContractRevision(output.value),
      redactedExcerpt: output.value || null,
      truncated: output.truncated,
    },
    subject: { commitSha: revisionAfter, worktreePath: cwd, branch },
    repositoryRevisionBefore: revisionBefore,
    repositoryRevisionAfter: revisionAfter,
    criterionIds: options.criterionIds ?? manifest.evidenceExpectations.map((item) => item.criterionId),
    baselineEvidenceReferences,
    policyTreatmentReference,
    remediation,
  });
}
