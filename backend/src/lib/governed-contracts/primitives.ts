/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

export const GOVERNED_CONTRACT_VERSION = '1.0.0' as const;
export const GOVERNED_CONTRACT_LIMITS = Object.freeze({
  requestBytes: 256 * 1024, eventBytes: 64 * 1024, auditBytes: 16 * 1024,
  bundleBytes: 4 * 1024 * 1024, maxRequiredSources: 500, maxAdvisoryItems: 50,
  maxDeltaChain: 8, maxRetrievalAttempts: 5, maxTransportReconciliations: 3,
  maxPageSize: 100,
});

export const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const FullGitShaSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const StableIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._:-]{1,127}$/);
export const SafeRelativePathSchema = z.string().min(1).max(4096)
  .refine((value) => !value.startsWith('/') && !value.includes('\\') && !/(^|\/)\.\.(\/|$)/.test(value) && !/%2f|%5c|\0/i.test(value), 'unsafe workspace-relative path');
export const CanonicalTimestampSchema = z.iso.datetime({ offset: true });
export const AuthorityCeilingSchema = z.enum(['none', 'observe', 'propose', 'execute_bounded']);
export const ArtifactStateSchema = z.enum(['proposed', 'active', 'superseded', 'rejected', 'revoked', 'stale']);

export const ExactRevisionRefSchema = z.object({
  id: StableIdSchema, revision: z.number().int().positive(), hash: Sha256Schema,
}).strict();

export const RepositoryScopeSchema = z.object({
  repositoryId: StableIdSchema,
  remoteAuthorityHash: Sha256Schema,
  gitObjectFormat: z.enum(['sha1', 'sha256']),
  baseSha: FullGitShaSchema,
  currentSha: FullGitShaSchema,
  expectedHeadSha: FullGitShaSchema,
  worktreeId: StableIdSchema,
  allowedPathManifestHash: Sha256Schema,
  requiredPathManifestHash: Sha256Schema,
  changedPathManifestHash: Sha256Schema,
  forbiddenPathManifestHash: Sha256Schema,
}).strict().superRefine((value, ctx) => {
  const expectedLength = value.gitObjectFormat === 'sha1' ? 40 : 64;
  for (const field of ['baseSha', 'currentSha', 'expectedHeadSha'] as const) {
    if (value[field].length !== expectedLength) ctx.addIssue({ code: 'custom', path: [field], message: `must be ${expectedLength} hex characters` });
  }
});

export const CanonicalSpecScopeSchema = z.object({
  specId: StableIdSchema, specVersion: z.number().int().positive(), specHash: Sha256Schema,
  canonicalSpecPath: SafeRelativePathSchema, storyId: StableIdSchema,
  storyVersion: z.number().int().positive(), storyHash: Sha256Schema, criteriaManifestHash: Sha256Schema,
}).strict();

export const ArtifactHeaderSchema = z.object({
  schemaVersion: z.string().regex(/^rorca\.[a-z0-9-]+\.v1$/),
  contractId: z.string().regex(/^rorca\.[a-z0-9-]+\.v1$/),
  contractVersion: z.string().regex(/^1\.[0-9]+\.[0-9]+$/),
  artifactId: StableIdSchema,
  contentHash: Sha256Schema,
  createdAt: CanonicalTimestampSchema,
  createdBy: StableIdSchema,
}).strict();

export const RestrictedReferenceSchema = z.object({
  referenceId: StableIdSchema, kind: z.enum(['artifact', 'log', 'transcript', 'prompt', 'evidence', 'context']),
  hash: Sha256Schema, sensitivity: z.enum(['public', 'internal', 'confidential', 'restricted']),
  retentionClass: StableIdSchema, accessTier: z.enum(['auth', 'admin']), rawPayloadIncluded: z.literal(false),
}).strict();

const FORBIDDEN_KEY = /(?:^|_)(?:context_?epoch|legacy_?epoch_?id|password|secret|access_?token|bearer_?token|api_?token|auth_?token|refresh_?token|provider_?token|credential|private_?key|authorization_(?:header|credential|token|bearer)|attestation|signature|raw_?prompt|raw_?transcript|environment)(?:_|$)/i;
const SECRET_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:postgres|mysql|mongodb(?:\+srv)?):\/\/[^\s]+:[^\s]+@|(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s]+)/i;

export function findForbiddenGovernedField(value: unknown, path: Array<string | number> = []): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenGovernedField(value[index], [...path, index]);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const next = [...path, key];
      const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
      if (normalizedKey === 'authorization' || FORBIDDEN_KEY.test(normalizedKey)) return next.join('.');
      const found = findForbiddenGovernedField(nested, next);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'string' && SECRET_VALUE.test(value)) return path.join('.');
  return null;
}

export function assertNoForbiddenGovernedFields(value: unknown): void {
  const path = findForbiddenGovernedField(value);
  if (path) throw new Error(`forbidden governed authority/secret field at ${path}`);
}

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };
function lp(name: string, bytes: Buffer): Buffer {
  const nameBytes = Buffer.from(name.normalize('NFC'), 'utf8');
  return Buffer.concat([Buffer.from(`${nameBytes.length}:`), nameBytes, Buffer.from(`${bytes.length}:`), bytes]);
}
function encode(value: CanonicalValue): Buffer {
  if (value === null) return lp('$type', Buffer.from('null'));
  if (typeof value === 'boolean') return Buffer.concat([lp('$type', Buffer.from('boolean')), lp('$value', Buffer.from(String(value)))]);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('LP1 permits safe integers only');
    return Buffer.concat([lp('$type', Buffer.from('integer')), lp('$value', Buffer.from(String(value)))]);
  }
  if (typeof value === 'string') return Buffer.concat([lp('$type', Buffer.from('string')), lp('$value', Buffer.from(value.normalize('NFC'), 'utf8'))]);
  if (Array.isArray(value)) return Buffer.concat([lp('$type', Buffer.from('array')), lp('$count', Buffer.from(String(value.length))), ...value.map((item, index) => lp(String(index), encode(item)))]);
  const entries = Object.entries(value).sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)));
  return Buffer.concat([lp('$type', Buffer.from('object')), lp('$count', Buffer.from(String(entries.length))), ...entries.map(([key, item]) => lp(key, encode(item)))]);
}

export function governedCanonicalBytes(domain: string, value: CanonicalValue): Buffer {
  assertNoForbiddenGovernedFields(value);
  return Buffer.concat([lp('$codec', Buffer.from('rorca.lp1')), lp('$domain', Buffer.from(domain)), encode(value)]);
}
export function governedHash(domain: string, value: CanonicalValue): string {
  return `sha256:${createHash('sha256').update(governedCanonicalBytes(domain, value)).digest('hex')}`;
}
export function governedId(prefix: string, domain: string, value: CanonicalValue): string {
  return `${prefix}${governedHash(domain, value).slice(7)}`;
}
