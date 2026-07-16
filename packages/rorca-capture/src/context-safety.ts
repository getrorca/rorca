/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * context-safety.ts — canonical path filtering, size limits, hashing, and
 * redaction primitives for context-capture producers.
 *
 * The standalone rorca-capture sidecar mirrors this contract so it can run
 * without importing backend database code. Keep the version and defaults in
 * sync with packages/rorca-capture/src/context-safety.ts.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CONTEXT_SAFETY_CONTRACT_VERSION = 'rorca-context-safety/v1';

export const DEFAULT_CONTEXT_MAX_FILE_BYTES = 256 * 1024;
export const DEFAULT_CONTEXT_MAX_EVENT_BYTES = 1024 * 1024;

export const DEFAULT_CONTEXT_IGNORE_FILE_NAME = '.rorca-captureignore';

export const DEFAULT_CONTEXT_IGNORE_PATHS = [
  '.git/**',
  '.hg/**',
  '.svn/**',
  'node_modules/**',
  'dist/**',
  'build/**',
  'coverage/**',
  '.next/**',
  '.nuxt/**',
  '.turbo/**',
  '.cache/**',
  '.rorca/capture-queue.ndjson',
  '.rorca/capture-queue/**',
  '.rorca-capture-queue.jsonl',
  '.rorca-capture-queue.jsonl.tmp',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '.env',
  '.env.*',
] as const;

export type ContextPattern = {
  name: string;
  pattern: string;
};

export type ContextRedactionPattern = ContextPattern & {
  replacement?: string;
};

export const DEFAULT_CONTEXT_REDACTION_PATTERNS: ContextRedactionPattern[] = [
  {
    name: 'bearer-token',
    pattern: '\\bBearer\\s+[A-Za-z0-9._~+\\/-]+=*',
    replacement: 'Bearer [REDACTED]',
  },
  {
    name: 'api-key-assignment',
    pattern: "\\b[A-Z0-9_]*(?:API|TOKEN|SECRET|PASSWORD|KEY)[A-Z0-9_]*\\s*=\\s*[\"\\']?[^\"\\'\\s]+",
    replacement: '[REDACTED_SECRET_ASSIGNMENT]',
  },
  {
    name: 'cli-secret-argument',
    pattern: "--?(?:api[-_]?key|token|secret|password|key)\\s+(?:=\\s*)?[\"\\']?[^\"\\'\\s]+",
    replacement: '[REDACTED_SECRET_ARGUMENT]',
  },
  {
    name: 'github-token',
    pattern: '\\bgh[pousr]_[A-Za-z0-9_]{20,}\\b',
    replacement: '[REDACTED_GITHUB_TOKEN]',
  },
  {
    name: 'openai-secret-key',
    pattern: '\\bsk-[A-Za-z0-9_-]{20,}\\b',
    replacement: 'sk-[REDACTED]',
  },
  {
    name: 'database-url',
    pattern: "\\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\\+srv)?|redis)://[^\\s'\"<>]+",
    replacement: '[REDACTED_DATABASE_URL]',
  },
  {
    name: 'aws-access-key-id',
    pattern: '\\bAKIA[0-9A-Z]{16}\\b',
    replacement: '[REDACTED_AWS_ACCESS_KEY]',
  },
  {
    name: 'jwt-token',
    pattern: '\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b',
    replacement: '[REDACTED_JWT]',
  },
  {
    name: 'private-key-block',
    pattern: '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----',
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
];

export const DEFAULT_CONTEXT_REGULATED_DOMAIN_PATTERNS: ContextPattern[] = [
  {
    name: 'hipaa-phi',
    pattern: '\\b(?:HIPAA|PHI|patient(?:\\s+(?:data|record|records|health))?|diagnosis|medical\\s+record|healthcare)\\b',
  },
  {
    name: 'pci-cardholder-data',
    pattern: '\\b(?:PCI(?:[-\\s]?DSS)?|cardholder\\s+data|credit\\s+card|payment\\s+card|primary\\s+account\\s+number|PAN)\\b',
  },
  {
    name: 'privacy-pii',
    pattern: '\\b(?:GDPR|PII|personally\\s+identifiable|SSN|social\\s+security\\s+number|data\\s+subject)\\b',
  },
  {
    name: 'financial-regulatory',
    pattern: '\\b(?:SOX|FINRA|GLBA|FedRAMP|ITAR|EAR|export\\s+controlled)\\b',
  },
];

export type ContextIgnoreSettings = {
  paths?: string[];
  maxFileBytes?: number;
  maxEventBytes?: number;
};

export type NormalizedContextIgnoreSettings = {
  paths: string[];
  maxFileBytes: number;
  maxEventBytes: number;
};

export type ContextRedactionSettings = {
  enabled?: boolean;
  patterns?: Array<ContextRedactionPattern | string>;
  replacement?: string;
};

export type NormalizedContextRedactionSettings = {
  enabled: boolean;
  patterns: ContextRedactionPattern[];
  replacement: string;
};

export type ContextPayloadRedactionOptions = {
  repoPath?: string;
  pathReplacement?: string;
  workspacePathReplacement?: string;
};

export type ContextSafetyFinding = {
  category: 'secret' | 'regulated-domain';
  name: string;
};

export type ContextSafetyDiagnostics = {
  securitySensitive: boolean;
  regulatedDomain: boolean;
  requiresReview: boolean;
  findings: ContextSafetyFinding[];
};

export type ContextCaptureIgnoreFile = {
  path: string;
  patterns: string[];
};

export function normalizeContextPath(input: string): string {
  return input.split(path.sep).join('/').replace(/^\.\//, '');
}

export function safeNormalizeWorkspaceRelativePath(workspacePath: string, inputPath: string): string {
  const rawWorkspaceRoot = path.resolve(workspacePath);
  const workspaceRoot = resolveContextPathForComparison(rawWorkspaceRoot);
  const rawAbsolutePath = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(rawWorkspaceRoot, inputPath);
  const absolutePath = resolveWorkspaceComparablePath(rawWorkspaceRoot, workspaceRoot, rawAbsolutePath);
  const relativePath = path.relative(workspaceRoot, absolutePath);

  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }

  return normalizeContextPath(relativePath);
}

export function normalizeContextIgnoreSettings(settings: ContextIgnoreSettings = {}): NormalizedContextIgnoreSettings {
  return {
    paths: [...DEFAULT_CONTEXT_IGNORE_PATHS, ...contextUserIgnorePaths(settings)],
    maxFileBytes: positiveNumberOrDefault(settings.maxFileBytes, DEFAULT_CONTEXT_MAX_FILE_BYTES),
    maxEventBytes: positiveNumberOrDefault(settings.maxEventBytes, DEFAULT_CONTEXT_MAX_EVENT_BYTES),
  };
}

export function normalizeContextRedactionSettings(
  settings: ContextRedactionSettings = {},
): NormalizedContextRedactionSettings {
  const customPatterns = contextUserRedactionPatterns(settings).map((item, index) => {
    if (typeof item === 'string') {
      return { name: `custom-${index + 1}`, pattern: item, replacement: settings.replacement };
    }
    return item;
  });

  return {
    enabled: settings.enabled ?? true,
    patterns: [...DEFAULT_CONTEXT_REDACTION_PATTERNS, ...customPatterns],
    replacement: settings.replacement ?? '[REDACTED]',
  };
}

export function shouldCapturePath(relativePath: string, settings: ContextIgnoreSettings = {}): boolean {
  return !isContextPathIgnored(relativePath, settings);
}

export function isContextPathIgnored(relativePath: string, settings: ContextIgnoreSettings = {}): boolean {
  const normalized = normalizeContextPath(relativePath);

  for (const rawPattern of DEFAULT_CONTEXT_IGNORE_PATHS) {
    const prepared = prepareIgnorePattern(rawPattern);
    if (prepared && globMatches(normalized, prepared.pattern)) {
      return true;
    }
  }

  let ignored = false;
  for (const rawPattern of contextUserIgnorePaths(settings)) {
    const prepared = prepareIgnorePattern(rawPattern);
    if (!prepared) continue;
    if (globMatches(normalized, prepared.pattern)) {
      ignored = !prepared.negated;
    }
  }

  return ignored;
}

export function enforceContextSizeLimit(
  byteLength: number,
  settings: ContextIgnoreSettings = {},
  limit: 'file' | 'event' = 'file',
): boolean {
  const ignore = normalizeContextIgnoreSettings(settings);
  const maxBytes = limit === 'file' ? ignore.maxFileBytes : ignore.maxEventBytes;
  return byteLength <= maxBytes;
}

export function hashContextContent(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function redactContextText(text: string, settings: ContextRedactionSettings = {}): string {
  const redaction = normalizeContextRedactionSettings(settings);
  if (!redaction.enabled) return text;

  return redaction.patterns.reduce((current, pattern) => {
    try {
      return current.replace(new RegExp(pattern.pattern, 'gi'), pattern.replacement ?? redaction.replacement);
    } catch {
      return current;
    }
  }, text);
}

export function redactContextPayload(
  value: unknown,
  settings: ContextRedactionSettings = {},
  options: ContextPayloadRedactionOptions = {},
): unknown {
  if (typeof value === 'string') {
    return redactContextText(redactAbsoluteContextPaths(value, options), settings);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactContextPayload(item, settings, options));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, redactContextPayload(record[key], settings, options)]),
    );
  }
  return value;
}

export function redactAbsoluteContextPaths(text: string, options: ContextPayloadRedactionOptions = {}): string {
  const pathReplacement = options.pathReplacement ?? '[REDACTED_PATH]';
  const workspacePathReplacement = options.workspacePathReplacement ?? '[WORKSPACE]';
  const repoPath = options.repoPath ? path.resolve(options.repoPath) : undefined;
  let redacted = text;

  if (repoPath) {
    const repoVariants = [...new Set([repoPath, normalizeContextPath(repoPath)])];
    for (const variant of repoVariants) {
      redacted = redacted.replace(new RegExp(escapeRegex(variant), 'g'), workspacePathReplacement);
    }
  }

  return redacted
    .replace(/(^|[\s"'([{,:])((?:\/(?:Users|home|tmp|var|private|Volumes|opt|srv|etc|mnt|workspace|workspaces)[^\s"'<>()[\]{},;]*)|(?:[A-Za-z]:\\[^\s"'<>()[\]{},;]+))/g, `$1${pathReplacement}`);
}

export function parseContextIgnoreFile(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export function loadContextCaptureIgnoreFile(
  repoPath: string,
  fileName = DEFAULT_CONTEXT_IGNORE_FILE_NAME,
): ContextCaptureIgnoreFile | null {
  const filePath = path.join(path.resolve(repoPath), fileName);
  if (!fs.existsSync(filePath)) return null;
  return {
    path: filePath,
    patterns: parseContextIgnoreFile(fs.readFileSync(filePath, 'utf8')),
  };
}

export function analyzeContextSafety(
  value: unknown,
  redactionSettings: ContextRedactionSettings = {},
): ContextSafetyDiagnostics {
  const text = collectContextText(value);
  const findings: ContextSafetyFinding[] = [];

  for (const pattern of normalizeContextRedactionSettings(redactionSettings).patterns) {
    if (patternMatches(text, pattern.pattern)) {
      findings.push({ category: 'secret', name: pattern.name });
    }
  }

  for (const pattern of DEFAULT_CONTEXT_REGULATED_DOMAIN_PATTERNS) {
    if (patternMatches(text, pattern.pattern)) {
      findings.push({ category: 'regulated-domain', name: pattern.name });
    }
  }

  const uniqueFindings = uniqueSafetyFindings(findings);
  const securitySensitive = uniqueFindings.some((finding) => finding.category === 'secret');
  const regulatedDomain = uniqueFindings.some((finding) => finding.category === 'regulated-domain');

  return {
    securitySensitive,
    regulatedDomain,
    requiresReview: regulatedDomain,
    findings: uniqueFindings,
  };
}

function contextUserIgnorePaths(settings: ContextIgnoreSettings): string[] {
  let paths = [...(settings.paths ?? [])];
  while (startsWithDefaultIgnorePaths(paths)) {
    paths = paths.slice(DEFAULT_CONTEXT_IGNORE_PATHS.length);
  }
  return paths;
}

function contextUserRedactionPatterns(settings: ContextRedactionSettings): Array<ContextRedactionPattern | string> {
  let patterns = [...(settings.patterns ?? [])];
  while (startsWithDefaultRedactionPatterns(patterns)) {
    patterns = patterns.slice(DEFAULT_CONTEXT_REDACTION_PATTERNS.length);
  }
  return patterns;
}

function startsWithDefaultIgnorePaths(paths: string[]): boolean {
  if (paths.length < DEFAULT_CONTEXT_IGNORE_PATHS.length) return false;
  return DEFAULT_CONTEXT_IGNORE_PATHS.every((pattern, index) => paths[index] === pattern);
}

function startsWithDefaultRedactionPatterns(patterns: Array<ContextRedactionPattern | string>): boolean {
  if (patterns.length < DEFAULT_CONTEXT_REDACTION_PATTERNS.length) return false;
  return DEFAULT_CONTEXT_REDACTION_PATTERNS.every((pattern, index) => {
    const current = patterns[index];
    return typeof current !== 'string' && current.name === pattern.name && current.pattern === pattern.pattern;
  });
}

function patternMatches(text: string, pattern: string): boolean {
  if (!text) return false;
  try {
    return new RegExp(pattern, 'i').test(text);
  } catch {
    return false;
  }
}

function uniqueSafetyFindings(findings: ContextSafetyFinding[]): ContextSafetyFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.category}:${finding.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectContextText(value: unknown, seen = new WeakSet<object>()): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return value.map((item) => collectContextText(item, seen)).join('\n');
  if (typeof value === 'object') {
    if (seen.has(value)) return '';
    seen.add(value);
    const record = value as Record<string, unknown>;
    return Object.keys(record).sort().map((key) => `${key}\n${collectContextText(record[key], seen)}`).join('\n');
  }
  return '';
}

function positiveNumberOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveContextPathForComparison(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function resolveWorkspaceComparablePath(rawWorkspaceRoot: string, workspaceRoot: string, rawAbsolutePath: string): string {
  const relativeToRawRoot = path.relative(rawWorkspaceRoot, rawAbsolutePath);
  if (relativeToRawRoot === '') return workspaceRoot;
  if (!relativeToRawRoot.startsWith(`..${path.sep}`) && relativeToRawRoot !== '..' && !path.isAbsolute(relativeToRawRoot)) {
    return path.resolve(workspaceRoot, relativeToRawRoot);
  }
  return resolveContextPathForComparison(rawAbsolutePath);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function prepareIgnorePattern(rawPattern: string): { pattern: string; negated: boolean } | null {
  let pattern = normalizeContextPath(rawPattern.trim());
  if (!pattern || pattern.startsWith('#')) return null;

  const negated = pattern.startsWith('!');
  if (negated) pattern = pattern.slice(1);
  pattern = pattern.replace(/^\//, '');
  if (!pattern || pattern.startsWith('#')) return null;
  if (pattern.endsWith('/')) pattern = `${pattern}**`;

  return { pattern, negated };
}

function globMatches(value: string, pattern: string): boolean {
  if (pattern === value) return true;

  if (!pattern.includes('/')) {
    return value.split('/').some((segment) => globMatchesAnchored(segment, pattern));
  }

  if (globMatchesAnchored(value, pattern)) return true;
  return !pattern.startsWith('**/') && globMatchesAnchored(value, `**/${pattern}`);
}

function globMatchesAnchored(value: string, pattern: string): boolean {
  if (pattern === value) return true;
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    if (!prefix.includes('*')) {
      return value === prefix.slice(0, -1) || value.startsWith(prefix);
    }
  }

  const regex = new RegExp(`^${globToRegexSource(pattern)}$`);
  return regex.test(value);
}

function globToRegexSource(pattern: string): string {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];
    if (char === '*' && next === '*' && afterNext === '/') {
      source += '(?:.*/)?';
      index += 2;
    } else if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return source;
}
