/**
 * Sidecar-local mirror of backend/src/lib/context-safety.ts.
 *
 * rorca-capture is intentionally API-only and standalone, so it reproduces the
 * canonical safety contract without importing backend database/runtime modules.
 * Keep CONTEXT_SAFETY_CONTRACT_VERSION and defaults in sync with the backend.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CONTEXT_SAFETY_CONTRACT_VERSION = "rorca-context-safety/v1";

export const DEFAULT_CONTEXT_MAX_FILE_BYTES = 256 * 1024;
export const DEFAULT_CONTEXT_MAX_EVENT_BYTES = 1024 * 1024;

export const DEFAULT_CONTEXT_IGNORE_PATHS = [
  ".git/**",
  ".hg/**",
  ".svn/**",
  "node_modules/**",
  "dist/**",
  "build/**",
  "coverage/**",
  ".next/**",
  ".nuxt/**",
  ".turbo/**",
  ".cache/**",
  ".rorca/capture-queue.ndjson",
  ".rorca/capture-queue/**",
  ".rorca-capture-queue.jsonl",
  ".rorca-capture-queue.jsonl.tmp",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  ".env",
  ".env.*",
] as const;

export type ContextRedactionPattern = {
  name: string;
  pattern: string;
  replacement?: string;
};

export const DEFAULT_CONTEXT_REDACTION_PATTERNS: ContextRedactionPattern[] = [
  {
    name: "bearer-token",
    pattern: "\\bBearer\\s+[A-Za-z0-9._~+\\/-]+=*",
    replacement: "Bearer [REDACTED]",
  },
  {
    name: "api-key-assignment",
    pattern: "\\b[A-Z0-9_]*(?:API|TOKEN|SECRET|PASSWORD|KEY)[A-Z0-9_]*\\s*=\\s*[\"\\']?[^\"\\'\\s]+",
    replacement: "[REDACTED_SECRET_ASSIGNMENT]",
  },
  {
    name: "github-token",
    pattern: "\\bgh[pousr]_[A-Za-z0-9_]{20,}\\b",
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    name: "private-key-block",
    pattern: "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----",
    replacement: "[REDACTED_PRIVATE_KEY]",
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

export function normalizeContextPath(input: string): string {
  return input.split(path.sep).join("/").replace(/^\.\//, "");
}

export function safeNormalizeWorkspaceRelativePath(workspacePath: string, inputPath: string): string {
  const rawWorkspaceRoot = path.resolve(workspacePath);
  const workspaceRoot = resolveContextPathForComparison(rawWorkspaceRoot);
  const rawAbsolutePath = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(rawWorkspaceRoot, inputPath);
  const absolutePath = resolveWorkspaceComparablePath(rawWorkspaceRoot, workspaceRoot, rawAbsolutePath);
  const relativePath = path.relative(workspaceRoot, absolutePath);

  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }

  return normalizeContextPath(relativePath);
}

export function normalizeContextIgnoreSettings(settings: ContextIgnoreSettings = {}): NormalizedContextIgnoreSettings {
  return {
    paths: [...DEFAULT_CONTEXT_IGNORE_PATHS, ...(settings.paths ?? [])],
    maxFileBytes: positiveNumberOrDefault(settings.maxFileBytes, DEFAULT_CONTEXT_MAX_FILE_BYTES),
    maxEventBytes: positiveNumberOrDefault(settings.maxEventBytes, DEFAULT_CONTEXT_MAX_EVENT_BYTES),
  };
}

export function normalizeContextRedactionSettings(
  settings: ContextRedactionSettings = {},
): NormalizedContextRedactionSettings {
  const patterns = (settings.patterns ?? DEFAULT_CONTEXT_REDACTION_PATTERNS).map((item, index) => {
    if (typeof item === "string") {
      return { name: `custom-${index + 1}`, pattern: item, replacement: settings.replacement };
    }
    return item;
  });

  return {
    enabled: settings.enabled ?? true,
    patterns,
    replacement: settings.replacement ?? "[REDACTED]",
  };
}

export function shouldCapturePath(relativePath: string, settings: ContextIgnoreSettings = {}): boolean {
  return !isContextPathIgnored(relativePath, settings);
}

export function isContextPathIgnored(relativePath: string, settings: ContextIgnoreSettings = {}): boolean {
  const normalized = normalizeContextPath(relativePath);
  const ignore = normalizeContextIgnoreSettings(settings);
  let ignored = false;

  for (const rawPattern of ignore.paths) {
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
  limit: "file" | "event" = "file",
): boolean {
  const ignore = normalizeContextIgnoreSettings(settings);
  const maxBytes = limit === "file" ? ignore.maxFileBytes : ignore.maxEventBytes;
  return byteLength <= maxBytes;
}

export function hashContextContent(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function redactContextText(text: string, settings: ContextRedactionSettings = {}): string {
  const redaction = normalizeContextRedactionSettings(settings);
  if (!redaction.enabled) return text;

  return redaction.patterns.reduce((current, pattern) => {
    try {
      return current.replace(new RegExp(pattern.pattern, "gi"), pattern.replacement ?? redaction.replacement);
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
  if (typeof value === "string") {
    return redactContextText(redactAbsoluteContextPaths(value, options), settings);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactContextPayload(item, settings, options));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, redactContextPayload(record[key], settings, options)]),
    );
  }
  return value;
}

export function redactAbsoluteContextPaths(text: string, options: ContextPayloadRedactionOptions = {}): string {
  const pathReplacement = options.pathReplacement ?? "[REDACTED_PATH]";
  const workspacePathReplacement = options.workspacePathReplacement ?? "[WORKSPACE]";
  const repoPath = options.repoPath ? path.resolve(options.repoPath) : undefined;
  let redacted = text;

  if (repoPath) {
    const repoVariants = [...new Set([repoPath, normalizeContextPath(repoPath)])];
    for (const variant of repoVariants) {
      redacted = redacted.replace(new RegExp(escapeRegex(variant), "g"), workspacePathReplacement);
    }
  }

  return redacted
    .replace(/(^|[\s"'([{,:])((?:\/(?:Users|home|tmp|var|private|Volumes|opt|srv|etc|mnt|workspace|workspaces)[^\s"'<>()[\]{},;]*)|(?:[A-Za-z]:\\[^\s"'<>()[\]{},;]+))/g, `$1${pathReplacement}`);
}

function positiveNumberOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
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
  if (relativeToRawRoot === "") return workspaceRoot;
  if (!relativeToRawRoot.startsWith(`..${path.sep}`) && relativeToRawRoot !== ".." && !path.isAbsolute(relativeToRawRoot)) {
    return path.resolve(workspaceRoot, relativeToRawRoot);
  }
  return resolveContextPathForComparison(rawAbsolutePath);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function prepareIgnorePattern(rawPattern: string): { pattern: string; negated: boolean } | null {
  let pattern = normalizeContextPath(rawPattern.trim());
  if (!pattern || pattern.startsWith("#")) return null;

  const negated = pattern.startsWith("!");
  if (negated) pattern = pattern.slice(1);
  pattern = pattern.replace(/^\//, "");
  if (!pattern || pattern.startsWith("#")) return null;
  if (pattern.endsWith("/")) pattern = `${pattern}**`;

  return { pattern, negated };
}

function globMatches(value: string, pattern: string): boolean {
  if (pattern === value) return true;

  if (!pattern.includes("/")) {
    return value.split("/").some((segment) => globMatchesAnchored(segment, pattern));
  }

  if (globMatchesAnchored(value, pattern)) return true;
  return !pattern.startsWith("**/") && globMatchesAnchored(value, `**/${pattern}`);
}

function globMatchesAnchored(value: string, pattern: string): boolean {
  if (pattern === value) return true;
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    if (!prefix.includes("*")) {
      return value === prefix.slice(0, -1) || value.startsWith(prefix);
    }
  }

  const regex = new RegExp(`^${globToRegexSource(pattern)}$`);
  return regex.test(value);
}

function globToRegexSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];
    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?";
      index += 2;
    } else if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return source;
}
