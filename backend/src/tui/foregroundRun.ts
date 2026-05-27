/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { parseWalPayload, type PipelineWalEvent } from './runFormatting';

export interface WatchableRunSummary {
  id: number;
  status: string;
  spec_path?: string | null;
  queue_position?: number | null;
  parallelism?: number | null;
  started_at?: string | null;
  queued_at?: string | null;
}

export type ForegroundStoryStatus = 'running' | 'passed' | 'failed' | 'skipped';

export interface ForegroundStorySummary {
  storyId: string;
  title: string;
  waveIndex: number;
  status: ForegroundStoryStatus;
}

export function specSlugFromSpecPath(specPath: string | null | undefined, fallback = 'unknown'): string {
  if (!specPath) {
    return fallback;
  }

  const basename = specPath.split('/').pop() ?? specPath;
  return basename.endsWith('.json') ? basename.slice(0, -5) : basename;
}

function activeStatusPriority(status: string, preferredStatus?: 'running' | 'queued' | null): number {
  if (preferredStatus === 'queued' && status === 'queued') return 0;
  if (preferredStatus === 'running' && status === 'running') return 0;
  if (status === 'running') return 1;
  if (status === 'paused') return 2;
  if (status === 'queued') return 3;
  return 99;
}

export function selectWatchableRunForSpec(
  specSlug: string,
  runs: WatchableRunSummary[],
  preferredStatus?: 'running' | 'queued' | null,
): WatchableRunSummary | null {
  const active = runs.filter((run) => {
    const runSlug = specSlugFromSpecPath(run.spec_path, `run-${run.id}`);
    return runSlug === specSlug && (run.status === 'running' || run.status === 'paused' || run.status === 'queued');
  });

  if (active.length === 0) {
    return null;
  }

  return [...active].sort((a, b) => {
    const priorityDiff = activeStatusPriority(a.status, preferredStatus) - activeStatusPriority(b.status, preferredStatus);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    return b.id - a.id;
  })[0] ?? null;
}

export function sortForegroundStories(stories: ForegroundStorySummary[]): ForegroundStorySummary[] {
  const statusWeight: Record<ForegroundStoryStatus, number> = {
    running: 0,
    failed: 1,
    passed: 2,
    skipped: 3,
  };

  return [...stories].sort((a, b) => {
    if (a.waveIndex !== b.waveIndex) {
      return a.waveIndex - b.waveIndex;
    }
    if (statusWeight[a.status] !== statusWeight[b.status]) {
      return statusWeight[a.status] - statusWeight[b.status];
    }
    return a.storyId.localeCompare(b.storyId);
  });
}

export function reduceForegroundStories(
  current: ForegroundStorySummary[],
  event: PipelineWalEvent,
): ForegroundStorySummary[] {
  if (!event.story_id) {
    return current;
  }

  const payload = parseWalPayload(event.payload);
  const currentMap = new Map(current.map((story) => [story.storyId, story]));
  const existing = currentMap.get(event.story_id);
  const nextTitle = typeof payload.story_title === 'string'
    ? payload.story_title
    : existing?.title ?? event.story_id;
  const nextWaveIndex = typeof payload.wave_index === 'number'
    ? payload.wave_index
    : existing?.waveIndex ?? 0;

  switch (event.event_type) {
    case 'story_started':
      currentMap.set(event.story_id, {
        storyId: event.story_id,
        title: nextTitle,
        waveIndex: nextWaveIndex,
        status: 'running',
      });
      break;
    case 'story_passed':
    case 'story_failed':
    case 'story_skipped':
      currentMap.set(event.story_id, {
        storyId: event.story_id,
        title: nextTitle,
        waveIndex: nextWaveIndex,
        status: event.event_type === 'story_passed'
          ? 'passed'
          : event.event_type === 'story_failed'
            ? 'failed'
            : 'skipped',
      });
      break;
    default:
      return current;
  }

  return sortForegroundStories(Array.from(currentMap.values()));
}

export function buildForegroundStreamTargets(stories: ForegroundStorySummary[]): Array<{ key: string; label: string }> {
  const targets = [{ key: 'run', label: 'run' }];
  for (const [index, story] of sortForegroundStories(stories).entries()) {
    targets.push({ key: story.storyId, label: `${index + 1}:${story.storyId}` });
  }
  return targets;
}
