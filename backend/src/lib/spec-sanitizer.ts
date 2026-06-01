/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * spec-sanitizer.ts — PII and secret scrubber for marketplace spec publishing.
 *
 * Walks spec JSON recursively, applies 8 regex patterns, replaces matches with
 * '[REDACTED]', and returns a redaction report.
 */

export interface RedactionEntry {
  field: string;
  pattern: string;
  original_preview: string;
}

export interface SanitizeResult {
  sanitized: unknown;
  redactionCount: number;
  redactions: RedactionEntry[];
}

// ─── Pattern registry ────────────────────────────────────────────────────────

interface PatternDef {
  name: string;
  regex: RegExp;
}

const PATTERNS: PatternDef[] = [
  // 1. URLs with embedded credentials — run FIRST before email pattern fires on user:pass@host
  {
    name: 'url_with_credentials',
    regex: /https?:\/\/[^@\s"']+:[^@\s"']+@[^\s"',)>]*/g,
  },
  // 2. Generic API keys — sk-*, pk-*, key_*, Bearer tokens
  {
    name: 'api_key',
    regex: /\b(?:sk-[A-Za-z0-9_-]{8,}|pk-[A-Za-z0-9_-]{8,}|key_[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._\-+/]{20,})/g,
  },
  // 3. Email addresses
  {
    name: 'email',
    regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
  },
  // 4. IPv4 addresses (not localhost / 127.x / 0.0.0.0)
  {
    name: 'ip_address',
    regex: /\b(?!(?:127\.|0\.0\.0\.0|localhost))(?:\d{1,3}\.){3}\d{1,3}\b/g,
  },
  // 5. Home directory paths — /Users/* and /home/*
  {
    name: 'home_path',
    regex: /\/(Users|home)\/[^\s"'`,;)>]+/g,
  },
  // 6. AWS credentials — AKIA* (12–20 alphanumeric chars after prefix)
  {
    name: 'aws_credential',
    regex: /\bAKIA[A-Z0-9]{12,20}\b/g,
  },
  // 7. GitHub tokens — ghp_*, gho_*, ghs_*, github_pat_*
  {
    name: 'github_token',
    regex: /\b(?:ghp_|gho_|ghs_|github_pat_)[A-Za-z0-9_]{10,}/g,
  },
  // 8. process.env.* references — captures the variable name as a potential secret marker
  {
    name: 'process_env_ref',
    regex: /process\.env\.[A-Z_][A-Z0-9_]*/g,
  },
];

// ─── Preview helper ───────────────────────────────────────────────────────────

function buildPreview(value: string): string {
  if (value.length <= 8) {
    return '[REDACTED]';
  }
  const head = value.slice(0, 4);
  const tail = value.slice(-4);
  return `${head}...${tail}`;
}

// ─── Core walker ─────────────────────────────────────────────────────────────

function sanitizeValue(
  value: string,
  fieldPath: string,
  redactions: RedactionEntry[],
): string {
  let result = value;

  for (const patternDef of PATTERNS) {
    // Reset lastIndex for global regexes on each iteration
    patternDef.regex.lastIndex = 0;

    let match: RegExpExecArray | null;
    // Collect all matches first (modifying the string mid-loop shifts offsets)
    const matches: string[] = [];

    while ((match = patternDef.regex.exec(result)) !== null) {
      matches.push(match[0]);
      // Prevent infinite loop on zero-length matches
      if (match[0].length === 0) {
        patternDef.regex.lastIndex++;
      }
    }

    for (const m of matches) {
      redactions.push({
        field: fieldPath,
        pattern: patternDef.name,
        original_preview: buildPreview(m),
      });
      // Replace all occurrences of this exact match literal
      result = result.split(m).join('[REDACTED]');
    }

    // Reset again after use
    patternDef.regex.lastIndex = 0;
  }

  return result;
}

function walkNode(
  node: unknown,
  fieldPath: string,
  redactions: RedactionEntry[],
): unknown {
  if (typeof node === 'string') {
    return sanitizeValue(node, fieldPath, redactions);
  }

  if (Array.isArray(node)) {
    return node.map((item, idx) =>
      walkNode(item, `${fieldPath}[${idx}]`, redactions),
    );
  }

  if (node !== null && typeof node === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      result[key] = walkNode(val, fieldPath ? `${fieldPath}.${key}` : key, redactions);
    }
    return result;
  }

  // number, boolean, null, undefined — pass through unchanged
  return node;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Recursively sanitizes all string values in `specJson`, replacing detected
 * secrets/PII with '[REDACTED]'.
 *
 * @param specJson - Any JSON-serializable value (typically a spec object).
 * @returns SanitizeResult with the cleaned object, count, and redaction entries.
 */
export function sanitizeSpec(specJson: unknown): SanitizeResult {
  const redactions: RedactionEntry[] = [];
  const sanitized = walkNode(specJson, '', redactions);

  return {
    sanitized,
    redactionCount: redactions.length,
    redactions,
  };
}
