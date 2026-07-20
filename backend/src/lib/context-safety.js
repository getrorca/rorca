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
export function toPosixPath(input) {
    return input.replace(/\\/g, '/');
}
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
export function safeWorkspaceRelativePath(workspaceRoot, target) {
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
export function normalizeWorkspaceRelativePath(workspaceRoot, target) {
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
export function isWithinWorkspace(workspaceRoot, target) {
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
export const DEFAULT_IGNORE_PATTERNS = Object.freeze([
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
/** Escape a single literal character for embedding in a RegExp source. */
function escapeRegexChar(ch) {
    return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}
/**
 * Translate the *body* of a gitignore glob (no leading/trailing slash, no `!`)
 * into a RegExp source fragment. Supports `*` (within a segment), `**`
 * (across segments), and `?`. Character classes are treated literally.
 */
function globBodyToRegExpSource(glob) {
    let out = '';
    let i = 0;
    while (i < glob.length) {
        const ch = glob[i];
        if (ch === '*') {
            let stars = 1;
            while (glob[i + stars] === '*')
                stars++;
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
function compileIgnorePattern(rawLine) {
    // Trailing whitespace is insignificant in gitignore (unless escaped — we keep
    // the common case simple and just trim it).
    let line = rawLine.replace(/\s+$/, '');
    if (line === '' || line.startsWith('#'))
        return null;
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
    if (leadingSlash)
        line = line.slice(1);
    // A separator at the start or middle anchors the pattern to the root;
    // otherwise it may match at any depth.
    const anchored = leadingSlash || line.includes('/');
    if (line === '')
        return null;
    const body = globBodyToRegExpSource(line);
    const prefix = anchored ? '^' : '(?:^|.*/)';
    // Match the path itself and anything beneath it (so a dir pattern also
    // ignores its contents).
    const suffix = '(?:/.*)?$';
    return { source, negated, regex: new RegExp(prefix + body + suffix) };
}
/** Normalize a relative path for matching: POSIX, no leading `./` or `/`. */
function normalizeForMatch(relPath) {
    let p = toPosixPath(relPath).trim();
    p = p.replace(/^\.\/+/, '');
    p = p.replace(/^\/+/, '');
    return p;
}
class CompiledIgnoreMatcher {
    rules;
    constructor(rules) {
        this.rules = rules;
    }
    get ruleCount() {
        return this.rules.length;
    }
    ignores(relPath) {
        const p = normalizeForMatch(relPath);
        if (p === '' || p === '.')
            return false;
        let ignored = false;
        for (const rule of this.rules) {
            if (rule.regex.test(p)) {
                ignored = !rule.negated;
            }
        }
        return ignored;
    }
}
/**
 * Build an {@link IgnoreMatcher} from the built-in excludes plus any extra
 * patterns. Defaults come first so user `!` re-includes can override them.
 */
export function createIgnoreMatcher(options = {}) {
    const { includeDefaults = true, extraPatterns = [] } = options;
    const sources = [
        ...(includeDefaults ? DEFAULT_IGNORE_PATTERNS : []),
        ...extraPatterns,
    ];
    const rules = [];
    for (const src of sources) {
        const rule = compileIgnorePattern(src);
        if (rule)
            rules.push(rule);
    }
    return new CompiledIgnoreMatcher(rules);
}
/** Parse `.rorca-captureignore` file contents into pattern lines. */
export function parseCaptureIgnore(contents) {
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
export function loadCaptureIgnore(workspaceRoot, options = {}) {
    const { includeDefaults = true } = options;
    let extraPatterns = [];
    try {
        const ignorePath = path.join(workspaceRoot, CAPTURE_IGNORE_FILENAME);
        if (fs.existsSync(ignorePath)) {
            extraPatterns = parseCaptureIgnore(fs.readFileSync(ignorePath, 'utf8'));
        }
    }
    catch {
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
export function getMaxFileBytes(override) {
    if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
        return Math.floor(override);
    }
    const envRaw = process.env[MAX_FILE_BYTES_ENV];
    if (envRaw) {
        const parsed = Number(envRaw);
        if (Number.isFinite(parsed) && parsed > 0)
            return Math.floor(parsed);
    }
    return DEFAULT_MAX_FILE_BYTES;
}
/** UTF-8 byte length of a string, or `.length` of a Buffer. */
export function byteLength(content) {
    return typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.length;
}
/** Coerce a size input (raw byte count, string, or Buffer) to a byte count. */
function toByteCount(size) {
    if (typeof size === 'number')
        return size;
    return byteLength(size);
}
/** True iff the content / byte count exceeds the (resolved) cap. */
export function exceedsSizeCap(size, cap) {
    return toByteCount(size) > getMaxFileBytes(cap);
}
/**
 * Throw {@link PayloadTooLargeError} (HTTP 413) if the content exceeds the cap.
 * Returns the byte count when within bounds.
 */
export function assertWithinSizeCap(size, cap, label = 'content') {
    const bytes = toByteCount(size);
    const limit = getMaxFileBytes(cap);
    if (bytes > limit) {
        throw new PayloadTooLargeError(`${label} is ${bytes} bytes, exceeding the ${limit}-byte cap`);
    }
    return bytes;
}
/** Hex digest of `content` (default `sha256`). Stable across runs. */
export function hashContent(content, algorithm = 'sha256') {
    return createHash(algorithm).update(content).digest('hex');
}
/** Algorithm-prefixed digest, e.g. `sha256:ab12…`. Convenient for provenance. */
export function contentDigest(content, algorithm = 'sha256') {
    return `${algorithm}:${hashContent(content, algorithm)}`;
}
/** First `length` hex chars of the sha256 digest (default 12) — for cache keys. */
export function shortHash(content, length = 12) {
    return hashContent(content, 'sha256').slice(0, Math.max(1, length));
}
/**
 * Stream a file through the shared hashing primitive without loading it into
 * memory. Security-sensitive archive verifiers use this instead of creating
 * ad-hoc hash implementations outside context-safety.
 */
export async function hashFileContent(filePath, algorithm = 'sha256') {
    const hash = createHash(algorithm);
    const stream = fs.createReadStream(filePath);
    for await (const chunk of stream) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}
/** Build a non-reversible preview of a matched secret (head/tail only). */
function buildPreview(value) {
    if (value.length <= 8)
        return '[REDACTED]';
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
/**
 * Ordered registry. PEM blocks and connection strings run before narrower
 * token patterns so a database URL is redacted whole rather than piecemeal.
 */
const SECRET_PATTERNS = [
    // 1. PEM private key blocks (RSA/EC/DSA/OpenSSH/PGP/encrypted).
    {
        type: 'private_key',
        regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
    },
    // 2. Database connection strings (with or without embedded credentials).
    {
        type: 'database_url',
        regex: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|sqlserver|cockroachdb|clickhouse|cassandra):\/\/[^\s"'`<>]+/gi,
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
        regex: /\b([A-Za-z0-9_.-]*?(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|access[_-]?key|token))\b(\s*[:=]\s*)(["']?)([^\s"'`]{6,})\3/gi,
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
export function redactSecrets(input, options = {}) {
    const placeholder = options.placeholder ?? '[REDACTED]';
    const findings = [];
    const byType = {};
    if (typeof input !== 'string' || input.length === 0) {
        return { redacted: input ?? '', findings, redactionCount: 0, byType };
    }
    let result = input;
    for (const pattern of SECRET_PATTERNS) {
        pattern.regex.lastIndex = 0;
        result = result.replace(pattern.regex, (...args) => {
            // String.replace callback: (match, p1, p2, …, offset, string[, groups]).
            // Drop the trailing offset/string/groups to recover the match array.
            const match = args.slice(0, -2);
            const previewSource = pattern.previewGroup !== undefined ? match[pattern.previewGroup] ?? match[0] : match[0];
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
export const SENSITIVE_KEY_PATTERN = /(password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|credential|connection[_-]?string|database[_-]?url|db[_-]?url|\bdsn\b|\btoken\b|\bbearer\b)/i;
/**
 * Deep-redact a JSON-like value before persistence or prompt composition.
 *
 * - String values are scrubbed with {@link redactSecrets}.
 * - Any value (string or number) under a key matching
 *   {@link SENSITIVE_KEY_PATTERN} is replaced wholesale, even if it has no
 *   recognizable secret shape.
 * - Arrays and nested objects are walked recursively. The input is not mutated.
 */
export function redactObject(value, options = {}) {
    const placeholder = options.placeholder ?? '[REDACTED]';
    const findings = [];
    const walk = (node, keyHint) => {
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
            const out = {};
            for (const [k, v] of Object.entries(node)) {
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
};
const HIGH_ENTROPY_TOKEN_PATTERN = /[A-Za-z0-9._~+=-]{20,}/g;
const UUID_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function shannonEntropy(value) {
    const counts = new Map();
    for (const char of value) {
        counts.set(char, (counts.get(char) ?? 0) + 1);
    }
    return [...counts.values()].reduce((entropy, count) => {
        const probability = count / value.length;
        return entropy - probability * Math.log2(probability);
    }, 0);
}
function characterClassCount(value) {
    return [
        /[a-z]/.test(value),
        /[A-Z]/.test(value),
        /\d/.test(value),
        /[^A-Za-z0-9]/.test(value),
    ].filter(Boolean).length;
}
function isHighEntropySecretToken(candidate) {
    if (candidate.length < 20)
        return false;
    if (UUID_TOKEN_PATTERN.test(candidate))
        return false;
    if (/^[a-f0-9]{32,}$/i.test(candidate))
        return false;
    if (!/[A-Z]/.test(candidate) || !/[a-z]/.test(candidate) || !/\d/.test(candidate))
        return false;
    if (characterClassCount(candidate) < 3)
        return false;
    return shannonEntropy(candidate) >= 4;
}
function findHighEntropySecretToken(value) {
    HIGH_ENTROPY_TOKEN_PATTERN.lastIndex = 0;
    let match;
    while ((match = HIGH_ENTROPY_TOKEN_PATTERN.exec(value)) !== null) {
        if (isHighEntropySecretToken(match[0])) {
            return match[0];
        }
    }
    return null;
}
function withDefaultContextSafetyOptions(options = {}) {
    return {
        maxStringChars: options.maxStringChars ?? CONTEXT_SAFETY_LIMITS.maxStringChars,
        maxArrayItems: options.maxArrayItems ?? CONTEXT_SAFETY_LIMITS.maxArrayItems,
        maxSerializedBytes: options.maxSerializedBytes ?? CONTEXT_SAFETY_LIMITS.maxSerializedBytes,
        maxRawTextChars: options.maxRawTextChars ?? CONTEXT_SAFETY_LIMITS.maxRawTextChars,
        maxRawLineCount: options.maxRawLineCount ?? CONTEXT_SAFETY_LIMITS.maxRawLineCount,
    };
}
function serializedBytes(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value), 'utf8');
    }
    catch {
        return Number.POSITIVE_INFINITY;
    }
}
export function detectSecretLikeString(value) {
    const redacted = redactSecrets(value);
    if (redacted.redactionCount > 0) {
        return Object.keys(redacted.byType)[0] ?? 'secret';
    }
    if (findHighEntropySecretToken(value)) {
        return 'high entropy token';
    }
    return null;
}
export function redactSecretLikeStrings(value) {
    const redacted = redactSecrets(value).redacted;
    HIGH_ENTROPY_TOKEN_PATTERN.lastIndex = 0;
    return redacted.replace(HIGH_ENTROPY_TOKEN_PATTERN, (candidate) => (isHighEntropySecretToken(candidate) ? '[REDACTED:high entropy token]' : candidate));
}
export function looksLikeRawPromptBundle(value) {
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
export function looksLikeRawLogBundle(value, options = withDefaultContextSafetyOptions()) {
    const lines = value.split(/\r?\n/);
    if (lines.length <= 8 && value.length <= options.maxRawTextChars) {
        return false;
    }
    const logishLines = lines.filter((line) => (/^\d{4}-\d{2}-\d{2}[T\s]/.test(line)
        || /\b(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\b/.test(line)
        || /^\s+at\s+\S+/.test(line)
        || /^npm ERR!/i.test(line)
        || /^Traceback \(most recent call last\):/.test(line))).length;
    return lines.length > options.maxRawLineCount
        || (value.length > options.maxRawTextChars && logishLines >= 3)
        || (lines.length > 40 && logishLines >= 10);
}
export function getUnsafePathReason(candidate) {
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
export function isSafeRelativePath(candidate) {
    return getUnsafePathReason(candidate) === null;
}
export function checkStringSafety(value, issuePath = [], options = {}) {
    const opts = withDefaultContextSafetyOptions(options);
    const issues = [];
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
function collectIssues(value, issuePath, options, issues) {
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
        Object.entries(value).forEach(([key, nested]) => {
            collectIssues(nested, [...issuePath, key], options, issues);
        });
    }
}
export function collectContextSafetyIssues(value, options = {}) {
    const opts = withDefaultContextSafetyOptions(options);
    const issues = [];
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
};
function contextResponseOptions(options = {}) {
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
export function contextSafeString(value, options = {}) {
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
export function contextSafeRelativePath(value, options = {}) {
    if (typeof value !== 'string')
        return null;
    const opts = contextResponseOptions(options);
    const safe = contextSafeString(value, { ...opts, maxStringChars: opts.maxPathChars });
    return isSafeRelativePath(safe.value) ? safe : null;
}
export function contextSafeRelativePathList(values, options = {}) {
    const opts = contextResponseOptions(options);
    const input = Array.isArray(values) ? values : [];
    const items = [];
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
export function sanitizeContextResponseValue(value, options = {}, depth = 0) {
    const opts = contextResponseOptions(options);
    if (value === null || value === undefined)
        return value ?? null;
    if (typeof value === 'string')
        return contextSafeString(value, opts).value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return value;
    if (typeof value === 'bigint')
        return value.toString();
    if (typeof value !== 'object')
        return contextSafeString(String(value), opts).value;
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
    const entries = Object.entries(value);
    const output = {};
    for (const [key, nested] of entries.slice(0, opts.maxObjectKeys)) {
        output[key] = sanitizeContextResponseValue(nested, opts, depth + 1);
    }
    if (entries.length > opts.maxObjectKeys) {
        output._truncatedKeys = entries.length - opts.maxObjectKeys;
    }
    return output;
}
/** Maximum persisted bytes for one normalized transcript payload. */
export const MAX_TRANSCRIPT_PAYLOAD_BYTES = 16 * 1024;
/**
 * Redact and structurally bound one transcript payload. This is the only
 * transcript sanitization boundary: callers must persist `value`/`serialized`
 * exactly as returned rather than adding writer-local secret rules.
 */
export function sanitizeTranscriptPayload(value, maxBytes = MAX_TRANSCRIPT_PAYLOAD_BYTES) {
    const boundedMax = Math.min(MAX_TRANSCRIPT_PAYLOAD_BYTES, Math.max(512, Math.floor(maxBytes)));
    let originalSerialized;
    try {
        originalSerialized = JSON.stringify(value ?? null);
    }
    catch {
        originalSerialized = JSON.stringify('[UNSERIALIZABLE_TRANSCRIPT_PAYLOAD]');
    }
    let safeValue;
    try {
        // Key-aware redaction must happen before structural truncation. Otherwise a
        // separate `{ password: "..." }` key/value would not look like an inline
        // assignment when the string value is sanitized on its own.
        safeValue = sanitizeContextResponseValue(redactObject(value).value, {
            maxStringChars: 2_000,
            maxArrayItems: 25,
            maxObjectKeys: 40,
            maxDepth: 6,
        });
    }
    catch {
        safeValue = '[UNSERIALIZABLE_TRANSCRIPT_PAYLOAD]';
    }
    let serialized = JSON.stringify(safeValue ?? null);
    let truncated = serialized !== originalSerialized && (serialized.includes('[TRUNCATED:') || serialized.includes('… [truncated '));
    if (Buffer.byteLength(serialized, 'utf8') > boundedMax) {
        const summaryLimit = Math.max(128, Math.min(8_000, boundedMax - 256));
        safeValue = {
            // Summarize the already-redacted structured form, never the raw input.
            summary: contextSafeString(serialized, { maxStringChars: summaryLimit }).value,
            truncated: true,
        };
        serialized = JSON.stringify(safeValue);
        truncated = true;
    }
    // JSON escaping can make the fallback larger than its character cap. Shrink
    // deterministically until the hard byte contract is met.
    if (Buffer.byteLength(serialized, 'utf8') > boundedMax) {
        safeValue = { summary: '[TRUNCATED:payload exceeds byte contract]', truncated: true };
        serialized = JSON.stringify(safeValue);
        truncated = true;
    }
    return {
        value: safeValue,
        serialized,
        bytes: Buffer.byteLength(serialized, 'utf8'),
        redacted: serialized !== originalSerialized && serialized.includes('[REDACTED'),
        truncated,
    };
}
// ════════════════════════════════════════════════════════════════════════════
// 7. PTY OPERATIONAL TELEMETRY (closed, content-free labels)
// ════════════════════════════════════════════════════════════════════════════
export const PTY_BYTE_CLASSES = [
    'observed',
    'archived',
    'transcripted',
    'compacted',
    'dropped',
    'unrecoverable',
];
export const PTY_TELEMETRY_COMPONENTS = [
    'capture',
    'archive',
    'transcript',
    'checkpoint',
    'replay',
    'retention',
];
/**
 * The sole label boundary for PTY metrics. It reconstructs a new object from
 * closed enums rather than redacting arbitrary values, so prompts, terminal
 * content, generation tokens, and paths can never become metric labels.
 */
export function safePtyTelemetryLabels(byteClass, component) {
    if (!PTY_BYTE_CLASSES.includes(byteClass) || !PTY_TELEMETRY_COMPONENTS.includes(component)) {
        throw new ValidationError('Unsupported PTY telemetry label');
    }
    return { byte_class: byteClass, component };
}
/** Keep only bounded numeric diagnostics suitable for logs, SSE, and JSONB. */
export function safePtyTelemetryMeasurements(input) {
    const output = {};
    for (const [key, value] of Object.entries(input).slice(0, 20)) {
        if (!/^[a-z][a-z0-9_]{0,47}$/.test(key))
            continue;
        if (typeof value === 'boolean' || value === null)
            output[key] = value;
        if (typeof value === 'number' && Number.isFinite(value))
            output[key] = Math.max(0, value);
    }
    return output;
}
// ─── Compatibility exports for context-capture sidecar APIs ─────────────────
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
];
export const DEFAULT_CONTEXT_REDACTION_PATTERNS = [
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
        // Provider prefixes are strong enough to redact deliberately shortened
        // canaries as well as full-length credentials.
        pattern: '\\bgh[pousr]_[A-Za-z0-9_]{8,}\\b',
        replacement: '[REDACTED_GITHUB_TOKEN]',
    },
    {
        name: 'slack-token',
        pattern: '\\bxox[baprs]-[A-Za-z0-9-]{8,}\\b',
        replacement: '[REDACTED_SLACK_TOKEN]',
    },
    {
        name: 'anthropic-secret-key',
        pattern: '\\bsk-ant-[A-Za-z0-9_-]{8,}\\b',
        replacement: 'sk-ant-[REDACTED]',
    },
    {
        name: 'openai-secret-key',
        pattern: '\\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\\b',
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
export const DEFAULT_CONTEXT_REGULATED_DOMAIN_PATTERNS = [
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
export function normalizeContextPath(input) {
    return input.split(path.sep).join('/').replace(/^\.\//, '');
}
export function safeNormalizeWorkspaceRelativePath(workspacePath, inputPath) {
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
export function normalizeContextIgnoreSettings(settings = {}) {
    return {
        paths: [...DEFAULT_CONTEXT_IGNORE_PATHS, ...contextUserIgnorePaths(settings)],
        maxFileBytes: positiveNumberOrDefault(settings.maxFileBytes, DEFAULT_CONTEXT_MAX_FILE_BYTES),
        maxEventBytes: positiveNumberOrDefault(settings.maxEventBytes, DEFAULT_CONTEXT_MAX_EVENT_BYTES),
    };
}
export function normalizeContextRedactionSettings(settings = {}) {
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
export function shouldCapturePath(relativePath, settings = {}) {
    return !isContextPathIgnored(relativePath, settings);
}
export function isContextPathIgnored(relativePath, settings = {}) {
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
        if (!prepared)
            continue;
        if (globMatches(normalized, prepared.pattern)) {
            ignored = !prepared.negated;
        }
    }
    return ignored;
}
export function enforceContextSizeLimit(byteLength, settings = {}, limit = 'file') {
    const ignore = normalizeContextIgnoreSettings(settings);
    const maxBytes = limit === 'file' ? ignore.maxFileBytes : ignore.maxEventBytes;
    return byteLength <= maxBytes;
}
export function hashContextContent(input) {
    return createHash('sha256').update(input).digest('hex');
}
export function redactContextText(text, settings = {}) {
    const redaction = normalizeContextRedactionSettings(settings);
    if (!redaction.enabled)
        return text;
    return redaction.patterns.reduce((current, pattern) => {
        try {
            return current.replace(new RegExp(pattern.pattern, 'gi'), pattern.replacement ?? redaction.replacement);
        }
        catch {
            return current;
        }
    }, text);
}
export function redactContextPayload(value, settings = {}, options = {}) {
    if (typeof value === 'string') {
        return redactContextText(redactAbsoluteContextPaths(value, options), settings);
    }
    if (Array.isArray(value)) {
        return value.map((item) => redactContextPayload(item, settings, options));
    }
    if (value && typeof value === 'object') {
        const record = value;
        return Object.fromEntries(Object.keys(record).sort().map((key) => [key, redactContextPayload(record[key], settings, options)]));
    }
    return value;
}
export function redactAbsoluteContextPaths(text, options = {}) {
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
export function parseContextIgnoreFile(text) {
    return text
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));
}
export function loadContextCaptureIgnoreFile(repoPath, fileName = DEFAULT_CONTEXT_IGNORE_FILE_NAME) {
    const filePath = path.join(path.resolve(repoPath), fileName);
    if (!fs.existsSync(filePath))
        return null;
    return {
        path: filePath,
        patterns: parseContextIgnoreFile(fs.readFileSync(filePath, 'utf8')),
    };
}
export function analyzeContextSafety(value, redactionSettings = {}) {
    const text = collectContextText(value);
    const findings = [];
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
function contextUserIgnorePaths(settings) {
    let paths = [...(settings.paths ?? [])];
    while (startsWithDefaultIgnorePaths(paths)) {
        paths = paths.slice(DEFAULT_CONTEXT_IGNORE_PATHS.length);
    }
    return paths;
}
function contextUserRedactionPatterns(settings) {
    let patterns = [...(settings.patterns ?? [])];
    while (startsWithDefaultRedactionPatterns(patterns)) {
        patterns = patterns.slice(DEFAULT_CONTEXT_REDACTION_PATTERNS.length);
    }
    return patterns;
}
function startsWithDefaultIgnorePaths(paths) {
    if (paths.length < DEFAULT_CONTEXT_IGNORE_PATHS.length)
        return false;
    return DEFAULT_CONTEXT_IGNORE_PATHS.every((pattern, index) => paths[index] === pattern);
}
function startsWithDefaultRedactionPatterns(patterns) {
    if (patterns.length < DEFAULT_CONTEXT_REDACTION_PATTERNS.length)
        return false;
    return DEFAULT_CONTEXT_REDACTION_PATTERNS.every((pattern, index) => {
        const current = patterns[index];
        return typeof current !== 'string' && current.name === pattern.name && current.pattern === pattern.pattern;
    });
}
function patternMatches(text, pattern) {
    if (!text)
        return false;
    try {
        return new RegExp(pattern, 'i').test(text);
    }
    catch {
        return false;
    }
}
function uniqueSafetyFindings(findings) {
    const seen = new Set();
    return findings.filter((finding) => {
        const key = `${finding.category}:${finding.name}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
function collectContextText(value, seen = new WeakSet()) {
    if (value == null)
        return '';
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
        return String(value);
    if (Array.isArray(value))
        return value.map((item) => collectContextText(item, seen)).join('\n');
    if (typeof value === 'object') {
        if (seen.has(value))
            return '';
        seen.add(value);
        const record = value;
        return Object.keys(record).sort().map((key) => `${key}\n${collectContextText(record[key], seen)}`).join('\n');
    }
    return '';
}
function positiveNumberOrDefault(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
function resolveContextPathForComparison(inputPath) {
    const resolved = path.resolve(inputPath);
    try {
        return fs.realpathSync.native(resolved);
    }
    catch {
        return resolved;
    }
}
function resolveWorkspaceComparablePath(rawWorkspaceRoot, workspaceRoot, rawAbsolutePath) {
    const relativeToRawRoot = path.relative(rawWorkspaceRoot, rawAbsolutePath);
    if (relativeToRawRoot === '')
        return workspaceRoot;
    if (!relativeToRawRoot.startsWith(`..${path.sep}`) && relativeToRawRoot !== '..' && !path.isAbsolute(relativeToRawRoot)) {
        return path.resolve(workspaceRoot, relativeToRawRoot);
    }
    return resolveContextPathForComparison(rawAbsolutePath);
}
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function prepareIgnorePattern(rawPattern) {
    let pattern = normalizeContextPath(rawPattern.trim());
    if (!pattern || pattern.startsWith('#'))
        return null;
    const negated = pattern.startsWith('!');
    if (negated)
        pattern = pattern.slice(1);
    pattern = pattern.replace(/^\//, '');
    if (!pattern || pattern.startsWith('#'))
        return null;
    if (pattern.endsWith('/'))
        pattern = `${pattern}**`;
    return { pattern, negated };
}
function globMatches(value, pattern) {
    if (pattern === value)
        return true;
    if (!pattern.includes('/')) {
        return value.split('/').some((segment) => globMatchesAnchored(segment, pattern));
    }
    if (globMatchesAnchored(value, pattern))
        return true;
    return !pattern.startsWith('**/') && globMatchesAnchored(value, `**/${pattern}`);
}
function globMatchesAnchored(value, pattern) {
    if (pattern === value)
        return true;
    if (pattern.endsWith('/**')) {
        const prefix = pattern.slice(0, -3);
        if (!prefix.includes('*')) {
            return value === prefix.slice(0, -1) || value.startsWith(prefix);
        }
    }
    const regex = new RegExp(`^${globToRegexSource(pattern)}$`);
    return regex.test(value);
}
function globToRegexSource(pattern) {
    let source = '';
    for (let index = 0; index < pattern.length; index += 1) {
        const char = pattern[index];
        const next = pattern[index + 1];
        const afterNext = pattern[index + 2];
        if (char === '*' && next === '*' && afterNext === '/') {
            source += '(?:.*/)?';
            index += 2;
        }
        else if (char === '*' && next === '*') {
            source += '.*';
            index += 1;
        }
        else if (char === '*') {
            source += '[^/]*';
        }
        else {
            source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
        }
    }
    return source;
}
export const CANONICAL_CAPTURE_POLICY_MODES = [
    'off',
    'metadata-only',
    'repo-and-command',
    'ide-assisted',
    'full',
];
export function normalizeCapturePolicyMode(value, fallback = 'metadata-only') {
    if (CANONICAL_CAPTURE_POLICY_MODES.includes(value)) {
        return value;
    }
    if (value === 'command-summary')
        return 'repo-and-command';
    if (value === 'explicit-transcript-import')
        return 'full';
    return fallback;
}
export function capturePolicyRawContent(mode) {
    const normalized = normalizeCapturePolicyMode(mode);
    if (normalized === 'off')
        return 'off';
    if (normalized === 'metadata-only')
        return 'metadata';
    if (normalized === 'full')
        return 'explicit';
    return 'summary';
}
export const DEFAULT_CAPTURE_POLICY = {
    version: '2026-07-ucc-007',
    maxStringBytes: 16_384,
    maxPayloadBytes: 128_000,
    rawContentDefault: 'metadata+hash',
    hashAlgorithm: 'sha256',
};
export const BUILTIN_AGENT_BINARIES = ['claude', 'codex', 'opencode', 'pi', 'aider', 'cursor'];
const CAPTURE_REGULATED_SIGNALS = [
    { name: 'possible_ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
    { name: 'possible_credit_card', pattern: /\b(?:\d[ -]*?){13,19}\b/ },
    { name: 'regulated_domain_keyword', pattern: /\b(hipaa|phi|pci|cardholder|ssn|medical\s+record|patient)\b/i },
];
export function hashCaptureContent(value) {
    return createHash('sha256').update(stableCaptureStringify(value)).digest('hex');
}
export function sanitizeCapturePayload(input, policy = DEFAULT_CAPTURE_POLICY) {
    const diagnostics = analyzeContextSafety(input, {});
    const redacted = redactContextPayload(input, {}, {});
    let payload = redactCaptureRawFields(redacted, policy);
    let truncated = false;
    const encoded = stableCaptureStringify(payload);
    if (Buffer.byteLength(encoded) > policy.maxPayloadBytes) {
        payload = {
            truncated: true,
            hash: hashCaptureContent(payload),
            byteLength: Buffer.byteLength(encoded),
            preview: encoded.slice(0, policy.maxStringBytes),
        };
        truncated = true;
    }
    const regulatedSignals = diagnostics.findings
        .filter((finding) => finding.category === 'regulated-domain')
        .map((finding) => finding.name)
        .sort();
    const redactionTypes = diagnostics.findings
        .filter((finding) => finding.category === 'secret')
        .map((finding) => finding.name)
        .sort();
    return {
        payload,
        safety: {
            contextSafetyModule: 'backend/src/lib/context-safety.ts',
            policyVersion: policy.version,
            redactionCount: redactionTypes.length,
            ignoredPathCount: 0,
            truncated,
            hashAlgorithm: 'sha256',
            contentHash: hashCaptureContent(payload),
            redactionTypes: [...new Set(redactionTypes)],
            regulatedSignals: [...new Set(regulatedSignals)],
        },
    };
}
function redactCaptureRawFields(value, policy) {
    if (Array.isArray(value))
        return value.slice(0, 200).map((item) => redactCaptureRawFields(item, policy));
    if (!value || typeof value !== 'object') {
        if (typeof value === 'string' && Buffer.byteLength(value) > policy.maxStringBytes) {
            return `${Buffer.from(value).subarray(0, policy.maxStringBytes).toString('utf8')}…[TRUNCATED]`;
        }
        return value;
    }
    const output = {};
    for (const [key, child] of Object.entries(value)) {
        if (/^(raw|content|text|stdout|stderr|transcript)$/i.test(key) && policy.rawContentDefault !== 'explicit') {
            output[key] = typeof child === 'string'
                ? { hash: hashCaptureContent(child), byteLength: Buffer.byteLength(child), redacted: true }
                : '[REDACTED_RAW_CONTENT]';
        }
        else {
            output[key] = redactCaptureRawFields(child, policy);
        }
    }
    return output;
}
export function detectAgentBinary(commandText, customPatterns = []) {
    const token = commandText.trim().match(/^(?:env\s+)?(?:[A-Z0-9_]+=[^\s]+\s+)*(?:command\s+)?(?:npx\s+)?(?:["']?)([^\s"']+)/i)?.[1] ?? '';
    const basename = token.split(/[\\/]/).pop()?.replace(/\.(cmd|exe|ps1)$/i, '').toLowerCase() ?? '';
    if (BUILTIN_AGENT_BINARIES.includes(basename)) {
        return { recognized: true, binary: basename, matchedPattern: basename };
    }
    for (const pattern of customPatterns) {
        try {
            if (new RegExp(pattern, 'i').test(commandText))
                return { recognized: true, binary: 'custom', matchedPattern: pattern };
        }
        catch {
            if (commandText.toLowerCase().includes(pattern.toLowerCase()))
                return { recognized: true, binary: 'custom', matchedPattern: pattern };
        }
    }
    return { recognized: false, binary: 'unknown' };
}
export function isCaptureIgnoredPath(candidatePath, workspacePath, patterns = []) {
    if (!candidatePath || patterns.length === 0)
        return false;
    const root = path.resolve(workspacePath || process.cwd());
    const absolute = path.isAbsolute(candidatePath) ? path.resolve(candidatePath) : path.resolve(root, candidatePath);
    const relative = normalizeContextPath(path.relative(root, absolute));
    return isContextPathIgnored(relative, { paths: patterns });
}
export function redactCommandText(commandText, input = {}) {
    const diagnostics = analyzeContextSafety(commandText, {});
    let text = redactContextText(commandText, {});
    let ignoredPathCount = 0;
    for (const match of text.matchAll(/(?:^|\s)(['"]?)([^\s'"<>|;&]+(?:[\\/][^\s'"<>|;&]*)+)\1/g)) {
        const token = match[2];
        if (isCaptureIgnoredPath(token, input.workspacePath, input.captureIgnorePatterns)) {
            text = text.split(token).join('[REDACTED_PATH]');
            ignoredPathCount += 1;
        }
    }
    const maxBytes = input.policy?.maxStringBytes ?? DEFAULT_CAPTURE_POLICY.maxStringBytes;
    const truncated = Buffer.byteLength(text) > maxBytes;
    if (truncated)
        text = `${Buffer.from(text).subarray(0, maxBytes).toString('utf8')}…[TRUNCATED]`;
    const regulatedSignals = CAPTURE_REGULATED_SIGNALS.filter((rule) => rule.pattern.test(commandText)).map((rule) => rule.name);
    return {
        text,
        redactionCount: diagnostics.findings.filter((finding) => finding.category === 'secret').length + ignoredPathCount,
        ignoredPathCount,
        truncated,
        regulatedSignals,
        redactionTypes: [...new Set([
                ...diagnostics.findings.filter((finding) => finding.category === 'secret').map((finding) => finding.name),
                ...(ignoredPathCount > 0 ? ['ignored_path'] : []),
            ])].sort(),
    };
}
export function sanitizeCliCommandEvent(input, policy = DEFAULT_CAPTURE_POLICY) {
    const policyMode = normalizeCapturePolicyMode(input.policyMode);
    if (policyMode === 'off')
        return { payload: null, safety: sanitizeCapturePayload({ skipped: 'policy_off' }, policy).safety };
    if (input.transcript !== undefined && policyMode !== 'full') {
        throw new ValidationError('Transcript capture requires full explicit-session summary policy');
    }
    if (input.cwd && isCaptureIgnoredPath(input.cwd, input.workspacePath, input.captureIgnorePatterns)) {
        const safety = sanitizeCapturePayload({ skipped: 'capture_ignore' }, policy).safety;
        return { payload: null, safety: { ...safety, ignoredPathCount: safety.ignoredPathCount + 1 } };
    }
    const command = input.command ?? '';
    const redacted = redactCommandText(command, {
        workspacePath: input.workspacePath,
        captureIgnorePatterns: input.captureIgnorePatterns,
        policy,
    });
    const agent = detectAgentBinary(command, input.customAgentPatterns);
    const event = {
        eventType: input.eventType === 'cli_command' ? 'shell_command' : input.eventType ?? (agent.recognized ? 'agent_cli_session' : 'shell_command'),
        source_system: input.source_system?.trim() || 'shell',
        tool_name: input.tool_name?.trim() || (agent.recognized ? agent.binary : 'shell'),
        session_id: input.session_id?.trim() || 'shell',
        phase: input.phase ?? 'end',
        policyMode,
        command_summary: policyMode === 'metadata-only' ? null : redacted.text,
        command_hash: hashCaptureContent(command),
        cwd: input.cwd ? redactCommandText(input.cwd, { workspacePath: input.workspacePath, captureIgnorePatterns: input.captureIgnorePatterns, policy }).text : null,
        exit_code: typeof input.exitCode === 'number' && Number.isFinite(input.exitCode) ? input.exitCode : null,
        duration_ms: typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) ? input.durationMs : null,
        git_branch: input.gitBranch ?? null,
        git_sha: input.gitSha ?? null,
        agent,
        regulated_signals: redacted.regulatedSignals,
        ...(policyMode === 'full' && input.transcript !== undefined ? { transcript: input.transcript } : {}),
    };
    const sanitized = sanitizeCapturePayload(event, {
        ...policy,
        rawContentDefault: policyMode === 'full' ? 'explicit' : policy.rawContentDefault,
    });
    return {
        payload: sanitized.payload,
        safety: {
            ...sanitized.safety,
            redactionCount: sanitized.safety.redactionCount + redacted.redactionCount,
            ignoredPathCount: sanitized.safety.ignoredPathCount + redacted.ignoredPathCount,
            truncated: sanitized.safety.truncated || redacted.truncated,
            redactionTypes: [...new Set([...sanitized.safety.redactionTypes, ...redacted.redactionTypes])].sort(),
            regulatedSignals: [...new Set([...sanitized.safety.regulatedSignals, ...redacted.regulatedSignals])].sort(),
        },
    };
}
export function formatRedactionDiagnostics(input = {}) {
    const regulatedSignals = [...new Set(input.regulatedSignals ?? [])].sort();
    return {
        redactionCount: Number(input.redactionCount ?? 0),
        ignoredPathCount: Number(input.ignoredPathCount ?? 0),
        redactionTypes: [...new Set(input.redactionTypes ?? [])].sort(),
        regulatedSignals,
        regulatedDomainFlags: regulatedSignals,
        truncated: Boolean(input.truncated),
    };
}
function stableCaptureStringify(value) {
    if (Array.isArray(value))
        return `[${value.map(stableCaptureStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => `${JSON.stringify(key)}:${stableCaptureStringify(child)}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}
