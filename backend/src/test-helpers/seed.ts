/**
 * Shared seed helpers for backend integration tests.
 * Each helper inserts directly via query() and returns the inserted row.
 * Never creates its own DB connection — uses the shared pool from db/index.ts.
 */

import { randomUUID as uuidv4 } from 'node:crypto';
import { query, queryOne, execute } from '../db/index';

// ─── Workspaces ───────────────────────────────────────────────────────────────

export interface SeedWorkspaceOverrides {
  id?: string;
  label?: string;
  path?: string;
}

export interface WorkspaceRow {
  id: string;
  label: string;
  path: string;
}

export async function seedWorkspace(overrides: SeedWorkspaceOverrides = {}): Promise<WorkspaceRow> {
  const id = overrides.id ?? `ws-test-${uuidv4().slice(0, 8)}`;
  const label = overrides.label ?? 'Test Workspace';
  const path = overrides.path ?? `/tmp/rorca-test-${id}`;

  const row = await queryOne<WorkspaceRow>(
    `INSERT INTO workspaces (id, label, path)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, path = EXCLUDED.path
     RETURNING id, label, path`,
    [id, label, path],
  );
  return row!;
}

// ─── Users ────────────────────────────────────────────────────────────────────

export interface SeedUserOverrides {
  id?: string;
  email?: string;
  display_name?: string;
  plan?: 'free' | 'solo' | 'pro' | 'team';
}

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  plan: string;
}

export async function seedUser(overrides: SeedUserOverrides = {}): Promise<UserRow> {
  const id = overrides.id ?? `user-test-${uuidv4().slice(0, 8)}`;
  const email = overrides.email ?? `test-${id}@rorca.test`;
  const displayName = overrides.display_name ?? 'Test User';
  const plan = overrides.plan ?? 'pro';

  const row = await queryOne<UserRow>(
    `INSERT INTO users (id, email, display_name, plan)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, plan = EXCLUDED.plan
     RETURNING id, email, display_name, plan`,
    [id, email, displayName, plan],
  );
  return row!;
}

// ─── Billing / Subscriptions ──────────────────────────────────────────────────

export interface SubscriptionRow {
  id: string;
  user_id: string;
  plan: string;
  status: string;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  trial_ends_at: Date | null;
  license_key: string | null;
  activated_at: Date | null;
}

/**
 * Seed an active Pro subscription for a given user.
 * Creates a test user first if userId is not provided.
 */
export async function seedBillingActive(userId?: string): Promise<SubscriptionRow> {
  const uid = userId ?? (await seedUser()).id;
  const id = `sub-active-${uuidv4().slice(0, 8)}`;

  const row = await queryOne<SubscriptionRow>(
    `INSERT INTO subscriptions (id, user_id, stripe_customer_id, stripe_subscription_id, plan, status)
     VALUES ($1, $2, $3, $4, 'pro', 'active')
     ON CONFLICT (id) DO UPDATE SET status = 'active', plan = 'pro'
     RETURNING id, user_id, plan, status, stripe_customer_id, stripe_subscription_id,
               trial_ends_at, license_key, activated_at`,
    [id, uid, `cus_test_${id}`, `sub_test_${id}`],
  );

  // Also bump the user's plan column
  await execute(`UPDATE users SET plan = 'pro' WHERE id = $1`, [uid]);

  return row!;
}

/**
 * Seed a trialing subscription for a given user.
 * @param daysRemaining - days until trial expires (negative = already expired)
 */
export async function seedBillingTrial(daysRemaining: number, userId?: string): Promise<SubscriptionRow> {
  const uid = userId ?? (await seedUser()).id;
  const id = `sub-trial-${uuidv4().slice(0, 8)}`;
  const trialEndsAt = new Date(Date.now() + daysRemaining * 24 * 60 * 60 * 1000);

  const row = await queryOne<SubscriptionRow>(
    `INSERT INTO subscriptions (id, user_id, stripe_customer_id, plan, status, trial_started_at, trial_ends_at)
     VALUES ($1, $2, $3, 'pro', 'trialing', NOW(), $4)
     ON CONFLICT (id) DO UPDATE SET status = 'trialing', trial_ends_at = EXCLUDED.trial_ends_at
     RETURNING id, user_id, plan, status, stripe_customer_id, stripe_subscription_id,
               trial_ends_at, license_key, activated_at`,
    [id, uid, `cus_trial_${id}`, trialEndsAt.toISOString()],
  );

  await execute(`UPDATE users SET plan = 'pro' WHERE id = $1`, [uid]);

  return row!;
}

// ─── Pipeline Runs ────────────────────────────────────────────────────────────

export interface SeedPipelineRunOverrides {
  spec_path?: string;
  status?: string;
  pid?: number | null;
  triggered_via?: string;
  queue_position?: number | null;
  last_heartbeat?: Date | null;
}

export interface PipelineRunRow {
  id: number;
  spec_path: string;
  workspace_id: string;
  status: string;
  pid: number | null;
  triggered_via: string;
  queue_position: number | null;
}

export async function seedPipelineRun(
  workspaceId: string,
  overrides: SeedPipelineRunOverrides = {},
): Promise<PipelineRunRow> {
  const row = await queryOne<PipelineRunRow>(
    `INSERT INTO pipeline_runs (spec_path, workspace_id, status, pid, triggered_via, queue_position, last_heartbeat)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, spec_path, workspace_id, status, pid, triggered_via, queue_position`,
    [
      overrides.spec_path ?? 'forge/specs/approved/test-spec.json',
      workspaceId,
      overrides.status ?? 'running',
      overrides.pid ?? null,
      overrides.triggered_via ?? 'run_now',
      overrides.queue_position ?? null,
      overrides.last_heartbeat ?? null,
    ],
  );
  return row!;
}
