/**
 * Unit tests for checkDuplicatePrefixes() in pg-index.ts.
 *
 * Verifies that the migration runner throws at startup when two files share
 * the same numeric prefix, and succeeds silently when all prefixes are unique.
 *
 * No DB connection needed — checkDuplicatePrefixes() is pure (filesystem-free).
 */

import { checkDuplicatePrefixes } from '../pg-index';

describe('checkDuplicatePrefixes()', () => {
  it('throws when two files share the same numeric prefix', () => {
    const files = ['069_foo.sql', '069_bar.sql', '070_other.sql'];
    expect(() => checkDuplicatePrefixes(files)).toThrow();
  });

  it('error message contains the word "duplicate" (case-insensitive)', () => {
    const files = ['069_foo.sql', '069_bar.sql'];
    expect(() => checkDuplicatePrefixes(files)).toThrow(/duplicate/i);
  });

  it('error message lists both conflicting filenames', () => {
    const files = ['069_foo.sql', '069_bar.sql'];
    expect(() => checkDuplicatePrefixes(files)).toThrow(/069_foo\.sql/);
    expect(() => checkDuplicatePrefixes(files)).toThrow(/069_bar\.sql/);
  });

  it('error message includes the conflicting prefix number', () => {
    const files = ['069_foo.sql', '069_bar.sql'];
    expect(() => checkDuplicatePrefixes(files)).toThrow(/69/);
  });

  it('succeeds silently when all prefixes are unique', () => {
    const files = ['001_init.sql', '002_bar.sql', '003_baz.sql'];
    expect(() => checkDuplicatePrefixes(files)).not.toThrow();
  });

  it('handles 3+ files sharing one prefix', () => {
    const files = ['072_a.sql', '072_b.sql', '072_c.sql'];
    const call = () => checkDuplicatePrefixes(files);
    expect(call).toThrow(/duplicate/i);
    // All three filenames must appear in the error
    let message = '';
    try { call(); } catch (e) { message = (e as Error).message; }
    expect(message).toContain('072_a.sql');
    expect(message).toContain('072_b.sql');
    expect(message).toContain('072_c.sql');
  });

  it('treats zero-padded and non-padded prefixes as the same number', () => {
    // parseInt('069') === parseInt('69') === 69
    const files = ['069_foo.sql', '69_bar.sql'];
    expect(() => checkDuplicatePrefixes(files)).toThrow(/duplicate/i);
  });

  it('ignores non-numbered filenames', () => {
    const files = ['001_init.sql', 'README.md', '.gitkeep', '002_other.sql'];
    expect(() => checkDuplicatePrefixes(files)).not.toThrow();
  });

  it('handles timestamp-format filenames as unique prefixes', () => {
    const files = ['001_init.sql', '20260313120000_feature.sql', '20260314090000_other.sql'];
    expect(() => checkDuplicatePrefixes(files)).not.toThrow();
  });

  it('detects duplicates among timestamp-format filenames', () => {
    const files = ['20260313120000_a.sql', '20260313120000_b.sql'];
    expect(() => checkDuplicatePrefixes(files)).toThrow(/duplicate/i);
  });

  it('succeeds on an empty array', () => {
    expect(() => checkDuplicatePrefixes([])).not.toThrow();
  });
});
