/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { PayloadTooLargeError, ValidationError } from '../errors';
import {
  CAPTURE_IGNORE_FILENAME,
  DEFAULT_IGNORE_PATTERNS,
  DEFAULT_MAX_FILE_BYTES,
  MAX_FILE_BYTES_ENV,
  SENSITIVE_KEY_PATTERN,
  assertWithinSizeCap,
  byteLength,
  contentDigest,
  createIgnoreMatcher,
  exceedsSizeCap,
  getMaxFileBytes,
  hashContent,
  hashFileContent,
  isWithinWorkspace,
  loadCaptureIgnore,
  normalizeWorkspaceRelativePath,
  parseCaptureIgnore,
  redactObject,
  redactSecrets,
  safeWorkspaceRelativePath,
  sanitizeTranscriptPayload,
  shortHash,
  toPosixPath,
} from '../context-safety';

describe('context-safety', () => {
  // ────────────────────────────────────────────────────────────────────────
  // 1. Path normalization & traversal protection
  // ────────────────────────────────────────────────────────────────────────
  describe('path normalization & traversal protection', () => {
    const root = path.resolve('/tmp/ws');

    it('normalizes a relative path to a workspace-relative POSIX path', () => {
      const r = safeWorkspaceRelativePath(root, 'src/lib/foo.ts');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.relPath).toBe('src/lib/foo.ts');
    });

    it('converts OS separators to POSIX', () => {
      expect(toPosixPath('src\\lib\\foo.ts')).toBe('src/lib/foo.ts');
      const r = safeWorkspaceRelativePath(root, 'src\\lib\\foo.ts');
      // On POSIX hosts backslashes are literal filename chars, so just assert no escape.
      expect(r.ok).toBe(true);
    });

    it('accepts an absolute path that lives inside the workspace', () => {
      const r = safeWorkspaceRelativePath(root, path.join(root, 'a', 'b.ts'));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.relPath).toBe('a/b.ts');
    });

    it('collapses interior . and redundant separators', () => {
      const r = safeWorkspaceRelativePath(root, 'src/./lib/../lib/foo.ts');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.relPath).toBe('src/lib/foo.ts');
    });

    it('maps the workspace root itself to "."', () => {
      const r = safeWorkspaceRelativePath(root, root);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.relPath).toBe('.');
    });

    it('rejects ../ traversal that escapes the workspace', () => {
      const r = safeWorkspaceRelativePath(root, '../outside/secret.txt');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/escape/i);
    });

    it('rejects a deep traversal that climbs above root', () => {
      const r = safeWorkspaceRelativePath(root, 'a/b/../../../etc/passwd');
      expect(r.ok).toBe(false);
    });

    it('rejects an absolute path outside the workspace', () => {
      const r = safeWorkspaceRelativePath(root, '/etc/passwd');
      expect(r.ok).toBe(false);
    });

    it('rejects NUL bytes and empty input', () => {
      expect(safeWorkspaceRelativePath(root, 'a\0b').ok).toBe(false);
      expect(safeWorkspaceRelativePath(root, '').ok).toBe(false);
      expect(safeWorkspaceRelativePath('', 'a').ok).toBe(false);
    });

    it('isWithinWorkspace mirrors the resolution result', () => {
      expect(isWithinWorkspace(root, 'src/a.ts')).toBe(true);
      expect(isWithinWorkspace(root, '../a.ts')).toBe(false);
    });

    it('normalizeWorkspaceRelativePath returns the path or throws ValidationError', () => {
      expect(normalizeWorkspaceRelativePath(root, 'src/a.ts')).toBe('src/a.ts');
      expect(() => normalizeWorkspaceRelativePath(root, '../a.ts')).toThrow(ValidationError);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 2. Ignore rules
  // ────────────────────────────────────────────────────────────────────────
  describe('ignore rules', () => {
    it('ignores the documented built-in exclude set', () => {
      const m = createIgnoreMatcher();
      const ignored = [
        '.git/config',
        'node_modules/react/index.js',
        'dist/bundle.js',
        'build/output.o',
        'target/release/app',
        'vendor/lib/thing.go',
        'secrets/token.txt',
        '.env',
        '.env.local',
        '.env.production',
        'generated/types.ts',
        'schema.generated.ts',
        'server.key',
        'cert.pem',
        'id_rsa',
      ];
      for (const p of ignored) {
        expect(m.ignores(p)).toBe(true);
      }
    });

    it('does not ignore ordinary source files', () => {
      const m = createIgnoreMatcher();
      for (const p of ['src/index.ts', 'README.md', 'backend/src/lib/foo.ts', 'env.ts']) {
        expect(m.ignores(p)).toBe(false);
      }
    });

    it('matches directory excludes at any depth', () => {
      const m = createIgnoreMatcher();
      expect(m.ignores('packages/a/node_modules/x/y.js')).toBe(true);
      expect(m.ignores('a/b/c/dist/out.js')).toBe(true);
    });

    it('supports extra patterns and gitignore-style negation (last match wins)', () => {
      const m = createIgnoreMatcher({
        includeDefaults: false,
        extraPatterns: ['*.log', '!keep.log'],
      });
      expect(m.ignores('debug.log')).toBe(true);
      expect(m.ignores('logs/app.log')).toBe(true);
      expect(m.ignores('keep.log')).toBe(false);
    });

    it('supports anchored vs unanchored and ** globs', () => {
      const m = createIgnoreMatcher({
        includeDefaults: false,
        extraPatterns: ['/root-only.txt', 'anywhere.txt', 'a/**/deep.txt'],
      });
      expect(m.ignores('root-only.txt')).toBe(true);
      expect(m.ignores('sub/root-only.txt')).toBe(false); // anchored to root
      expect(m.ignores('anywhere.txt')).toBe(true);
      expect(m.ignores('x/y/anywhere.txt')).toBe(true);
      expect(m.ignores('a/deep.txt')).toBe(true);
      expect(m.ignores('a/b/c/deep.txt')).toBe(true);
    });

    it('parseCaptureIgnore strips comments and blank lines', () => {
      const parsed = parseCaptureIgnore('# comment\n\n*.tmp\n  \nfoo/\n');
      expect(parsed).toEqual(['*.tmp', 'foo/']);
    });

    it('loadCaptureIgnore merges .rorca-captureignore with built-in defaults', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'captureignore-'));
      try {
        fs.writeFileSync(
          path.join(dir, CAPTURE_IGNORE_FILENAME),
          '# custom\n*.draft\nscratch/\n',
        );
        const m = loadCaptureIgnore(dir);
        expect(m.ignores('notes.draft')).toBe(true); // from .rorca-captureignore
        expect(m.ignores('scratch/x.ts')).toBe(true);
        expect(m.ignores('node_modules/x')).toBe(true); // still has defaults
        expect(m.ignores('src/index.ts')).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('loadCaptureIgnore degrades to defaults when the file is absent', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'captureignore-empty-'));
      try {
        const m = loadCaptureIgnore(dir);
        expect(m.ignores('node_modules/x')).toBe(true);
        expect(m.ignores('src/index.ts')).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('exposes the default pattern set as frozen', () => {
      expect(DEFAULT_IGNORE_PATTERNS).toContain('node_modules/');
      expect(Object.isFrozen(DEFAULT_IGNORE_PATTERNS)).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 3. File size caps
  // ────────────────────────────────────────────────────────────────────────
  describe('file size caps', () => {
    const ENV_KEY = MAX_FILE_BYTES_ENV;
    const original = process.env[ENV_KEY];
    afterEach(() => {
      if (original === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = original;
    });

    it('byteLength counts UTF-8 bytes', () => {
      expect(byteLength('abc')).toBe(3);
      expect(byteLength('é')).toBe(2); // 2-byte UTF-8
      expect(byteLength(Buffer.from([1, 2, 3, 4]))).toBe(4);
    });

    it('exceedsSizeCap respects the default cap', () => {
      expect(exceedsSizeCap(DEFAULT_MAX_FILE_BYTES)).toBe(false);
      expect(exceedsSizeCap(DEFAULT_MAX_FILE_BYTES + 1)).toBe(true);
      expect(exceedsSizeCap('small string')).toBe(false);
    });

    it('honors an explicit cap override', () => {
      expect(exceedsSizeCap('123456', 5)).toBe(true);
      expect(exceedsSizeCap('12345', 5)).toBe(false);
    });

    it('honors the env override', () => {
      delete process.env[ENV_KEY];
      expect(getMaxFileBytes()).toBe(DEFAULT_MAX_FILE_BYTES);
      process.env[ENV_KEY] = '10';
      expect(getMaxFileBytes()).toBe(10);
      expect(exceedsSizeCap('12345678901')).toBe(true);
      // invalid env falls back to default
      process.env[ENV_KEY] = 'not-a-number';
      expect(getMaxFileBytes()).toBe(DEFAULT_MAX_FILE_BYTES);
    });

    it('assertWithinSizeCap returns bytes or throws PayloadTooLargeError', () => {
      expect(assertWithinSizeCap('abc', 10)).toBe(3);
      expect(() => assertWithinSizeCap('abcdef', 3, 'snippet')).toThrow(PayloadTooLargeError);
      try {
        assertWithinSizeCap('abcdef', 3, 'snippet');
      } catch (e) {
        expect((e as Error).message).toMatch(/snippet/);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 4. Content hashing
  // ────────────────────────────────────────────────────────────────────────
  describe('content hashing', () => {
    it('produces a stable sha256 hex digest', () => {
      // sha256("hello") — known vector
      expect(hashContent('hello')).toBe(
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      );
      expect(hashContent('hello')).toBe(hashContent('hello'));
      expect(hashContent('hello')).not.toBe(hashContent('world'));
    });

    it('hashes Buffers identically to their UTF-8 string', () => {
      expect(hashContent(Buffer.from('hello', 'utf8'))).toBe(hashContent('hello'));
    });

    it('contentDigest prefixes the algorithm', () => {
      expect(contentDigest('hello')).toBe(`sha256:${hashContent('hello')}`);
    });

    it('shortHash returns a bounded prefix', () => {
      expect(shortHash('hello')).toBe(hashContent('hello').slice(0, 12));
      expect(shortHash('hello', 8)).toHaveLength(8);
    });

    it('hashFileContent streams the same shared digest without loading caller state', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-hash-'));
      const file = path.join(dir, 'segment.gz');
      try {
        fs.writeFileSync(file, Buffer.from([0, 1, 2, 3, 255]));
        expect(await hashFileContent(file)).toBe(hashContent(Buffer.from([0, 1, 2, 3, 255])));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 5. Secret redaction
  // ────────────────────────────────────────────────────────────────────────
  describe('secret redaction', () => {
    it('redacts a PEM private key block', () => {
      const pem = [
        '-----BEGIN RSA PRIVATE KEY-----',
        'MIIEpAIBAAKCAQEAuffault0123456789abcdefABCDEF',
        'ZmFrZWtleWZha2VrZXlmYWtला',
        '-----END RSA PRIVATE KEY-----',
      ].join('\n');
      const { redacted, byType } = redactSecrets(pem);
      expect(redacted).not.toContain('BEGIN RSA PRIVATE KEY');
      expect(redacted).toContain('[REDACTED]');
      expect(byType.private_key).toBe(1);
    });

    it('redacts database connection URLs (with and without credentials)', () => {
      const text =
        'DATABASE_URL=postgres://admin:s3cr3tpw@db.internal:5432/app and mongodb+srv://u:p@cluster0.mongodb.net/db';
      const { redacted, byType } = redactSecrets(text);
      expect(redacted).not.toContain('s3cr3tpw');
      expect(redacted).not.toContain('db.internal');
      expect(redacted).not.toContain('cluster0.mongodb.net');
      expect(byType.database_url).toBeGreaterThanOrEqual(2);
    });

    it('redacts a generic credentialed URL', () => {
      const { redacted, byType } = redactSecrets('see https://user:hunter2@example.com/path');
      expect(redacted).not.toContain('hunter2');
      expect(byType.url_with_credentials).toBe(1);
    });

    it('redacts common provider keys and tokens', () => {
      const samples: Array<[string, string]> = [
        ['key=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx', 'api_key'],
        ['token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'github_token'],
        ['AKIAIOSFODNN7EXAMPLE', 'aws_access_key_id'],
        ['xoxb-1234567890-abcdefghijklmnop', 'slack_token'],
        ['AIzaSyA1234567890abcdefghijklmnopqrstuv', 'google_api_key'],
        ['sk_live_abcdef0123456789ABCDEF', 'stripe_key'],
        ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123', 'bearer_token'],
      ];
      for (const [input, type] of samples) {
        const { redacted, byType } = redactSecrets(input);
        expect(redacted).toContain('[REDACTED]');
        expect(byType[type]).toBeGreaterThanOrEqual(1);
      }
    });

    it('redacts a JWT', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const { redacted, byType } = redactSecrets(jwt);
      expect(redacted).not.toContain(jwt);
      expect(byType.jwt).toBe(1);
    });

    it('redacts assignment-style secrets while keeping the key name', () => {
      const { redacted, byType } = redactSecrets('password = "supersecretvalue"');
      expect(redacted).toContain('password');
      expect(redacted).not.toContain('supersecretvalue');
      expect(redacted).toMatch(/password\s*=\s*"\[REDACTED\]"/);
      expect(byType.secret_assignment).toBe(1);
    });

    it('leaves benign text untouched', () => {
      const benign = 'The quick brown fox jumps over 1 lazy dog.';
      const { redacted, redactionCount } = redactSecrets(benign);
      expect(redacted).toBe(benign);
      expect(redactionCount).toBe(0);
    });

    it('previews never leak the full secret', () => {
      const { findings } = redactSecrets('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
      expect(findings.length).toBeGreaterThan(0);
      for (const f of findings) {
        expect(f.preview).not.toContain('GHIJKLMNOP');
      }
    });

    it('supports a custom placeholder', () => {
      const { redacted } = redactSecrets('password = "topsecret9"', { placeholder: '***' });
      expect(redacted).toContain('***');
      expect(redacted).not.toContain('topsecret9');
    });

    describe('bounded transcript payloads', () => {
      it('redacts nested credentials and enforces the persisted byte contract', () => {
        const safe = sanitizeTranscriptPayload({
          tool: 'deploy',
          password: 'super-secret-password',
          output: 'x'.repeat(50_000),
        });
        expect(safe.serialized).not.toContain('super-secret-password');
        expect(safe.redacted).toBe(true);
        expect(safe.truncated).toBe(true);
        expect(safe.bytes).toBeLessThanOrEqual(16 * 1024);
      });
    });

    describe('redactObject (structured payloads)', () => {
      it('redacts by sensitive key name and by value shape, without mutating input', () => {
        const input = {
          name: 'demo',
          password: 'literally-anything',
          nested: {
            apiKey: 'whatever-value',
            note: 'connect via postgres://u:p@host:5432/db',
            list: ['ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'plain text'],
          },
          count: 5,
        };
        const snapshot = JSON.stringify(input);
        const { value, redactionCount } = redactObject(input) as {
          value: typeof input;
          redactionCount: number;
        };

        expect(value.password).toBe('[REDACTED]');
        expect(value.nested.apiKey).toBe('[REDACTED]');
        expect(value.nested.note).not.toContain('u:p@host');
        expect(value.nested.list[0]).toBe('[REDACTED]');
        expect(value.nested.list[1]).toBe('plain text');
        expect(value.name).toBe('demo');
        expect(value.count).toBe(5);
        expect(redactionCount).toBeGreaterThanOrEqual(3);

        // input untouched
        expect(JSON.stringify(input)).toBe(snapshot);
      });

      it('SENSITIVE_KEY_PATTERN matches the documented key families', () => {
        for (const k of ['password', 'apiKey', 'api_key', 'access_token', 'DATABASE_URL', 'dsn', 'token']) {
          expect(SENSITIVE_KEY_PATTERN.test(k)).toBe(true);
        }
        // benign keys must NOT match ('tokenizer' embeds 'token' but not as a word)
        for (const k of ['name', 'description', 'count', 'tokenizer']) {
          expect(SENSITIVE_KEY_PATTERN.test(k)).toBe(false);
        }
      });
    });
  });
});
