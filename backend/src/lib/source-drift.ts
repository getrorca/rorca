/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { UnprocessableError, ValidationError } from './errors';
import { resolveLocalFileSource } from './local-file-source-adapter';
import { RevisionRefV1Schema, type RevisionRefV1 } from './mission-contracts';
import { SourceBundleV1Schema, type SourceBundleV1, type SourceRefV1 } from './source-contracts';
import { compileSourceBundle, type CompileSourceBundleInput } from './source-compiler';

export const SOURCE_DRIFT_STATES = ['unchanged', 'changed', 'deleted', 'unavailable', 'unknown'] as const;
export type SourceDriftState = typeof SOURCE_DRIFT_STATES[number];

export interface SourceDriftItem {
  readonly sourceId: string;
  readonly kind: SourceRefV1['kind'];
  readonly locator: string;
  readonly state: SourceDriftState;
  readonly oldHash: string;
  readonly newHash: string | null;
  readonly detail: string;
}

export interface SourceDriftReport {
  readonly schemaVersion: 'rorca.source-drift-report.v1';
  readonly bundleId: string;
  readonly bundleHash: string;
  readonly contextState: 'fresh' | 'stale' | 'unavailable' | 'unknown';
  readonly stale: boolean;
  readonly checkedAt: string;
  readonly sources: readonly SourceDriftItem[];
}

export type SourceHashProbe = (source: SourceRefV1) => Promise<
  | { state: 'available'; contentHash: string }
  | { state: 'deleted'; detail?: string }
  | { state: 'unavailable'; detail?: string }
  | { state: 'unknown'; detail?: string }
>;

export interface InspectSourceDriftOptions {
  readonly workspaceRoot: string;
  readonly checkedAt?: string;
  readonly probes?: Partial<Record<SourceRefV1['kind'], SourceHashProbe>>;
}

async function probeLocalFile(workspaceRoot: string, source: SourceRefV1): ReturnType<SourceHashProbe> {
  let root: string;
  try {
    root = await realpath(workspaceRoot);
  } catch {
    return { state: 'unavailable', detail: 'Workspace root is unavailable.' };
  }
  try {
    await realpath(path.resolve(root, source.locator));
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    return code === 'ENOENT'
      ? { state: 'deleted', detail: 'Frozen local source no longer exists.' }
      : { state: 'unavailable', detail: 'Frozen local source could not be read.' };
  }
  try {
    const resolved = await resolveLocalFileSource(root, source.locator);
    return { state: 'available', contentHash: resolved.sourceRef.contentHash };
  } catch {
    return { state: 'unavailable', detail: 'Frozen local source could not be resolved safely.' };
  }
}

function reportState(items: readonly SourceDriftItem[]): Pick<SourceDriftReport, 'contextState' | 'stale'> {
  if (items.some(({ state }) => state === 'changed' || state === 'deleted')) return { contextState: 'stale', stale: true };
  if (items.some(({ state }) => state === 'unavailable')) return { contextState: 'unavailable', stale: false };
  if (items.some(({ state }) => state === 'unknown')) return { contextState: 'unknown', stale: false };
  return { contextState: 'fresh', stale: false };
}

/** Re-hash live sources while preserving the supplied frozen bundle byte-for-byte. */
export async function inspectSourceDrift(bundleInput: unknown, options: InspectSourceDriftOptions): Promise<SourceDriftReport> {
  const bundle = SourceBundleV1Schema.parse(bundleInput);
  const before = JSON.stringify(bundle);
  const sources = await Promise.all(bundle.includedSources.map(async (source): Promise<SourceDriftItem> => {
    const probe = options.probes?.[source.kind]
      ?? (source.kind === 'local_file' ? (candidate: SourceRefV1) => probeLocalFile(options.workspaceRoot, candidate) : undefined);
    if (!probe) return {
      sourceId: source.sourceId, kind: source.kind, locator: source.locator, state: 'unknown', oldHash: source.contentHash,
      newHash: null, detail: `No live ${source.kind} verifier is configured.`,
    };
    let observed: Awaited<ReturnType<SourceHashProbe>>;
    try { observed = await probe(source); }
    catch { observed = { state: 'unavailable', detail: 'The source verifier was unavailable.' }; }
    if (observed.state === 'available') {
      const state = observed.contentHash === source.contentHash ? 'unchanged' : 'changed';
      return { sourceId: source.sourceId, kind: source.kind, locator: source.locator, state,
        oldHash: source.contentHash, newHash: observed.contentHash,
        detail: state === 'unchanged' ? 'Live content matches the frozen hash.' : 'Live content differs from the frozen hash; frozen content was not replaced.' };
    }
    return { sourceId: source.sourceId, kind: source.kind, locator: source.locator, state: observed.state,
      oldHash: source.contentHash, newHash: null, detail: observed.detail ?? `Source state is ${observed.state}.` };
  }));
  if (JSON.stringify(bundle) !== before) throw new UnprocessableError('Drift inspection mutated the frozen source bundle', 'SOURCE_BUNDLE_MUTATED');
  return Object.freeze({ schemaVersion: 'rorca.source-drift-report.v1', bundleId: bundle.bundleId,
    bundleHash: bundle.bundleHash, ...reportState(sources), checkedAt: options.checkedAt ?? new Date().toISOString(),
    sources: Object.freeze(sources.map((source) => Object.freeze(source))) });
}

export interface RevisionBoundEvidence {
  readonly specRevision: RevisionRefV1;
  readonly sourceBundleHash: string;
  readonly assuranceCompilationReceiptHash: string;
}

export function assertEvidenceCurrent(evidence: RevisionBoundEvidence, current: RevisionBoundEvidence): void {
  const sameRevision = evidence.specRevision.kind === current.specRevision.kind && evidence.specRevision.value === current.specRevision.value;
  if (!sameRevision || evidence.sourceBundleHash !== current.sourceBundleHash
    || evidence.assuranceCompilationReceiptHash !== current.assuranceCompilationReceiptHash) {
    throw new UnprocessableError('Evidence is bound to a stale source/spec/assurance revision', 'STALE_EVIDENCE');
  }
}

export interface RecompileSourceRevisionInput {
  readonly previousBundle: SourceBundleV1;
  readonly drift: SourceDriftReport;
  readonly previousSpecRevision: RevisionRefV1;
  readonly nextSpecRevision: RevisionRefV1;
  readonly previousAssuranceCompilationReceiptHash: string;
  readonly compilation: CompileSourceBundleInput;
  readonly compileAssurance: (context: { bundle: SourceBundleV1; specRevision: RevisionRefV1 }) => Promise<{ compilationReceiptHash: string }> | { compilationReceiptHash: string };
}

/** Bounded recompilation emits new immutable identities and deliberately cannot approve the new revision. */
export async function recompileSourceRevision(input: RecompileSourceRevisionInput) {
  const previous = SourceBundleV1Schema.parse(input.previousBundle);
  if (input.drift.bundleId !== previous.bundleId || input.drift.bundleHash !== previous.bundleHash || !input.drift.stale) {
    throw new ValidationError('Recompilation requires a stale report for the exact frozen bundle');
  }
  const previousReceipt = z.string().regex(/^sha256:[0-9a-f]{64}$/).parse(input.previousAssuranceCompilationReceiptHash);
  const previousRevision = RevisionRefV1Schema.parse(input.previousSpecRevision);
  const nextRevision = RevisionRefV1Schema.parse(input.nextSpecRevision);
  if (previousRevision.kind === nextRevision.kind && previousRevision.value === nextRevision.value) {
    throw new ValidationError('Recompilation requires a new exact spec revision');
  }
  if (input.compilation.workspaceRef.workspaceId !== previous.workspaceRef.workspaceId
    || input.compilation.userIntent !== previous.userIntent) {
    throw new ValidationError('Recompilation cannot change Mission workspace or frozen user intent');
  }
  const compiled = await compileSourceBundle(input.compilation);
  if (compiled.bundle.bundleHash === previous.bundleHash) throw new ValidationError('Recompilation did not produce a new source bundle hash');
  const assurance = await input.compileAssurance({ bundle: compiled.bundle, specRevision: nextRevision });
  const receipt = z.string().regex(/^sha256:[0-9a-f]{64}$/).parse(assurance.compilationReceiptHash);
  if (receipt === previousReceipt) {
    throw new UnprocessableError('New revision reused the prior assurance compilation receipt', 'ASSURANCE_PROFILE_STALE');
  }
  return Object.freeze({
    schemaVersion: 'rorca.source-recompilation-receipt.v1' as const,
    previous: { bundleHash: previous.bundleHash, specRevision: previousRevision, assuranceCompilationReceiptHash: previousReceipt },
    current: { bundle: compiled.bundle, bundleHash: compiled.bundle.bundleHash, specRevision: nextRevision, assuranceCompilationReceiptHash: receipt },
    reviewState: 'pending_re_review' as const,
    executionAffected: false as const,
    priorProfileApplies: false as const,
  });
}
