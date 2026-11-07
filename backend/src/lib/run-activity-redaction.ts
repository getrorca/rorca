/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import { governedHash } from './governed-contracts/primitives';
import type { RuntimeNeutralObservationV1 } from './governed-contracts/run-stream';
import { parseRunStreamPayload } from './governed-contracts/run-stream';
import { PayloadTooLargeError, UnprocessableError } from './errors';

const FORBIDDEN_OBSERVABILITY_KEY = /(?:^|_)(?:context_?epoch|legacy_?epoch_?id|raw_?prompt|prompt|raw_?transcript|transcript|unrestricted_?context|context_?body|environment|env_?snapshot|authorization|credential|password|private_?key|attestation|signature|secret|token)(?:_|$)/i;
const BUILTIN_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi,
  /\b(?:sk|pk|rk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|provider[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
];
const MAX_PROJECTED_BYTES = 64 * 1024;
const MAX_DEPTH = 16;
const MAX_ARRAY_ITEMS = 500;
const MAX_OBJECT_KEYS = 200;
const MAX_STRING_LENGTH = 4096;

export interface RedactedRunActivityPayload {
  payload: unknown;
  redactionClass: 'none' | 'redacted' | 'restricted';
  redactedFieldCount: number;
  policyHash: string;
}

function configuredPatterns(): readonly RegExp[] {
  const configured = process.env.RORCA_RUN_ACTIVITY_REDACTION_PATTERNS;
  if (!configured) return BUILTIN_SECRET_PATTERNS;
  let values: unknown;
  try {
    values = JSON.parse(configured);
  } catch {
    throw new UnprocessableError('Run activity redaction policy is invalid', 'REDACTION_POLICY_INVALID');
  }
  if (!Array.isArray(values) || values.length > 20 || values.some((value) => typeof value !== 'string' || value.length < 2 || value.length > 256)) {
    throw new UnprocessableError('Run activity redaction policy is invalid', 'REDACTION_POLICY_INVALID');
  }
  try {
    return [...BUILTIN_SECRET_PATTERNS, ...values.map((value) => new RegExp(value as string, 'gi'))];
  } catch {
    throw new UnprocessableError('Run activity redaction policy is invalid', 'REDACTION_POLICY_INVALID');
  }
}

function sanitizedString(value: string, patterns: readonly RegExp[]): { value: string; redactions: number } {
  if (value.includes('\uFFFD')) {
    throw new UnprocessableError('Run activity contains invalid UTF-8 replacement material', 'INVALID_UTF8');
  }
  let sanitized = value.replace(/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u009b]/g, ' ');
  if (sanitized.length > MAX_STRING_LENGTH) {
    throw new PayloadTooLargeError('Run activity string exceeds the bounded projection limit');
  }
  let redactions = sanitized === value ? 0 : 1;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(sanitized)) {
      pattern.lastIndex = 0;
      sanitized = sanitized.replace(pattern, '[REDACTED]');
      redactions += 1;
    }
  }
  return { value: sanitized.normalize('NFC'), redactions };
}

function sanitizeValue(value: unknown, patterns: readonly RegExp[], depth: number, path: string[]): { value: unknown; redactions: number } {
  if (depth > MAX_DEPTH) throw new PayloadTooLargeError('Run activity payload nesting exceeds the bounded limit');
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return { value, redactions: 0 };
  if (typeof value === 'string') return sanitizedString(value, patterns);
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) throw new PayloadTooLargeError('Run activity array exceeds the bounded projection limit');
    let redactions = 0;
    const sanitized = value.map((entry, index) => {
      const result = sanitizeValue(entry, patterns, depth + 1, [...path, String(index)]);
      redactions += result.redactions;
      return result.value;
    });
    return { value: sanitized, redactions };
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new UnprocessableError('Run activity payload must be plain JSON', 'OBSERVABILITY_PAYLOAD_INVALID');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_OBJECT_KEYS) throw new PayloadTooLargeError('Run activity object exceeds the bounded projection limit');
  let redactions = 0;
  const sanitized: Record<string, unknown> = {};
  for (const [key, nested] of entries) {
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    if (FORBIDDEN_OBSERVABILITY_KEY.test(normalizedKey)) {
      throw new UnprocessableError('Run activity contains a forbidden raw, authority, or secret field', 'SECRET_BEARING_PAYLOAD', {
        fieldClass: 'restricted_material',
      });
    }
    const result = sanitizeValue(nested, patterns, depth + 1, [...path, key]);
    sanitized[key] = result.value;
    redactions += result.redactions;
  }
  return { value: sanitized, redactions };
}

/** Boundary invariant: only this returned payload may enter persistence or an ordinary projection. */
export function redactRunActivityObservation(observation: RuntimeNeutralObservationV1): RedactedRunActivityPayload {
  const patterns = configuredPatterns();
  const sanitized = sanitizeValue(observation.payload, patterns, 0, []);
  const payload = parseRunStreamPayload(observation.kind, sanitized.value);
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (bytes > MAX_PROJECTED_BYTES) throw new PayloadTooLargeError('Run activity payload exceeds 64 KiB');
  const policyHash = governedHash('rorca.run-activity-redaction-policy.v1', {
    builtInPatternCount: BUILTIN_SECRET_PATTERNS.length,
    configuredPatternCount: patterns.length - BUILTIN_SECRET_PATTERNS.length,
    maximumBytes: MAX_PROJECTED_BYTES,
    maximumDepth: MAX_DEPTH,
  });
  return {
    payload,
    redactionClass: observation.redactionClass === 'restricted' ? 'restricted'
      : sanitized.redactions > 0 ? 'redacted' : observation.redactionClass,
    redactedFieldCount: sanitized.redactions,
    policyHash,
  };
}
