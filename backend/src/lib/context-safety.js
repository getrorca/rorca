/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import crypto from 'node:crypto';
export const CANONICAL_CAPTURE_POLICY_MODES = ['off', 'metadata-only', 'repo-and-command', 'ide-assisted', 'full'];
export function normalizeCapturePolicyMode(value, fallback = 'metadata-only') {
    if (value === 'off' || value === 'metadata-only' || value === 'repo-and-command' || value === 'ide-assisted' || value === 'full')
        return value;
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
    if (normalized === 'repo-and-command' || normalized === 'ide-assisted')
        return 'summary';
    return 'explicit';
}
export const DEFAULT_CAPTURE_POLICY = {
    version: '2026-07-ucc-007',
    maxStringBytes: 16_384,
    maxPayloadBytes: 128_000,
    rawContentDefault: 'metadata+hash',
    hashAlgorithm: 'sha256',
    redactionPatterns: [
        { name: 'environment assignment', pattern: /\b[A-Z0-9_]{2,}=([^\s]+)/g, replacement: '[REDACTED_ENV]' },
        { name: 'private key block', pattern: /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
        { name: 'bearer token', pattern: /Bearer\s+[A-Za-z0-9._~+/-]+=*/g, replacement: 'Bearer [REDACTED]' },
        { name: 'api key', pattern: /\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;}]+/gi, replacement: '$1=[REDACTED]' },
        { name: 'long token', pattern: /\b[A-Za-z0-9_=-]{32,}\b/g, replacement: '[REDACTED_TOKEN]' },
        { name: 'url credential', pattern: /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, replacement: '$1[REDACTED]@' },
    ],
};
export const BUILTIN_AGENT_BINARIES = ['claude', 'codex', 'opencode', 'pi', 'aider', 'cursor'];
const REGULATED_SIGNAL_RULES = [
    { name: 'possible_ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
    { name: 'possible_credit_card', pattern: /\b(?:\d[ -]*?){13,19}\b/ },
    { name: 'regulated_domain_keyword', pattern: /\b(hipaa|phi|pci|cardholder|ssn|medical\s+record|patient)\b/i },
];
export function hashCaptureContent(value) {
    return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}
export function sanitizeCapturePayload(input, policy = DEFAULT_CAPTURE_POLICY) {
    const counters = { redactionCount: 0, ignoredPathCount: 0, truncated: false, redactionTypes: new Set(), regulatedSignals: new Set() };
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
            redactionTypes: Array.from(counters.redactionTypes).sort(),
            regulatedSignals: Array.from(counters.regulatedSignals).sort(),
        },
    };
}
function sanitizeValue(value, policy, counters, depth) {
    if (depth > 16) {
        counters.truncated = true;
        return '[TRUNCATED_DEPTH]';
    }
    if (typeof value === 'string')
        return sanitizeString(value, policy, counters);
    if (value == null || typeof value === 'number' || typeof value === 'boolean')
        return value;
    if (Array.isArray(value))
        return value.slice(0, 200).map((item) => sanitizeValue(item, policy, counters, depth + 1));
    if (typeof value === 'object') {
        const out = {};
        for (const [key, child] of Object.entries(value)) {
            if (/^(hash|commandHash|command_hash|contentHash|content_hash|idempotency_key|repo_path_hash|gitSha|git_sha)$/i.test(key) && typeof child === 'string') {
                out[key] = child;
                continue;
            }
            if (/^(raw|content|text|stdout|stderr)$/i.test(key) && policy.rawContentDefault !== 'explicit') {
                out[key] = typeof child === 'string' ? { hash: hashCaptureContent(child), byteLength: Buffer.byteLength(child), redacted: true } : '[REDACTED_RAW_CONTENT]';
                counters.redactionCount += 1;
                counters.redactionTypes?.add('raw_content');
                continue;
            }
            out[key] = sanitizeValue(child, policy, counters, depth + 1);
        }
        return out;
    }
    return String(value);
}
function sanitizeString(input, policy, counters) {
    let output = input;
    for (const rule of policy.redactionPatterns) {
        output = output.replace(rule.pattern, (...args) => {
            const match = String(args[0]);
            if (match) {
                counters.redactionCount += 1;
                counters.redactionTypes?.add(rule.name);
            }
            return rule.replacement.replace(/\$(\d+)/g, (_placeholder, index) => String(args[Number(index)] ?? ''));
        });
    }
    const bytes = Buffer.byteLength(output);
    if (bytes > policy.maxStringBytes) {
        counters.truncated = true;
        return `${Buffer.from(output).subarray(0, policy.maxStringBytes).toString('utf8')}…[TRUNCATED ${bytes - policy.maxStringBytes} bytes]`;
    }
    return output;
}
function boundPayload(payload, policy, counters) {
    const encoded = stableStringify(payload);
    if (Buffer.byteLength(encoded) <= policy.maxPayloadBytes)
        return payload;
    counters.truncated = true;
    return {
        truncated: true,
        hash: hashCaptureContent(payload),
        byteLength: Buffer.byteLength(encoded),
        preview: encoded.slice(0, policy.maxStringBytes),
    };
}
export function detectAgentBinary(commandText, customPatterns = []) {
    const firstToken = commandText.trim().match(/^(?:env\s+)?(?:[A-Z0-9_]+=[^\s]+\s+)*(?:command\s+)?(?:npx\s+)?(?:["']?)([^\s"']+)/i)?.[1] ?? '';
    const basename = firstToken.split(/[\\/]/).pop()?.replace(/\.(cmd|exe|ps1)$/i, '').toLowerCase() ?? '';
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
    const root = pathNormalize(workspacePath || process.cwd());
    const absolute = pathNormalize(pathIsAbsolute(candidatePath) ? candidatePath : `${root}/${candidatePath}`);
    const relative = stripLeadingSlash(absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : absolute);
    return patterns.some((rawPattern) => matchesCaptureIgnorePattern(relative, absolute, root, rawPattern));
}
export function redactCommandText(commandText, input = {}) {
    const counters = { redactionCount: 0, truncated: false, redactionTypes: new Set() };
    let text = sanitizeString(commandText, input.policy ?? DEFAULT_CAPTURE_POLICY, counters);
    let ignoredPathCount = 0;
    const regulatedSignals = REGULATED_SIGNAL_RULES.filter((rule) => rule.pattern.test(commandText)).map((rule) => rule.name);
    const pathTokens = Array.from(text.matchAll(/(?:^|\s)(['"]?)([^\s'"<>|;&]+(?:[\\/][^\s'"<>|;&]*)+)\1/g));
    for (const match of pathTokens) {
        const token = match[2];
        if (isCaptureIgnoredPath(token, input.workspacePath, input.captureIgnorePatterns)) {
            text = text.split(token).join('[REDACTED_PATH]');
            counters.redactionCount += 1;
            counters.redactionTypes.add('ignored_path');
            ignoredPathCount += 1;
        }
    }
    return { text, redactionCount: counters.redactionCount, ignoredPathCount, truncated: counters.truncated, regulatedSignals, redactionTypes: Array.from(counters.redactionTypes).sort() };
}
export function sanitizeCliCommandEvent(input, policy = DEFAULT_CAPTURE_POLICY) {
    const policyMode = normalizeCapturePolicyMode(input.policyMode ?? 'metadata-only');
    if (policyMode === 'off') {
        return { payload: null, safety: sanitizeCapturePayload({ skipped: 'policy_off' }, policy).safety };
    }
    if (input.transcript !== undefined && policyMode !== 'full') {
        throw new Error('Transcript capture requires full explicit-session summary policy');
    }
    if (input.cwd && isCaptureIgnoredPath(input.cwd, input.workspacePath, input.captureIgnorePatterns)) {
        const skipped = sanitizeCapturePayload({ skipped: 'capture_ignore' }, policy).safety;
        return { payload: null, safety: { ...skipped, ignoredPathCount: skipped.ignoredPathCount + 1 } };
    }
    const command = input.command ?? '';
    const redacted = redactCommandText(command, { workspacePath: input.workspacePath, captureIgnorePatterns: input.captureIgnorePatterns, policy });
    const detectedAgent = detectAgentBinary(command, input.customAgentPatterns);
    const event = {
        eventType: input.eventType === 'cli_command'
            ? 'shell_command'
            : input.eventType ?? (detectedAgent.recognized ? 'agent_cli_session' : 'shell_command'),
        source_system: typeof input.source_system === 'string' && input.source_system.trim() ? input.source_system : 'shell',
        tool_name: typeof input.tool_name === 'string' && input.tool_name.trim() ? input.tool_name : detectedAgent.recognized ? detectedAgent.binary : 'shell',
        session_id: typeof input.session_id === 'string' && input.session_id.trim() ? input.session_id : 'shell',
        phase: input.phase ?? 'end',
        policyMode,
        commandSummary: policyMode === 'metadata-only' ? null : redacted.text,
        commandHash: hashCaptureContent(command),
        cwd: input.cwd ? redactCommandText(input.cwd, { workspacePath: input.workspacePath, captureIgnorePatterns: input.captureIgnorePatterns, policy }).text : null,
        exitCode: typeof input.exitCode === 'number' && Number.isFinite(input.exitCode) ? input.exitCode : null,
        durationMs: typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) ? input.durationMs : null,
        gitBranch: input.gitBranch ?? null,
        gitSha: input.gitSha ?? null,
        agent: detectedAgent,
        regulatedSignals: redacted.regulatedSignals,
        ...(policyMode === 'full' && input.transcript !== undefined ? { transcript: input.transcript } : {}),
    };
    const sanitized = sanitizeCapturePayload(event, {
        ...policy,
        rawContentDefault: policyMode === 'full' ? 'explicit' : policy.rawContentDefault,
    });
    return {
        ...sanitized,
        safety: {
            ...sanitized.safety,
            redactionCount: sanitized.safety.redactionCount + redacted.redactionCount,
            ignoredPathCount: sanitized.safety.ignoredPathCount + redacted.ignoredPathCount,
            truncated: sanitized.safety.truncated || redacted.truncated,
            redactionTypes: Array.from(new Set([...(sanitized.safety.redactionTypes ?? []), ...redacted.redactionTypes])).sort(),
            regulatedSignals: Array.from(new Set([...(sanitized.safety.regulatedSignals ?? []), ...redacted.regulatedSignals])).sort(),
        },
    };
}
export function formatRedactionDiagnostics(input = {}) {
    const regulatedSignals = Array.from(new Set(input.regulatedSignals ?? [])).sort();
    return {
        redactionCount: Number(input.redactionCount ?? 0),
        ignoredPathCount: Number(input.ignoredPathCount ?? 0),
        redactionTypes: Array.from(new Set(input.redactionTypes ?? [])).sort(),
        regulatedSignals,
        regulatedDomainFlags: regulatedSignals,
        truncated: Boolean(input.truncated),
    };
}
function matchesCaptureIgnorePattern(relative, absolute, root, rawPattern) {
    const trimmed = rawPattern.trim();
    if (!trimmed || trimmed.startsWith('#'))
        return false;
    const negated = trimmed.startsWith('!');
    if (negated)
        return false;
    const directoryPattern = trimmed.endsWith('/');
    const pattern = stripLeadingSlash(directoryPattern ? `${trimmed}**` : trimmed);
    const target = relative || stripLeadingSlash(absolute.replace(`${root}/`, ''));
    const targetParts = target.split('/').filter(Boolean);
    const basename = targetParts.at(-1) ?? target;
    if (!pattern.includes('*')) {
        if (!pattern.includes('/'))
            return basename === pattern || targetParts.includes(pattern);
        return target === pattern || target.startsWith(`${pattern}/`);
    }
    const regex = globPatternToRegex(pattern);
    if (regex.test(target))
        return true;
    return !pattern.includes('/') && regex.test(basename);
}
function pathNormalize(value) {
    return value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}
function pathIsAbsolute(value) {
    return /^([A-Za-z]:)?[\\/]/.test(value);
}
function stripLeadingSlash(value) {
    return value.replace(/^\/+/, '');
}
function globPatternToRegex(pattern) {
    let source = '';
    for (let i = 0; i < pattern.length; i += 1) {
        const char = pattern[i];
        if (char === '*') {
            if (pattern[i + 1] === '*') {
                source += '.*';
                i += 1;
            }
            else {
                source += '[^/]*';
            }
            continue;
        }
        source += escapeRegex(char);
    }
    return new RegExp(`^${source}$`);
}
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function stableStringify(value) {
    return JSON.stringify(sortJson(value));
}
function sortJson(value) {
    if (Array.isArray(value))
        return value.map(sortJson);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortJson(child)]));
    }
    return value;
}
