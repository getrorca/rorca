/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useMemo } from 'react';
import type { WalEvent } from '../hooks/usePipelineSSE';
import MiniTerminalPane, { type StoryPaneStatus } from './MiniTerminalPane';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ConcurrentStory {
  storyId: string;
  title: string;
  waveIndex: number;
  status: StoryPaneStatus;
}

interface MultiPaneTerminalProps {
  runId: number;
  walEvents: WalEvent[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deriveConcurrentStories(events: WalEvent[]): ConcurrentStory[] {
  const storyMap = new Map<string, ConcurrentStory>();

  for (const e of events) {
    if (!e.story_id) continue;
    let payload: Record<string, unknown> = {};
    if (e.payload) {
      try {
        payload = typeof e.payload === 'string' ? JSON.parse(e.payload) : (e.payload as Record<string, unknown>);
      } catch { /* ignore */ }
    }

    switch (e.event_type) {
      case 'story_started':
        storyMap.set(e.story_id, {
          storyId: e.story_id,
          title: String(payload.story_title || payload.title || e.story_id),
          waveIndex: Number(payload.wave_index ?? 0),
          status: 'running',
        });
        break;
      case 'story_passed':
        if (storyMap.has(e.story_id)) {
          storyMap.get(e.story_id)!.status = 'passed';
        }
        break;
      case 'story_failed':
        if (storyMap.has(e.story_id)) {
          storyMap.get(e.story_id)!.status = 'failed';
        }
        break;
    }
  }

  return Array.from(storyMap.values());
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function MultiPaneTerminal({ runId, walEvents }: MultiPaneTerminalProps) {
  const stories = useMemo(() => deriveConcurrentStories(walEvents), [walEvents]);

  // Group stories by wave index
  const waveGroups = useMemo(() => {
    const groups = new Map<number, ConcurrentStory[]>();
    for (const story of stories) {
      const existing = groups.get(story.waveIndex) || [];
      existing.push(story);
      groups.set(story.waveIndex, existing);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a - b)
      .map(([waveIndex, waveStories]) => ({ waveIndex, stories: waveStories }));
  }, [stories]);

  if (stories.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-[var(--text-muted)] text-sm">
        Waiting for parallel stories to start...
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-3 space-y-4">
      {waveGroups.map(({ waveIndex, stories: waveStories }) => (
        <div key={waveIndex}>
          {/* Wave label */}
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Wave {waveIndex}
            </span>
            <div className="flex-1 h-px bg-[var(--border)]" />
            <span className="text-[10px] text-[var(--text-muted)]">
              {waveStories.filter(s => s.status === 'passed').length}/{waveStories.length} done
            </span>
          </div>

          {/* Responsive grid: 2 columns on wide screens, 1 on narrow */}
          <div className="grid grid-cols-1 min-[900px]:grid-cols-2 gap-3">
            {waveStories.map(story => (
              <div key={story.storyId} className="h-[300px]">
                <MiniTerminalPane
                  runId={runId}
                  storyId={story.storyId}
                  storyTitle={story.title}
                  status={story.status}
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
