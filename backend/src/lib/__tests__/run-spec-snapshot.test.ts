import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { prepareRunSpecSnapshot } from '../run-spec-snapshot';

describe('prepareRunSpecSnapshot', () => {
  test('copies worktree runs to an isolated mutable artifact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-run-spec-'));
    try {
      const source = path.join(root, 'approved.json');
      const worktree = path.join(root, 'worktree');
      fs.mkdirSync(worktree);
      fs.writeFileSync(source, JSON.stringify({ userStories: [{ id: 'US-1', passes: false }] }));

      const snapshot = prepareRunSpecSnapshot({ runId: 42, sourceSpecPath: source, worktreePath: worktree });
      expect(snapshot).toBe(path.join(worktree, '.rorca', 'run-specs', 'run-42.json'));
      expect(JSON.parse(fs.readFileSync(snapshot, 'utf8'))).toEqual({ userStories: [{ id: 'US-1', passes: false }] });

      fs.writeFileSync(snapshot, JSON.stringify({ userStories: [{ id: 'US-1', passes: true }] }));
      expect(JSON.parse(fs.readFileSync(source, 'utf8'))).toEqual({ userStories: [{ id: 'US-1', passes: false }] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps non-worktree runs on the canonical path', () => {
    expect(prepareRunSpecSnapshot({ runId: 7, sourceSpecPath: '/tmp/spec.json', worktreePath: null }))
      .toBe('/tmp/spec.json');
  });
});
