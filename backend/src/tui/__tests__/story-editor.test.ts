import {
  clampStoryComplexity,
  getEffectiveStoryDraft,
  normalizeSpecStories,
  updateComplexityDraft,
  updateTitleDraft,
  validateStoryDraft,
  type StoryEditorStory,
} from '../storyEditor';

function makeStory(overrides?: Partial<StoryEditorStory>): StoryEditorStory {
  return {
    id: 'US-001',
    title: 'Base title',
    description: 'Base description',
    acceptanceCriteria: ['One', 'Two'],
    complexity: 3,
    dependsOn: [],
    ...overrides,
  };
}

describe('story editor helpers', () => {
  test('normalizes full spec stories for editor rendering', () => {
    expect(normalizeSpecStories({
      userStories: [{
        id: 'US-001',
        title: 'Story one',
        description: 'Desc',
        acceptanceCriteria: ['AC1'],
        complexity: 4,
        dependsOn: ['US-000'],
      }],
    })).toEqual([{
      id: 'US-001',
      title: 'Story one',
      description: 'Desc',
      acceptanceCriteria: ['AC1'],
      complexity: 4,
      dependsOn: ['US-000'],
    }]);
  });

  test('title drafts clear when restored to original value', () => {
    const story = makeStory();
    const first = updateTitleDraft(new Map(), story, 'New title');
    expect(first.get(story.id)).toEqual({ title: 'New title' });

    const reverted = updateTitleDraft(first, story, story.title);
    expect(reverted.has(story.id)).toBe(false);
  });

  test('complexity drafts clamp between 1 and 5 and clear when restored', () => {
    const story = makeStory({ complexity: 3 });
    const raised = updateComplexityDraft(new Map(), story, 10);
    expect(getEffectiveStoryDraft(story, raised).complexity).toBe(5);

    const lowered = updateComplexityDraft(raised, story, -10);
    expect(getEffectiveStoryDraft(story, lowered).complexity).toBe(1);

    const reset = updateComplexityDraft(lowered, story, 2);
    expect(reset.has(story.id)).toBe(false);
  });

  test('validates non-empty titles using current draft value', () => {
    const story = makeStory();
    const dirty = updateTitleDraft(new Map(), story, '   ');
    expect(validateStoryDraft(story, dirty)).toBe('US-001: title is required');
  });

  test('falls back to mid complexity when story value is missing', () => {
    expect(clampStoryComplexity(undefined)).toBe(3);
  });
});
