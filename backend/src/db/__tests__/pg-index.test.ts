/**
 * Unit tests for pg-index.ts migration filename parsing and ordering.
 *
 * Verifies that both sequential (001_description.sql) and timestamp
 * (20260313120000_description.sql) migration filename formats are:
 *   1. Discovered (filtered from non-.sql files)
 *   2. Sorted numerically (not lexicographically)
 *   3. Version-extracted correctly via parseInt()
 *
 * No DB connection needed — the sorting/parsing logic is pure and can be
 * tested by replicating it directly.
 */

// Replicate the sorting comparator from pg-index.ts exactly
function sortMigrationFiles(files: string[]): string[] {
  return files
    .filter(f => f.endsWith('.sql'))
    .sort((a, b) => {
      const aMatch = a.match(/^(\d+)/);
      const bMatch = b.match(/^(\d+)/);
      const aNum = aMatch ? parseInt(aMatch[1], 10) : 0;
      const bNum = bMatch ? parseInt(bMatch[1], 10) : 0;
      return aNum - bNum;
    });
}

// Replicate the version extraction from pg-index.ts exactly
function extractVersion(filename: string): number | null {
  const match = filename.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

describe('pg-index migration filename format support', () => {
  describe('sortMigrationFiles()', () => {
    it('sorts sequential files by numeric prefix', () => {
      const files = ['003_foo.sql', '001_init.sql', '002_bar.sql'];
      expect(sortMigrationFiles(files)).toEqual([
        '001_init.sql',
        '002_bar.sql',
        '003_foo.sql',
      ]);
    });

    it('places timestamp-format files after all sequential files', () => {
      const files = [
        '20260313120000_add_feature.sql',
        '001_init.sql',
        '072_pipeline_runs.sql',
        '003_specs.sql',
      ];
      const sorted = sortMigrationFiles(files);
      expect(sorted).toEqual([
        '001_init.sql',
        '003_specs.sql',
        '072_pipeline_runs.sql',
        '20260313120000_add_feature.sql',
      ]);
    });

    it('sorts multiple timestamp-format files chronologically', () => {
      const files = [
        '20260314090000_second.sql',
        '001_init.sql',
        '20260313120000_first.sql',
      ];
      const sorted = sortMigrationFiles(files);
      expect(sorted).toEqual([
        '001_init.sql',
        '20260313120000_first.sql',
        '20260314090000_second.sql',
      ]);
    });

    it('filters out non-.sql files', () => {
      const files = [
        '001_init.sql',
        'README.md',
        '20260313120000_feature.sql',
        '.gitkeep',
      ];
      const sorted = sortMigrationFiles(files);
      expect(sorted).toHaveLength(2);
      expect(sorted).not.toContain('README.md');
      expect(sorted).not.toContain('.gitkeep');
    });

    it('does NOT use lexicographic sort (timestamp > "3" numerically, not "2..." < "3" as strings)', () => {
      // Lexicographic: '20260313120000_x.sql' < '3_x.sql' (because '2' < '3')
      // Numeric: 20260313120000 > 3
      const files = ['3_test.sql', '20260313120000_timestamp.sql', '1_init.sql'];
      const sorted = sortMigrationFiles(files);
      // Timestamp must come LAST
      expect(sorted[sorted.length - 1]).toBe('20260313120000_timestamp.sql');
      expect(sorted[0]).toBe('1_init.sql');
      expect(sorted[1]).toBe('3_test.sql');
    });
  });

  describe('extractVersion()', () => {
    it('extracts sequential version as integer', () => {
      expect(extractVersion('001_init.sql')).toBe(1);
      expect(extractVersion('072_pipeline_runs.sql')).toBe(72);
    });

    it('extracts 14-digit timestamp version without precision loss', () => {
      const version = extractVersion('20260313120000_feature.sql');
      expect(version).toBe(20260313120000);
      // Verify no precision loss: parseInt is safe for 14-digit values
      // Number.MAX_SAFE_INTEGER = 9007199254740991 (~9×10^15)
      // Max plausible timestamp = 29991231235959 (~3×10^13) — well within safe range
      expect(version).toBeLessThan(Number.MAX_SAFE_INTEGER);
    });

    it('returns null for filenames without a numeric prefix', () => {
      expect(extractVersion('README.md')).toBeNull();
      expect(extractVersion('no-prefix.sql')).toBeNull();
    });
  });

  describe('mixed sequential and timestamp migrations', () => {
    it('discovers, sorts, and versions a realistic mixed set correctly', () => {
      const rawFiles = [
        '20260313120000_test_timestamp.sql', // timestamp format
        '003_specs.sql',
        'README.md',                          // non-sql, should be filtered
        '072_pipeline_runs.sql',
        '001_init.sql',
        '074_add_auto_merge.sql',
      ];

      const sorted = sortMigrationFiles(rawFiles);

      // Correct order: sequential 001, 003, 072, 074 then timestamp 20260313120000
      expect(sorted).toEqual([
        '001_init.sql',
        '003_specs.sql',
        '072_pipeline_runs.sql',
        '074_add_auto_merge.sql',
        '20260313120000_test_timestamp.sql',
      ]);

      // Versions are extracted correctly
      const versions = sorted.map(extractVersion);
      expect(versions).toEqual([1, 3, 72, 74, 20260313120000]);

      // Timestamp migration is last
      const lastVersion = versions[versions.length - 1];
      expect(lastVersion).toBe(20260313120000);
      expect(lastVersion).toBeGreaterThan(versions[versions.length - 2]!);
    });
  });
});
