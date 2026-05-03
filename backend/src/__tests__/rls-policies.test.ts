/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { execute } from '../db/index';

const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY?.trim();
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

const hasSupabaseEnv = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_ROLE_KEY);
const describeIfSupabase = hasSupabaseEnv ? describe : describe.skip;

type TestUser = {
  authId: string;
  appUserId: string;
  email: string;
  password: string;
};

type TestWorkspace = {
  id: string;
  ownerAuthId: string;
};

function createUserClient(email: string, password: string): SupabaseClient {
  return createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

async function signInUser(email: string, password: string): Promise<SupabaseClient> {
  const client = createUserClient(email, password);
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    throw error;
  }
  return client;
}

describeIfSupabase('MU-025 RLS policies via Supabase auth', () => {
  let supabaseAdmin: SupabaseClient;
  let userA: TestUser;
  let userB: TestUser;
  let workspaceA: TestWorkspace;
  let workspaceB: TestWorkspace;
  let userAClient: SupabaseClient;
  let pipelineRunBId: number;

  beforeAll(async () => {
    supabaseAdmin = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    userA = {
      authId: '',
      appUserId: `rls-user-a-${suffix}`,
      email: `rls-user-a-${suffix}@example.com`,
      password: `Rorca!${suffix}`,
    };
    userB = {
      authId: '',
      appUserId: `rls-user-b-${suffix}`,
      email: `rls-user-b-${suffix}@example.com`,
      password: `Rorca!${suffix}`,
    };

    const createdA = await supabaseAdmin.auth.admin.createUser({
      email: userA.email,
      password: userA.password,
      email_confirm: true,
    });
    if (createdA.error || !createdA.data.user) {
      throw createdA.error ?? new Error('Failed to create Supabase user A');
    }
    userA.authId = createdA.data.user.id;

    const createdB = await supabaseAdmin.auth.admin.createUser({
      email: userB.email,
      password: userB.password,
      email_confirm: true,
    });
    if (createdB.error || !createdB.data.user) {
      throw createdB.error ?? new Error('Failed to create Supabase user B');
    }
    userB.authId = createdB.data.user.id;

    await execute(
      `INSERT INTO users (id, email, display_name, password_hash, role, auth_id)
       VALUES ($1, $2, $3, $4, 'user', $5::uuid),
              ($6, $7, $8, $9, 'user', $10::uuid)`,
      [
        userA.appUserId, userA.email, 'RLS User A', 'supabase-managed', userA.authId,
        userB.appUserId, userB.email, 'RLS User B', 'supabase-managed', userB.authId,
      ]
    );

    workspaceA = {
      id: `rls-workspace-a-${suffix}`,
      ownerAuthId: userA.authId,
    };
    workspaceB = {
      id: `rls-workspace-b-${suffix}`,
      ownerAuthId: userB.authId,
    };

    await execute(
      `INSERT INTO workspaces (id, label, path)
       VALUES ($1, $2, $3),
              ($4, $5, $6)`,
      [
        workspaceA.id, 'RLS Workspace A', `/tmp/${workspaceA.id}`,
        workspaceB.id, 'RLS Workspace B', `/tmp/${workspaceB.id}`,
      ]
    );

    await execute(
      `INSERT INTO workspace_members (workspace_id, user_auth_id, role)
       VALUES ($1, $2::uuid, 'owner'),
              ($3, $4::uuid, 'owner')`,
      [workspaceA.id, userA.authId, workspaceB.id, userB.authId]
    );

    await execute(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, queued_at, queue_position)
       VALUES ($1, $2, 'queued', NOW(), 1)`,
      [`forge/specs/approved/${workspaceB.id}.json`, workspaceB.id]
    );
    const pipelineRunLookup = await supabaseAdmin
      .from('pipeline_runs')
      .select('id')
      .eq('workspace_id', workspaceB.id)
      .order('id', { ascending: false })
      .limit(1);
    if (pipelineRunLookup.error || !pipelineRunLookup.data?.[0]?.id) {
      throw pipelineRunLookup.error ?? new Error('Failed to fetch pipeline run id');
    }
    pipelineRunBId = Number(pipelineRunLookup.data[0].id);

    await execute(
      `INSERT INTO api_key_vault (id, user_id, workspace_id, provider, encrypted_key, label)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [`rls-vault-${suffix}`, userB.appUserId, workspaceB.id, 'openai', 'iv:tag:ciphertext', 'Workspace B secret']
    );

    await execute(
      `INSERT INTO direction_layers (workspace_id, domain, layer, content_yaml)
       VALUES (NULL, NULL, 1, $1),
              (NULL, 'saas', 2, $2),
              ($3, NULL, 3, $4),
              ($5, NULL, 3, $6)`,
      [
        `global-l1-${suffix}`,
        `global-l2-${suffix}`,
        workspaceA.id,
        `workspace-a-l3-${suffix}`,
        workspaceB.id,
        `workspace-b-l3-${suffix}`,
      ]
    );

    await execute(
      `INSERT INTO user_settings (user_id, default_model, items_per_page)
       VALUES ($1, 'claude-sonnet-4-5-20250929', 20),
              ($2, 'openai/gpt-4o', 50)`,
      [userA.appUserId, userB.appUserId]
    );

    userAClient = await signInUser(userA.email, userA.password);
    await signInUser(userB.email, userB.password);
  });

  afterAll(async () => {
    try {
      if (pipelineRunBId) {
        await execute('DELETE FROM story_results WHERE run_id = $1', [pipelineRunBId]);
      }
      await execute('DELETE FROM pipeline_runs WHERE workspace_id IN ($1, $2)', [workspaceA.id, workspaceB.id]);
      await execute('DELETE FROM api_key_vault WHERE workspace_id IN ($1, $2)', [workspaceA.id, workspaceB.id]);
      await execute('DELETE FROM direction_layers WHERE workspace_id IS NULL OR workspace_id IN ($1, $2)', [workspaceA.id, workspaceB.id]);
      await execute('DELETE FROM user_settings WHERE user_id IN ($1, $2)', [userA.appUserId, userB.appUserId]);
      await execute('DELETE FROM workspace_members WHERE workspace_id IN ($1, $2)', [workspaceA.id, workspaceB.id]);
      await execute('DELETE FROM workspaces WHERE id IN ($1, $2)', [workspaceA.id, workspaceB.id]);
      await execute('DELETE FROM users WHERE id IN ($1, $2)', [userA.appUserId, userB.appUserId]);
    } catch {
    }

    try {
      if (userA.authId) {
        await supabaseAdmin.auth.admin.deleteUser(userA.authId);
      }
      if (userB.authId) {
        await supabaseAdmin.auth.admin.deleteUser(userB.authId);
      }
    } catch {
    }
  });

  it('user A sees only workspace A', async () => {
    const { data, error } = await userAClient
      .from('workspaces')
      .select('id')
      .order('id', { ascending: true });

    expect(error).toBeNull();
    expect(data?.map((row) => row.id)).toEqual([workspaceA.id]);
  });

  it('user A cannot read pipeline_runs from workspace B', async () => {
    const { data, error } = await userAClient
      .from('pipeline_runs')
      .select('id, workspace_id')
      .eq('workspace_id', workspaceB.id);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('user A cannot read vault keys from workspace B', async () => {
    const { data, error } = await userAClient
      .from('api_key_vault')
      .select('id, workspace_id')
      .eq('workspace_id', workspaceB.id);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('user A can read global direction layers but not workspace B L3', async () => {
    const globalResult = await userAClient
      .from('direction_layers')
      .select('workspace_id, layer, content_yaml')
      .is('workspace_id', null)
      .order('layer', { ascending: true });

    expect(globalResult.error).toBeNull();
    expect(globalResult.data?.length).toBeGreaterThanOrEqual(2);
    expect(globalResult.data?.every((row) => row.workspace_id === null)).toBe(true);

    const foreignWorkspaceResult = await userAClient
      .from('direction_layers')
      .select('workspace_id, layer, content_yaml')
      .eq('workspace_id', workspaceB.id);

    expect(foreignWorkspaceResult.error).toBeNull();
    expect(foreignWorkspaceResult.data).toEqual([]);
  });

  it("user A cannot read user B's user_settings", async () => {
    const { data, error } = await userAClient
      .from('user_settings')
      .select('user_id, default_model')
      .eq('user_id', userB.appUserId);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});
