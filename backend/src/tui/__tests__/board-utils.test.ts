/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  buildBoardColumns,
  computePassRate,
  formatBoardMeta,
  moveBoardSelection,
  resolveBoardSelection,
  truncateSlug,
  type KanbanResponse,
} from '../boardUtils';

function buildKanban(): KanbanResponse {
  return {
    draft: [
      { id: 'pending-one', storyCount: 3, generatedAt: '2026-05-02T10:00:00.000Z' },
    ],
    inProgress: [
      { id: 'approved-one', storyCount: 4, generatedAt: '2026-05-02T09:00:00.000Z', approvedAt: '2026-05-02T09:30:00.000Z', passedStories: 1 },
      { id: 'running-one', storyCount: 5, generatedAt: '2026-05-02T08:00:00.000Z', activeRunStatus: 'running', passedStories: 2 },
      { id: 'queued-one', storyCount: 6, generatedAt: '2026-05-02T07:00:00.000Z', activeRunStatus: 'queued', queuePosition: 2, passedStories: 0 },
    ],
    done: [
      { id: 'done-one', storyCount: 2, generatedAt: '2026-05-01T08:00:00.000Z' },
    ],
  };
}

describe('board utils', () => {
  test('builds board columns from kanban response', () => {
    const columns = buildBoardColumns(buildKanban());

    expect(columns[0].specs.map((spec) => spec.id)).toEqual(['pending-one']);
    expect(columns[1].specs.map((spec) => spec.id)).toEqual(['approved-one']);
    expect(columns[2].specs.map((spec) => spec.id)).toEqual(['running-one', 'queued-one', 'done-one']);
  });

  test('truncates slugs to 28 characters with ellipsis', () => {
    expect(truncateSlug('short-slug')).toBe('short-slug');
    expect(truncateSlug('abcdefghijklmnopqrstuvwxyz123456')).toBe('abcdefghijklmnopqrstuvwxyz1…');
  });

  test('computes pass rates by column semantics', () => {
    const columns = buildBoardColumns(buildKanban());

    expect(computePassRate(columns[0].specs[0], columns[0].key)).toBe(0);
    expect(computePassRate(columns[1].specs[0], columns[1].key)).toBe(25);
    expect(computePassRate(columns[2].specs[2], columns[2].key)).toBe(100);
  });

  test('formats board metadata with stories, pass rate, and relative time', () => {
    const now = new Date('2026-05-02T10:30:00.000Z');
    expect(formatBoardMeta(buildKanban().draft[0], 'pending', now)).toContain('3 stories  •  0%');
  });

  test('selection skips empty columns and clamps row index', () => {
    const columns = buildBoardColumns(buildKanban());
    const initial = resolveBoardSelection(columns, 0, 'approved-one');
    const movedRight = moveBoardSelection(columns, initial, 'right');

    expect(movedRight).toEqual({ columnIndex: 2, specId: 'running-one' });

    const movedDown = moveBoardSelection(columns, movedRight, 'down');
    expect(movedDown).toEqual({ columnIndex: 2, specId: 'queued-one' });
  });
});
