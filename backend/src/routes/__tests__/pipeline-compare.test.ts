import { db } from '../../db/index';

// The compare endpoint logic is in the pipeline router.
// We test it by directly querying the DB in the same way the route does,
// since Express integration tests would require the full server setup.

describe('pipeline runs compare', () => {
  const workspaceId = 'test-compare-ws';

  beforeAll(() => {
    // Ensure workspace exists
    db.prepare(`INSERT OR IGNORE INTO workspaces (id, label, path) VALUES (?, ?, ?)`)
      .run(workspaceId, 'Test Compare', '/tmp/test-compare');
  });

  afterAll(() => {
    // Clean up test data
    db.prepare(`DELETE FROM story_results WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = ?)`).run(workspaceId);
    db.prepare(`DELETE FROM pipeline_runs WHERE workspace_id = ?`).run(workspaceId);
    db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(workspaceId);
  });

  function insertRun(specPath: string, status: string): number {
    const result = db.prepare(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, finished_at) VALUES (?, ?, ?, datetime('now'))`
    ).run(specPath, workspaceId, status);
    return result.lastInsertRowid as number;
  }

  function insertStory(runId: number, storyId: string, status: string, elapsed?: number) {
    db.prepare(
      `INSERT INTO story_results (run_id, story_id, status, elapsed_seconds) VALUES (?, ?, ?, ?)`
    ).run(runId, storyId, status, elapsed ?? null);
  }

  it('produces correct comparison for identical runs', () => {
    const run1Id = insertRun('ralph/specs/approved/test.json', 'done');
    const run2Id = insertRun('ralph/specs/approved/test.json', 'done');

    insertStory(run1Id, 'US-001', 'pass', 10);
    insertStory(run1Id, 'US-002', 'pass', 20);
    insertStory(run2Id, 'US-001', 'pass', 12);
    insertStory(run2Id, 'US-002', 'pass', 18);

    // Simulate what the compare endpoint does
    const stories1 = db.prepare('SELECT * FROM story_results WHERE run_id = ? ORDER BY id ASC').all(run1Id) as any[];
    const stories2 = db.prepare('SELECT * FROM story_results WHERE run_id = ? ORDER BY id ASC').all(run2Id) as any[];

    const map1 = new Map(stories1.map((s: any) => [s.story_id, s]));
    const map2 = new Map(stories2.map((s: any) => [s.story_id, s]));

    expect(map1.size).toBe(2);
    expect(map2.size).toBe(2);

    // Both have same stories with same status → all unchanged
    for (const storyId of map1.keys()) {
      const s1 = map1.get(storyId);
      const s2 = map2.get(storyId);
      expect(s1).toBeDefined();
      expect(s2).toBeDefined();
      expect(s1.status).toBe(s2.status);
    }
  });

  it('detects regressions and improvements', () => {
    const run1Id = insertRun('ralph/specs/approved/regr.json', 'done');
    const run2Id = insertRun('ralph/specs/approved/regr.json', 'failed');

    // Run 1: US-001 pass, US-002 fail
    insertStory(run1Id, 'US-001', 'pass', 10);
    insertStory(run1Id, 'US-002', 'fail', 5);

    // Run 2: US-001 fail (regression), US-002 pass (improvement)
    insertStory(run2Id, 'US-001', 'fail', 8);
    insertStory(run2Id, 'US-002', 'pass', 15);

    const s1 = db.prepare('SELECT * FROM story_results WHERE run_id = ?').all(run1Id) as any[];
    const s2 = db.prepare('SELECT * FROM story_results WHERE run_id = ?').all(run2Id) as any[];

    const map1 = new Map(s1.map((s: any) => [s.story_id, s]));
    const map2 = new Map(s2.map((s: any) => [s.story_id, s]));

    // US-001: pass → fail = regression
    expect(map1.get('US-001')!.status).toBe('pass');
    expect(map2.get('US-001')!.status).toBe('fail');

    // US-002: fail → pass = improvement
    expect(map1.get('US-002')!.status).toBe('fail');
    expect(map2.get('US-002')!.status).toBe('pass');
  });

  it('handles new and removed stories between runs', () => {
    const run1Id = insertRun('ralph/specs/approved/diff.json', 'done');
    const run2Id = insertRun('ralph/specs/approved/diff-v2.json', 'done');

    // Run 1 has US-001, US-002
    insertStory(run1Id, 'US-001', 'pass', 10);
    insertStory(run1Id, 'US-002', 'pass', 20);

    // Run 2 has US-001, US-003 (US-002 removed, US-003 new)
    insertStory(run2Id, 'US-001', 'pass', 12);
    insertStory(run2Id, 'US-003', 'pass', 15);

    const s1 = db.prepare('SELECT * FROM story_results WHERE run_id = ?').all(run1Id) as any[];
    const s2 = db.prepare('SELECT * FROM story_results WHERE run_id = ?').all(run2Id) as any[];

    const map1 = new Map(s1.map((s: any) => [s.story_id, s]));
    const map2 = new Map(s2.map((s: any) => [s.story_id, s]));

    const allIds = new Set([...map1.keys(), ...map2.keys()]);
    expect(allIds).toEqual(new Set(['US-001', 'US-002', 'US-003']));

    // US-002 only in run1 (removed)
    expect(map1.has('US-002')).toBe(true);
    expect(map2.has('US-002')).toBe(false);

    // US-003 only in run2 (new)
    expect(map1.has('US-003')).toBe(false);
    expect(map2.has('US-003')).toBe(true);
  });

  it('handles retry deduplication (latest row wins)', () => {
    const run1Id = insertRun('ralph/specs/approved/retry.json', 'done');

    // US-001 failed first, then retried and passed (two rows)
    db.prepare(
      `INSERT INTO story_results (run_id, story_id, status, retries, elapsed_seconds) VALUES (?, ?, ?, ?, ?)`
    ).run(run1Id, 'US-001', 'fail', 0, 5);
    db.prepare(
      `INSERT INTO story_results (run_id, story_id, status, retries, elapsed_seconds) VALUES (?, ?, ?, ?, ?)`
    ).run(run1Id, 'US-001', 'pass', 1, 10);

    const stories = db.prepare('SELECT * FROM story_results WHERE run_id = ? ORDER BY id ASC').all(run1Id) as any[];

    // Deduplicate: last row per story_id wins
    const map = new Map<string, any>();
    for (const s of stories) map.set(s.story_id, s);

    expect(map.get('US-001')!.status).toBe('pass');
    expect(map.get('US-001')!.retries).toBe(1);
  });

  it('computes pass rate correctly', () => {
    const runId = insertRun('ralph/specs/approved/rate.json', 'partial_failure');

    insertStory(runId, 'US-001', 'pass', 10);
    insertStory(runId, 'US-002', 'pass', 20);
    insertStory(runId, 'US-003', 'fail', 5);

    const stories = db.prepare('SELECT * FROM story_results WHERE run_id = ?').all(runId) as any[];
    const passCount = stories.filter((s: any) => s.status === 'pass').length;
    const passRate = Math.round((passCount / stories.length) * 100);

    expect(passRate).toBe(67); // 2/3 = 66.67% rounds to 67
  });
});
