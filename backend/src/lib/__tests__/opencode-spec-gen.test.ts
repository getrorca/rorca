/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { validateSpecQuality, isSpecError, type OpenCodeSpecResult, type OpenCodeSpecError } from '../opencode-spec-gen';

// ─── validateSpecQuality ─────────────────────────────────────────────────────

describe('validateSpecQuality', () => {
  test('valid spec with all required fields passes', () => {
    const stories = [
      {
        id: 'US-001',
        title: 'Setup auth',
        description: 'Implement authentication',
        acceptanceCriteria: ['Users can login', 'Users can logout'],
        dependsOn: [],
        complexity: 3,
      },
      {
        id: 'US-002',
        title: 'User dashboard',
        description: 'Build main dashboard',
        acceptanceCriteria: ['Dashboard loads', 'Shows user data'],
        dependsOn: ['US-001'],
        complexity: 2,
      },
    ];

    const result = validateSpecQuality(stories);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('empty stories array fails', () => {
    const result = validateSpecQuality([]);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('stories array is empty or missing');
  });

  test('story missing id fails', () => {
    const stories = [
      {
        title: 'Setup auth',
        description: 'Implement authentication',
        acceptanceCriteria: ['Users can login'],
        dependsOn: [],
      },
    ];
    const result = validateSpecQuality(stories);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('missing id'))).toBe(true);
  });

  test('story missing title fails', () => {
    const stories = [
      {
        id: 'US-001',
        description: 'Implement authentication',
        acceptanceCriteria: ['Users can login'],
        dependsOn: [],
      },
    ];
    const result = validateSpecQuality(stories);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('missing title'))).toBe(true);
  });

  test('story missing description fails', () => {
    const stories = [
      {
        id: 'US-001',
        title: 'Setup auth',
        acceptanceCriteria: ['Users can login'],
        dependsOn: [],
      },
    ];
    const result = validateSpecQuality(stories);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('missing description'))).toBe(true);
  });

  test('story with empty acceptanceCriteria fails', () => {
    const stories = [
      {
        id: 'US-001',
        title: 'Setup auth',
        description: 'Implement authentication',
        acceptanceCriteria: [],
        dependsOn: [],
      },
    ];
    const result = validateSpecQuality(stories);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('empty acceptanceCriteria'))).toBe(true);
  });

  test('story missing dependsOn array fails', () => {
    const stories = [
      {
        id: 'US-001',
        title: 'Setup auth',
        description: 'Implement authentication',
        acceptanceCriteria: ['Users can login'],
      },
    ];
    const result = validateSpecQuality(stories);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('missing dependsOn'))).toBe(true);
  });

  test('multiple errors reported for multiple bad stories', () => {
    const stories = [
      { id: 'US-001' }, // missing title, description, acceptanceCriteria, dependsOn
      { title: 'foo' }, // missing id, description, acceptanceCriteria, dependsOn
    ];
    const result = validateSpecQuality(stories);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });
});

// ─── isSpecError ─────────────────────────────────────────────────────────────

describe('isSpecError', () => {
  test('identifies error result', () => {
    const err: OpenCodeSpecError = { error: 'something broke' };
    expect(isSpecError(err)).toBe(true);
  });

  test('identifies success result', () => {
    const success: OpenCodeSpecResult = {
      stories: [
        {
          id: 'US-001',
          title: 'Test',
          description: 'Test story',
          acceptanceCriteria: ['AC1'],
          dependsOn: [],
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
    };
    expect(isSpecError(success)).toBe(false);
  });
});
