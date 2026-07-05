/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';

export type CapturePolicy = {
  version: string;
  maxStringBytes: number;
  maxPayloadBytes: number;
  rawContentDefault: 'off' | 'metadata+hash' | 'explicit';
  hashAlgorithm: 'sha256';
  redactionPatterns: Array<{ name: string; pattern: RegExp; replacement: string }>;
};

export type CaptureSafetyReport = {
  contextSafetyModule: 'backend/src/lib/context-safety.ts';
  policyVersion: string;
  redactionCount: number;
  ignoredPathCount: number;
  truncated: boolean;
  hashAlgorithm: 'sha256';
  contentHash: string;
};

export type SanitizedCapturePayload = {
  payload: unknown;
  safety: CaptureSafetyReport;
};

export const DEFAULT_CAPTURE_POLICY: CapturePolicy = {
  version: '2026-07-ucc-003',
  maxStringBytes: 16_384,
  maxPayloadBytes: 128_000,
  rawContentDefault: 'metadata+hash',
  hashAlgorithm: 'sha256',
  redactionPatterns: [
    { name: 'environment assignment', pattern: /\b[A-Z0-9_]{2,}=([^\s]+)/g, replacement: '[REDACTED_ENV]' },
    { name: 'private key block', pattern: /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
    { name: 'bearer token', pattern: /Bearer\s+[A-Za-z0-9._~+/-]+=*/g, replacement: 'Bearer [REDACTED]' },
    { name: 'api key', pattern: /\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;}]+/gi, replacement: '$1=[REDACTED]' },
  ],
};

export function hashCaptureContent(value: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function sanitizeCapturePayload(input: unknown, policy: CapturePolicy = DEFAULT_CAPTURE_POLICY): SanitizedCapturePayload {
  const counters = { redactionCount: 0, ignoredPathCount: 0, truncated: false };
  const payload = sanitizeValue(input, policy, counters, 0);
  const bounded = boundPayload(payload, policy, counters);
  return {
    payload: bounded,
    safety: {
      contextSafetyModule: 'backend/src/lib/context-safety.ts',
      policyVersion: policy.version,
      redactionCount: counters.redactionCount,
      ignoredPathCount: counters.ignoredPathCount,
      truncated: counters.truncated,
      hashAlgorithm: policy.hashAlgorithm,
      contentHash: hashCaptureContent(bounded),
    },
  };
}

function sanitizeValue(value: unknown, policy: CapturePolicy, counters: { redactionCount: number; ignoredPathCount: number; truncated: boolean }, depth: number): unknown {
  if (depth > 16) {
    counters.truncated = true;
    return '[TRUNCATED_DEPTH]';
  }
  if (typeof value === 'string') return sanitizeString(value, policy, counters);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeValue(item, policy, counters, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/^(raw|content|text|stdout|stderr)$/i.test(key) && policy.rawContentDefault !== 'explicit') {
        out[key] = typeof child === 'string' ? { hash: hashCaptureContent(child), byteLength: Buffer.byteLength(child), redacted: true } : '[REDACTED_RAW_CONTENT]';
        counters.redactionCount += 1;
        continue;
      }
      out[key] = sanitizeValue(child, policy, counters, depth + 1);
    }
    return out;
  }
  return String(value);
}

function sanitizeString(input: string, policy: CapturePolicy, counters: { redactionCount: number; truncated: boolean }): string {
  let output = input;
  for (const rule of policy.redactionPatterns) {
    output = output.replace(rule.pattern, (...args: unknown[]) => {
      const match = String(args[0]);
      if (match) counters.redactionCount += 1;
      return rule.replacement;
    });
  }
  const bytes = Buffer.byteLength(output);
  if (bytes > policy.maxStringBytes) {
    counters.truncated = true;
    return `${Buffer.from(output).subarray(0, policy.maxStringBytes).toString('utf8')}…[TRUNCATED ${bytes - policy.maxStringBytes} bytes]`;
  }
  return output;
}

function boundPayload(payload: unknown, policy: CapturePolicy, counters: { truncated: boolean }): unknown {
  const encoded = stableStringify(payload);
  if (Buffer.byteLength(encoded) <= policy.maxPayloadBytes) return payload;
  counters.truncated = true;
  return {
    truncated: true,
    hash: hashCaptureContent(payload),
    byteLength: Buffer.byteLength(encoded),
    preview: encoded.slice(0, policy.maxStringBytes),
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortJson(child)]));
  }
  return value;
}
