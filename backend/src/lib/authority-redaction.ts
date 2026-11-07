/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { AppError } from './errors';

export const AUTHORITY_REDACTION_CONTRACT_VERSION = 'rorca.authority-redaction.v1' as const;

const MAX_BOUNDARY_BYTES = 256 * 1024;
const MAX_DEPTH = 32;
const FORBIDDEN_KEY_PATTERN = /(^|[_-])(secret|credential|password|token|authorization|private[_-]?key)([_-]|$)/i;
const SECRET_ENV_KEY_PATTERN = /(^|_)(secret|credential|password|token|authorization|private_?key)($|_)/i;
const CREDENTIAL_VALUE_PATTERNS = [
  /(?:^|\s)(?:Bearer|Basic)\s+[A-Za-z0-9+/=_:.-]{4,}/i,
  /gh[pousr]_[A-Za-z0-9_]{8,}/i,
  /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/i,
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/i,
  /\b(?:rea-\d+-|rorca[-_])?secret[-_]canary[-_](?:value|[a-z0-9]{12,})\b/i,
] as const;

export type AuthorityRedactionFailureCode =
  | 'AUTHORITY_BOUNDARY_NOT_REDACTED'
  | 'AUTHORITY_BOUNDARY_INVALID_JSON'
  | 'AUTHORITY_BOUNDARY_TOO_LARGE';

const FAILURE_MESSAGES: Readonly<Record<AuthorityRedactionFailureCode, string>> = Object.freeze({
  AUTHORITY_BOUNDARY_NOT_REDACTED: 'Execution Authority boundary rejected credential material',
  AUTHORITY_BOUNDARY_INVALID_JSON: 'Execution Authority boundary requires acyclic JSON',
  AUTHORITY_BOUNDARY_TOO_LARGE: 'Execution Authority boundary payload exceeds its size limit',
});

/** Fixed-message failure: rejected field names and values never enter errors or logs. */
export class AuthorityRedactionError extends AppError {
  readonly statusCode = 422 as const;
  declare readonly code: AuthorityRedactionFailureCode;

  constructor(code: AuthorityRedactionFailureCode) {
    super(FAILURE_MESSAGES[code], code);
    this.code = code;
  }
}

export interface AuthorityRedactionOptions {
  /** Exact runtime values that must not cross this boundary. */
  secretCanaries?: readonly string[];
  /** Explicit opaque-reference envelope keys; their contents are still inspected. */
  allowedReferenceKeys?: readonly string[];
  maximumBytes?: number;
}

function normalizedCanaries(values: readonly string[] | undefined): readonly string[] {
  if (!values) return [];
  return values.filter((value) => typeof value === 'string' && value.length >= 4);
}

function containsCredentialMaterial(value: string, canaries: readonly string[]): boolean {
  return CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value))
    || canaries.some((canary) => value.includes(canary));
}

function allowedReferenceKeys(options: AuthorityRedactionOptions): ReadonlySet<string> {
  return new Set(options.allowedReferenceKeys ?? []);
}

function assertBoundaryValue(
  value: unknown,
  canaries: readonly string[],
  allowedKeys: ReadonlySet<string>,
  seen: Set<object>,
  depth: number,
): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (containsCredentialMaterial(value, canaries)) {
      throw new AuthorityRedactionError('AUTHORITY_BOUNDARY_NOT_REDACTED');
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AuthorityRedactionError('AUTHORITY_BOUNDARY_INVALID_JSON');
    return;
  }
  if (typeof value !== 'object' || value instanceof Date || seen.has(value) || depth > MAX_DEPTH) {
    throw new AuthorityRedactionError('AUTHORITY_BOUNDARY_INVALID_JSON');
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertBoundaryValue(item, canaries, allowedKeys, seen, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if ((FORBIDDEN_KEY_PATTERN.test(key) && !(depth === 0 && allowedKeys.has(key))) || item === undefined) {
        throw new AuthorityRedactionError('AUTHORITY_BOUNDARY_NOT_REDACTED');
      }
      assertBoundaryValue(item, canaries, allowedKeys, seen, depth + 1);
    }
  } finally {
    seen.delete(value);
  }
}

/** Admit only bounded, acyclic JSON with no credential-shaped keys or values. */
export function assertAuthorityRedactedValue(
  value: unknown,
  options: AuthorityRedactionOptions = {},
): void {
  assertBoundaryValue(
    value,
    normalizedCanaries(options.secretCanaries),
    allowedReferenceKeys(options),
    new Set<object>(),
    0,
  );
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    throw new AuthorityRedactionError('AUTHORITY_BOUNDARY_INVALID_JSON');
  }
  if (bytes > (options.maximumBytes ?? MAX_BOUNDARY_BYTES)) {
    throw new AuthorityRedactionError('AUTHORITY_BOUNDARY_TOO_LARGE');
  }
}

/** Validate one bounded provider reference without reflecting it into failures. */
export function assertAuthorityRedactedReference(value: unknown, maximumBytes = 1024): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maximumBytes
    || containsCredentialMaterial(value, [])) {
    throw new AuthorityRedactionError('AUTHORITY_BOUNDARY_NOT_REDACTED');
  }
}

function redactLogValue(
  value: unknown,
  canaries: readonly string[],
  seen: Set<object>,
  depth: number,
): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return containsCredentialMaterial(value, canaries) ? '[REDACTED]' : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[REDACTED]';
  if (typeof value !== 'object' || value instanceof Date || seen.has(value) || depth > MAX_DEPTH) {
    return '[REDACTED]';
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactLogValue(item, canaries, seen, depth + 1));
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = FORBIDDEN_KEY_PATTERN.test(key)
        ? '[REDACTED]'
        : redactLogValue(item, canaries, seen, depth + 1);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/** Copy a value into a JSON-safe log projection; unsafe leaves are replaced, never echoed. */
export function redactAuthorityLogValue(value: unknown, secretCanaries: readonly string[] = []): unknown {
  return redactLogValue(value, normalizedCanaries(secretCanaries), new Set<object>(), 0);
}

/** Secrets inherited by the trusted engine must never be copied into model/tool child environments. */
export function isAuthoritySecretEnvironmentEntry(key: string, value: string): boolean {
  return SECRET_ENV_KEY_PATTERN.test(key) || containsCredentialMaterial(value, []);
}

export function authoritySecretCanariesFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return Object.entries(environment)
    .filter(([key, value]) => value !== undefined && isAuthoritySecretEnvironmentEntry(key, value))
    .map(([, value]) => value as string)
    .filter((value) => value.length >= 4);
}

/** Fail prompt assembly if host secret material was injected through story/context text. */
export function assertAuthorityModelPrompt(prompt: string, environment: NodeJS.ProcessEnv = process.env): void {
  assertAuthorityRedactedValue(prompt, { secretCanaries: authoritySecretCanariesFromEnvironment(environment) });
}

/** Keep typed safe errors; collapse any unsafe or unknown error before route/log serialization. */
export function redactAuthorityError(error: unknown): AppError {
  if (error instanceof AppError) {
    try {
      assertAuthorityRedactedValue(error.toJSON());
      return error;
    } catch {
      return new AuthorityRedactionError('AUTHORITY_BOUNDARY_NOT_REDACTED');
    }
  }
  return new AuthorityRedactionError('AUTHORITY_BOUNDARY_NOT_REDACTED');
}
