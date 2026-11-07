/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { execute } from '../../db/index';

let app: Express;
let tmpDir: string;
let authToken: string;

const WORKSPACE_ID = 'ws-finops-test';
const AUTH_EMAIL = 'finops-settings-auth@example.com';
const AUTH_ID = '00000000-0000-4000-8000-000000000020';
beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const serverMod = require('../../server');
  app = serverMod.default;
});

beforeEach(async () => {
  authToken = await getAuthToken(app, { email: AUTH_EMAIL, authId: AUTH_ID, role: 'admin' });
  await execute('UPDATE users SET plan = $1 WHERE email = $2', ['pro', AUTH_EMAIL]);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-finops-test-'));
  await execute(
    `INSERT INTO workspaces (id, label, path)
     VALUES ($1, 'FinOps Test Workspace', $2)
     ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, path = EXCLUDED.path`,
    [WORKSPACE_ID, tmpDir],
  );
  await execute('DELETE FROM billing_profiles WHERE workspace_id = $1 OR workspace_id IS NULL', [WORKSPACE_ID]);
});

afterEach(async () => {
  await execute('DELETE FROM billing_profiles WHERE workspace_id = $1 OR workspace_id IS NULL', [WORKSPACE_ID]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(async () => {
  try { const { closePool: cp } = require('../../db/index'); await cp(); } catch {}
  delete process.env.NODE_ENV;
});

function auth(req: request.Test) {
  return req.set('Authorization', `Bearer ${authToken}`);
}

const BASE = '/api/finops/billing-profiles';

describe('POST /api/finops/billing-profiles', () => {
  it('creates a metered_api profile', async () => {
    const res = await auth(
      request(app).post(BASE).send({
        workspace_id: WORKSPACE_ID,
        provider: 'openai',
        model_pattern: 'gpt-4o',
        billing_mode: 'metered_api',
      }),
    );

    expect(res.status).toBe(201);
    expect(res.body.profile.provider).toBe('openai');
    expect(res.body.profile.billingMode).toBe('metered_api');
    expect(res.body.profile.allocationBasis).toBe('none');
    expect(res.body.profile.enabled).toBe(true);
    expect(res.body.profile.monthlyCostUsd).toBeNull();
  });

  it('creates a subscription profile with monthly cost', async () => {
    const res = await auth(
      request(app).post(BASE).send({
        workspace_id: WORKSPACE_ID,
        provider: 'anthropic',
        billing_mode: 'subscription',
        monthly_cost_usd: 200,
        allocation_basis: 'even',
      }),
    );

    expect(res.status).toBe(201);
    expect(res.body.profile.billingMode).toBe('subscription');
    expect(res.body.profile.monthlyCostUsd).toBe(200);
    expect(res.body.profile.allocationBasis).toBe('even');
  });

  it('rejects unknown billing_mode', async () => {
    const res = await auth(
      request(app).post(BASE).send({ provider: 'x', billing_mode: 'pay-later' }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/billing_mode must be one of/i);
  });

  it('requires provider', async () => {
    const res = await auth(request(app).post(BASE).send({ billing_mode: 'unknown' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/provider is required/i);
  });

  it('requires monthly_cost_usd for subscription mode', async () => {
    const res = await auth(
      request(app).post(BASE).send({ provider: 'anthropic', billing_mode: 'subscription' }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/monthly_cost_usd is required/i);
  });

  it('rejects monthly_cost_usd on non-subscription mode', async () => {
    const res = await auth(
      request(app).post(BASE).send({ provider: 'openai', billing_mode: 'metered_api', monthly_cost_usd: 50 }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/only allowed when billing_mode is subscription/i);
  });

  it('rejects negative monthly_cost_usd', async () => {
    const res = await auth(
      request(app).post(BASE).send({ provider: 'anthropic', billing_mode: 'subscription', monthly_cost_usd: -1 }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be negative/i);
  });

  it('rejects effective_to before effective_from', async () => {
    const res = await auth(
      request(app).post(BASE).send({
        provider: 'openai',
        billing_mode: 'metered_api',
        effective_from: '2026-06-01T00:00:00.000Z',
        effective_to: '2026-05-01T00:00:00.000Z',
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/effective_to must be after effective_from/i);
  });

  it('returns 404 for a nonexistent workspace', async () => {
    const res = await auth(
      request(app).post(BASE).send({ workspace_id: 'no-such-ws', provider: 'openai', billing_mode: 'metered_api' }),
    );
    expect(res.status).toBe(404);
  });

  it('rejects an overlapping enabled window with 409', async () => {
    const first = await auth(
      request(app).post(BASE).send({
        workspace_id: WORKSPACE_ID,
        provider: 'anthropic',
        billing_mode: 'subscription',
        monthly_cost_usd: 200,
        effective_from: '2026-01-01T00:00:00.000Z',
        effective_to: '2026-12-31T00:00:00.000Z',
      }),
    );
    expect(first.status).toBe(201);

    const overlap = await auth(
      request(app).post(BASE).send({
        workspace_id: WORKSPACE_ID,
        provider: 'anthropic',
        billing_mode: 'subscription',
        monthly_cost_usd: 250,
        effective_from: '2026-06-01T00:00:00.000Z',
        effective_to: '2027-06-01T00:00:00.000Z',
      }),
    );
    expect(overlap.status).toBe(409);
    expect(overlap.body.error).toMatch(/overlapping effective-date window/i);
  });

  it('allows a non-overlapping window for the same provider', async () => {
    const first = await auth(
      request(app).post(BASE).send({
        workspace_id: WORKSPACE_ID,
        provider: 'anthropic',
        billing_mode: 'subscription',
        monthly_cost_usd: 200,
        effective_from: '2026-01-01T00:00:00.000Z',
        effective_to: '2026-06-01T00:00:00.000Z',
      }),
    );
    expect(first.status).toBe(201);

    const next = await auth(
      request(app).post(BASE).send({
        workspace_id: WORKSPACE_ID,
        provider: 'anthropic',
        billing_mode: 'subscription',
        monthly_cost_usd: 250,
        effective_from: '2026-06-01T00:00:00.000Z',
        effective_to: '2026-12-01T00:00:00.000Z',
      }),
    );
    expect(next.status).toBe(201);
  });

  it('allows an overlapping window when the existing profile is disabled', async () => {
    const first = await auth(
      request(app).post(BASE).send({
        workspace_id: WORKSPACE_ID,
        provider: 'anthropic',
        billing_mode: 'subscription',
        monthly_cost_usd: 200,
        effective_from: '2026-01-01T00:00:00.000Z',
        effective_to: '2026-12-31T00:00:00.000Z',
        enabled: false,
      }),
    );
    expect(first.status).toBe(201);

    const overlap = await auth(
      request(app).post(BASE).send({
        workspace_id: WORKSPACE_ID,
        provider: 'anthropic',
        billing_mode: 'subscription',
        monthly_cost_usd: 250,
        effective_from: '2026-06-01T00:00:00.000Z',
        effective_to: '2027-06-01T00:00:00.000Z',
      }),
    );
    expect(overlap.status).toBe(201);
  });
});

describe('GET /api/finops/billing-profiles', () => {
  it('lists workspace and global profiles', async () => {
    await auth(
      request(app).post(BASE).send({ workspace_id: WORKSPACE_ID, provider: 'openai', billing_mode: 'metered_api' }),
    );
    await auth(
      request(app).post(BASE).send({ provider: 'local', billing_mode: 'free_local' }),
    );

    const res = await auth(request(app).get(`${BASE}?workspace_id=${WORKSPACE_ID}`));
    expect(res.status).toBe(200);
    const providers = res.body.profiles.map((p: { provider: string }) => p.provider).sort();
    expect(providers).toContain('openai');
    expect(providers).toContain('local');
  });

  it('filters by enabled flag', async () => {
    await auth(
      request(app).post(BASE).send({
        workspace_id: WORKSPACE_ID, provider: 'openai', billing_mode: 'metered_api', enabled: false,
      }),
    );
    const res = await auth(request(app).get(`${BASE}?workspace_id=${WORKSPACE_ID}&enabled=true`));
    expect(res.status).toBe(200);
    expect(res.body.profiles.find((p: { provider: string }) => p.provider === 'openai')).toBeUndefined();
  });

  it('rejects an invalid enabled query value', async () => {
    const res = await auth(request(app).get(`${BASE}?enabled=maybe`));
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/finops/billing-profiles/:id', () => {
  it('updates a profile', async () => {
    const created = await auth(
      request(app).post(BASE).send({ workspace_id: WORKSPACE_ID, provider: 'openai', billing_mode: 'metered_api' }),
    );
    const id = created.body.profile.id;

    const res = await auth(
      request(app).put(`${BASE}/${id}`).send({
        workspace_id: WORKSPACE_ID,
        provider: 'openai',
        billing_mode: 'subscription',
        monthly_cost_usd: 100,
        notes: 'switched to subscription',
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body.profile.billingMode).toBe('subscription');
    expect(res.body.profile.monthlyCostUsd).toBe(100);
    expect(res.body.profile.notes).toBe('switched to subscription');
  });

  it('does not conflict with itself on update', async () => {
    const created = await auth(
      request(app).post(BASE).send({
        workspace_id: WORKSPACE_ID,
        provider: 'anthropic',
        billing_mode: 'subscription',
        monthly_cost_usd: 200,
        effective_from: '2026-01-01T00:00:00.000Z',
        effective_to: '2026-12-31T00:00:00.000Z',
      }),
    );
    const id = created.body.profile.id;

    const res = await auth(
      request(app).put(`${BASE}/${id}`).send({
        workspace_id: WORKSPACE_ID,
        provider: 'anthropic',
        billing_mode: 'subscription',
        monthly_cost_usd: 220,
        effective_from: '2026-01-01T00:00:00.000Z',
        effective_to: '2026-12-31T00:00:00.000Z',
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body.profile.monthlyCostUsd).toBe(220);
  });

  it('returns 404 for a nonexistent profile', async () => {
    const res = await auth(
      request(app).put(`${BASE}/999999`).send({ provider: 'openai', billing_mode: 'metered_api' }),
    );
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/finops/billing-profiles/:id', () => {
  it('deletes a profile', async () => {
    const created = await auth(
      request(app).post(BASE).send({ workspace_id: WORKSPACE_ID, provider: 'openai', billing_mode: 'metered_api' }),
    );
    const id = created.body.profile.id;

    const res = await auth(request(app).delete(`${BASE}/${id}`));
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(id);

    const after = await auth(request(app).get(`${BASE}/${id}`));
    expect(after.status).toBe(404);
  });

  it('returns 404 when deleting a missing profile', async () => {
    const res = await auth(request(app).delete(`${BASE}/999999`));
    expect(res.status).toBe(404);
  });

  it('rejects a non-numeric id', async () => {
    const res = await auth(request(app).delete(`${BASE}/not-a-number`));
    expect(res.status).toBe(400);
  });
});
