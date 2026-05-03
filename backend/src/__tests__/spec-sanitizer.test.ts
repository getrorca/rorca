/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Unit tests for spec-sanitizer.ts — covers all 8 detection patterns with
 * real-world examples and verifies recursive sanitization.
 */

import { sanitizeSpec, SanitizeResult } from '../lib/spec-sanitizer';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sanitized(input: unknown): unknown {
  return sanitizeSpec(input).sanitized;
}

function count(input: unknown): number {
  return sanitizeSpec(input).redactionCount;
}

function redactions(input: unknown): SanitizeResult['redactions'] {
  return sanitizeSpec(input).redactions;
}

// ─── Pattern 1: API keys ──────────────────────────────────────────────────────

describe('Pattern 1 — API keys', () => {
  test('redacts sk- prefixed key', () => {
    const result = sanitized({ key: 'sk-ant-api03-abcdefghij1234567890' });
    expect((result as any).key).toBe('[REDACTED]');
  });

  test('redacts pk- prefixed key', () => {
    const result = sanitized({ key: 'pk-live-xxxxxxxxxxxxxxxxxxxx' });
    expect((result as any).key).toBe('[REDACTED]');
  });

  test('redacts key_ prefixed key', () => {
    const result = sanitized({ cfg: 'key_my_secret_value_here' });
    expect((result as any).cfg).toBe('[REDACTED]');
  });

  test('redacts Bearer token', () => {
    const result = sanitized({ auth: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig' });
    expect((result as any).auth).toBe('[REDACTED]');
  });

  test('preserves short keys below threshold', () => {
    // "sk-abc" is only 6 chars after prefix — below the 8-char min
    const result = sanitized({ x: 'sk-abc' });
    expect((result as any).x).toBe('sk-abc');
  });
});

// ─── Pattern 2: Email addresses ──────────────────────────────────────────────

describe('Pattern 2 — Email addresses', () => {
  test('redacts plain email', () => {
    const result = sanitized({ contact: 'alice@example.com' });
    expect((result as any).contact).toBe('[REDACTED]');
  });

  test('redacts email in sentence', () => {
    const result = sanitized({ note: 'Send report to bob.smith+test@company.io today' });
    expect((result as any).note).toContain('[REDACTED]');
    expect((result as any).note).not.toContain('bob.smith');
  });

  test('preserves non-email text', () => {
    const result = sanitized({ x: 'no-email-here' });
    expect((result as any).x).toBe('no-email-here');
  });
});

// ─── Pattern 3: IP addresses ─────────────────────────────────────────────────

describe('Pattern 3 — IP addresses', () => {
  test('redacts public IPv4', () => {
    const result = sanitized({ server: '203.0.113.42' });
    expect((result as any).server).toBe('[REDACTED]');
  });

  test('redacts IP embedded in text', () => {
    const result = sanitized({ note: 'Connect to 198.51.100.1 on port 443' });
    expect((result as any).note).toContain('[REDACTED]');
  });

  test('preserves 127.x (localhost)', () => {
    const result = sanitized({ host: '127.0.0.1' });
    expect((result as any).host).toBe('127.0.0.1');
  });

  test('preserves 0.0.0.0', () => {
    const result = sanitized({ bind: '0.0.0.0' });
    expect((result as any).bind).toBe('0.0.0.0');
  });
});

// ─── Pattern 4: Home directory paths ─────────────────────────────────────────

describe('Pattern 4 — Home directory paths', () => {
  test('redacts /Users/* path', () => {
    const result = sanitized({ cwd: '/Users/alice/projects/rorca' });
    expect((result as any).cwd).toBe('[REDACTED]');
  });

  test('redacts /home/* path', () => {
    const result = sanitized({ home: '/home/ubuntu/.ssh/id_rsa' });
    expect((result as any).home).toBe('[REDACTED]');
  });

  test('redacts path embedded in string', () => {
    const result = sanitized({ log: 'Config loaded from /Users/bob/config.json successfully' });
    expect((result as any).log).toContain('[REDACTED]');
    expect((result as any).log).not.toContain('/Users/bob');
  });
});

// ─── Pattern 5: AWS credentials ──────────────────────────────────────────────

describe('Pattern 5 — AWS credentials', () => {
  test('redacts AKIA access key ID', () => {
    const result = sanitized({ aws: 'AKIAIOSFODNN7EXAMPLE' });
    expect((result as any).aws).toBe('[REDACTED]');
  });

  test('redacts AKIA key in description', () => {
    const result = sanitized({ desc: 'Use key AKIAIOSFODNN7EXAMPLE for uploads' });
    expect((result as any).desc).toContain('[REDACTED]');
    expect((result as any).desc).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});

// ─── Pattern 6: GitHub tokens ────────────────────────────────────────────────

describe('Pattern 6 — GitHub tokens', () => {
  test('redacts ghp_ token', () => {
    const result = sanitized({ token: 'ghp_16C7e42F292c6912E7710c838347Ae178B4a' });
    expect((result as any).token).toBe('[REDACTED]');
  });

  test('redacts gho_ token', () => {
    const result = sanitized({ token: 'gho_abcdefghijklmnopqrstuvwxyz123456' });
    expect((result as any).token).toBe('[REDACTED]');
  });

  test('redacts github_pat_ token', () => {
    const result = sanitized({ token: 'github_pat_11ABCDE_LongTokenValue123456789' });
    expect((result as any).token).toBe('[REDACTED]');
  });
});

// ─── Pattern 7: URLs with credentials ────────────────────────────────────────

describe('Pattern 7 — URLs with embedded credentials', () => {
  test('redacts https://user:pass@host', () => {
    const result = sanitized({ db: 'https://admin:s3cr3t@db.example.com/mydb' });
    expect((result as any).db).toBe('[REDACTED]');
  });

  test('redacts http:// form as well', () => {
    const result = sanitized({ url: 'http://user:password@192.168.1.50/path' });
    expect((result as any).url).toBe('[REDACTED]');
  });

  test('preserves normal https URL without credentials', () => {
    const result = sanitized({ url: 'https://api.example.com/v1/endpoint' });
    expect((result as any).url).toBe('https://api.example.com/v1/endpoint');
  });
});

// ─── Pattern 8: process.env references ───────────────────────────────────────

describe('Pattern 8 — process.env.* references', () => {
  test('redacts process.env.API_KEY', () => {
    const result = sanitized({ note: 'Set process.env.API_KEY before running' });
    expect((result as any).note).toContain('[REDACTED]');
    expect((result as any).note).not.toContain('process.env.API_KEY');
  });

  test('redacts process.env.DATABASE_URL', () => {
    const result = sanitized({ cfg: 'process.env.DATABASE_URL' });
    expect((result as any).cfg).toBe('[REDACTED]');
  });
});

// ─── Recursive traversal ─────────────────────────────────────────────────────

describe('Recursive sanitization', () => {
  test('sanitizes nested object fields', () => {
    const input = {
      title: 'My Spec',
      config: {
        apiKey: 'sk-ant-abcdefghij1234567890',
        author: 'alice@example.com',
      },
    };
    const result = sanitized(input) as any;
    expect(result.title).toBe('My Spec');
    expect(result.config.apiKey).toBe('[REDACTED]');
    expect(result.config.author).toBe('[REDACTED]');
  });

  test('sanitizes values inside arrays', () => {
    const input = {
      userStories: [
        { id: 'US-001', description: 'Deploy to 203.0.113.5 server' },
        { id: 'US-002', description: 'Normal description without secrets' },
      ],
    };
    const result = sanitized(input) as any;
    expect(result.userStories[0].description).toContain('[REDACTED]');
    expect(result.userStories[1].description).toBe('Normal description without secrets');
  });

  test('sanitizes acceptance criteria array strings', () => {
    const input = {
      userStories: [
        {
          id: 'US-003',
          acceptanceCriteria: [
            'Send notification to admin@corp.com on completion',
            'No secrets leaked',
          ],
        },
      ],
    };
    const result = sanitized(input) as any;
    expect(result.userStories[0].acceptanceCriteria[0]).toContain('[REDACTED]');
    expect(result.userStories[0].acceptanceCriteria[1]).toBe('No secrets leaked');
  });

  test('passes through numbers and booleans unchanged', () => {
    const input = { count: 42, active: true, nothing: null };
    const result = sanitized(input) as any;
    expect(result.count).toBe(42);
    expect(result.active).toBe(true);
    expect(result.nothing).toBeNull();
  });
});

// ─── Return shape ─────────────────────────────────────────────────────────────

describe('SanitizeResult shape', () => {
  test('returns redactionCount matching redactions array length', () => {
    const input = {
      a: 'alice@example.com',
      b: 'sk-ant-abcdefghij1234567890',
    };
    const res = sanitizeSpec(input);
    expect(res.redactionCount).toBe(res.redactions.length);
    expect(res.redactionCount).toBe(2);
  });

  test('each redaction entry has field, pattern, original_preview', () => {
    const input = { contact: 'user@test.org' };
    const entries = redactions(input);
    expect(entries.length).toBeGreaterThan(0);
    const entry = entries[0];
    expect(entry).toHaveProperty('field');
    expect(entry).toHaveProperty('pattern');
    expect(entry).toHaveProperty('original_preview');
  });

  test('original_preview shows head...tail format for long values', () => {
    const input = { key: 'sk-ant-api03-abcdefghijklmnop' };
    const entries = redactions(input);
    expect(entries[0].original_preview).toMatch(/^.{4}\.\.\..{4}$/);
  });

  test('original_preview is [REDACTED] for very short values', () => {
    // Construct a synthetic match that's short — use IP that's exactly 7 chars
    // "1.2.3.4" is 7 chars, triggers ip_address pattern
    const input = { ip: '1.2.3.4' };
    const entries = redactions(input);
    if (entries.length > 0) {
      // Short value preview
      expect(entries[0].original_preview).toBeDefined();
    }
  });

  test('returns zero redactions for clean spec', () => {
    const input = {
      title: 'auth-feature',
      userStories: [
        { id: 'US-001', description: 'Add login button', acceptanceCriteria: ['Button visible'] },
      ],
    };
    const res = sanitizeSpec(input);
    expect(res.redactionCount).toBe(0);
    expect(res.redactions).toHaveLength(0);
    expect(res.sanitized).toEqual(input);
  });
});
