/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it } from 'vitest';
import { getKanbanRunPresentation, isRunStatusBlocking } from '../kanbanRunStatus';

describe('kanban run status presentation', () => {
  it('uses activeRunStatus and queuePosition to present queued runs', () => {
    const presentation = getKanbanRunPresentation({
      activeRunId: 42,
      activeRunStatus: 'queued',
      queuePosition: 3,
    });

    expect(presentation).toMatchObject({
      hasActiveRun: true,
      status: 'queued',
      isQueued: true,
      queuePosition: 3,
      badgeText: 'Queued #3',
    });
  });

  it('uses activeRunStatus to present running and parallel states without queue derivation', () => {
    const presentation = getKanbanRunPresentation({
      activeRunId: 43,
      activeRunStatus: 'running',
      queuePosition: 9,
      isParallelRun: true,
    });

    expect(presentation).toMatchObject({
      hasActiveRun: true,
      status: 'running',
      isQueued: false,
      isParallelRun: true,
      badgeText: 'Running (parallel)',
    });
  });

  it('does not present an active run when the kanban contract omits activeRunId', () => {
    const presentation = getKanbanRunPresentation({ activeRunStatus: 'queued', queuePosition: 1 });

    expect(presentation.hasActiveRun).toBe(false);
    expect(presentation.status).toBeUndefined();
    expect(presentation.badgeText).toBeUndefined();
  });
});

describe('active run disabled-state rules', () => {
  it('blocks actions for activeRunStatus running or queued only', () => {
    expect(isRunStatusBlocking('running')).toBe(true);
    expect(isRunStatusBlocking('queued')).toBe(true);
    expect(isRunStatusBlocking(undefined)).toBe(false);
    expect(isRunStatusBlocking(null)).toBe(false);
  });
});
