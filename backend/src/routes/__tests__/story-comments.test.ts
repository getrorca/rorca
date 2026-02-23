import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';

let app: Express;
let db: Database.Database;
let tmpDir: string;
let authToken: string;

const WORKSPACE_ID = 'ws-comments-test';
const SPEC_ID = 'test-spec';
const STORY_ID = 'US-001';

function createSpecFile() {
  const approvedDir = path.join(tmpDir, 'scripts', 'ralph', 'specs', 'approved');
  fs.mkdirSync(approvedDir, { recursive: true });
  const spec = {
    title: 'test-spec',
    userStories: [
      { id: 'US-001', title: 'First Story', description: 'Desc', acceptanceCriteria: ['AC1', 'AC2', 'AC3'], dependsOn: [], passes: false },
      { id: 'US-002', title: 'Second Story', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [], passes: false },
    ],
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(approvedDir, `${SPEC_ID}.json`), JSON.stringify(spec, null, 2));
}

beforeEach(async () => {
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorcha-comments-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  process.env.DB_PATH = dbPath;
  process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
  const dbMod = require('../../db/index');
  db = dbMod.db;
  authToken = await getAuthToken(app);

  db.prepare('DELETE FROM wal_events').run();
  db.prepare("INSERT INTO workspaces (id, label, path) VALUES (?, ?, ?)").run(WORKSPACE_ID, 'Comments Test', tmpDir);
  createSpecFile();
});

afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 100));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

describe('POST /api/specs/:specId/stories/:storyId/comments', () => {
  it('creates a comment and returns it with author info', async () => {
    const res = await request(app)
      .post(`/api/specs/${SPEC_ID}/stories/${STORY_ID}/comments`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ body: 'This story needs more detail on **error handling**.' });

    expect(res.status).toBe(201);
    expect(res.body.spec_id).toBe(SPEC_ID);
    expect(res.body.story_id).toBe(STORY_ID);
    expect(res.body.body).toBe('This story needs more detail on **error handling**.');
    expect(res.body.display_name).toBe('Auth Test User');
    expect(res.body.resolved_at).toBeNull();
    expect(res.body.id).toBeDefined();
    expect(res.body.created_at).toBeDefined();
  });

  it('rejects empty body', async () => {
    const res = await request(app)
      .post(`/api/specs/${SPEC_ID}/stories/${STORY_ID}/comments`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ body: '' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('body is required');
  });

  it('rejects missing body field', async () => {
    const res = await request(app)
      .post(`/api/specs/${SPEC_ID}/stories/${STORY_ID}/comments`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('emits a comment_added WAL event', async () => {
    await request(app)
      .post(`/api/specs/${SPEC_ID}/stories/${STORY_ID}/comments`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ body: 'WAL test comment' });

    const walEvent = db.prepare(
      "SELECT * FROM wal_events WHERE event_type = 'comment_added' AND spec_id = ? AND story_id = ?"
    ).get(SPEC_ID, STORY_ID) as { event_type: string; payload: string } | undefined;

    expect(walEvent).toBeDefined();
    expect(JSON.parse(walEvent!.payload).commentId).toBeDefined();
  });
});

describe('GET /api/specs/:specId/stories/:storyId/comments', () => {
  it('returns comments in chronological order', async () => {
    // Create two comments
    await request(app)
      .post(`/api/specs/${SPEC_ID}/stories/${STORY_ID}/comments`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ body: 'First comment' });

    await request(app)
      .post(`/api/specs/${SPEC_ID}/stories/${STORY_ID}/comments`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ body: 'Second comment' });

    const res = await request(app)
      .get(`/api/specs/${SPEC_ID}/stories/${STORY_ID}/comments`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.comments).toHaveLength(2);
    expect(res.body.comments[0].body).toBe('First comment');
    expect(res.body.comments[1].body).toBe('Second comment');
  });

  it('returns empty array when no comments exist', async () => {
    const res = await request(app)
      .get(`/api/specs/${SPEC_ID}/stories/US-999/comments`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.comments).toHaveLength(0);
  });
});

describe('POST /api/specs/:specId/stories/:storyId/comments/:commentId/resolve', () => {
  it('resolves an existing comment', async () => {
    const createRes = await request(app)
      .post(`/api/specs/${SPEC_ID}/stories/${STORY_ID}/comments`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ body: 'Needs fix' });

    const commentId = createRes.body.id;

    const res = await request(app)
      .post(`/api/specs/${SPEC_ID}/stories/${STORY_ID}/comments/${commentId}/resolve`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.resolved_at).not.toBeNull();
    expect(res.body.id).toBe(commentId);
  });

  it('returns 404 for non-existent comment', async () => {
    const res = await request(app)
      .post(`/api/specs/${SPEC_ID}/stories/${STORY_ID}/comments/non-existent/resolve`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
  });

  it('returns 400 when resolving already-resolved comment', async () => {
    const createRes = await request(app)
      .post(`/api/specs/${SPEC_ID}/stories/${STORY_ID}/comments`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ body: 'Already resolved' });

    const commentId = createRes.body.id;

    // Resolve once
    await request(app)
      .post(`/api/specs/${SPEC_ID}/stories/${STORY_ID}/comments/${commentId}/resolve`)
      .set('Authorization', `Bearer ${authToken}`);

    // Resolve again — should fail
    const res = await request(app)
      .post(`/api/specs/${SPEC_ID}/stories/${STORY_ID}/comments/${commentId}/resolve`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Comment is already resolved');
  });

  it('emits a comment_resolved WAL event', async () => {
    const createRes = await request(app)
      .post(`/api/specs/${SPEC_ID}/stories/${STORY_ID}/comments`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ body: 'WAL resolve test' });

    await request(app)
      .post(`/api/specs/${SPEC_ID}/stories/${STORY_ID}/comments/${createRes.body.id}/resolve`)
      .set('Authorization', `Bearer ${authToken}`);

    const walEvent = db.prepare(
      "SELECT * FROM wal_events WHERE event_type = 'comment_resolved' AND spec_id = ? AND story_id = ?"
    ).get(SPEC_ID, STORY_ID) as { event_type: string; payload: string } | undefined;

    expect(walEvent).toBeDefined();
    expect(JSON.parse(walEvent!.payload).commentId).toBe(createRes.body.id);
  });
});

describe('GET /api/specs/:specId/comments/counts', () => {
  it('returns unresolved comment counts per story', async () => {
    // Add 2 comments to US-001, 1 to US-002
    await request(app)
      .post(`/api/specs/${SPEC_ID}/stories/US-001/comments`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ body: 'Comment 1' });

    await request(app)
      .post(`/api/specs/${SPEC_ID}/stories/US-001/comments`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ body: 'Comment 2' });

    const c3 = await request(app)
      .post(`/api/specs/${SPEC_ID}/stories/US-002/comments`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ body: 'Comment 3' });

    // Resolve the US-002 comment
    await request(app)
      .post(`/api/specs/${SPEC_ID}/stories/US-002/comments/${c3.body.id}/resolve`)
      .set('Authorization', `Bearer ${authToken}`);

    const res = await request(app)
      .get(`/api/specs/${SPEC_ID}/comments/counts`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.counts['US-001']).toBe(2);
    expect(res.body.counts['US-002']).toBeUndefined(); // Resolved, so no unresolved
  });

  it('returns empty counts when no comments', async () => {
    const res = await request(app)
      .get(`/api/specs/${SPEC_ID}/comments/counts`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({});
  });
});
