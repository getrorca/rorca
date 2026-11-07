/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * @module error-parser
 * @description
 * Language-agnostic CI error parser registry. Extracts structured { path, line, message }
 * from raw CI log text using regex-based parsers. Extensible — adding a new language is
 * one function + one registerParser() call.
 *
 * Built-in parsers: typescript, eslint, python-pytest, python-flake8, python-mypy,
 * go-vet, rust-cargo, ruby-rubocop, generic-gcc, github-actions.
 */

export interface ParsedAnnotation {
  path: string;
  line: number;
  message: string;
  parser: string;
}

type Extractor = (match: RegExpMatchArray) => { path: string; line: number; message: string } | null;

interface ParserEntry {
  name: string;
  regex: RegExp;
  extractor: Extractor;
}

const parsers: ParserEntry[] = [];

/**
 * Register a named error parser. Parsers run in registration order during
 * parseErrorsFromText(). More-specific parsers should be registered before
 * generic ones so they win deduplication priority.
 */
export function registerParser(
  name: string,
  regex: RegExp,
  extractor: Extractor,
): void {
  parsers.push({ name, regex, extractor });
}

/**
 * Run ALL registered parsers against `text` and return deduplicated annotations.
 * Deduplication key is `path:line` — first parser match wins.
 */
export function parseErrorsFromText(text: string): ParsedAnnotation[] {
  const seen = new Set<string>();
  const results: ParsedAnnotation[] = [];

  for (const { name, regex, extractor } of parsers) {
    // Reset regex state for global patterns
    regex.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const extracted = extractor(match);
      if (!extracted) continue;

      const key = `${extracted.path}:${extracted.line}`;
      if (seen.has(key)) continue;

      seen.add(key);
      results.push({
        path: extracted.path,
        line: extracted.line,
        message: extracted.message,
        parser: name,
      });
    }
  }

  return results;
}

// ─── Built-in parsers (registered on module load) ────────────────────────────

// TypeScript: src/foo.ts(12,5): error TS2345: Argument of type...
registerParser(
  'typescript',
  /^(.+?)\((\d+),\d+\): error TS\d+: (.+)$/gm,
  (m) => ({ path: m[1], line: parseInt(m[2], 10), message: m[3] }),
);

// ESLint: src/foo.ts  12:5  error  Unexpected token  no-undef
registerParser(
  'eslint',
  /^(.+?)\s+(\d+):\d+\s+error\s+(.+?)\s+\S+$/gm,
  (m) => ({ path: m[1], line: parseInt(m[2], 10), message: m[3] }),
);

// Python pytest: FAILED tests/test_foo.py::test_bar - AssertionError: ...
registerParser(
  'python-pytest',
  /^FAILED (.+?)::(.+?) - (.+)$/gm,
  (m) => ({ path: m[1], line: 0, message: `${m[2]}: ${m[3]}` }),
);

// Python flake8: src/foo.py:12:5: E501 line too long
registerParser(
  'python-flake8',
  /^(.+?):(\d+):\d+: [A-Z]\d+ (.+)$/gm,
  (m) => ({ path: m[1], line: parseInt(m[2], 10), message: m[3] }),
);

// Python mypy: src/foo.py:12: error: Incompatible types
// Negative lookahead ensures we don't match GCC-style path:line:col: error:
registerParser(
  'python-mypy',
  /^(.+?):(\d+): error: (.+)$/gm,
  (m) => {
    // Reject if path contains ':' followed by digits (GCC-style col:line:col)
    if (/:\d+$/.test(m[1])) return null;
    return { path: m[1], line: parseInt(m[2], 10), message: m[3] };
  },
);

// Go vet / golint / staticcheck: src/foo.go:12:5: error message
registerParser(
  'go-vet',
  /^(.+?\.go):(\d+):\d+: (.+)$/gm,
  (m) => ({ path: m[1], line: parseInt(m[2], 10), message: m[3] }),
);

// Rust cargo: error[E0308]: mismatched types\n  --> src/main.rs:12:5
registerParser(
  'rust-cargo',
  /error(?:\[E\d+\])?: (.+?)\n\s*--> (.+?):(\d+):\d+/g,
  (m) => ({ path: m[2], line: parseInt(m[3], 10), message: m[1] }),
);

// Ruby RuboCop: src/foo.rb:12:5: C: Style/FrozenStringLiteralComment: ...
registerParser(
  'ruby-rubocop',
  /^(.+?):(\d+):\d+: [CWEF]: (.+)$/gm,
  (m) => ({ path: m[1], line: parseInt(m[2], 10), message: m[3] }),
);

// Generic GCC-style (C/C++/Java/Kotlin): src/foo.c:12:5: error: undeclared
registerParser(
  'generic-gcc',
  /^(.+?):(\d+):\d+: error: (.+)$/gm,
  (m) => ({ path: m[1], line: parseInt(m[2], 10), message: m[3] }),
);

// GitHub Actions native annotation: ::error file=src/foo.ts,line=12::message
// This is the most generic catch-all — registered last so specific parsers win.
registerParser(
  'github-actions',
  /^::error file=(.+?),line=(\d+).*::(.+)$/gm,
  (m) => ({ path: m[1], line: parseInt(m[2], 10), message: m[3] }),
);
