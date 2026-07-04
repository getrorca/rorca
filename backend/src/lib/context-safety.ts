/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import path from 'path';

export const CONTEXT_SAFETY_LIMITS = {
  maxStringChars: 4_000,
  maxArrayItems: 100,
  maxSerializedBytes: 64 * 1024,
  maxRawTextChars: 8_000,
  maxRawLineCount: 120,
} as const;

export type ContextSafetyIssueCode =
  | 'oversized-array'
  | 'oversized-payload'
  | 'oversized-string'
  | 'raw-log-bundle'
  | 'raw-prompt-bundle'
  | 'secret-like-string'
  | 'unsafe-path';

export interface ContextSafetyIssue {
  code: ContextSafetyIssueCode;
  path: Array<string | number>;
  message: string;
}

export interface ContextSafetyOptions {
  maxStringChars?: number;
  maxArrayItems?: number;
  maxSerializedBytes?: number;
  maxRawTextChars?: number;
  maxRawLineCount?: number;
}

interface SecretPattern {
  label: string;
  pattern: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    label: 'private key block',
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/i,
  },
  {
    label: 'AWS access key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    label: 'GitHub token',
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  },
  {
    label: 'Slack token',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/,
  },
  {
    label: 'OpenAI-style API key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  },
  {
    label: 'Bearer token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/i,
  },
  {
    label: 'environment secret assignment',
    pattern: /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*\s*=\s*['"]?(?:sk-(?:proj-)?[A-Za-z0-9_-]{8,}|[A-Za-z0-9._~+/=-]{20,})['"]?/,
  },
  {
    label: 'secret assignment',
    pattern: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|credential)\b\s*[:=]\s*['"]?[A-Za-z0-9._\-+/=]{8,}/i,
  },
];

const HIGH_ENTROPY_TOKEN_PATTERN = /[A-Za-z0-9._~+=-]{20,}/g;
const UUID_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function toGlobalPattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }

  return [...counts.values()].reduce((entropy, count) => {
    const probability = count / value.length;
    return entropy - probability * Math.log2(probability);
  }, 0);
}

function characterClassCount(value: string): number {
  return [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /\d/.test(value),
    /[^A-Za-z0-9]/.test(value),
  ].filter(Boolean).length;
}

function isHighEntropySecretToken(candidate: string): boolean {
  if (candidate.length < 20) return false;
  if (UUID_TOKEN_PATTERN.test(candidate)) return false;
  if (/^[a-f0-9]{32,}$/i.test(candidate)) return false;
  if (!/[A-Z]/.test(candidate) || !/[a-z]/.test(candidate) || !/\d/.test(candidate)) return false;
  if (characterClassCount(candidate) < 3) return false;
  return shannonEntropy(candidate) >= 4;
}

function findHighEntropySecretToken(value: string): string | null {
  HIGH_ENTROPY_TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HIGH_ENTROPY_TOKEN_PATTERN.exec(value)) !== null) {
    if (isHighEntropySecretToken(match[0])) {
      return match[0];
    }
  }
  return null;
}

function withDefaultOptions(options: ContextSafetyOptions = {}): Required<ContextSafetyOptions> {
  return {
    maxStringChars: options.maxStringChars ?? CONTEXT_SAFETY_LIMITS.maxStringChars,
    maxArrayItems: options.maxArrayItems ?? CONTEXT_SAFETY_LIMITS.maxArrayItems,
    maxSerializedBytes: options.maxSerializedBytes ?? CONTEXT_SAFETY_LIMITS.maxSerializedBytes,
    maxRawTextChars: options.maxRawTextChars ?? CONTEXT_SAFETY_LIMITS.maxRawTextChars,
    maxRawLineCount: options.maxRawLineCount ?? CONTEXT_SAFETY_LIMITS.maxRawLineCount,
  };
}

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function detectSecretLikeString(value: string): string | null {
  for (const { label, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) {
      return label;
    }
  }

  if (findHighEntropySecretToken(value)) {
    return 'high entropy token';
  }

  return null;
}

export function redactSecretLikeStrings(value: string): string {
  const patternRedacted = SECRET_PATTERNS.reduce((current, { label, pattern }) => (
    current.replace(toGlobalPattern(pattern), `[REDACTED:${label}]`)
  ), value);

  HIGH_ENTROPY_TOKEN_PATTERN.lastIndex = 0;
  return patternRedacted.replace(HIGH_ENTROPY_TOKEN_PATTERN, (candidate) => (
    isHighEntropySecretToken(candidate) ? '[REDACTED:high entropy token]' : candidate
  ));
}

export function looksLikeRawPromptBundle(value: string): boolean {
  const markers = [
    /^\s*system prompt\s*:/im,
    /^\s*developer prompt\s*:/im,
    /^\s*user prompt\s*:/im,
    /^\s*assistant prompt\s*:/im,
    /<{1,2}\s*system\s*>/i,
    /<{1,2}\s*developer\s*>/i,
    /BEGIN (?:RAW )?PROMPT/i,
    /RORCA DIRECTION STACK/i,
  ];

  const markerCount = markers.reduce((count, marker) => count + (marker.test(value) ? 1 : 0), 0);
  return markerCount >= 2 || (markerCount === 1 && value.length > 1_500);
}

export function looksLikeRawLogBundle(
  value: string,
  options: Pick<Required<ContextSafetyOptions>, 'maxRawLineCount' | 'maxRawTextChars'> = withDefaultOptions(),
): boolean {
  const lines = value.split(/\r?\n/);
  if (lines.length <= 8 && value.length <= options.maxRawTextChars) {
    return false;
  }

  const logishLines = lines.filter((line) => (
    /^\d{4}-\d{2}-\d{2}[T\s]/.test(line)
    || /\b(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\b/.test(line)
    || /^\s+at\s+\S+/.test(line)
    || /^npm ERR!/i.test(line)
    || /^Traceback \(most recent call last\):/.test(line)
  )).length;

  return lines.length > options.maxRawLineCount
    || (value.length > options.maxRawTextChars && logishLines >= 3)
    || (lines.length > 40 && logishLines >= 10);
}

export function getUnsafePathReason(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return 'path cannot be empty';
  }
  if (trimmed.includes('\0')) {
    return 'path contains a NUL byte';
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) {
    return 'path must be workspace-relative, not a URL';
  }
  if (trimmed.startsWith('~')) {
    return 'path must not use home-directory expansion';
  }
  if (path.isAbsolute(trimmed) || path.posix.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) {
    return 'path must be workspace-relative, not absolute';
  }
  if (/^[A-Za-z]:/.test(trimmed)) {
    return 'path must not use a Windows drive prefix';
  }

  const normalized = trimmed.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..')) {
    return 'path must not traverse outside the workspace';
  }

  return null;
}

export function isSafeRelativePath(candidate: string): boolean {
  return getUnsafePathReason(candidate) === null;
}

export function checkStringSafety(
  value: string,
  issuePath: Array<string | number> = [],
  options: ContextSafetyOptions = {},
): ContextSafetyIssue[] {
  const opts = withDefaultOptions(options);
  const issues: ContextSafetyIssue[] = [];

  if (value.length > opts.maxStringChars) {
    issues.push({
      code: 'oversized-string',
      path: issuePath,
      message: `String exceeds ${opts.maxStringChars} characters`,
    });
  }

  const secretLabel = detectSecretLikeString(value);
  if (secretLabel) {
    issues.push({
      code: 'secret-like-string',
      path: issuePath,
      message: `Secret-like value detected (${secretLabel}); pass a reference instead of raw credentials`,
    });
  }

  if (looksLikeRawPromptBundle(value)) {
    issues.push({
      code: 'raw-prompt-bundle',
      path: issuePath,
      message: 'Raw prompt bundles are not accepted in task manifests; pass a bounded artifact reference instead',
    });
  }

  if (looksLikeRawLogBundle(value, opts)) {
    issues.push({
      code: 'raw-log-bundle',
      path: issuePath,
      message: 'Raw oversized logs are not accepted in task manifests; pass a bounded artifact reference instead',
    });
  }

  return issues;
}

function collectIssues(value: unknown, issuePath: Array<string | number>, options: Required<ContextSafetyOptions>, issues: ContextSafetyIssue[]): void {
  if (typeof value === 'string') {
    issues.push(...checkStringSafety(value, issuePath, options));
    return;
  }

  if (Array.isArray(value)) {
    if (value.length > options.maxArrayItems) {
      issues.push({
        code: 'oversized-array',
        path: issuePath,
        message: `Array exceeds ${options.maxArrayItems} items`,
      });
    }

    value.forEach((item, index) => collectIssues(item, [...issuePath, index], options, issues));
    return;
  }

  if (value && typeof value === 'object') {
    Object.entries(value as Record<string, unknown>).forEach(([key, nested]) => {
      collectIssues(nested, [...issuePath, key], options, issues);
    });
  }
}

export function collectContextSafetyIssues(value: unknown, options: ContextSafetyOptions = {}): ContextSafetyIssue[] {
  const opts = withDefaultOptions(options);
  const issues: ContextSafetyIssue[] = [];
  const byteLength = serializedBytes(value);

  if (byteLength > opts.maxSerializedBytes) {
    issues.push({
      code: 'oversized-payload',
      path: [],
      message: `Payload exceeds ${opts.maxSerializedBytes} serialized bytes`,
    });
  }

  collectIssues(value, [], opts, issues);
  return issues;
}
