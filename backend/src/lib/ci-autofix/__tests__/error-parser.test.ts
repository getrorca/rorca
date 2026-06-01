/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { parseErrorsFromText } from '../error-parser';

describe('error-parser', () => {
  describe('typescript parser', () => {
    test('extracts TypeScript compiler errors', () => {
      const text = `src/components/App.tsx(42,7): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
src/lib/utils.ts(18,3): error TS7006: Parameter 'x' implicitly has an 'any' type.`;

      const results = parseErrorsFromText(text);
      expect(results).toEqual([
        { path: 'src/components/App.tsx', line: 42, message: "Argument of type 'string' is not assignable to parameter of type 'number'.", parser: 'typescript' },
        { path: 'src/lib/utils.ts', line: 18, message: "Parameter 'x' implicitly has an 'any' type.", parser: 'typescript' },
      ]);
    });
  });

  describe('eslint parser', () => {
    test('extracts ESLint errors', () => {
      const text = `src/index.ts  12:5  error  Unexpected token  no-undef
src/app.ts  45:10  error  'foo' is not defined  no-undef`;

      const results = parseErrorsFromText(text);
      expect(results).toEqual([
        { path: 'src/index.ts', line: 12, message: 'Unexpected token', parser: 'eslint' },
        { path: 'src/app.ts', line: 45, message: "'foo' is not defined", parser: 'eslint' },
      ]);
    });
  });

  describe('python-pytest parser', () => {
    test('extracts pytest FAILED lines', () => {
      const text = `FAILED tests/test_auth.py::test_login_invalid - AssertionError: Expected 401 but got 200
FAILED tests/test_user.py::test_create_duplicate - IntegrityError: UNIQUE constraint failed`;

      const results = parseErrorsFromText(text);
      expect(results).toEqual([
        { path: 'tests/test_auth.py', line: 0, message: 'test_login_invalid: AssertionError: Expected 401 but got 200', parser: 'python-pytest' },
        { path: 'tests/test_user.py', line: 0, message: 'test_create_duplicate: IntegrityError: UNIQUE constraint failed', parser: 'python-pytest' },
      ]);
    });
  });

  describe('python-flake8 parser', () => {
    test('extracts flake8 errors', () => {
      const text = `src/main.py:12:1: E501 line too long (120 > 79 characters)
src/utils.py:5:1: F401 'os' imported but unused`;

      const results = parseErrorsFromText(text);
      expect(results).toEqual([
        { path: 'src/main.py', line: 12, message: 'line too long (120 > 79 characters)', parser: 'python-flake8' },
        { path: 'src/utils.py', line: 5, message: "'os' imported but unused", parser: 'python-flake8' },
      ]);
    });
  });

  describe('python-mypy parser', () => {
    test('extracts mypy errors', () => {
      const text = `src/handler.py:23: error: Incompatible return value type (got "str", expected "int")
src/models.py:8: error: Name "Optional" is not defined`;

      const results = parseErrorsFromText(text);
      expect(results).toEqual([
        { path: 'src/handler.py', line: 23, message: 'Incompatible return value type (got "str", expected "int")', parser: 'python-mypy' },
        { path: 'src/models.py', line: 8, message: 'Name "Optional" is not defined', parser: 'python-mypy' },
      ]);
    });
  });

  describe('go-vet parser', () => {
    test('extracts Go vet / staticcheck errors', () => {
      const text = `main.go:15:2: undefined: handleRequest
internal/server.go:42:10: cannot use x (type int) as type string in argument`;

      const results = parseErrorsFromText(text);
      expect(results).toEqual([
        { path: 'main.go', line: 15, message: 'undefined: handleRequest', parser: 'go-vet' },
        { path: 'internal/server.go', line: 42, message: 'cannot use x (type int) as type string in argument', parser: 'go-vet' },
      ]);
    });
  });

  describe('rust-cargo parser', () => {
    test('extracts Rust cargo errors (multiline)', () => {
      const text = `error[E0308]: mismatched types
  --> src/main.rs:12:5
   |
12 |     let x: i32 = "hello";
   |                   ^^^^^^^ expected \`i32\`, found \`&str\`

error[E0425]: cannot find value \`foo\` in this scope
  --> src/lib.rs:28:9`;

      const results = parseErrorsFromText(text);
      expect(results).toEqual([
        { path: 'src/main.rs', line: 12, message: 'mismatched types', parser: 'rust-cargo' },
        { path: 'src/lib.rs', line: 28, message: 'cannot find value `foo` in this scope', parser: 'rust-cargo' },
      ]);
    });
  });

  describe('ruby-rubocop parser', () => {
    test('extracts RuboCop offenses', () => {
      const text = `app/models/user.rb:12:5: C: Style/FrozenStringLiteralComment: Missing frozen string literal comment.
app/controllers/api.rb:45:3: W: Lint/UselessAssignment: Useless assignment to variable.
app/services/auth.rb:8:1: E: Naming/FileName: Use snake_case for file names.`;

      const results = parseErrorsFromText(text);
      expect(results).toEqual([
        { path: 'app/models/user.rb', line: 12, message: 'Style/FrozenStringLiteralComment: Missing frozen string literal comment.', parser: 'ruby-rubocop' },
        { path: 'app/controllers/api.rb', line: 45, message: 'Lint/UselessAssignment: Useless assignment to variable.', parser: 'ruby-rubocop' },
        { path: 'app/services/auth.rb', line: 8, message: 'Naming/FileName: Use snake_case for file names.', parser: 'ruby-rubocop' },
      ]);
    });
  });

  describe('generic-gcc parser', () => {
    test('extracts GCC-style errors (C/C++/Java/Kotlin)', () => {
      const text = `src/main.c:42:10: error: undeclared identifier 'foo'
src/lib.cpp:18:5: error: no matching function for call to 'bar'`;

      const results = parseErrorsFromText(text);
      expect(results).toEqual([
        { path: 'src/main.c', line: 42, message: "undeclared identifier 'foo'", parser: 'generic-gcc' },
        { path: 'src/lib.cpp', line: 18, message: "no matching function for call to 'bar'", parser: 'generic-gcc' },
      ]);
    });
  });

  describe('github-actions parser', () => {
    test('extracts GitHub Actions native annotations', () => {
      const text = `::error file=src/app.ts,line=15,col=3::Unexpected token
::error file=tests/test_api.py,line=42::AssertionError: values differ`;

      const results = parseErrorsFromText(text);
      expect(results).toEqual([
        { path: 'src/app.ts', line: 15, message: 'Unexpected token', parser: 'github-actions' },
        { path: 'tests/test_api.py', line: 42, message: 'AssertionError: values differ', parser: 'github-actions' },
      ]);
    });
  });

  describe('deduplication', () => {
    test('deduplicates by path:line — first parser match wins', () => {
      // mypy and generic-gcc share same format for this line
      const text = `src/handler.py:23: error: Incompatible types
src/handler.py:23:5: error: Incompatible types`;

      const results = parseErrorsFromText(text);
      // path:line = src/handler.py:23 — first match (python-mypy) wins
      const matchesForLine23 = results.filter(r => r.path === 'src/handler.py' && r.line === 23);
      expect(matchesForLine23).toHaveLength(1);
      expect(matchesForLine23[0].parser).toBe('python-mypy');
    });

    test('same file different lines are not deduplicated', () => {
      const text = `src/app.ts(10,5): error TS2345: First error
src/app.ts(20,5): error TS2345: Second error`;

      const results = parseErrorsFromText(text);
      expect(results).toHaveLength(2);
      expect(results[0].line).toBe(10);
      expect(results[1].line).toBe(20);
    });
  });

  describe('empty/no-match input', () => {
    test('returns empty array for empty text', () => {
      expect(parseErrorsFromText('')).toEqual([]);
    });

    test('returns empty array for text with no matching errors', () => {
      const text = `Build succeeded!
All tests passed.
Done in 12.5s.`;
      expect(parseErrorsFromText(text)).toEqual([]);
    });
  });
});
