/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { canonicalizeBountyValue } from './bounty-contracts';
import { ValidationError } from './errors';

const HASH = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
type SemanticAction = 'observe' | 'test' | 'authenticate' | 'submit';

export interface ScopeRuleInput {
  effect: 'allow' | 'deny';
  scheme: 'http' | 'https';
  host: string;
  port?: number;
  path: string;
  methods: string[];
  actions: SemanticAction[];
  accountRoles?: string[];
  query?: { allowedKeys: string[]; allowRepeated?: boolean };
}
export interface NormalizedScopeRule extends Omit<ScopeRuleInput, 'methods' | 'accountRoles'> {
  host: string; port: number; methods: Array<typeof METHODS[number]>; accountRoles: string[];
}
export interface PolicyAdmissionInput {
  workspaceId: string; programId: string; effectiveFrom: string; effectiveUntil?: string;
  sources: Array<{ sourceId: string; bytes: string; claimedHash: string }>;
  assertion: { assertionId: string; humanId: string; authenticatedAt: string; revokedAt?: string };
  rules: ScopeRuleInput[]; unresolvedProse?: string[]; generation: number;
  limits: { requestsPerMinute: number; maximumDataBytes: number };
}
export interface PolicyAdmission {
  workspaceId: string; programId: string; effectiveFrom: string; effectiveUntil?: string;
  sourceHashes: ReadonlyArray<{ sourceId: string; hash: string }>;
  assertion: PolicyAdmissionInput['assertion']; rules: ReadonlyArray<NormalizedScopeRule>;
  limits: PolicyAdmissionInput['limits']; generation: number; status: 'admitted' | 'hold'; contractHash: string;
}

function fail(message: string): never { throw new ValidationError(message); }
function sha256(bytes: string): string { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
function cleanId(value: string, field: string): string { if (!ID.test(value)) fail(`invalid ${field}`); return value; }

/** Strict URL host normalization: ambiguous spellings are rejected rather than silently repaired. */
export function normalizeHost(input: string): string {
  if (!input || input.endsWith('.') || input !== input.trim() || /[^\x00-\x7f]/.test(input)) fail('ambiguous host');
  const wildcard = input.startsWith('*.');
  const raw = wildcard ? input.slice(2) : input;
  if (raw.includes('*') || raw.includes('%') || raw.includes('@')) fail('invalid host');
  const unwrapped = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  const ipVersion = isIP(unwrapped);
  if (ipVersion === 4 && !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(unwrapped)) fail('alternate IPv4 notation');
  if (ipVersion) {
    if (wildcard) fail('IP wildcards are forbidden');
    return unwrapped.toLowerCase();
  }
  const ascii = domainToASCII(raw).toLowerCase();
  if (!ascii || ascii !== raw.toLowerCase() || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(ascii)) fail('invalid or ambiguous DNS host');
  if (wildcard && ascii.split('.').length < 3) fail('wildcard apex may be a public suffix');
  return wildcard ? `*.${ascii}` : ascii;
}

export function normalizeScopeRule(rule: ScopeRuleInput): NormalizedScopeRule {
  if (rule.scheme !== 'http' && rule.scheme !== 'https') fail('unsupported scheme');
  const host = normalizeHost(rule.host);
  const port = rule.port ?? (rule.scheme === 'https' ? 443 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('invalid port');
  let decodedPath: string;
  try { decodedPath = decodeURIComponent(rule.path); } catch { return fail('invalid path encoding'); }
  if (!rule.path.startsWith('/') || rule.path.includes('\\') || /%(?:2f|5c|2e)/i.test(rule.path) || decodedPath !== rule.path) fail('encoded separator or ambiguous path');
  const methods = [...new Set(rule.methods.map((m) => m.toUpperCase()))];
  if (!methods.length || methods.some((m) => !(METHODS as readonly string[]).includes(m))) fail('unsupported method');
  const query = rule.query ? { allowedKeys: [...new Set(rule.query.allowedKeys)].sort(), allowRepeated: rule.query.allowRepeated ?? false } : undefined;
  if (query?.allowedKeys.some((key) => !/^[A-Za-z0-9._~-]{1,128}$/.test(key))) fail('invalid query policy');
  return Object.freeze({ ...rule, host, port, path: rule.path, methods: methods.sort() as Array<typeof METHODS[number]>, actions: [...new Set(rule.actions)].sort(), accountRoles: [...new Set(rule.accountRoles ?? [])].sort(), ...(query ? { query } : {}) });
}

export function admitProgramPolicy(input: PolicyAdmissionInput): PolicyAdmission {
  cleanId(input.workspaceId, 'workspaceId'); cleanId(input.programId, 'programId');
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) fail('invalid generation');
  const from = Date.parse(input.effectiveFrom), until = input.effectiveUntil ? Date.parse(input.effectiveUntil) : Infinity;
  if (!Number.isFinite(from) || until <= from) fail('invalid effective dates');
  if (!input.assertion.humanId || input.assertion.revokedAt || !Number.isFinite(Date.parse(input.assertion.authenticatedAt))) fail('accountable-human assertion is invalid or revoked');
  const sourceHashes = input.sources.map((source) => {
    cleanId(source.sourceId, 'sourceId'); const actual = sha256(source.bytes);
    if (!HASH.test(source.claimedHash) || actual !== source.claimedHash) fail('policy source hash mismatch');
    return Object.freeze({ sourceId: source.sourceId, hash: actual });
  });
  if (!sourceHashes.length) fail('at least one immutable source is required');
  const rules = input.rules.map(normalizeScopeRule);
  const withoutEffect = ({ effect: _effect, ...rule }: NormalizedScopeRule) => rule;
  const contradictory = rules.some((allow) => allow.effect === 'allow' && rules.some((deny) => deny.effect === 'deny' && canonicalizeBountyValue(withoutEffect(allow)) === canonicalizeBountyValue(withoutEffect(deny))));
  const status: PolicyAdmission['status'] = input.unresolvedProse?.length || contradictory ? 'hold' : 'admitted';
  const assertion = input.assertion.revokedAt
    ? input.assertion
    : { assertionId: input.assertion.assertionId, humanId: input.assertion.humanId, authenticatedAt: input.assertion.authenticatedAt };
  const hashableContract = { workspaceId: input.workspaceId, programId: input.programId, effectiveFrom: input.effectiveFrom, effectiveUntil: input.effectiveUntil ?? null, sourceHashes, assertion, rules, limits: input.limits, generation: input.generation, status };
  return Object.freeze({ ...hashableContract, effectiveUntil: input.effectiveUntil, contractHash: sha256(canonicalizeBountyValue(hashableContract)) });
}

function hostMatches(pattern: string, host: string): boolean {
  if (!pattern.startsWith('*.')) return pattern === host;
  const apex = pattern.slice(2);
  return host.endsWith(`.${apex}`) && host !== apex;
}
function pathMatches(prefix: string, path: string): boolean { return path === prefix || (prefix.endsWith('/') ? path.startsWith(prefix) : path.startsWith(`${prefix}/`)); }

/** Observations are evidence only: the original rule is re-evaluated for every hop/address. */
export function authorizeObservation(admission: PolicyAdmission, request: { workspaceId: string; programId: string; generation: number; url: string; method: string; action: SemanticAction; accountRole?: string }, observations: Array<{ host: string; port?: number }> = []): boolean {
  if (admission.status !== 'admitted' || request.workspaceId !== admission.workspaceId || request.programId !== admission.programId || request.generation !== admission.generation) return false;
  let url: URL; try { url = new URL(request.url); } catch { return false; }
  if (url.username || url.password || url.hash || url.hostname.endsWith('.') || url.pathname.includes('\\') || /%(?:2f|5c|2e)/i.test(url.pathname)) return false;
  let host: string; try { host = normalizeHost(url.hostname); } catch { return false; }
  const scheme = url.protocol.slice(0, -1), port = url.port ? Number(url.port) : scheme === 'https' ? 443 : 80;
  let points: Array<{ host: string; port: number }>;
  try { points = [{ host, port }, ...observations.map((o) => ({ host: normalizeHost(o.host), port: o.port ?? port }))]; } catch { return false; }
  const queryMatches = (rule: NormalizedScopeRule) => {
    if (!url.search) return true;
    if (!rule.query) return false;
    const keys = [...url.searchParams.keys()];
    return keys.every((key) => rule.query!.allowedKeys.includes(key)) && (rule.query.allowRepeated || new Set(keys).size === keys.length);
  };
  const matches = (rule: NormalizedScopeRule, point: { host: string; port: number }) => rule.scheme === scheme && rule.port === point.port && hostMatches(rule.host, point.host) && pathMatches(rule.path, url.pathname) && queryMatches(rule) && rule.methods.includes(request.method.toUpperCase() as typeof METHODS[number]) && rule.actions.includes(request.action) && (!rule.accountRoles.length || !!request.accountRole && rule.accountRoles.includes(request.accountRole));
  if (admission.rules.some((r) => r.effect === 'deny' && points.some((p) => matches(r, p)))) return false;
  return points.every((p) => admission.rules.some((r) => r.effect === 'allow' && matches(r, p)));
}
