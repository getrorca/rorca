/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

export type Sha256 = `sha256:${string}`;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

export function governedOperationsHash(value: unknown): Sha256 {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')}`;
}

const SENSITIVE_KEY = '(?:password|passwd|secret|token|credential|authorization|private[-_ ]?key|raw[-_ ]?(?:prompt|transcript)|human[-_ ]?(?:signature|attestation))';
const QUOTED_SENSITIVE = new RegExp(`([\"']${SENSITIVE_KEY}[\"']\\s*:\\s*)(?:\"(?:\\\\.|[^\"])*\"|'(?:\\\\.|[^'])*'|[^,}\\s]+)`, 'gi');
const TEXT_SENSITIVE = new RegExp(`\\b(${SENSITIVE_KEY})\\b\\s*(?::|=|\\bis\\b)\\s*(?:Bearer\\s+)?(?:\"(?:\\\\.|[^\"])*\"|'(?:\\\\.|[^'])*'|[^\\s,;}]+)`, 'gi');

export function boundedRedactedObservation(value: string, maxBytes = 2048): string {
  const redacted = value
    .replace(QUOTED_SENSITIVE, '$1\"[REDACTED]\"')
    .replace(TEXT_SENSITIVE, '$1=[REDACTED]');
  const bytes = Buffer.from(redacted);
  if (bytes.length <= maxBytes) return redacted;
  return `${bytes.subarray(0, Math.max(0, maxBytes - 14)).toString('utf8')}...[TRUNCATED]`;
}

export function requireExactHash(value: string, label: string): asserts value is Sha256 {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be an exact sha256 digest`);
}

export function assertNonEmptyExactIdentity(value: string, label: string): void {
  if (!value || value.trim() !== value || value.length > 256) throw new Error(`${label} must be a bounded exact identity`);
}
