import { db } from '../../db/index';

describe('story token usage (V2-025)', () => {
  const workspaceId = 'test-tokens-ws';

  beforeAll(() => {
    db.prepare(`INSERT OR IGNORE INTO workspaces (id, label, path) VALUES (?, ?, ?)`)
      .run(workspaceId, 'Test Tokens', '/tmp/test-tokens');
  });

  afterAll(() => {
    db.prepare(`DELETE FROM story_results WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = ?)`).run(workspaceId);
    db.prepare(`DELETE FROM pipeline_runs WHERE workspace_id = ?`).run(workspaceId);
    db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(workspaceId);
  });

  function insertRun(status: string): number {
    const result = db.prepare(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, finished_at) VALUES (?, ?, ?, datetime('now'))`
    ).run('ralph/specs/approved/test.json', workspaceId, status);
    return result.lastInsertRowid as number;
  }

  it('stores and retrieves input_tokens and output_tokens', () => {
    const runId = insertRun('done');

    db.prepare(
      `INSERT INTO story_results (run_id, story_id, status, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)`
    ).run(runId, 'US-001', 'pass', 15000, 3000);

    db.prepare(
      `INSERT INTO story_results (run_id, story_id, status, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)`
    ).run(runId, 'US-002', 'pass', 180000, 5000);

    const stories = db.prepare('SELECT * FROM story_results WHERE run_id = ? ORDER BY id ASC').all(runId) as any[];

    expect(stories).toHaveLength(2);
    expect(stories[0].input_tokens).toBe(15000);
    expect(stories[0].output_tokens).toBe(3000);
    expect(stories[1].input_tokens).toBe(180000);
    expect(stories[1].output_tokens).toBe(5000);
  });

  it('allows null token values for stories without token data', () => {
    const runId = insertRun('done');

    db.prepare(
      `INSERT INTO story_results (run_id, story_id, status) VALUES (?, ?, ?)`
    ).run(runId, 'US-003', 'pass');

    const story = db.prepare('SELECT * FROM story_results WHERE run_id = ? AND story_id = ?').get(runId, 'US-003') as any;

    expect(story.input_tokens).toBeNull();
    expect(story.output_tokens).toBeNull();
  });

  it('updates token values via COALESCE pattern', () => {
    const runId = insertRun('done');

    db.prepare(
      `INSERT INTO story_results (run_id, story_id, status) VALUES (?, ?, ?)`
    ).run(runId, 'US-004', 'pass');

    // Update with token data (simulating the POST endpoint logic)
    const row = db.prepare(
      `SELECT id FROM story_results WHERE run_id = ? AND story_id = ? ORDER BY id DESC LIMIT 1`
    ).get(runId, 'US-004') as { id: number };

    db.prepare(
      `UPDATE story_results SET input_tokens = COALESCE(?, input_tokens), output_tokens = COALESCE(?, output_tokens) WHERE id = ?`
    ).run(50000, 8000, row.id);

    const updated = db.prepare('SELECT * FROM story_results WHERE id = ?').get(row.id) as any;
    expect(updated.input_tokens).toBe(50000);
    expect(updated.output_tokens).toBe(8000);
  });

  it('computes aggregate token stats across a run', () => {
    const runId = insertRun('done');

    db.prepare(
      `INSERT INTO story_results (run_id, story_id, status, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)`
    ).run(runId, 'US-010', 'pass', 25000, 5000);
    db.prepare(
      `INSERT INTO story_results (run_id, story_id, status, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)`
    ).run(runId, 'US-011', 'pass', 150000, 12000);
    db.prepare(
      `INSERT INTO story_results (run_id, story_id, status, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)`
    ).run(runId, 'US-012', 'fail', 190000, 8000);

    const agg = db.prepare(
      `SELECT SUM(input_tokens) as total_input, SUM(output_tokens) as total_output, COUNT(*) as count
       FROM story_results WHERE run_id = ? AND input_tokens IS NOT NULL`
    ).get(runId) as any;

    expect(agg.total_input).toBe(365000);
    expect(agg.total_output).toBe(25000);
    expect(agg.count).toBe(3);

    // Context window check: US-012 uses 198k/200k = 99% — should be flagged
    const contextWindow = 200000;
    const threshold = 0.8;
    const warningStories = db.prepare(
      `SELECT story_id, input_tokens, output_tokens,
              (input_tokens + output_tokens) as total_tokens
       FROM story_results
       WHERE run_id = ? AND input_tokens IS NOT NULL
         AND (input_tokens + output_tokens) >= ?`
    ).all(runId, contextWindow * threshold) as any[];

    expect(warningStories).toHaveLength(2); // US-011 (162k) and US-012 (198k)
    expect(warningStories.map((s: any) => s.story_id).sort()).toEqual(['US-011', 'US-012']);
  });
});
