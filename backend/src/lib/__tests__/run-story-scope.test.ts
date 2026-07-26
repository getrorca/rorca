/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { frozenRunStoryScope } from '../run-story-scope';

test('full-run frozen scope includes pre-seeded and forged pass projections', () => {
  expect(frozenRunStoryScope({ userStories: [
    { id: 'US-001', passes: true },
    { id: 'US-002', passes: false },
    { id: 'US-003', passes: true, status: 'passed' },
    { id: 'US-004', excluded: true, passes: true },
  ] })).toEqual({
    expectedStoryIds: ['US-001', 'US-002', 'US-003'],
    excludedStoryIds: ['US-004'],
  });
});

test('explicit story-only scope remains separate from mutable pass flags', () => {
  expect(frozenRunStoryScope({ userStories: [
    { id: 'US-001', passes: true },
    { id: 'US-002', passes: true },
  ] }, 'US-002')).toEqual({ expectedStoryIds: ['US-002'], excludedStoryIds: [] });
});
