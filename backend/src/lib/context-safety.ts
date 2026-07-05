/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';

export type CapturePolicyMode = 'off' | 'metadata-only' | 'command-summary' | 'explicit-transcript-import';

export type CapturePolicy = {
  version: string;
  maxStringBytes: number;
  maxPayloadBytes: number;
  rawContentDefault: 'off' | 'metadata+hash' | 'explicit';
  hashAlgorithm: 'sha256';
  redactionPatterns: Array<{ name: string; pattern: RegExp; replacement: string }>;
};

export type AgentBinaryDetection = {
  recognized: boolean;
  binary: 'claude' | 'codex' | 'opencode' | 'pi' | 'aider' | 'cursor' | 'custom' | 'unknown';
  matchedPattern?: string;
};

export type CliCommandSafetyInput = {
  eventType?: 'cli_command' | 'agent_cli_session';
  phase?: 'start' | 'end';
  command?: string;
  cwd?: string;
  workspacePath?: string;
  exitCode?: number | null;
  durationMs?: number | null;
  gitBranch?: string | null;
  gitSha?: string | null;
  startedAt?: string;
  endedAt?: string;
  customAgentPatterns?: string[];
  captureIgnorePatterns?: string[];
  policyMode?: CapturePolicyMode;
  transcript?: unknown;
};

export type SanitizedCliCommandEvent = {
  eventType: 'cli_command' | 'agent_cli_session';
  phase: 'start' | 'end';
  policyMode: CapturePolicyMode;
  commandSummary: string | null;
  commandHash: string;
  cwd: string | null;
  exitCode: number | null;
  durationMs: number | null;
  gitBranch: string | null;
  gitSha: string | null;
  agent: AgentBinaryDetection;
  regulatedSignals: string[];
  transcript?: unknown;
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
    { name: 'long token', pattern: /\b[A-Za-z0-9_=-]{32,}\b/g, replacement: '[REDACTED_TOKEN]' },
    { name: 'url credential', pattern: /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, replacement: '$1[REDACTED]@' },
  ],
};

export const BUILTIN_AGENT_BINARIES = ['claude', 'codex', 'opencode', 'pi', 'aider', 'cursor'] as const;

const REGULATED_SIGNAL_RULES: Array<{ name: string; pattern: RegExp }> = [
  { name: 'possible_ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
  { name: 'possible_credit_card', pattern: /\b(?:\d[ -]*?){13,19}\b/ },
  { name: 'regulated_domain_keyword', pattern: /\b(hipaa|phi|pci|cardholder|ssn|medical\s+record|patient)\b/i },
];

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

export function detectAgentBinary(commandText: string, customPatterns: string[] = []): AgentBinaryDetection {
  const firstToken = commandText.trim().match(/^(?:env\s+)?(?:[A-Z0-9_]+=[^\s]+\s+)*(?:command\s+)?(?:npx\s+)?(?:["']?)([^\s"']+)/i)?.[1] ?? '';
  const basename = firstToken.split(/[\\/]/).pop()?.replace(/\.(cmd|exe|ps1)$/i, '').toLowerCase() ?? '';
  if ((BUILTIN_AGENT_BINARIES as readonly string[]).includes(basename)) {
    return { recognized: true, binary: basename as AgentBinaryDetection['binary'], matchedPattern: basename };
  }
  for (const pattern of customPatterns) {
    try {
      if (new RegExp(pattern, 'i').test(commandText)) return { recognized: true, binary: 'custom', matchedPattern: pattern };
    } catch {
      if (commandText.toLowerCase().includes(pattern.toLowerCase())) return { recognized: true, binary: 'custom', matchedPattern: pattern };
    }
  }
  return { recognized: false, binary: 'unknown' };
}

export function isCaptureIgnoredPath(candidatePath: string, workspacePath: string | undefined, patterns: string[] = []): boolean {
  if (!candidatePath || patterns.length === 0) return false;
  const root = pathNormalize(workspacePath || process.cwd());
  const absolute = pathNormalize(pathIsAbsolute(candidatePath) ? candidatePath : `${root}/${candidatePath}`);
  const relative = stripLeadingSlash(absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : absolute);
  return patterns.some((rawPattern) => matchesCaptureIgnorePattern(relative, absolute, root, rawPattern));
}

export function redactCommandText(commandText: string, input: { workspacePath?: string; captureIgnorePatterns?: string[]; policy?: CapturePolicy } = {}): { text: string; redactionCount: number; regulatedSignals: string[] } {
  const counters = { redactionCount: 0, truncated: false };
  let text = sanitizeString(commandText, input.policy ?? DEFAULT_CAPTURE_POLICY, counters);
  const regulatedSignals = REGULATED_SIGNAL_RULES.filter((rule) => rule.pattern.test(commandText)).map((rule) => rule.name);
  const pathTokens = Array.from(text.matchAll(/(?:^|\s)(['"]?)([^\s'"<>|;&]+(?:\/[^^\s'"<>|;&]*)+)\1/g));
  for (const match of pathTokens) {
    const token = match[2];
    if (isCaptureIgnoredPath(token, input.workspacePath, input.captureIgnorePatterns)) {
      text = text.split(token).join('[REDACTED_PATH]');
      counters.redactionCount += 1;
    }
  }
  return { text, redactionCount: counters.redactionCount, regulatedSignals };
}

export function sanitizeCliCommandEvent(input: CliCommandSafetyInput, policy: CapturePolicy = DEFAULT_CAPTURE_POLICY): SanitizedCapturePayload & { payload: SanitizedCliCommandEvent | null } {
  const policyMode = input.policyMode ?? 'metadata-only';
  if (policyMode === 'off') {
    return { payload: null, safety: sanitizeCapturePayload({ skipped: 'policy_off' }, policy).safety };
  }
  if (input.transcript !== undefined && policyMode !== 'explicit-transcript-import') {
    throw new Error('Transcript capture requires explicit-transcript-import policy');
  }
  if (input.cwd && isCaptureIgnoredPath(input.cwd, input.workspacePath, input.captureIgnorePatterns)) {
    return { payload: null, safety: sanitizeCapturePayload({ skipped: 'capture_ignore' }, policy).safety };
  }
  const command = input.command ?? '';
  const redacted = redactCommandText(command, { workspacePath: input.workspacePath, captureIgnorePatterns: input.captureIgnorePatterns, policy });
  const event: SanitizedCliCommandEvent = {
    eventType: input.eventType ?? (detectAgentBinary(command, input.customAgentPatterns).recognized ? 'agent_cli_session' : 'cli_command'),
    phase: input.phase ?? 'end',
    policyMode,
    commandSummary: policyMode === 'metadata-only' ? null : redacted.text,
    commandHash: hashCaptureContent(command),
    cwd: input.cwd ? redactCommandText(input.cwd, { workspacePath: input.workspacePath, captureIgnorePatterns: input.captureIgnorePatterns, policy }).text : null,
    exitCode: typeof input.exitCode === 'number' && Number.isFinite(input.exitCode) ? input.exitCode : null,
    durationMs: typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) ? input.durationMs : null,
    gitBranch: input.gitBranch ?? null,
    gitSha: input.gitSha ?? null,
    agent: detectAgentBinary(command, input.customAgentPatterns),
    regulatedSignals: redacted.regulatedSignals,
    ...(policyMode === 'explicit-transcript-import' && input.transcript !== undefined ? { transcript: input.transcript } : {}),
  };
  return sanitizeCapturePayload(event, {
    ...policy,
    rawContentDefault: policyMode === 'explicit-transcript-import' ? 'explicit' : policy.rawContentDefault,
  }) as SanitizedCapturePayload & { payload: SanitizedCliCommandEvent };
}

function matchesCaptureIgnorePattern(relative: string, absolute: string, root: string, rawPattern: string): boolean {
  const trimmed = rawPattern.trim();
  if (!trimmed || trimmed.startsWith('#')) return false;
  const negated = trimmed.startsWith('!');
  if (negated) return false;
  const pattern = stripLeadingSlash(trimmed.endsWith('/') ? `${trimmed}**` : trimmed);
  const target = relative || stripLeadingSlash(absolute.replace(`${root}/`, ''));
  if (!pattern.includes('*')) return target === pattern || target.startsWith(`${pattern}/`);
  const regex = new RegExp(`^${pattern.split('**').map(escapeRegex).join('.*').split('\\*').join('[^/]*')}$`);
  return regex.test(target);
}

function pathNormalize(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

function pathIsAbsolute(value: string): boolean {
  return /^([A-Za-z]:)?[\\/]/.test(value);
}

function stripLeadingSlash(value: string): string {
  return value.replace(/^\/+/, '');
}

function escapeRegex(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
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
