/**
 * BL-009: Trial expiry notification cron + requirePlan grace period tests.
 */

// ─── Mock DB layer ──────────────────────────────────────────────────────────
const mockQuery = jest.fn().mockResolvedValue([]);
const mockQueryOne = jest.fn().mockResolvedValue(undefined);
const mockExecute = jest.fn().mockResolvedValue({ rowCount: 0 });

jest.mock('../../db/index', () => ({
  query: (sql: string, params: unknown[]) => mockQuery(sql, params),
  queryOne: (sql: string, params: unknown[]) => mockQueryOne(sql, params),
  execute: (sql: string, params: unknown[]) => mockExecute(sql, params),
  transaction: jest.fn(),
}));

// ─── Mock createNotification ────────────────────────────────────────────────
const mockCreateNotification = jest.fn().mockResolvedValue('notif-id');
jest.mock('../../routes/notifications', () => ({
  createNotification: (userId: string, type: string, title: string, body: string, link?: string) =>
    mockCreateNotification(userId, type, title, body, link),
}));

// ─── Mock backup (scheduler imports it) ─────────────────────────────────────
jest.mock('../backup', () => ({
  createBackup: jest.fn().mockResolvedValue({ filename: 'test.sql.gz', size: 100 }),
  pruneOldBackups: jest.fn().mockReturnValue(0),
}));

// ─── Mock auth (scheduler imports INTERNAL_SERVICE_TOKEN) ───────────────────
jest.mock('../../routes/auth', () => ({
  INTERNAL_SERVICE_TOKEN: 'test-token',
}));

// ─── Mock logger ────────────────────────────────────────────────────────────
jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

import { checkTrialExpiry } from '../scheduler';
import { checkTrialGrace } from '../require-plan';

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── checkTrialExpiry ───────────────────────────────────────────────────────

describe('checkTrialExpiry', () => {
  test('creates notification at 7-day mark', async () => {
    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

    // query: SELECT from subscriptions WHERE status = 'trialing'
    mockQuery.mockResolvedValueOnce([
      { user_id: 'user-1', trial_ends_at: sevenDaysFromNow.toISOString() },
    ]);

    // queryOne: idempotency check — no existing notification
    mockQueryOne.mockResolvedValueOnce(undefined);

    await checkTrialExpiry();

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      'user-1',
      'trial_expiring',
      'Trial expires in 7 days',
      expect.stringContaining('in 7 days'),
      '/settings/billing',
    );
  });

  test('creates notification at 3-day mark', async () => {
    const threeDaysFromNow = new Date();
    threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);

    mockQuery.mockResolvedValueOnce([
      { user_id: 'user-2', trial_ends_at: threeDaysFromNow.toISOString() },
    ]);
    mockQueryOne.mockResolvedValueOnce(undefined);

    await checkTrialExpiry();

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      'user-2',
      'trial_expiring',
      'Trial expires in 3 days',
      expect.stringContaining('in 3 days'),
      '/settings/billing',
    );
  });

  test('creates notification at 1-day mark', async () => {
    const oneDayFromNow = new Date();
    oneDayFromNow.setDate(oneDayFromNow.getDate() + 1);

    mockQuery.mockResolvedValueOnce([
      { user_id: 'user-3', trial_ends_at: oneDayFromNow.toISOString() },
    ]);
    mockQueryOne.mockResolvedValueOnce(undefined);

    await checkTrialExpiry();

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      'user-3',
      'trial_expiring',
      'Trial expires in 1 day',
      expect.stringContaining('tomorrow'),
      '/settings/billing',
    );
  });

  test('creates trial_expired notification at 0-day mark', async () => {
    // Trial ends right now (less than 1 day remaining = 0 days via Math.ceil)
    const now = new Date();
    now.setHours(now.getHours() - 1); // 1 hour ago → daysRemaining = 0

    mockQuery.mockResolvedValueOnce([
      { user_id: 'user-4', trial_ends_at: now.toISOString() },
    ]);
    mockQueryOne.mockResolvedValueOnce(undefined);

    await checkTrialExpiry();

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      'user-4',
      'trial_expired',
      'Your trial has expired',
      expect.stringContaining('ended'),
      '/settings/billing',
    );
  });

  test('skips notification when one already exists for today (idempotent)', async () => {
    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

    mockQuery.mockResolvedValueOnce([
      { user_id: 'user-1', trial_ends_at: sevenDaysFromNow.toISOString() },
    ]);

    // Existing notification found — dedup
    mockQueryOne.mockResolvedValueOnce({ id: 'existing-notif' });

    await checkTrialExpiry();

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  test('does not notify at 5-day mark (not in notify list)', async () => {
    const fiveDaysFromNow = new Date();
    fiveDaysFromNow.setDate(fiveDaysFromNow.getDate() + 5);

    mockQuery.mockResolvedValueOnce([
      { user_id: 'user-5', trial_ends_at: fiveDaysFromNow.toISOString() },
    ]);

    await checkTrialExpiry();

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  test('handles empty result (no trialing subscriptions)', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await checkTrialExpiry();

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});

// ─── checkTrialGrace (requirePlan grace period) ─────────────────────────────

describe('checkTrialGrace', () => {
  test('returns inGrace=true when trial expired 1 day ago', async () => {
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    mockQueryOne.mockResolvedValueOnce({
      trial_ends_at: oneDayAgo.toISOString(),
      status: 'trialing',
    });

    const result = await checkTrialGrace('user-1');
    expect(result.inGrace).toBe(true);
  });

  test('returns inGrace=true when trial expired 2 days ago', async () => {
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

    mockQueryOne.mockResolvedValueOnce({
      trial_ends_at: twoDaysAgo.toISOString(),
      status: 'trialing',
    });

    const result = await checkTrialGrace('user-1');
    expect(result.inGrace).toBe(true);
  });

  test('returns inGrace=false when trial expired 4 days ago (past grace)', async () => {
    const fourDaysAgo = new Date();
    fourDaysAgo.setDate(fourDaysAgo.getDate() - 4);

    mockQueryOne.mockResolvedValueOnce({
      trial_ends_at: fourDaysAgo.toISOString(),
      status: 'trialing',
    });

    const result = await checkTrialGrace('user-1');
    expect(result.inGrace).toBe(false);
  });

  test('returns inGrace=false when trial has not expired yet', async () => {
    const threeDaysFromNow = new Date();
    threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);

    mockQueryOne.mockResolvedValueOnce({
      trial_ends_at: threeDaysFromNow.toISOString(),
      status: 'trialing',
    });

    const result = await checkTrialGrace('user-1');
    expect(result.inGrace).toBe(false);
  });

  test('returns inGrace=false when no subscription exists', async () => {
    mockQueryOne.mockResolvedValueOnce(undefined);

    const result = await checkTrialGrace('user-1');
    expect(result.inGrace).toBe(false);
  });

  test('returns inGrace=false when subscription is active (upgraded)', async () => {
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    mockQueryOne.mockResolvedValueOnce({
      trial_ends_at: oneDayAgo.toISOString(),
      status: 'active',
    });

    const result = await checkTrialGrace('user-1');
    expect(result.inGrace).toBe(false);
  });

  test('returns inGrace=false when trial_ends_at is null', async () => {
    mockQueryOne.mockResolvedValueOnce({
      trial_ends_at: null,
      status: 'trialing',
    });

    const result = await checkTrialGrace('user-1');
    expect(result.inGrace).toBe(false);
  });
});
