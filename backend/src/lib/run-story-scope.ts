/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Host-owned frozen run scope; mutable pass flags are projection-only. */
export function frozenRunStoryScope(
  specJson: Record<string, unknown>,
  specificStory?: string,
): { expectedStoryIds: string[]; excludedStoryIds: string[] } {
  type Story = { id?: unknown; excluded?: boolean; passes?: boolean };
  const phaseStories = Array.isArray(specJson.phases)
    ? (specJson.phases as Array<{ stories?: Story[] }>).flatMap(phase => phase.stories ?? [])
    : [];
  const stories = Array.isArray(specJson.userStories)
    ? specJson.userStories as Story[]
    : phaseStories;
  const normalized = stories
    .map(story => ({ story, id: typeof story.id === 'string' ? story.id.trim() : '' }))
    .filter((entry): entry is { story: Story; id: string } => Boolean(entry.id));
  const excludedStoryIds = [...new Set(normalized
    .filter(({ story }) => story.excluded === true)
    .map(({ id }) => id))].sort();
  const expectedStoryIds = [...new Set(normalized
    .filter(({ story, id }) => story.excluded !== true
      && (!specificStory || id === specificStory))
    .map(({ id }) => id))].sort();
  return { expectedStoryIds, excludedStoryIds };
}
