/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export type CapturePolicyMode =
  | 'off'
  | 'metadata-only'
  | 'repo-and-command'
  | 'ide-assisted'
  | 'full'
  /** @deprecated use repo-and-command */
  | 'command-summary'
  /** @deprecated use full */
  | 'explicit-transcript-import';

export type CanonicalCapturePolicyMode = 'off' | 'metadata-only' | 'repo-and-command' | 'ide-assisted' | 'full';

export const CANONICAL_CAPTURE_POLICY_MODES: CanonicalCapturePolicyMode[] = ['off', 'metadata-only', 'repo-and-command', 'ide-assisted', 'full'];

export function normalizeCapturePolicyMode(value: unknown, fallback: CanonicalCapturePolicyMode = 'metadata-only'): CanonicalCapturePolicyMode {
  if (value === 'off' || value === 'metadata-only' || value === 'repo-and-command' || value === 'ide-assisted' || value === 'full') return value;
  if (value === 'command-summary') return 'repo-and-command';
  if (value === 'explicit-transcript-import') return 'full';
  return fallback;
}

export function capturePolicyRawContent(mode: CapturePolicyMode): 'off' | 'metadata' | 'summary' | 'explicit' {
  const normalized = normalizeCapturePolicyMode(mode);
  if (normalized === 'off') return 'off';
  if (normalized === 'metadata-only') return 'metadata';
  if (normalized === 'repo-and-command' || normalized === 'ide-assisted') return 'summary';
  return 'explicit';
}

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
  eventType?: 'cli_command' | 'shell_command' | 'agent_cli_session';
  source_system?: string;
  tool_name?: string;
  session_id?: string;
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
  eventType: 'cli_command' | 'shell_command' | 'agent_cli_session';
  source_system: string;
  tool_name: string;
  session_id: string;
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
  redactionTypes?: string[];
  regulatedSignals?: string[];
};

export type RedactionDiagnostics = {
  redactionCount: number;
  ignoredPathCount: number;
  redactionTypes: string[];
  regulatedSignals: string[];
  regulatedDomainFlags: string[];
  truncated: boolean;
};

export type SanitizedCapturePayload = {
  payload: unknown;
  safety: CaptureSafetyReport;
};

export type SafeContextFilePreview = {
  path: string;
  workspaceRelativePath: string;
  byteLength: number;
  truncated: boolean;
  contentHash: string;
  content: string;
  redactionDiagnostics: RedactionDiagnostics;
};

export type SafeContextFilePreviewOptions = {
  maxBytes?: number;
  policy?: CapturePolicy;
};

export const DEFAULT_CAPTURE_POLICY: CapturePolicy = {
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
  const counters = { redactionCount: 0, ignoredPathCount: 0, truncated: false, redactionTypes: new Set<string>(), regulatedSignals: new Set<string>() };
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

function sanitizeValue(value: unknown, policy: CapturePolicy, counters: { redactionCount: number; ignoredPathCount: number; truncated: boolean; redactionTypes?: Set<string>; regulatedSignals?: Set<string> }, depth: number): unknown {
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

function sanitizeString(input: string, policy: CapturePolicy, counters: { redactionCount: number; truncated: boolean; redactionTypes?: Set<string> }): string {
  let output = input;
  for (const rule of policy.redactionPatterns) {
    output = output.replace(rule.pattern, (...args: unknown[]) => {
      const match = String(args[0]);
      if (match) {
        counters.redactionCount += 1;
        counters.redactionTypes?.add(rule.name);
      }
      return rule.replacement.replace(/\$(\d+)/g, (_placeholder, index: string) => String(args[Number(index)] ?? ''));
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

export function redactCommandText(commandText: string, input: { workspacePath?: string; captureIgnorePatterns?: string[]; policy?: CapturePolicy } = {}): { text: string; redactionCount: number; ignoredPathCount: number; truncated: boolean; regulatedSignals: string[]; redactionTypes: string[] } {
  const counters = { redactionCount: 0, truncated: false, redactionTypes: new Set<string>() };
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


export function sanitizeCliCommandEvent(input: CliCommandSafetyInput, policy: CapturePolicy = DEFAULT_CAPTURE_POLICY): SanitizedCapturePayload & { payload: SanitizedCliCommandEvent | null } {
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
  const event: SanitizedCliCommandEvent = {
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
  }) as SanitizedCapturePayload & { payload: SanitizedCliCommandEvent };
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

export function formatRedactionDiagnostics(input: Partial<CaptureSafetyReport> & { regulatedSignals?: string[] } = {}): RedactionDiagnostics {
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

export function resolveWorkspaceRelativePath(workspacePath: string, candidatePath: string): { absolutePath: string; relativePath: string } {
  const root = path.resolve(workspacePath);
  const absolutePath = path.resolve(root, candidatePath);
  const relativePath = path.relative(root, absolutePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Preview path must be inside the workspace');
  }
  return { absolutePath, relativePath: pathNormalize(relativePath) };
}

export async function readSafeContextFilePreview(
  workspacePath: string,
  candidatePath: string,
  options: SafeContextFilePreviewOptions = {},
): Promise<SafeContextFilePreview> {
  const policy = options.policy ?? DEFAULT_CAPTURE_POLICY;
  const maxBytes = Math.min(Math.max(options.maxBytes ?? 32_768, 1), 128_000);
  const { absolutePath, relativePath } = resolveWorkspaceRelativePath(workspacePath, candidatePath);
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) throw new Error('Preview path must be a file');
  const handle = await fs.open(absolutePath, 'r');
  try {
    const bytesToRead = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, 0);
    if (buffer.includes(0)) throw new Error('Binary file previews are not supported');
    const raw = buffer.toString('utf8');
    const sanitized = sanitizeCapturePayload({ preview: raw }, policy);
    const payload = sanitized.payload && typeof sanitized.payload === 'object' ? sanitized.payload as Record<string, unknown> : {};
    return {
      path: candidatePath,
      workspaceRelativePath: relativePath,
      byteLength: stat.size,
      truncated: stat.size > maxBytes || sanitized.safety.truncated,
      contentHash: hashCaptureContent(raw),
      content: typeof payload.preview === 'string' ? payload.preview : '',
      redactionDiagnostics: formatRedactionDiagnostics(sanitized.safety),
    };
  } finally {
    await handle.close();
  }
}

function matchesCaptureIgnorePattern(relative: string, absolute: string, root: string, rawPattern: string): boolean {
  const trimmed = rawPattern.trim();
  if (!trimmed || trimmed.startsWith('#')) return false;
  const negated = trimmed.startsWith('!');
  if (negated) return false;
  const directoryPattern = trimmed.endsWith('/');
  const pattern = stripLeadingSlash(directoryPattern ? `${trimmed}**` : trimmed);
  const target = relative || stripLeadingSlash(absolute.replace(`${root}/`, ''));
  const targetParts = target.split('/').filter(Boolean);
  const basename = targetParts.at(-1) ?? target;
  if (!pattern.includes('*')) {
    if (!pattern.includes('/')) return basename === pattern || targetParts.includes(pattern);
    return target === pattern || target.startsWith(`${pattern}/`);
  }
  const regex = globPatternToRegex(pattern);
  if (regex.test(target)) return true;
  return !pattern.includes('/') && regex.test(basename);
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

function globPatternToRegex(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    source += escapeRegex(char);
  }
  return new RegExp(`^${source}$`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
