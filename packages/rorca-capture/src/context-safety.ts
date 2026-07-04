/**
 * Sidecar-local mirror of backend/src/lib/context-safety.ts.
 *
 * rorca-capture is intentionally API-only and standalone, so it reproduces the
 * canonical safety contract without importing backend database/runtime modules.
 * Keep CONTEXT_SAFETY_CONTRACT_VERSION and defaults in sync with the backend.
 */

import { createHash } from "node:crypto";
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

export function normalizeContextPath(input: string): string {
  return input.split(path.sep).join("/").replace(/^\.\//, "");
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
  const normalized = normalizeContextPath(relativePath);
  const ignore = normalizeContextIgnoreSettings(settings);
  return !ignore.paths.some((pattern) => globMatches(normalized, normalizeContextPath(pattern)));
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

function positiveNumberOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function globMatches(value: string, pattern: string): boolean {
  if (pattern === value) return true;
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return value === prefix.slice(0, -1) || value.startsWith(prefix);
  }

  const regex = new RegExp(`^${globToRegexSource(pattern)}$`);
  return regex.test(value);
}

function globToRegexSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
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
