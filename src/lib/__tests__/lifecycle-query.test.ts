/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it } from 'vitest';
import {
  formatLifecycleQuery,
  lifecycleQuerySuggestions,
  parseLifecycleQuery,
} from '../lifecycle-query';

describe('lifecycle restricted query language', () => {
  it('maps free text and supported field tokens to existing validated filters', () => {
    expect(parseLifecycleQuery('release train status:blocked phase:qa risk:high owner:"team alpha" blocked:true view:risk-desc')).toEqual({
      filters: {
        status: 'blocked', phase: 'qa', risk: 'high', owner: 'team alpha', blocked: true, sort: 'risk_desc',
      },
      freeText: 'release train',
      tokens: expect.arrayContaining([
        expect.objectContaining({ field: 'status', value: 'blocked' }),
        expect.objectContaining({ field: 'view', value: 'risk_desc' }),
      ]),
      errors: [],
    });
  });

  it('never interprets unknown or invalid tokens as executable query syntax', () => {
    const parsed = parseLifecycleQuery('deploy:true status:destroy blocked:maybe ordinary');
    expect(parsed.filters).toEqual({});
    expect(parsed.freeText).toBe('deploy:true ordinary');
    expect(parsed.errors).toEqual([
      'Unsupported status value: destroy',
      'Unsupported blocked value: maybe',
    ]);
  });

  it('uses the last duplicate token deterministically and accepts friendly enum separators', () => {
    const parsed = parseLifecycleQuery('status:not-started status:awaiting-approval sort:owner-asc');
    expect(parsed.filters).toEqual({ status: 'awaiting_approval', sort: 'owner_asc' });
  });

  it('round trips quoted free text and owner identifiers', () => {
    const filters = {
      sort: 'updated_desc' as const,
      search: 'release: north star',
      phase: 'production' as const,
      owner: 'Platform team',
      blocked: false,
    };
    const parsed = parseLifecycleQuery(formatLifecycleQuery(filters));
    expect(parsed.freeText).toBe(filters.search);
    expect(parsed.filters).toEqual({ phase: 'production', owner: 'Platform team', blocked: false, sort: 'updated_desc' });
  });

  it('offers only known keyboard-insertable field and value suggestions', () => {
    expect(lifecycleQuerySuggestions('sta').map((item) => item.label)).toEqual(['status:']);
    expect(lifecycleQuerySuggestions('status:awa')[0]).toEqual(expect.objectContaining({
      label: 'Awaiting Approval', replacement: 'status:awaiting_approval ',
    }));
    expect(lifecycleQuerySuggestions('owner:ad', [['ada', 'Ada Lovelace']])[0]).toEqual(expect.objectContaining({
      label: 'Ada Lovelace', replacement: 'owner:ada ',
    }));
    expect(lifecycleQuerySuggestions('shell:')).toEqual([]);
  });
});
