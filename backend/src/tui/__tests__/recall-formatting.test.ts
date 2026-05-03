import {
  formatRecallHeader,
  getRecallCategoryColor,
  getRecallCategoryLabel,
  parseMemoryContent,
} from '../recallFormatting';

describe('recallFormatting', () => {
  test('splits memory content into title and body when persisted as title: rule', () => {
    expect(parseMemoryContent('Use SQLite WAL mode: Always enable WAL mode for concurrent reads.')).toEqual({
      title: 'Use SQLite WAL mode',
      body: 'Always enable WAL mode for concurrent reads.',
    });
  });

  test('falls back to the full string when no delimiter is present', () => {
    expect(parseMemoryContent('Standalone memory')).toEqual({
      title: 'Standalone memory',
      body: '',
    });
  });

  test('maps categories to the required TUI colors', () => {
    expect(getRecallCategoryColor('Decision')).toBe('blue');
    expect(getRecallCategoryColor('Gotcha')).toBe('red');
    expect(getRecallCategoryColor('Bug Fix')).toBe('red');
    expect(getRecallCategoryColor('Pattern')).toBe('cyan');
    expect(getRecallCategoryColor('Convention')).toBe('green');
    expect(getRecallCategoryColor('Architecture')).toBe('magenta');
  });

  test('renders an uppercase category label for display', () => {
    expect(getRecallCategoryLabel('Bug Fix')).toBe('BUG FIX');
  });

  test('builds the boxed recall header with the query and count', () => {
    expect(formatRecallHeader('billing', 3, 39)).toBe("━━━━ Memory: 'billing' (3 results) ━━━━");
  });
});
