/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * context-safety.ts — US-005 shared safety primitives for the Context
 * Intelligence Platform.
 *
 * This is a Foundations (Wave 1) module: it is consumed by virtually every
 * store / compose / capture story (hydration, retrieval excerpts, the capture
 * sidecar, ingestion routes, candidate governance) before any content is
 * persisted to the Rorca DB or composed into a prompt. See
 * `docs/context-intelligence-platform.md` §6 (Shared Contracts).
 *
 * It is intentionally **dependency-free** (only node `crypto` / `path` / `fs`)
 * and **pure** — no DB connection, no network, no global state. Every function
 * is deterministic so it can be unit-tested and reasoned about in isolation.
 *
 * Five capabilities:
 *   1. Path normalization → workspace-relative POSIX paths + traversal rejection
 *   2. Ignore rules → built-in excludes + `.rorca-captureignore` (gitignore-style)
 *   3. File size caps → bounded reads / payloads
 *   4. Content hashing → stable provenance / cache keys
 *   5. Secret redaction → keys / tokens / private keys / database URLs
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { PayloadTooLargeError, ValidationError } from './errors';

// ════════════════════════════════════════════════════════════════════════════
// 1. PATH NORMALIZATION & TRAVERSAL PROTECTION
// ════════════════════════════════════════════════════════════════════════════

/** Convert any OS path separator to POSIX `/`. Does not resolve `..`. */
export function toPosixPath(input: string): string {
  return input.replace(/\\/g, '/');
}

/** Result of a non-throwing workspace-relative path resolution. */
export type SafePathResult =
  | { ok: true; relPath: string; absPath: string }
  | { ok: false; reason: string };

/**
 * Resolve `target` (absolute or workspace-relative) to a normalized
 * **workspace-relative POSIX** path, rejecting anything that escapes the
 * workspace root via `..`, an absolute path outside the root, or a NUL byte.
 *
 * Non-throwing variant — returns a discriminated result. Use
 * {@link normalizeWorkspaceRelativePath} when you want an exception.
 *
 * Resolution is **logical** (string/`path` based). It does not follow symlinks,
 * so callers that resolve untrusted symlinks on disk should additionally
 * `fs.realpath` and re-check containment. The workspace root itself normalizes
 * to `'.'`.
 */
export function safeWorkspaceRelativePath(workspaceRoot: string, target: string): SafePathResult {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
    return { ok: false, reason: 'workspace root is empty' };
  }
  if (typeof target !== 'string' || target.length === 0) {
    return { ok: false, reason: 'path is empty' };
  }
  if (target.includes('\0') || workspaceRoot.includes('\0')) {
    return { ok: false, reason: 'path contains a NUL byte' };
  }

  // Normalize the root to an absolute, separator-consistent base.
  const absRoot = path.resolve(workspaceRoot);

  // A relative target is resolved against the root; an absolute target is used
  // as-is (and must still fall inside the root once resolved).
  const absTarget = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(absRoot, target);

  // path.relative gives the shortest route from root to target. If it has to
  // climb out (`..`) or stays absolute (different drive), the target escapes.
  let rel = path.relative(absRoot, absTarget);

  if (rel === '') {
    // target === root
    return { ok: true, relPath: '.', absPath: absTarget };
  }
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return { ok: false, reason: 'path escapes the workspace root' };
  }

  rel = toPosixPath(rel);
  return { ok: true, relPath: rel, absPath: absTarget };
}

/**
 * Throwing form of {@link safeWorkspaceRelativePath}. Returns the normalized
 * workspace-relative POSIX path or throws {@link ValidationError} (HTTP 400)
 * on traversal / invalid input. Use this at route / persistence boundaries.
 */
export function normalizeWorkspaceRelativePath(workspaceRoot: string, target: string): string {
  const result = safeWorkspaceRelativePath(workspaceRoot, target);
  if (!result.ok) {
    throw new ValidationError(`Unsafe path rejected: ${result.reason}`, {
      target,
      reason: result.reason,
    });
  }
  return result.relPath;
}

/** True iff `target` resolves to a location inside (or equal to) `workspaceRoot`. */
export function isWithinWorkspace(workspaceRoot: string, target: string): boolean {
  return safeWorkspaceRelativePath(workspaceRoot, target).ok;
}

// ════════════════════════════════════════════════════════════════════════════
// 2. IGNORE RULES (built-in excludes + .rorca-captureignore)
// ════════════════════════════════════════════════════════════════════════════

/** Filename, at the workspace root, that augments the built-in ignore list. */
export const CAPTURE_IGNORE_FILENAME = '.rorca-captureignore';

/**
 * Built-in excludes applied to every capture / hydration / composition walk.
 * Gitignore-style patterns. Covers VCS, dependency dirs, build/generated
 * outputs, vendored code, secrets, and `.env*` files.
 */
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = Object.freeze([
  // ── version control ──
  '.git/',
  '.hg/',
  '.svn/',
  // ── dependency / vendor directories ──
  'node_modules/',
  'vendor/',
  'bower_components/',
  '.pnp/',
  '.yarn/',
  // ── build / generated outputs ──
  'dist/',
  'build/',
  'target/',
  'out/',
  'bin/',
  'obj/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.turbo/',
  '.cache/',
  'coverage/',
  '__pycache__/',
  '*.pyc',
  'generated/',
  '*.generated.*',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.lock', // lockfiles (package-lock.json handled below) are noisy generated output
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  // ── secrets / credentials ──
  'secrets/',
  '.secrets/',
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.keystore',
  '*.jks',
  '*.crt',
  '*.cer',
  '*.der',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  '*.secret',
  // ── OS / editor noise ──
  '.DS_Store',
  'Thumbs.db',
]);

/** A compiled ignore rule. */
interface IgnoreRule {
  /** Original source pattern (for debugging). */
  source: string;
  /** Whether this is a re-include (`!pattern`). */
  negated: boolean;
  /** Compiled matcher against a POSIX, workspace-relative path. */
  regex: RegExp;
}

/** A reusable, order-aware ignore matcher. */
export interface IgnoreMatcher {
  /** Number of compiled rules (built-in + extra). */
  readonly ruleCount: number;
  /**
   * True iff `relPath` (workspace-relative; absolute paths are normalized when a
   * root is known) should be ignored. Evaluation is gitignore-style: the last
   * matching rule wins, so a later `!pattern` re-includes a path.
   */
  ignores(relPath: string): boolean;
}

/** Escape a single literal character for embedding in a RegExp source. */
function escapeRegexChar(ch: string): string {
  return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Translate the *body* of a gitignore glob (no leading/trailing slash, no `!`)
 * into a RegExp source fragment. Supports `*` (within a segment), `**`
 * (across segments), and `?`. Character classes are treated literally.
 */
function globBodyToRegExpSource(glob: string): string {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*') {
      let stars = 1;
      while (glob[i + stars] === '*') stars++;
      const before = i === 0 ? '/' : glob[i - 1];
      const afterIdx = i + stars;
      const after = afterIdx < glob.length ? glob[afterIdx] : '/';
      if (stars >= 2 && before === '/' && after === '/') {
        // `a/**/b` → zero or more intermediate path segments
        out += '(?:.+/)?';
        i = afterIdx + 1; // also consume the slash after **
        continue;
      }
      if (stars >= 2 && before === '/' && afterIdx >= glob.length) {
        // trailing `a/**` → everything beneath
        out += '.*';
        i = afterIdx;
        continue;
      }
      // single `*` (or `**` that isn't a whole segment) → within one segment
      out += '[^/]*';
      i = afterIdx;
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    out += escapeRegexChar(ch);
    i += 1;
  }
  return out;
}

/** Compile a single gitignore line into a rule, or `null` if it is blank/comment. */
function compileIgnorePattern(rawLine: string): IgnoreRule | null {
  // Trailing whitespace is insignificant in gitignore (unless escaped — we keep
  // the common case simple and just trim it).
  let line = rawLine.replace(/\s+$/, '');
  if (line === '' || line.startsWith('#')) return null;

  const source = line;

  let negated = false;
  if (line.startsWith('!')) {
    negated = true;
    line = line.slice(1);
  }
  // `\#` / `\!` escape a literal leading char.
  if (line.startsWith('\\#') || line.startsWith('\\!')) {
    line = line.slice(1);
  }

  if (line.endsWith('/')) {
    line = line.slice(0, -1);
  }

  const leadingSlash = line.startsWith('/');
  if (leadingSlash) line = line.slice(1);
  // A separator at the start or middle anchors the pattern to the root;
  // otherwise it may match at any depth.
  const anchored = leadingSlash || line.includes('/');

  if (line === '') return null;

  const body = globBodyToRegExpSource(line);
  const prefix = anchored ? '^' : '(?:^|.*/)';
  // Match the path itself and anything beneath it (so a dir pattern also
  // ignores its contents).
  const suffix = '(?:/.*)?$';

  return { source, negated, regex: new RegExp(prefix + body + suffix) };
}

/** Normalize a relative path for matching: POSIX, no leading `./` or `/`. */
function normalizeForMatch(relPath: string): string {
  let p = toPosixPath(relPath).trim();
  p = p.replace(/^\.\/+/, '');
  p = p.replace(/^\/+/, '');
  return p;
}

class CompiledIgnoreMatcher implements IgnoreMatcher {
  private readonly rules: IgnoreRule[];

  constructor(rules: IgnoreRule[]) {
    this.rules = rules;
  }

  get ruleCount(): number {
    return this.rules.length;
  }

  ignores(relPath: string): boolean {
    const p = normalizeForMatch(relPath);
    if (p === '' || p === '.') return false;
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.regex.test(p)) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  }
}

/** Options for building an {@link IgnoreMatcher}. */
export interface IgnoreMatcherOptions {
  /** Prepend {@link DEFAULT_IGNORE_PATTERNS}. Default: `true`. */
  includeDefaults?: boolean;
  /** Extra gitignore-style patterns (e.g. from `.rorca-captureignore`). */
  extraPatterns?: readonly string[];
}

/**
 * Build an {@link IgnoreMatcher} from the built-in excludes plus any extra
 * patterns. Defaults come first so user `!` re-includes can override them.
 */
export function createIgnoreMatcher(options: IgnoreMatcherOptions = {}): IgnoreMatcher {
  const { includeDefaults = true, extraPatterns = [] } = options;
  const sources: string[] = [
    ...(includeDefaults ? DEFAULT_IGNORE_PATTERNS : []),
    ...extraPatterns,
  ];
  const rules: IgnoreRule[] = [];
  for (const src of sources) {
    const rule = compileIgnorePattern(src);
    if (rule) rules.push(rule);
  }
  return new CompiledIgnoreMatcher(rules);
}

/** Parse `.rorca-captureignore` file contents into pattern lines. */
export function parseCaptureIgnore(contents: string): string[] {
  return contents
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l !== '' && !l.startsWith('#'));
}

/**
 * Load an {@link IgnoreMatcher} for a workspace: built-in excludes plus the
 * patterns in `<workspaceRoot>/.rorca-captureignore` if it exists. Missing or
 * unreadable ignore files degrade silently to the built-in defaults.
 */
export function loadCaptureIgnore(
  workspaceRoot: string,
  options: { includeDefaults?: boolean } = {},
): IgnoreMatcher {
  const { includeDefaults = true } = options;
  let extraPatterns: string[] = [];
  try {
    const ignorePath = path.join(workspaceRoot, CAPTURE_IGNORE_FILENAME);
    if (fs.existsSync(ignorePath)) {
      extraPatterns = parseCaptureIgnore(fs.readFileSync(ignorePath, 'utf8'));
    }
  } catch {
    // Non-fatal: an unreadable ignore file must never break a capture walk.
    extraPatterns = [];
  }
  return createIgnoreMatcher({ includeDefaults, extraPatterns });
}

// ════════════════════════════════════════════════════════════════════════════
// 3. FILE SIZE CAPS
// ════════════════════════════════════════════════════════════════════════════

/** Default per-file byte cap (1 MiB) for captured / composed content. */
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

/** Environment variable that overrides {@link DEFAULT_MAX_FILE_BYTES}. */
export const MAX_FILE_BYTES_ENV = 'RORCA_CAPTURE_MAX_FILE_BYTES';

/**
 * Resolve the effective per-file byte cap: explicit `override` →
 * `RORCA_CAPTURE_MAX_FILE_BYTES` → {@link DEFAULT_MAX_FILE_BYTES}. Non-positive
 * or non-numeric values fall through to the default.
 */
export function getMaxFileBytes(override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const envRaw = process.env[MAX_FILE_BYTES_ENV];
  if (envRaw) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return DEFAULT_MAX_FILE_BYTES;
}

/** UTF-8 byte length of a string, or `.length` of a Buffer. */
export function byteLength(content: string | Buffer): number {
  return typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.length;
}

/** Coerce a size input (raw byte count, string, or Buffer) to a byte count. */
function toByteCount(size: number | string | Buffer): number {
  if (typeof size === 'number') return size;
  return byteLength(size);
}

/** True iff the content / byte count exceeds the (resolved) cap. */
export function exceedsSizeCap(size: number | string | Buffer, cap?: number): boolean {
  return toByteCount(size) > getMaxFileBytes(cap);
}

/**
 * Throw {@link PayloadTooLargeError} (HTTP 413) if the content exceeds the cap.
 * Returns the byte count when within bounds.
 */
export function assertWithinSizeCap(
  size: number | string | Buffer,
  cap?: number,
  label = 'content',
): number {
  const bytes = toByteCount(size);
  const limit = getMaxFileBytes(cap);
  if (bytes > limit) {
    throw new PayloadTooLargeError(
      `${label} is ${bytes} bytes, exceeding the ${limit}-byte cap`,
    );
  }
  return bytes;
}

// ════════════════════════════════════════════════════════════════════════════
// 4. CONTENT HASHING
// ════════════════════════════════════════════════════════════════════════════

/** Supported hash algorithms for content fingerprints. */
export type HashAlgorithm = 'sha256' | 'sha1' | 'sha512' | 'md5';

/** Hex digest of `content` (default `sha256`). Stable across runs. */
export function hashContent(content: string | Buffer, algorithm: HashAlgorithm = 'sha256'): string {
  return createHash(algorithm).update(content).digest('hex');
}

/** Algorithm-prefixed digest, e.g. `sha256:ab12…`. Convenient for provenance. */
export function contentDigest(content: string | Buffer, algorithm: HashAlgorithm = 'sha256'): string {
  return `${algorithm}:${hashContent(content, algorithm)}`;
}

/** First `length` hex chars of the sha256 digest (default 12) — for cache keys. */
export function shortHash(content: string | Buffer, length = 12): string {
  return hashContent(content, 'sha256').slice(0, Math.max(1, length));
}

// ════════════════════════════════════════════════════════════════════════════
// 5. SECRET REDACTION (keys / tokens / private keys / database URLs)
// ════════════════════════════════════════════════════════════════════════════

/** A single redaction occurrence (never carries the full secret). */
export interface RedactionFinding {
  /** Category of the matched secret. */
  type: string;
  /** Safe preview — head/tail only, or `[REDACTED]` for short values. */
  preview: string;
}

/** Result of redacting a string. */
export interface RedactionResult {
  /** Input with every detected secret replaced by the placeholder. */
  redacted: string;
  /** One entry per redacted occurrence (order of detection). */
  findings: RedactionFinding[];
  /** Total number of redactions (== `findings.length`). */
  redactionCount: number;
  /** Occurrence counts grouped by `type`. */
  byType: Record<string, number>;
}

/** Options controlling redaction output. */
export interface RedactionOptions {
  /** Replacement marker. Default `'[REDACTED]'`. */
  placeholder?: string;
}

/** Build a non-reversible preview of a matched secret (head/tail only). */
function buildPreview(value: string): string {
  if (value.length <= 8) return '[REDACTED]';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/**
 * A secret pattern. `replace` lets assignment-style patterns keep the key name
 * while redacting only the value; `previewSource` selects which capture group
 * is previewed (defaults to the whole match).
 */
interface SecretPattern {
  type: string;
  regex: RegExp;
  replace?: (match: RegExpMatchArray, placeholder: string) => string;
  previewGroup?: number;
}

/**
 * Ordered registry. PEM blocks and connection strings run before narrower
 * token patterns so a database URL is redacted whole rather than piecemeal.
 */
const SECRET_PATTERNS: SecretPattern[] = [
  // 1. PEM private key blocks (RSA/EC/DSA/OpenSSH/PGP/encrypted).
  {
    type: 'private_key',
    regex:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
  },
  // 2. Database connection strings (with or without embedded credentials).
  {
    type: 'database_url',
    regex:
      /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|sqlserver|cockroachdb|clickhouse|cassandra):\/\/[^\s"'`<>]+/gi,
  },
  // 3. Any URL carrying user:password@host credentials.
  {
    type: 'url_with_credentials',
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'`]+:[^\s/@"'`]+@[^\s"'`<>]+/gi,
  },
  // 4. AWS access key IDs.
  {
    type: 'aws_access_key_id',
    regex: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|A3T[A-Z0-9])[A-Z0-9]{12,20}\b/g,
  },
  // 5. GitHub tokens (PAT v1/v2, OAuth, server, refresh).
  {
    type: 'github_token',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g,
  },
  // 6. Slack tokens.
  {
    type: 'slack_token',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  // 7. Google API keys.
  {
    type: 'google_api_key',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  // 8. Stripe-style live/test keys.
  {
    type: 'stripe_key',
    regex: /\b[rs]k_(?:live|test)_[0-9A-Za-z]{10,}\b/g,
  },
  // 9. OpenAI / Anthropic style secret keys (sk-, sk-ant-, pk-).
  {
    type: 'api_key',
    regex: /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|pk-[A-Za-z0-9_-]{16,})\b/g,
  },
  // 10. JWTs (header.payload.signature, all base64url).
  {
    type: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  // 11. Bearer authorization headers.
  {
    type: 'bearer_token',
    regex: /\bBearer\s+[A-Za-z0-9._\-+/]{16,}={0,2}/g,
    previewGroup: 0,
  },
  // 12. Assignment-style secrets: `password = "…"`, `api_key: …`, etc.
  //     Keeps the key + delimiter, redacts only the value.
  {
    type: 'secret_assignment',
    regex:
      /\b([A-Za-z0-9_.-]*?(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|access[_-]?key|token))\b(\s*[:=]\s*)(["']?)([^\s"'`]{6,})\3/gi,
    replace: (m, placeholder) => `${m[1]}${m[2]}${m[3]}${placeholder}${m[3]}`,
    previewGroup: 4,
  },
  // 13. Natural-language password disclosure: `password is hunter2`, `pwd was …`.
  //     Narrowly scoped to password-family keywords plus an `is`/`was` linker
  //     (the `:`/`=` form is already handled above) so spoken-form passwords are
  //     redacted without broadly over-redacting unrelated prose.
  {
    type: 'password_phrase',
    regex: /\b(password|passphrase|passwd|pwd)(\s+(?:is|was)\s+)(["']?)([^\s"'`]{6,})\3/gi,
    replace: (m, placeholder) => `${m[1]}${m[2]}${m[3]}${placeholder}${m[3]}`,
    previewGroup: 4,
  },
];

/**
 * Redact secrets (API keys, tokens, private keys, database / credentialed URLs)
 * from a string. Returns the cleaned string plus non-reversible findings.
 */
export function redactSecrets(input: string, options: RedactionOptions = {}): RedactionResult {
  const placeholder = options.placeholder ?? '[REDACTED]';
  const findings: RedactionFinding[] = [];
  const byType: Record<string, number> = {};

  if (typeof input !== 'string' || input.length === 0) {
    return { redacted: input ?? '', findings, redactionCount: 0, byType };
  }

  let result = input;
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    result = result.replace(pattern.regex, (...args) => {
      // String.replace callback: (match, p1, p2, …, offset, string[, groups]).
      // Drop the trailing offset/string/groups to recover the match array.
      const match = args.slice(0, -2) as unknown as RegExpMatchArray;
      const previewSource =
        pattern.previewGroup !== undefined ? match[pattern.previewGroup] ?? match[0] : match[0];
      findings.push({ type: pattern.type, preview: buildPreview(String(previewSource)) });
      byType[pattern.type] = (byType[pattern.type] ?? 0) + 1;
      return pattern.replace ? pattern.replace(match, placeholder) : placeholder;
    });
  }

  return { redacted: result, findings, redactionCount: findings.length, byType };
}

/**
 * Key names whose value should be redacted wholesale in a structured payload,
 * regardless of the value's shape (e.g. `{ "password": "literally anything" }`).
 */
export const SENSITIVE_KEY_PATTERN =
  /(password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|credential|connection[_-]?string|database[_-]?url|db[_-]?url|\bdsn\b|\btoken\b|\bbearer\b)/i;

/** Result of redacting a structured value. */
export interface RedactObjectResult {
  /** Deep copy with secrets redacted (input is never mutated). */
  value: unknown;
  findings: RedactionFinding[];
  redactionCount: number;
}

/**
 * Deep-redact a JSON-like value before persistence or prompt composition.
 *
 * - String values are scrubbed with {@link redactSecrets}.
 * - Any value (string or number) under a key matching
 *   {@link SENSITIVE_KEY_PATTERN} is replaced wholesale, even if it has no
 *   recognizable secret shape.
 * - Arrays and nested objects are walked recursively. The input is not mutated.
 */
export function redactObject(value: unknown, options: RedactionOptions = {}): RedactObjectResult {
  const placeholder = options.placeholder ?? '[REDACTED]';
  const findings: RedactionFinding[] = [];

  const walk = (node: unknown, keyHint?: string): unknown => {
    if (typeof node === 'string') {
      if (keyHint && SENSITIVE_KEY_PATTERN.test(keyHint)) {
        findings.push({ type: `sensitive_key:${keyHint}`, preview: buildPreview(node) });
        return placeholder;
      }
      const { redacted, findings: stringFindings } = redactSecrets(node, options);
      findings.push(...stringFindings);
      return redacted;
    }

    if (typeof node === 'number' || typeof node === 'bigint') {
      if (keyHint && SENSITIVE_KEY_PATTERN.test(keyHint)) {
        findings.push({ type: `sensitive_key:${keyHint}`, preview: '[REDACTED]' });
        return placeholder;
      }
      return node;
    }

    if (Array.isArray(node)) {
      return node.map((item) => walk(item, keyHint));
    }

    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = walk(v, k);
      }
      return out;
    }

    return node; // boolean, null, undefined, function — pass through
  };

  const redactedValue = walk(value);
  return { value: redactedValue, findings, redactionCount: findings.length };
}


// ════════════════════════════════════════════════════════════════════════════
// 6. TASK-MANIFEST CONTEXT SAFETY (bounded manifest/prompt response helpers)
// ════════════════════════════════════════════════════════════════════════════

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

const HIGH_ENTROPY_TOKEN_PATTERN = /[A-Za-z0-9._~+=-]{20,}/g;
const UUID_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function withDefaultContextSafetyOptions(options: ContextSafetyOptions = {}): Required<ContextSafetyOptions> {
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
  const redacted = redactSecrets(value);
  if (redacted.redactionCount > 0) {
    return Object.keys(redacted.byType)[0] ?? 'secret';
  }

  if (findHighEntropySecretToken(value)) {
    return 'high entropy token';
  }

  return null;
}

export function redactSecretLikeStrings(value: string): string {
  const redacted = redactSecrets(value).redacted;
  HIGH_ENTROPY_TOKEN_PATTERN.lastIndex = 0;
  return redacted.replace(HIGH_ENTROPY_TOKEN_PATTERN, (candidate) => (
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
  options: Pick<Required<ContextSafetyOptions>, 'maxRawLineCount' | 'maxRawTextChars'> = withDefaultContextSafetyOptions(),
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
  const opts = withDefaultContextSafetyOptions(options);
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

function collectIssues(
  value: unknown,
  issuePath: Array<string | number>,
  options: Required<ContextSafetyOptions>,
  issues: ContextSafetyIssue[],
): void {
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
  const opts = withDefaultContextSafetyOptions(options);
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

export const CONTEXT_RESPONSE_LIMITS = {
  maxStringChars: 1_000,
  maxPathChars: 512,
  maxArrayItems: 25,
  maxObjectKeys: 40,
  maxDepth: 6,
} as const;

export interface ContextResponseSafetyOptions extends ContextSafetyOptions {
  maxPathChars?: number;
  maxObjectKeys?: number;
  maxDepth?: number;
}

export interface ContextSafeStringResult {
  value: string;
  truncated: boolean;
  redacted: boolean;
}

export interface ContextSafePathListResult {
  items: string[];
  omittedUnsafe: number;
  omittedOverflow: number;
  truncated: boolean;
  redacted: boolean;
}

function contextResponseOptions(options: ContextResponseSafetyOptions = {}) {
  const base = withDefaultContextSafetyOptions({
    ...options,
    maxStringChars: options.maxStringChars ?? CONTEXT_RESPONSE_LIMITS.maxStringChars,
    maxArrayItems: options.maxArrayItems ?? CONTEXT_RESPONSE_LIMITS.maxArrayItems,
  });
  return {
    ...base,
    maxPathChars: options.maxPathChars ?? CONTEXT_RESPONSE_LIMITS.maxPathChars,
    maxObjectKeys: options.maxObjectKeys ?? CONTEXT_RESPONSE_LIMITS.maxObjectKeys,
    maxDepth: options.maxDepth ?? CONTEXT_RESPONSE_LIMITS.maxDepth,
  };
}

export function contextSafeString(value: unknown, options: ContextResponseSafetyOptions = {}): ContextSafeStringResult {
  const opts = contextResponseOptions(options);
  const input = String(value ?? '');
  const redactedValue = redactSecretLikeStrings(input).replace(/\r\n/g, '\n');
  const truncated = redactedValue.length > opts.maxStringChars;
  const valueOut = truncated
    ? `${redactedValue.slice(0, opts.maxStringChars)}… [truncated ${redactedValue.length - opts.maxStringChars} chars]`
    : redactedValue;

  return {
    value: valueOut,
    truncated,
    redacted: redactedValue !== input,
  };
}

export function contextSafeRelativePath(value: unknown, options: ContextResponseSafetyOptions = {}): ContextSafeStringResult | null {
  if (typeof value !== 'string') return null;
  const opts = contextResponseOptions(options);
  const safe = contextSafeString(value, { ...opts, maxStringChars: opts.maxPathChars });
  return isSafeRelativePath(safe.value) ? safe : null;
}

export function contextSafeRelativePathList(values: unknown, options: ContextResponseSafetyOptions = {}): ContextSafePathListResult {
  const opts = contextResponseOptions(options);
  const input = Array.isArray(values) ? values : [];
  const items: string[] = [];
  let omittedUnsafe = 0;
  let redacted = false;
  let truncated = input.length > opts.maxArrayItems;

  for (const candidate of input.slice(0, opts.maxArrayItems)) {
    const safe = contextSafeRelativePath(candidate, opts);
    if (!safe) {
      omittedUnsafe += 1;
      continue;
    }
    items.push(safe.value);
    redacted = redacted || safe.redacted;
    truncated = truncated || safe.truncated;
  }

  return {
    items,
    omittedUnsafe,
    omittedOverflow: Math.max(0, input.length - opts.maxArrayItems),
    truncated,
    redacted,
  };
}

export function sanitizeContextResponseValue(
  value: unknown,
  options: ContextResponseSafetyOptions = {},
  depth = 0,
): unknown {
  const opts = contextResponseOptions(options);

  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return contextSafeString(value, opts).value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return contextSafeString(String(value), opts).value;

  if (depth >= opts.maxDepth) {
    return `[TRUNCATED:max depth ${opts.maxDepth}]`;
  }

  if (Array.isArray(value)) {
    const items = value.slice(0, opts.maxArrayItems).map((item) => sanitizeContextResponseValue(item, opts, depth + 1));
    if (value.length > opts.maxArrayItems) {
      items.push(`[TRUNCATED:${value.length - opts.maxArrayItems} additional items]`);
    }
    return items;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const output: Record<string, unknown> = {};
  for (const [key, nested] of entries.slice(0, opts.maxObjectKeys)) {
    output[key] = sanitizeContextResponseValue(nested, opts, depth + 1);
  }
  if (entries.length > opts.maxObjectKeys) {
    output._truncatedKeys = entries.length - opts.maxObjectKeys;
  }
  return output;
}
