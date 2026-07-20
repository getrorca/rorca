import * as fs from 'fs';
import * as path from 'path';

const migrationPath = path.join(process.cwd(), 'src/db/pg-migrations/20260720120000_pipeline_run_worker_summary.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');
const worker = fs.readFileSync(path.join(process.cwd(), 'src/worker.ts'), 'utf8');

test('worker terminal reason authority has a forward-only bounded application-table column', () => {
  expect(migration).toMatch(/ALTER TABLE pipeline_runs[\s\S]*ADD COLUMN IF NOT EXISTS summary TEXT/);
  expect(migration).toMatch(/pipeline_runs_summary_length_ck[\s\S]*char_length\(summary\) <= 4000/);
  expect(migration).not.toMatch(/pgboss\./i);
  expect(worker).toContain("status = 'failed', finished_at = NOW(), summary = $2");
});
