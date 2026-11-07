/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it } from 'vitest';
import {
  appendReturnContext,
  consumeReturnContext,
  createReturnContext,
  parseReturnContext,
  serializeReturnContext,
  withReturnContext,
} from '../returnContext';

describe('ReturnContextV1 navigation', () => {
  it('serializes and parses bounded pathname, search, focus, and lens', () => {
    const context = createReturnContext(
      { pathname: '/workspaces/ws-1/specs/spec-a/review', search: '?tab=lifecycle' },
      { focus: 'evidence:7', lens: 'review' },
    );
    expect(context).not.toBeNull();
    expect(parseReturnContext(serializeReturnContext(context!))).toEqual(context);
  });

  it.each([
    'https://evil.example/phish',
    '//evil.example/phish',
    '/safe/../admin',
    '/safe?query=in-path',
    '/safe#fragment',
  ])('rejects external or malformed return path %s', (pathname) => {
    expect(createReturnContext({ pathname, search: '' })).toBeNull();
  });

  it('rejects malformed serialized values and nested return contexts', () => {
    expect(parseReturnContext('{not-json')).toBeNull();
    expect(parseReturnContext(JSON.stringify({
      schemaVersion: 'rorca.return-context.v1',
      path: '/runs',
      search: '?next=x%26returnTo%3D%2Fadmin',
    }))).toBeNull();
  });

  it('does not grow across three drill-down round trips', () => {
    const origin = { pathname: '/lifecycle', search: '?spec=spec-a&phase=testing' };
    const context = createReturnContext(origin)!;
    let destination = '/runs/42';
    const lengths: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      destination = appendReturnContext(destination, context);
      lengths.push(destination.length);
      expect(consumeReturnContext(destination.slice(destination.indexOf('?')), '/runs')).toBe('/lifecycle?spec=spec-a&phase=testing');
    }
    expect(new Set(lengths).size).toBe(1);
    expect((destination.match(/returnTo=/g) ?? [])).toHaveLength(1);
  });

  it('strips a source returnTo instead of nesting it', () => {
    const first = withReturnContext('/runs/42', { pathname: '/lifecycle', search: '?spec=a' });
    const second = withReturnContext('/specs/a/review', {
      pathname: '/runs/42',
      search: first.slice(first.indexOf('?')),
    });
    const consumed = consumeReturnContext(second.slice(second.indexOf('?')), '/specs');
    expect(consumed).toBe('/runs/42');
    expect(second.length).toBeLessThan(1_500);
  });

  it('rejects a return destination from another workspace', () => {
    const destination = withReturnContext('/runs/42', {
      pathname: '/workspaces/ws-old/runs/7',
      search: '?tab=evidence',
    });
    expect(consumeReturnContext(destination.slice(destination.indexOf('?')), '/runs', 'ws-new')).toBe('/runs');
  });
});
