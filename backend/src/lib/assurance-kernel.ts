/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Tool-agnostic verification kernel.
 *
 * This module deliberately returns an internal result, not lifecycle evidence and
 * not a gate decision. A caller-owned adapter executes concrete mechanisms and
 * translates this result at the canonical evidence boundary.
 */

import { createHash } from 'node:crypto';
import { GIT_SHA_PATTERN, type GitSha } from './git-sha';
import type { RevisionRefV1 } from './mission-contracts';

export const KERNEL_VERDICTS = ['pass', 'fail', 'blocked'] as const;
export type KernelVerdict = typeof KERNEL_VERDICTS[number];

export interface KernelSubjectIdentity {
  specId: string;
  specRevision: RevisionRefV1;
  commitSha: GitSha;
}

export interface MechanismExecution<TOutcome> {
  /** Identity observed by the mechanism at execution time. */
  subject: KernelSubjectIdentity;
  outcome: TOutcome;
}

export interface VerificationMechanism<TOutcome> {
  /** Immutable adapter-owned identity (for example, a compiled binding digest). */
  identity: string;
  execute(): Promise<MechanismExecution<TOutcome>>;
}

export interface KernelJudgment {
  verdict: KernelVerdict;
  /** A bounded action the caller can take; pass results state the next handoff. */
  gap: string;
}

export interface VerificationCriteria<TOutcome, TGovernedOverride = unknown> {
  judge(outcome: TOutcome, governedOverride: TGovernedOverride | undefined): KernelJudgment;
}

export interface KernelVerificationContract<TOutcome = unknown, TGovernedOverride = unknown>
  extends KernelSubjectIdentity {
  /** Canonical US-001 control ID; this kernel does not define another control shape. */
  controlId: string;
  mechanism: VerificationMechanism<TOutcome>;
  criteria: VerificationCriteria<TOutcome, TGovernedOverride>;
  /** Opaque governed input interpreted only by the contract's deterministic judge. */
  governedOverride?: TGovernedOverride;
}

export interface KernelVerificationOutcome<TOutcome = unknown> extends KernelSubjectIdentity {
  controlId: string;
  actor: string;
  verifiedAt: string;
  mechanismIdentity: string;
  outcomeDigest: `sha256:${string}`;
  verdict: KernelVerdict;
  gap: string;
  /** Internal mechanism result retained for the sole canonical evidence adapter. */
  mechanismOutcome: TOutcome | null;
}

export interface AssuranceKernelOptions {
  now?: () => Date;
}

const MAX_GAP_LENGTH = 4_096;

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

function assertContractIdentity(contract: KernelVerificationContract<unknown, unknown>, actor: string): void {
  requiredText(contract.controlId, 'controlId');
  requiredText(contract.specId, 'specId');
  requiredText(contract.specRevision?.kind, 'specRevision.kind');
  requiredText(contract.specRevision?.value, 'specRevision.value');
  requiredText(contract.mechanism?.identity, 'mechanism.identity');
  requiredText(actor, 'actor');
  if (!GIT_SHA_PATTERN.test(contract.commitSha)) {
    throw new TypeError('commitSha must be exactly 40 lowercase hexadecimal characters');
  }
  if (typeof contract.mechanism.execute !== 'function') throw new TypeError('mechanism.execute must be a function');
  if (typeof contract.criteria?.judge !== 'function') throw new TypeError('criteria.judge must be a function');
}

/** Capture binding-critical values before asynchronous mechanism execution can mutate caller-owned input. */
function snapshotContract<TOutcome, TGovernedOverride>(
  contract: KernelVerificationContract<TOutcome, TGovernedOverride>,
): KernelVerificationContract<TOutcome, TGovernedOverride> {
  return Object.freeze({
    ...contract,
    controlId: requiredText(contract.controlId, 'controlId'),
    specId: requiredText(contract.specId, 'specId'),
    // Revision values are identity data: validate them, but never normalize or rewrite them.
    specRevision: Object.freeze({ ...contract.specRevision }),
    mechanism: Object.freeze({
      identity: requiredText(contract.mechanism.identity, 'mechanism.identity'),
      execute: contract.mechanism.execute.bind(contract.mechanism),
    }),
    criteria: Object.freeze({
      judge: contract.criteria.judge.bind(contract.criteria),
    }),
  });
}

function isSubjectIdentity(value: unknown): value is KernelSubjectIdentity {
  if (!value || typeof value !== 'object') return false;
  const subject = value as Partial<KernelSubjectIdentity>;
  return typeof subject.specId === 'string'
    && subject.specId.trim() !== ''
    && typeof subject.specRevision?.kind === 'string'
    && subject.specRevision.kind.trim() !== ''
    && typeof subject.specRevision.value === 'string'
    && subject.specRevision.value.trim() !== ''
    && typeof subject.commitSha === 'string'
    && GIT_SHA_PATTERN.test(subject.commitSha);
}

function sameSubject(expected: KernelSubjectIdentity, observed: KernelSubjectIdentity): boolean {
  return expected.specId === observed.specId
    && expected.specRevision.kind === observed.specRevision.kind
    && expected.specRevision.value === observed.specRevision.value
    && expected.commitSha === observed.commitSha;
}

function staleGap(expected: KernelSubjectIdentity, observed: KernelSubjectIdentity): string {
  const differences: string[] = [];
  if (expected.specId !== observed.specId) differences.push(`specId expected ${expected.specId}, observed ${observed.specId}`);
  if (expected.specRevision.kind !== observed.specRevision.kind
    || expected.specRevision.value !== observed.specRevision.value) {
    differences.push(
      `specRevision expected ${expected.specRevision.kind}:${expected.specRevision.value}, `
      + `observed ${observed.specRevision.kind}:${observed.specRevision.value}`,
    );
  }
  if (expected.commitSha !== observed.commitSha) {
    differences.push(`commitSha expected ${expected.commitSha}, observed ${observed.commitSha}`);
  }
  return `Re-run the mechanism against the contract's exact subject identity; stale execution identity: ${differences.join('; ')}.`;
}

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('mechanism outcome contains a non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') return JSON.stringify({ $bigint: value.toString() });
  if (typeof value === 'undefined') return JSON.stringify({ $undefined: true });
  if (typeof value !== 'object') throw new TypeError(`mechanism outcome contains unsupported ${typeof value} data`);
  if (seen.has(value)) throw new TypeError('mechanism outcome must not contain cycles');
  seen.add(value);
  try {
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) throw new TypeError('mechanism outcome contains an invalid date');
      return JSON.stringify({ $date: value.toISOString() });
    }
    if (Buffer.isBuffer(value)) return JSON.stringify({ $bytes: value.toString('base64') });
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function normalizeJudgment(judgment: KernelJudgment): KernelJudgment {
  if (!judgment || !KERNEL_VERDICTS.includes(judgment.verdict)) {
    throw new TypeError(`judge verdict must be one of: ${KERNEL_VERDICTS.join(', ')}`);
  }
  const gap = requiredText(judgment.gap, 'judgment.gap');
  if (gap.length > MAX_GAP_LENGTH) throw new TypeError(`judgment.gap must not exceed ${MAX_GAP_LENGTH} characters`);
  return { verdict: judgment.verdict, gap };
}

/** Execute a mechanism without interpreting its kind, locator, tool, or methodology. */
export async function execute<TOutcome>(mechanism: VerificationMechanism<TOutcome>): Promise<MechanismExecution<TOutcome>> {
  return mechanism.execute();
}

/** Apply only contract-owned deterministic criteria; override semantics remain caller-owned. */
export function judge<TOutcome, TGovernedOverride>(
  outcome: TOutcome,
  criteria: VerificationCriteria<TOutcome, TGovernedOverride>,
  governedOverride?: TGovernedOverride,
): KernelJudgment {
  return normalizeJudgment(criteria.judge(outcome, governedOverride));
}

/** Bind an internal result. This function has no lifecycle-evidence or gate fields. */
export function bind<TOutcome, TGovernedOverride>(
  contract: KernelVerificationContract<TOutcome, TGovernedOverride>,
  execution: MechanismExecution<TOutcome> | null,
  judgment: KernelJudgment,
  actor: string,
  now: Date,
  digestInput: unknown = execution?.outcome,
): KernelVerificationOutcome<TOutcome> {
  if (Number.isNaN(now.getTime())) throw new TypeError('now must return a valid Date');
  const normalizedJudgment = normalizeJudgment(judgment);
  return Object.freeze({
    controlId: requiredText(contract.controlId, 'controlId'),
    specId: requiredText(contract.specId, 'specId'),
    specRevision: Object.freeze({ ...contract.specRevision }),
    commitSha: contract.commitSha,
    actor: requiredText(actor, 'actor'),
    verifiedAt: now.toISOString(),
    mechanismIdentity: requiredText(contract.mechanism.identity, 'mechanism.identity'),
    outcomeDigest: digest(digestInput),
    verdict: normalizedJudgment.verdict,
    gap: normalizedJudgment.gap,
    mechanismOutcome: execution?.outcome ?? null,
  });
}

export function createAssuranceKernel(options: AssuranceKernelOptions = {}): {
  verify<TOutcome, TGovernedOverride>(
    contract: KernelVerificationContract<TOutcome, TGovernedOverride>,
    actor: string,
  ): Promise<KernelVerificationOutcome<TOutcome>>;
} {
  const now = options.now ?? (() => new Date());
  return {
    async verify<TOutcome, TGovernedOverride>(
      contract: KernelVerificationContract<TOutcome, TGovernedOverride>,
      actor: string,
    ): Promise<KernelVerificationOutcome<TOutcome>> {
      assertContractIdentity(
        contract as KernelVerificationContract<unknown, unknown>,
        actor,
      );
      const contractSnapshot = snapshotContract(contract);

      let execution: MechanismExecution<TOutcome>;
      try {
        execution = await execute(contractSnapshot.mechanism);
      } catch (error) {
        const errorName = error instanceof Error ? error.name : 'UnknownExecutionError';
        return bind(
          contractSnapshot,
          null,
          { verdict: 'blocked', gap: `Restore the verification mechanism and retry execution (${errorName}).` },
          actor,
          now(),
          { blocked: 'execution-error', errorName },
        );
      }

      if (!execution || !isSubjectIdentity(execution.subject) || !sameSubject(contractSnapshot, execution.subject)) {
        const gap = execution && isSubjectIdentity(execution.subject)
          ? staleGap(contractSnapshot, execution.subject)
          : "Re-run the mechanism with a valid observed spec revision and commit identity; execution returned no valid subject identity.";
        return bind(
          contractSnapshot,
          execution ?? null,
          { verdict: 'blocked', gap },
          actor,
          now(),
          execution ?? { blocked: 'missing-subject' },
        );
      }

      let judgment: KernelJudgment;
      try {
        judgment = judge(
          execution.outcome,
          contractSnapshot.criteria,
          contractSnapshot.governedOverride,
        );
      } catch (error) {
        const errorName = error instanceof Error ? error.name : 'UnknownJudgmentError';
        judgment = {
          verdict: 'blocked',
          gap: `Correct the verification criteria or governed input and retry judgment (${errorName}).`,
        };
      }
      return bind(contractSnapshot, execution, judgment, actor, now());
    },
  };
}

const defaultKernel = createAssuranceKernel();

/** Default kernel entrypoint: execute -> judge -> bind. */
export async function verify<TOutcome, TGovernedOverride = unknown>(
  contract: KernelVerificationContract<TOutcome, TGovernedOverride>,
  actor: string,
): Promise<KernelVerificationOutcome<TOutcome>> {
  return defaultKernel.verify(contract, actor);
}
