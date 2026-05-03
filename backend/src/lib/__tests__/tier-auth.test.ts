import {
  getRorcaTier,
  summarizeRorcaTiers,
  tierAllowedFromMcp,
} from '../tier-auth';

describe('tier-auth', () => {
  it('returns denied for missing or invalid tiers', () => {
    expect(getRorcaTier({})).toEqual({ tier: 'denied' });
    expect(getRorcaTier({ 'x-rorca-tier': 'nope' })).toEqual({ tier: 'denied' });
  });

  it('returns structured metadata for valid tiers', () => {
    expect(getRorcaTier({
      'x-rorca-tier': 'public',
      'x-rorca-rationale': 'Stable read-only route',
      'x-rorca-public-api': true,
    })).toEqual({
      tier: 'public',
      rationale: 'Stable read-only route',
      publicApi: true,
    });
  });

  it('allows only public and auth tiers through MCP', () => {
    expect(tierAllowedFromMcp('public')).toBe(true);
    expect(tierAllowedFromMcp('auth')).toBe(true);
    expect(tierAllowedFromMcp('paid')).toBe(false);
    expect(tierAllowedFromMcp('admin')).toBe(false);
    expect(tierAllowedFromMcp('denied')).toBe(false);
  });

  it('summarizes tier exposure and public API counts', () => {
    const summary = summarizeRorcaTiers({
      paths: {
        '/api/specs': {
          get: {
            'x-rorca-tier': 'public',
            'x-rorca-public-api': true,
          },
          post: {
            'x-rorca-tier': 'auth',
          },
        },
        '/api/teams': {
          post: {
            'x-rorca-tier': 'paid',
          },
        },
        '/api/admin/backups': {
          post: {
            'x-rorca-tier': 'admin',
          },
        },
        '/api/internal': {
          get: {},
        },
      },
    });

    expect(summary).toEqual({
      public: 1,
      auth: 1,
      paid: 1,
      admin: 1,
      denied: 1,
      publicApi: 1,
    });
  });
});
