/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  createCanonicalEvidence,
  type CanonicalLifecycleEvidence,
  type EvidenceClassification,
  type EvidenceReleaseIdentity,
  type EvidenceScope,
  type EvidenceSourceType,
  type EvidenceSubjectType,
} from '../lib/ssdlc-evidence';

export interface ExecutableMechanism {
  executable: string;
  args: readonly string[];
  cwd: string;
}

export interface TruncationRecord {
  field: 'stdout' | 'stderr' | 'artifactManifest';
  truncated: boolean;
  capturedBytes: number;
  omittedBytes: number;
  originalBytes: number;
}

export interface BoundedCommandCapture {
  executable: string;
  args: readonly string[];
  exitCode: number;
  /** Digest of every stdout/stderr byte, including bytes omitted from the bounded text fields. */
  outputDigest: `sha256:${string}`;
  stdout: string;
  stderr: string;
  truncation: readonly TruncationRecord[];
}

export interface TestSummary {
  framework: 'jest' | 'vitest' | 'pytest';
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface RequirementCoverage {
  required: readonly string[];
  covered: readonly string[];
  missing: readonly string[];
}

export interface TestResultOutcome {
  adapter: 'test_result';
  command: BoundedCommandCapture;
  testSummary: TestSummary;
  requirementCoverage: RequirementCoverage;
  passed: boolean;
  summary: string;
}

export interface ArtifactDigestOutcome {
  adapter: 'artifact_digest';
  command: BoundedCommandCapture;
  artifactDigest: `sha256:${string}` | null;
  files: readonly { path: string; bytes: number; digest: `sha256:${string}` }[];
  missingOutputPaths: readonly string[];
  manifestTruncation: TruncationRecord;
  passed: boolean;
  summary: string;
}

export interface DeploymentReceiptOutcome {
  adapter: 'deployment_receipt';
  command: BoundedCommandCapture;
  deploymentId: string | null;
  commitSha: string | null;
  artifactDigest: string | null;
  environment: string | null;
  passed: boolean;
  summary: string;
}

export type ArtifactAdapterOutcome = TestResultOutcome | ArtifactDigestOutcome | DeploymentReceiptOutcome;

export interface CanonicalAdapterMapping {
  classification: EvidenceClassification;
  sourceType: EvidenceSourceType;
  subjectType: EvidenceSubjectType;
  requiredSubjectBinding: 'commitSha' | 'artifactDigest' | 'deploymentId';
  requiredReleaseBindings: readonly (keyof EvidenceReleaseIdentity)[];
}

/** AAV-006 mappings reuse the lifecycle taxonomy; adapter labels are not evidence kinds. */
export const CANONICAL_ADAPTER_MAPPINGS = Object.freeze({
  test_result: Object.freeze({
    classification: 'testing', sourceType: 'wal_validation', subjectType: 'commit_sha',
    requiredSubjectBinding: 'commitSha', requiredReleaseBindings: Object.freeze(['commitSha'] as const),
  }),
  artifact_digest: Object.freeze({
    classification: 'deployment', sourceType: 'staging_result', subjectType: 'artifact_digest',
    requiredSubjectBinding: 'artifactDigest', requiredReleaseBindings: Object.freeze(['commitSha', 'artifactDigest'] as const),
  }),
  deployment_receipt: Object.freeze({
    classification: 'deployment', sourceType: 'deployment_proof', subjectType: 'deployment_id',
    requiredSubjectBinding: 'deploymentId', requiredReleaseBindings: Object.freeze(['commitSha', 'artifactDigest', 'deploymentId'] as const),
  }),
} satisfies Record<ArtifactAdapterOutcome['adapter'], CanonicalAdapterMapping>);

const DEFAULT_CAPTURE_BYTES = 64 * 1024;
const DEFAULT_MANIFEST_FILES = 256;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

function validateMechanism(mechanism: ExecutableMechanism): void {
  requiredText(mechanism.executable, 'mechanism.executable');
  requiredText(mechanism.cwd, 'mechanism.cwd');
  if (!Array.isArray(mechanism.args) || mechanism.args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('mechanism.args must be a string array');
  }
}

interface CaptureAccumulator { chunks: Buffer[]; capturedBytes: number; originalBytes: number }

function appendCapture(target: CaptureAccumulator, chunk: Buffer, maximum: number): void {
  target.originalBytes += chunk.length;
  const remaining = maximum - target.capturedBytes;
  if (remaining > 0) {
    const captured = chunk.subarray(0, remaining);
    target.chunks.push(captured);
    target.capturedBytes += captured.length;
  }
}

function truncation(field: TruncationRecord['field'], capture: CaptureAccumulator): TruncationRecord {
  return Object.freeze({
    field,
    truncated: capture.originalBytes > capture.capturedBytes,
    capturedBytes: capture.capturedBytes,
    omittedBytes: capture.originalBytes - capture.capturedBytes,
    originalBytes: capture.originalBytes,
  });
}

export async function executeBounded(
  mechanism: ExecutableMechanism,
  maximumBytes = DEFAULT_CAPTURE_BYTES,
): Promise<BoundedCommandCapture> {
  validateMechanism(mechanism);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new TypeError('maximumBytes must be a positive integer');
  const stdout: CaptureAccumulator = { chunks: [], capturedBytes: 0, originalBytes: 0 };
  const stderr: CaptureAccumulator = { chunks: [], capturedBytes: 0, originalBytes: 0 };
  const stdoutDigest = createHash('sha256');
  const stderrDigest = createHash('sha256');
  const exitCode = await new Promise<number>((resolve, reject) => {
    // Deliberately no shell option: executable and args are passed directly to the OS.
    const child = spawn(mechanism.executable, [...mechanism.args], {
      cwd: mechanism.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (value: Buffer) => { stdoutDigest.update(value); appendCapture(stdout, value, maximumBytes); });
    child.stderr.on('data', (value: Buffer) => { stderrDigest.update(value); appendCapture(stderr, value, maximumBytes); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
  return Object.freeze({
    executable: mechanism.executable,
    args: Object.freeze([...mechanism.args]),
    exitCode,
    outputDigest: `sha256:${createHash('sha256')
      .update(JSON.stringify({ stdout: stdoutDigest.digest('hex'), stderr: stderrDigest.digest('hex') }))
      .digest('hex')}`,
    stdout: Buffer.concat(stdout.chunks).toString('utf8'),
    stderr: Buffer.concat(stderr.chunks).toString('utf8'),
    truncation: Object.freeze([truncation('stdout', stdout), truncation('stderr', stderr)]),
  });
}

function nonNegative(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${field} must be a non-negative integer`);
  return Number(value);
}

function inferJsonTestFramework(mechanism: ExecutableMechanism): 'jest' | 'vitest' {
  const invocation = [path.basename(mechanism.executable), ...mechanism.args].join(' ').toLowerCase();
  return /(?:^|[^a-z0-9])vitest(?:[^a-z0-9]|$)/.test(invocation) ? 'vitest' : 'jest';
}

function parseJsonTestSummary(
  value: unknown,
  frameworkHint: 'jest' | 'vitest',
): { summary: TestSummary; names: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('test output must be a JSON object');
  const record = value as Record<string, unknown>;
  const framework: TestSummary['framework'] = typeof record.vitestVersion === 'string' ? 'vitest' : frameworkHint;
  const names: string[] = [];
  if (Array.isArray(record.testResults)) {
    for (const suite of record.testResults) {
      if (!suite || typeof suite !== 'object') continue;
      const assertions = (suite as Record<string, unknown>).assertionResults;
      if (!Array.isArray(assertions)) continue;
      for (const assertion of assertions) {
        if (!assertion || typeof assertion !== 'object') continue;
        const item = assertion as Record<string, unknown>;
        const name = typeof item.fullName === 'string' ? item.fullName : item.title;
        if (typeof name === 'string') names.push(name);
      }
    }
  }
  return {
    summary: {
      framework,
      total: nonNegative(record.numTotalTests, 'numTotalTests'),
      passed: nonNegative(record.numPassedTests, 'numPassedTests'),
      failed: nonNegative(record.numFailedTests, 'numFailedTests'),
      skipped: nonNegative(record.numPendingTests ?? 0, 'numPendingTests')
        + nonNegative(record.numTodoTests ?? 0, 'numTodoTests'),
    },
    names,
  };
}

function parseTestOutput(output: string, mechanism: ExecutableMechanism): { summary: TestSummary; names: string[] } {
  try {
    return parseJsonTestSummary(JSON.parse(output), inferJsonTestFramework(mechanism));
  } catch (error) {
    const counts = { passed: 0, failed: 0, skipped: 0 };
    let matched = false;
    for (const match of output.matchAll(/(\d+)\s+(passed|failed|skipped|xfailed|xpassed)/gi)) {
      matched = true;
      const key = match[2].toLowerCase();
      if (key === 'passed' || key === 'xpassed') counts.passed += Number(match[1]);
      else if (key === 'failed') counts.failed += Number(match[1]);
      else counts.skipped += Number(match[1]);
    }
    if (!matched) throw new TypeError(`unsupported Jest, Vitest, or Pytest output (${error instanceof Error ? error.name : 'parse error'})`);
    return { summary: { framework: 'pytest', total: counts.passed + counts.failed + counts.skipped, ...counts }, names: output.split('\n') };
  }
}

function coverage(names: readonly string[], required: readonly string[]): RequirementCoverage {
  const uniqueRequired = [...new Set(required.map((item) => requiredText(item, 'requiredRequirementIds[]')))].sort();
  const joined = names.join('\n');
  const covered = uniqueRequired.filter((requirement) => joined.includes(requirement));
  return Object.freeze({
    required: Object.freeze(uniqueRequired),
    covered: Object.freeze(covered),
    missing: Object.freeze(uniqueRequired.filter((requirement) => !covered.includes(requirement))),
  });
}

export async function runTestResultAdapter(input: {
  mechanism: ExecutableMechanism;
  requiredRequirementIds?: readonly string[];
  maximumCaptureBytes?: number;
}): Promise<TestResultOutcome> {
  const command = await executeBounded(input.mechanism, input.maximumCaptureBytes);
  const parsed = parseTestOutput(command.stdout, input.mechanism);
  const requirementCoverage = coverage(parsed.names, input.requiredRequirementIds ?? []);
  const passed = command.exitCode === 0 && parsed.summary.failed === 0 && requirementCoverage.missing.length === 0;
  return Object.freeze({
    adapter: 'test_result', command, testSummary: Object.freeze(parsed.summary), requirementCoverage, passed,
    summary: `${parsed.summary.framework}: ${parsed.summary.passed}/${parsed.summary.total} passed; ${requirementCoverage.covered.length}/${requirementCoverage.required.length} requirements covered`,
  });
}

async function collectFiles(root: string, target: string): Promise<string[]> {
  const metadata = await stat(target);
  if (metadata.isFile()) return [target];
  if (!metadata.isDirectory()) throw new TypeError(`artifact output is not a regular file or directory: ${target}`);
  const files: string[] = [];
  for (const entry of (await readdir(target)).sort()) files.push(...await collectFiles(root, path.join(target, entry)));
  return files;
}

export async function runArtifactDigestAdapter(input: {
  mechanism: ExecutableMechanism;
  outputPaths: readonly string[];
  maximumCaptureBytes?: number;
  maximumManifestFiles?: number;
}): Promise<ArtifactDigestOutcome> {
  if (!Array.isArray(input.outputPaths) || input.outputPaths.length === 0) throw new TypeError('outputPaths must not be empty');
  const command = await executeBounded(input.mechanism, input.maximumCaptureBytes);
  const root = path.resolve(input.mechanism.cwd);
  const allFiles: string[] = [];
  const missingOutputPaths: string[] = [];
  for (const output of [...input.outputPaths].sort()) {
    const configuredPath = requiredText(output, 'outputPaths[]');
    const resolved = path.resolve(root, configuredPath);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new TypeError('artifact output must stay within mechanism.cwd');
    try {
      allFiles.push(...await collectFiles(root, resolved));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missingOutputPaths.push(configuredPath);
    }
  }
  const uniqueFiles = [...new Set(allFiles)].sort();
  const digest = createHash('sha256');
  const manifest = [] as { path: string; bytes: number; digest: `sha256:${string}` }[];
  for (const file of uniqueFiles) {
    const content = await readFile(file);
    const relative = path.relative(root, file).split(path.sep).join('/');
    const fileDigest = `sha256:${createHash('sha256').update(content).digest('hex')}` as const;
    digest.update(`${relative}\0${content.length}\0${fileDigest}\n`);
    manifest.push({ path: relative, bytes: content.length, digest: fileDigest });
  }
  const maximumFiles = input.maximumManifestFiles ?? DEFAULT_MANIFEST_FILES;
  if (!Number.isSafeInteger(maximumFiles) || maximumFiles < 1) throw new TypeError('maximumManifestFiles must be a positive integer');
  const capturedFiles = manifest.slice(0, maximumFiles);
  const manifestTruncation = Object.freeze({
    field: 'artifactManifest' as const,
    truncated: manifest.length > capturedFiles.length,
    capturedBytes: capturedFiles.length,
    omittedBytes: manifest.length - capturedFiles.length,
    originalBytes: manifest.length,
  });
  const passed = command.exitCode === 0 && uniqueFiles.length > 0 && missingOutputPaths.length === 0;
  return Object.freeze({
    adapter: 'artifact_digest', command,
    artifactDigest: uniqueFiles.length > 0 ? `sha256:${digest.digest('hex')}` : null,
    files: Object.freeze(capturedFiles.map((file) => Object.freeze(file))),
    missingOutputPaths: Object.freeze(missingOutputPaths), manifestTruncation, passed,
    summary: `${uniqueFiles.length} build artifact(s) captured${passed ? '' : `; ${command.exitCode === 0 ? 'configured output missing' : 'build command failed'}`}`,
  });
}

function optionalReceiptText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export async function runDeploymentReceiptAdapter(input: {
  mechanism: ExecutableMechanism;
  expected: { commitSha: string; artifactDigest: string; deploymentId?: string };
  maximumCaptureBytes?: number;
}): Promise<DeploymentReceiptOutcome> {
  const command = await executeBounded(input.mechanism, input.maximumCaptureBytes);
  let receipt: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(command.stdout);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) receipt = parsed as Record<string, unknown>;
  } catch {
    // A malformed or truncated receipt deterministically fails below without copying provider output.
  }
  const deploymentId = optionalReceiptText(receipt.deploymentId);
  const commitSha = optionalReceiptText(receipt.commitSha);
  const artifactDigest = optionalReceiptText(receipt.artifactDigest);
  const environment = optionalReceiptText(receipt.environment);
  const identitiesValid = COMMIT_SHA.test(input.expected.commitSha) && SHA256.test(input.expected.artifactDigest);
  const passed = identitiesValid && command.exitCode === 0
    && deploymentId !== null
    && commitSha === input.expected.commitSha
    && artifactDigest === input.expected.artifactDigest
    && (!input.expected.deploymentId || deploymentId === input.expected.deploymentId);
  return Object.freeze({
    adapter: 'deployment_receipt', command, deploymentId, commitSha, artifactDigest, environment, passed,
    summary: passed ? `deployment ${deploymentId} receipt verified` : 'deployment receipt missing or does not match the required release identity',
  });
}

export function mapAdapterOutcomeToCanonicalEvidence(input: {
  outcome: ArtifactAdapterOutcome;
  scope: EvidenceScope;
  observedAt: Date | string;
  sourceSystem: string;
  releaseIdentity: EvidenceReleaseIdentity;
}): CanonicalLifecycleEvidence {
  const mapping = CANONICAL_ADAPTER_MAPPINGS[input.outcome.adapter];
  for (const field of mapping.requiredReleaseBindings) {
    if (!input.releaseIdentity[field]) throw new TypeError(`${input.outcome.adapter} mapping requires releaseIdentity.${field}`);
  }
  const subjectValue = input.releaseIdentity[mapping.requiredSubjectBinding];
  if (!subjectValue) throw new TypeError(`${input.outcome.adapter} mapping requires subject binding ${mapping.requiredSubjectBinding}`);
  if (input.outcome.adapter === 'artifact_digest'
    && input.outcome.artifactDigest !== null
    && input.outcome.artifactDigest !== subjectValue) {
    throw new TypeError('artifact outcome digest must match releaseIdentity.artifactDigest');
  }
  if (input.outcome.adapter === 'deployment_receipt'
    && input.outcome.deploymentId !== null
    && input.outcome.deploymentId !== subjectValue) {
    throw new TypeError('deployment receipt must match releaseIdentity.deploymentId');
  }
  const outcomeHash = createHash('sha256').update(JSON.stringify(input.outcome)).digest('hex');
  return createCanonicalEvidence({
    sourceType: mapping.sourceType,
    sourceSystem: requiredText(input.sourceSystem, 'sourceSystem'),
    sourceEventId: `${input.outcome.adapter}:${outcomeHash}`,
    observedAt: input.observedAt,
    scope: input.scope,
    subject: { type: mapping.subjectType, value: subjectValue },
    releaseIdentity: input.releaseIdentity,
    classification: mapping.classification,
    status: input.outcome.passed ? 'passed' : 'story_caused_failure',
    trustLevel: 'host_observed',
    confidence: 1,
    excerpt: input.outcome.summary,
    rawReference: `adapter-capture:${input.outcome.adapter}:${outcomeHash}`,
    provenanceChain: [{
      system: 'rorca:evidence-artifact-adapters', eventId: outcomeHash,
      observedAt: new Date(input.observedAt).toISOString(), verification: 'direct-executable-args-capture',
    }],
    details: {
      adapter: input.outcome.adapter,
      command: { executable: input.outcome.command.executable, args: input.outcome.command.args, exitCode: input.outcome.command.exitCode },
      truncation: input.outcome.command.truncation,
      ...(input.outcome.adapter === 'test_result' ? { testSummary: input.outcome.testSummary, requirementCoverage: input.outcome.requirementCoverage } : {}),
      ...(input.outcome.adapter === 'artifact_digest' ? {
        artifactDigest: input.outcome.artifactDigest,
        files: input.outcome.files,
        missingOutputPaths: input.outcome.missingOutputPaths,
        manifestTruncation: input.outcome.manifestTruncation,
      } : {}),
      ...(input.outcome.adapter === 'deployment_receipt' ? { deploymentId: input.outcome.deploymentId, environment: input.outcome.environment } : {}),
    },
  });
}
