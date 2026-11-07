/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const PUBLIC_REJECTION_REASON_BYTES = 1_024;
export const PUBLIC_REJECTION_STACK_BYTES = 4_096;
export const LOCAL_REJECTION_DIAGNOSTIC_BYTES = 32_768;

const SECRET_ASSIGNMENT = /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY)[A-Z0-9_]*)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const JSON_SECRET_ASSIGNMENT = /"([^"]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY)[^"]*)"\s*:\s*(?:"(?:\\.|[^"])*"|[^,}\s]+)/gi;
const BEARER_SECRET = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const WINDOWS_PATH = /\b[A-Za-z]:\\(?:[^\s<>:"|?*]+\\)*[^\s<>:"|?*]*/g;
const POSIX_PATH = /(^|[\s('"`])\/(?:[^\s)'"`:]+\/?)+/gm;
const SAFE_STORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type RejectionKind = 'error' | 'string' | 'object' | 'primitive' | 'serialization_failure';

export interface PortableRejectionEvidence {
  schemaVersion: 1;
  storyId: string;
  kind: RejectionKind;
  reason: string;
  stack: string;
  reasonTruncated: boolean;
  stackTruncated: boolean;
  portable: true;
}

export interface CompiledDependencyStory {
  id: unknown;
  dependsOn?: unknown;
}

export type RejectionEvidenceChannel = 'specState' | 'runState' | 'wal' | 'storyResult' | 'localDiagnostics';

export interface RejectedStoryProjection {
  storyId: string;
  evidence: PortableRejectionEvidence;
  blockedBy: Readonly<Record<string, readonly string[]>>;
  semanticStatus: 'failed';
}

export type RejectionProjectors = Record<
  RejectionEvidenceChannel,
  (projection: Readonly<RejectedStoryProjection>) => void | Promise<void>
>;

export interface RejectedWaveAccounting {
  failed: Set<string>;
  rejected: Set<string>;
  processed: Set<string>;
  dispatchClosed: boolean;
  accountingOrder: string[];
}

export interface RejectedStoryCloseoutResult extends RejectedStoryProjection {
  evidenceGap: boolean;
  failedChannels: RejectionEvidenceChannel[];
  channelAttempts: RejectionEvidenceChannel[];
}

function utf8Bound(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return { value, truncated: false };
  let output = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maximumBytes) break;
    output += character;
    bytes += characterBytes;
  }
  return { value: output, truncated: true };
}

function redactPortable(value: string): string {
  return value
    .replace(BEARER_SECRET, 'Bearer [REDACTED_SECRET]')
    .replace(JSON_SECRET_ASSIGNMENT, '"$1":"[REDACTED_SECRET]"')
    .replace(SECRET_ASSIGNMENT, '$1=[REDACTED_SECRET]')
    .replace(WINDOWS_PATH, '[REDACTED_PATH]')
    .replace(POSIX_PATH, (_match, prefix: string) => `${prefix}[REDACTED_PATH]`);
}

function rejectionStrings(rejection: unknown): { kind: RejectionKind; reason: string; stack: string } {
  if (rejection instanceof Error) {
    return {
      kind: 'error',
      reason: rejection.message || rejection.name || 'Error',
      stack: rejection.stack || `${rejection.name}: ${rejection.message}`,
    };
  }
  if (typeof rejection === 'string') return { kind: 'string', reason: rejection, stack: rejection };
  if (rejection !== null && typeof rejection === 'object') {
    try {
      const serialized = JSON.stringify(rejection);
      if (serialized === undefined) throw new TypeError('serialization produced undefined');
      return { kind: 'object', reason: serialized, stack: serialized };
    } catch {
      return {
        kind: 'serialization_failure',
        reason: 'Rejected with a non-serializable value',
        stack: 'Rejection serialization failed; inspect the local non-portable diagnostic',
      };
    }
  }
  try {
    const rendered = String(rejection);
    return { kind: 'primitive', reason: rendered, stack: rendered };
  } catch {
    return {
      kind: 'serialization_failure',
      reason: 'Rejected with an unrenderable value',
      stack: 'Rejection rendering failed; inspect the local non-portable diagnostic',
    };
  }
}

/** Build the only rejection representation safe to return through APIs or WAL. */
export function normalizeRejectedStoryEvidence(storyId: string, rejection: unknown): PortableRejectionEvidence {
  if (!SAFE_STORY_ID.test(storyId)) throw new Error('[wave-rejection] storyId is invalid');
  const rendered = rejectionStrings(rejection);
  const reason = utf8Bound(redactPortable(rendered.reason), PUBLIC_REJECTION_REASON_BYTES);
  const stack = utf8Bound(redactPortable(rendered.stack), PUBLIC_REJECTION_STACK_BYTES);
  return {
    schemaVersion: 1,
    storyId,
    kind: rendered.kind,
    reason: reason.value,
    stack: stack.value,
    reasonTruncated: reason.truncated,
    stackTruncated: stack.truncated,
    portable: true,
  };
}

/** Revalidate a stored projection at the API read boundary. */
export function sanitizeStoredRejectedStoryEvidence(storyId: string, value: unknown): PortableRejectionEvidence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<PortableRejectionEvidence>;
  const kinds: RejectionKind[] = ['error', 'string', 'object', 'primitive', 'serialization_failure'];
  if (candidate.schemaVersion !== 1 || candidate.portable !== true || candidate.storyId !== storyId
    || !candidate.kind || !kinds.includes(candidate.kind)
    || typeof candidate.reason !== 'string' || typeof candidate.stack !== 'string') return null;
  const reason = utf8Bound(redactPortable(candidate.reason), PUBLIC_REJECTION_REASON_BYTES);
  const stack = utf8Bound(redactPortable(candidate.stack), PUBLIC_REJECTION_STACK_BYTES);
  return {
    schemaVersion: 1,
    storyId,
    kind: candidate.kind,
    reason: reason.value,
    stack: stack.value,
    reasonTruncated: candidate.reasonTruncated === true || reason.truncated,
    stackTruncated: candidate.stackTruncated === true || stack.truncated,
    portable: true,
  };
}

function rawRejection(rejection: unknown): string {
  if (rejection instanceof Error) {
    return JSON.stringify({ name: rejection.name, message: rejection.message, stack: rejection.stack ?? null });
  }
  try {
    const seen = new WeakSet<object>();
    const serialized = JSON.stringify(rejection, (_key, value: unknown) => {
      if (value && typeof value === 'object') {
        if (seen.has(value as object)) return '[Circular]';
        seen.add(value as object);
      }
      return value;
    });
    return serialized ?? String(rejection);
  } catch {
    try { return String(rejection); } catch { return '[unrenderable rejection]'; }
  }
}

/**
 * Persist bounded local debugging detail. This artifact intentionally retains
 * host-local values and is explicitly not portable or API-safe.
 */
export function writeLocalRejectedStoryDiagnostic(filePath: string, storyId: string, rejection: unknown): { path: string; bytes: number } {
  if (!SAFE_STORY_ID.test(storyId)) throw new Error('[wave-rejection] storyId is invalid');
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  if (fs.existsSync(resolved)) {
    const existing = fs.lstatSync(resolved);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
      throw new Error('[wave-rejection] local diagnostic target is unsafe');
    }
  }
  const warning = 'NON-PORTABLE LOCAL DIAGNOSTIC: may contain secrets and absolute host paths; never return through an API or copy to WAL.';
  const fixed = { schemaVersion: 1, storyId, portable: false, warning } as const;
  const envelopeOverhead = Buffer.byteLength(`${JSON.stringify({ ...fixed, raw: '', truncated: false })}\n`, 'utf8');
  const boundedRaw = utf8Bound(rawRejection(rejection), Math.max(0, LOCAL_REJECTION_DIAGNOSTIC_BYTES - envelopeOverhead));
  const body = `${JSON.stringify({ ...fixed, raw: boundedRaw.value, truncated: boundedRaw.truncated })}\n`;
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(resolved, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollow, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, body, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { path: resolved, bytes: Buffer.byteLength(body, 'utf8') };
}

/**
 * Return canonical direct/transitive dependents and their rejected roots.
 * Unknown/malformed IDs and edges are ignored; visited/root sets guarantee
 * termination even when defensive input contains cycles.
 */
export function computeBlockedDependencyClosure(
  compiledStories: readonly CompiledDependencyStory[],
  rejectedStoryIds: readonly string[],
): Record<string, string[]> {
  const canonicalIds = new Set<string>();
  for (const story of compiledStories) {
    if (typeof story.id === 'string' && SAFE_STORY_ID.test(story.id)) canonicalIds.add(story.id);
  }
  const reverse = new Map<string, Set<string>>([...canonicalIds].map(id => [id, new Set<string>()]));
  for (const story of compiledStories) {
    if (typeof story.id !== 'string' || !canonicalIds.has(story.id) || !Array.isArray(story.dependsOn)) continue;
    for (const dependency of story.dependsOn) {
      if (typeof dependency === 'string' && canonicalIds.has(dependency) && dependency !== story.id) {
        reverse.get(dependency)!.add(story.id);
      }
    }
  }

  const blocked = new Map<string, Set<string>>();
  const roots = [...new Set(rejectedStoryIds.filter(id => canonicalIds.has(id)))].sort();
  for (const root of roots) {
    const visited = new Set<string>([root]);
    const queue = [...(reverse.get(root) ?? [])];
    while (queue.length > 0) {
      const storyId = queue.shift()!;
      if (visited.has(storyId)) continue;
      visited.add(storyId);
      if (!roots.includes(storyId)) {
        const blockers = blocked.get(storyId) ?? new Set<string>();
        blockers.add(root);
        blocked.set(storyId, blockers);
      }
      for (const dependent of reverse.get(storyId) ?? []) queue.push(dependent);
    }
  }
  return Object.fromEntries([...blocked]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, blockers]) => [id, [...blockers].sort()]));
}

export function createRejectedWaveAccounting(): RejectedWaveAccounting {
  return { failed: new Set(), rejected: new Set(), processed: new Set(), dispatchClosed: false, accountingOrder: [] };
}

/**
 * Durably-oriented closeout ordering. In-memory accounting and the dispatch
 * fence are established before dependency analysis or any fallible projection.
 * Every channel is attempted; one failed channel makes evidenceGap true.
 */
export async function closeoutRejectedStory(input: {
  storyId: string;
  rejection: unknown;
  compiledStories: readonly CompiledDependencyStory[];
  accounting: RejectedWaveAccounting;
  projectors: RejectionProjectors;
}): Promise<RejectedStoryCloseoutResult> {
  const { accounting, storyId } = input;
  accounting.failed.add(storyId);
  accounting.accountingOrder.push(`failed:${storyId}`);
  accounting.rejected.add(storyId);
  accounting.accountingOrder.push(`rejected:${storyId}`);
  accounting.processed.add(storyId);
  accounting.accountingOrder.push(`processed:${storyId}`);
  accounting.dispatchClosed = true;
  accounting.accountingOrder.push(`dispatch_closed:${storyId}`);

  const blockedBy = computeBlockedDependencyClosure(input.compiledStories, [...accounting.rejected]);
  accounting.accountingOrder.push(`dependency_analysis:${storyId}`);
  const projection: RejectedStoryProjection = {
    storyId,
    evidence: normalizeRejectedStoryEvidence(storyId, input.rejection),
    blockedBy,
    semanticStatus: 'failed',
  };
  const channels: RejectionEvidenceChannel[] = ['specState', 'runState', 'wal', 'storyResult', 'localDiagnostics'];
  const attempts: RejectionEvidenceChannel[] = [];
  const settled = await Promise.allSettled(channels.map(async channel => {
    attempts.push(channel);
    await input.projectors[channel](projection);
    return channel;
  }));
  const failedChannels = settled.flatMap((result, index) => result.status === 'rejected' ? [channels[index]] : []);
  return { ...projection, evidenceGap: failedChannels.length > 0, failedChannels, channelAttempts: attempts };
}

/** Promise.allSettled correlation made explicit rather than inferred from completion time. */
export async function settleStoriesCorrelated<T>(entries: readonly { storyId: string; promise: Promise<T> }[]): Promise<Array<
  { storyId: string; status: 'fulfilled'; value: T }
  | { storyId: string; status: 'rejected'; reason: unknown }
>> {
  const settled = await Promise.allSettled(entries.map(entry => entry.promise));
  return settled.map((result, index) => result.status === 'fulfilled'
    ? { storyId: entries[index].storyId, status: 'fulfilled', value: result.value }
    : { storyId: entries[index].storyId, status: 'rejected', reason: result.reason });
}

/**
 * Running independent siblings may drain to their safe closeout boundary.
 * Once rejection accounting closes dispatch, no unstarted story or later wave
 * may begin; blocked dependents are never eligible under any state.
 */
export function rejectedWaveDispatchDecision(input: {
  dispatchClosed: boolean;
  alreadyRunning: boolean;
  blockedBy: readonly string[];
}): 'drain_running_sibling' | 'do_not_start' | 'start' {
  if (input.blockedBy.length > 0) return 'do_not_start';
  if (input.dispatchClosed) return input.alreadyRunning ? 'drain_running_sibling' : 'do_not_start';
  return 'start';
}
