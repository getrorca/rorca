/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { compileWaves, isCycleError, UserStory, Wave, CycleError } from '../wave-compiler';

function story(id: string, dependsOn: string[] = [], passes = false): UserStory {
  return {
    id,
    title: id,
    description: '',
    acceptanceCriteria: [],
    dependsOn,
    passes,
  };
}

function waveIds(waves: Wave[]): string[][] {
  return waves.map(w => w.stories.map(s => s.id).sort());
}

describe('compileWaves', () => {
  test('linear chain — each story in its own wave', () => {
    const stories = [
      story('US-001'),
      story('US-002', ['US-001']),
      story('US-003', ['US-002']),
    ];
    const result = compileWaves(stories);
    expect(isCycleError(result)).toBe(false);
    const waves = result as Wave[];

    expect(waves).toHaveLength(3);
    expect(waves[0].index).toBe(0);
    expect(waves[0].stories.map(s => s.id)).toEqual(['US-001']);
    expect(waves[1].stories.map(s => s.id)).toEqual(['US-002']);
    expect(waves[2].stories.map(s => s.id)).toEqual(['US-003']);
  });

  test('diamond DAG — fan-out then fan-in', () => {
    //   US-001
    //   /    \
    // US-002  US-003
    //   \    /
    //   US-004
    const stories = [
      story('US-001'),
      story('US-002', ['US-001']),
      story('US-003', ['US-001']),
      story('US-004', ['US-002', 'US-003']),
    ];
    const result = compileWaves(stories);
    expect(isCycleError(result)).toBe(false);
    const waves = result as Wave[];

    expect(waves).toHaveLength(3);
    expect(waveIds(waves)).toEqual([
      ['US-001'],
      ['US-002', 'US-003'],
      ['US-004'],
    ]);
  });

  test('fully independent — all stories in wave 0', () => {
    const stories = [
      story('US-001'),
      story('US-002'),
      story('US-003'),
      story('US-004'),
    ];
    const result = compileWaves(stories);
    expect(isCycleError(result)).toBe(false);
    const waves = result as Wave[];

    expect(waves).toHaveLength(1);
    expect(waves[0].index).toBe(0);
    expect(waves[0].stories.map(s => s.id).sort()).toEqual([
      'US-001', 'US-002', 'US-003', 'US-004',
    ]);
  });

  test('cycle detection — returns CycleError with involved IDs', () => {
    const stories = [
      story('US-001', ['US-003']),
      story('US-002', ['US-001']),
      story('US-003', ['US-002']),
    ];
    const result = compileWaves(stories);
    expect(isCycleError(result)).toBe(true);
    const err = result as CycleError;

    expect(err.cycle).toBe(true);
    expect(err.involvedIds.sort()).toEqual(['US-001', 'US-002', 'US-003']);
  });

  test('partial cycle — non-cyclic stories still excluded from involvedIds', () => {
    // US-001 is independent, US-002 ↔ US-003 form a cycle
    const stories = [
      story('US-001'),
      story('US-002', ['US-003']),
      story('US-003', ['US-002']),
    ];
    const result = compileWaves(stories);
    // Kahn's will process US-001 but leave US-002/US-003 stuck
    expect(isCycleError(result)).toBe(true);
    const err = result as CycleError;
    expect(err.involvedIds.sort()).toEqual(['US-002', 'US-003']);
  });

  test('mixed passed/pending — passed stories excluded, deps on them are satisfied', () => {
    const stories = [
      story('US-001', [], true),  // already passed
      story('US-002', ['US-001']),  // depends on passed story
      story('US-003', ['US-002']),
    ];
    const result = compileWaves(stories);
    expect(isCycleError(result)).toBe(false);
    const waves = result as Wave[];

    // US-001 excluded; US-002's dep is satisfied, so it's wave 0
    expect(waves).toHaveLength(2);
    expect(waves[0].stories.map(s => s.id)).toEqual(['US-002']);
    expect(waves[1].stories.map(s => s.id)).toEqual(['US-003']);
  });

  test('all stories passed — returns empty array', () => {
    const stories = [
      story('US-001', [], true),
      story('US-002', ['US-001'], true),
    ];
    const result = compileWaves(stories);
    expect(isCycleError(result)).toBe(false);
    expect(result as Wave[]).toEqual([]);
  });

  test('dangling dependency refs — unknown IDs treated as satisfied', () => {
    const stories = [
      story('US-001', ['US-999']),  // US-999 doesn't exist
      story('US-002', ['US-001']),
    ];
    const result = compileWaves(stories);
    expect(isCycleError(result)).toBe(false);
    const waves = result as Wave[];

    expect(waves).toHaveLength(2);
    expect(waves[0].stories.map(s => s.id)).toEqual(['US-001']);
    expect(waves[1].stories.map(s => s.id)).toEqual(['US-002']);
  });

  test('single story — one wave', () => {
    const stories = [story('US-001')];
    const result = compileWaves(stories);
    expect(isCycleError(result)).toBe(false);
    const waves = result as Wave[];

    expect(waves).toHaveLength(1);
    expect(waves[0].stories[0].id).toBe('US-001');
  });

  test('empty input — returns empty array', () => {
    const result = compileWaves([]);
    expect(isCycleError(result)).toBe(false);
    expect(result as Wave[]).toEqual([]);
  });

  test('wave indices are sequential starting from 0', () => {
    const stories = [
      story('US-001'),
      story('US-002', ['US-001']),
      story('US-003', ['US-002']),
    ];
    const result = compileWaves(stories) as Wave[];
    expect(result.map(w => w.index)).toEqual([0, 1, 2]);
  });

  test('stories retain full UserStory data in waves', () => {
    const stories: UserStory[] = [{
      id: 'US-001',
      title: 'Setup auth',
      description: 'Implement authentication',
      acceptanceCriteria: ['login works', 'logout works'],
      dependsOn: [],
      complexity: 3,
      priority: 2,
      timeoutMinutes: 30,
    }];
    const result = compileWaves(stories) as Wave[];
    const s = result[0].stories[0];
    expect(s.title).toBe('Setup auth');
    expect(s.description).toBe('Implement authentication');
    expect(s.acceptanceCriteria).toEqual(['login works', 'logout works']);
    expect(s.complexity).toBe(3);
    expect(s.priority).toBe(2);
    expect(s.timeoutMinutes).toBe(30);
  });
});
