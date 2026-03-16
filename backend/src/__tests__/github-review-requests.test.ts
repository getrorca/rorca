import { resolveReviewers, parseReviewConfig } from '../lib/github-pr-creator';
import type { ReviewConfig } from '../lib/github-pr-creator';

describe('parseReviewConfig', () => {
  it('returns empty object for null/undefined', () => {
    expect(parseReviewConfig(null)).toEqual({});
    expect(parseReviewConfig(undefined)).toEqual({});
  });

  it('parses a valid JSON string', () => {
    const config: ReviewConfig = {
      defaultReviewers: ['alice'],
      teamReviewers: ['frontend-team'],
    };
    expect(parseReviewConfig(JSON.stringify(config))).toEqual(config);
  });

  it('returns the object directly if already parsed', () => {
    const config: ReviewConfig = { defaultReviewers: ['bob'] };
    expect(parseReviewConfig(config)).toBe(config);
  });

  it('returns empty object for invalid JSON string', () => {
    expect(parseReviewConfig('not-json')).toEqual({});
  });
});

describe('resolveReviewers', () => {
  it('happy path: merges legacy + default + team reviewers', () => {
    const result = resolveReviewers({
      legacyReviewers: '["legacy-user"]',
      reviewConfig: {
        defaultReviewers: ['alice', 'bob'],
        teamReviewers: ['frontend-team', 'backend-team'],
      },
    });

    expect(result.reviewers).toEqual(expect.arrayContaining(['legacy-user', 'alice', 'bob']));
    expect(result.reviewers).toHaveLength(3);
    expect(result.teamReviewers).toEqual(expect.arrayContaining(['frontend-team', 'backend-team']));
    expect(result.teamReviewers).toHaveLength(2);
  });

  it('deduplicates reviewers across legacy and config', () => {
    const result = resolveReviewers({
      legacyReviewers: '["alice"]',
      reviewConfig: {
        defaultReviewers: ['alice', 'bob'],
      },
    });

    expect(result.reviewers).toEqual(['alice', 'bob']);
    expect(result.teamReviewers).toEqual([]);
  });

  it('returns empty arrays when no reviewers configured', () => {
    const result = resolveReviewers({
      legacyReviewers: '[]',
      reviewConfig: null,
    });

    expect(result.reviewers).toEqual([]);
    expect(result.teamReviewers).toEqual([]);
  });

  it('matches conditional rules on spec tags', () => {
    const config: ReviewConfig = {
      defaultReviewers: ['alice'],
      rules: [
        {
          condition: { field: 'tag', matches: 'security' },
          reviewers: ['sec-reviewer'],
          teamReviewers: ['security-team'],
        },
        {
          condition: { field: 'tag', matches: 'database' },
          reviewers: ['db-reviewer'],
        },
      ],
    };

    const result = resolveReviewers({
      legacyReviewers: '[]',
      reviewConfig: config,
      specTags: ['security', 'frontend'],
    });

    expect(result.reviewers).toEqual(expect.arrayContaining(['alice', 'sec-reviewer']));
    expect(result.reviewers).not.toContain('db-reviewer');
    expect(result.teamReviewers).toContain('security-team');
  });

  it('matches conditional rules on story persona (case-insensitive)', () => {
    const config: ReviewConfig = {
      rules: [
        {
          condition: { field: 'persona', matches: 'Backend' },
          reviewers: ['backend-lead'],
        },
      ],
    };

    const result = resolveReviewers({
      legacyReviewers: '[]',
      reviewConfig: config,
      storyPersonas: ['backend'],
    });

    expect(result.reviewers).toContain('backend-lead');
  });

  it('matches CODEOWNERS-style path rules', () => {
    const config: ReviewConfig = {
      pathRules: [
        {
          pattern: 'src/security/**',
          reviewers: ['sec-expert'],
          teamReviewers: ['security-team'],
        },
        {
          pattern: '**/*.sql',
          reviewers: ['dba'],
        },
        {
          pattern: 'docs/**',
          reviewers: ['tech-writer'],
        },
      ],
    };

    const result = resolveReviewers({
      legacyReviewers: '[]',
      reviewConfig: config,
      changedFiles: [
        'src/security/auth.ts',
        'src/components/Button.tsx',
        'backend/src/db/pg-migrations/001_init.sql',
      ],
    });

    expect(result.reviewers).toContain('sec-expert');
    expect(result.reviewers).toContain('dba');
    expect(result.reviewers).not.toContain('tech-writer');
    expect(result.teamReviewers).toContain('security-team');
  });

  it('path rules with no changed files does nothing', () => {
    const config: ReviewConfig = {
      pathRules: [
        { pattern: 'src/**', reviewers: ['someone'] },
      ],
    };

    const result = resolveReviewers({
      legacyReviewers: '[]',
      reviewConfig: config,
      changedFiles: [],
    });

    expect(result.reviewers).toEqual([]);
  });

  it('combines all layers: legacy + default + conditional + path', () => {
    const config: ReviewConfig = {
      defaultReviewers: ['default-user'],
      teamReviewers: ['core-team'],
      rules: [
        {
          condition: { field: 'tag', matches: 'api' },
          reviewers: ['api-reviewer'],
        },
      ],
      pathRules: [
        {
          pattern: 'backend/**',
          teamReviewers: ['backend-team'],
        },
      ],
    };

    const result = resolveReviewers({
      legacyReviewers: '["legacy-user"]',
      reviewConfig: config,
      specTags: ['api'],
      changedFiles: ['backend/src/routes/specs.ts'],
    });

    expect(result.reviewers).toEqual(
      expect.arrayContaining(['legacy-user', 'default-user', 'api-reviewer']),
    );
    expect(result.teamReviewers).toEqual(
      expect.arrayContaining(['core-team', 'backend-team']),
    );
  });

  it('handles invalid legacy reviewers JSON gracefully', () => {
    const result = resolveReviewers({
      legacyReviewers: 'not-json',
      reviewConfig: { defaultReviewers: ['alice'] },
    });

    expect(result.reviewers).toEqual(['alice']);
  });

  it('handles review_config as JSON string', () => {
    const config: ReviewConfig = {
      defaultReviewers: ['from-json-string'],
      teamReviewers: ['team-from-string'],
    };

    const result = resolveReviewers({
      legacyReviewers: '[]',
      reviewConfig: JSON.stringify(config),
    });

    expect(result.reviewers).toEqual(['from-json-string']);
    expect(result.teamReviewers).toEqual(['team-from-string']);
  });
});
