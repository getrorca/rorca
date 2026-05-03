export interface StoryEditorStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  complexity?: number;
  dependsOn: string[];
}

export interface StoryEditorDirtyFields {
  title?: string;
  complexity?: number;
}

export type StoryEditorDirtyMap = Map<string, StoryEditorDirtyFields>;

export type StoryEditorFocus = 'title' | 'complexity';

function sanitizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function clampStoryComplexity(value: number | undefined): number {
  const safe = Number.isInteger(value) ? Number(value) : 3;
  return Math.min(5, Math.max(1, safe));
}

export function normalizeSpecStories(payload: {
  userStories?: unknown[];
  stories?: unknown[];
}): StoryEditorStory[] {
  const stories = Array.isArray(payload.userStories)
    ? payload.userStories
    : Array.isArray(payload.stories)
      ? payload.stories
      : [];

  return stories.flatMap((story): StoryEditorStory[] => {
    if (!story || typeof story !== 'object') {
      return [];
    }

    const raw = story as Record<string, unknown>;
    if (typeof raw.id !== 'string' || typeof raw.title !== 'string') {
      return [];
    }

    return [{
      id: raw.id,
      title: raw.title,
      description: typeof raw.description === 'string' ? raw.description : '',
      acceptanceCriteria: sanitizeStringArray(raw.acceptanceCriteria),
      complexity: Number.isInteger(raw.complexity) ? Number(raw.complexity) : undefined,
      dependsOn: sanitizeStringArray(raw.dependsOn),
    }];
  });
}

export function getEffectiveStoryDraft(
  story: StoryEditorStory,
  dirtyMap: StoryEditorDirtyMap,
): { title: string; complexity: number } {
  const draft = dirtyMap.get(story.id);
  return {
    title: draft?.title ?? story.title,
    complexity: clampStoryComplexity(draft?.complexity ?? story.complexity),
  };
}

export function updateTitleDraft(
  dirtyMap: StoryEditorDirtyMap,
  story: StoryEditorStory,
  nextTitle: string,
): StoryEditorDirtyMap {
  const next = new Map(dirtyMap);
  const current = next.get(story.id) ?? {};
  const normalizedTitle = nextTitle === story.title ? undefined : nextTitle;
  const updated: StoryEditorDirtyFields = { ...current, title: normalizedTitle };

  if (updated.title === undefined && updated.complexity === undefined) {
    next.delete(story.id);
    return next;
  }

  next.set(story.id, updated);
  return next;
}

export function updateComplexityDraft(
  dirtyMap: StoryEditorDirtyMap,
  story: StoryEditorStory,
  delta: number,
): StoryEditorDirtyMap {
  const next = new Map(dirtyMap);
  const current = next.get(story.id) ?? {};
  const currentValue = getEffectiveStoryDraft(story, dirtyMap).complexity;
  const nextValue = clampStoryComplexity(currentValue + delta);
  const normalizedComplexity = nextValue === clampStoryComplexity(story.complexity) ? undefined : nextValue;
  const updated: StoryEditorDirtyFields = { ...current, complexity: normalizedComplexity };

  if (updated.title === undefined && updated.complexity === undefined) {
    next.delete(story.id);
    return next;
  }

  next.set(story.id, updated);
  return next;
}

export function validateStoryDraft(
  story: StoryEditorStory,
  dirtyMap: StoryEditorDirtyMap,
): string | null {
  const draft = getEffectiveStoryDraft(story, dirtyMap);
  if (!draft.title.trim()) {
    return `${story.id}: title is required`;
  }
  return null;
}
