/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { query, queryOne, execute, transaction } from '../db/index';
import type { AuthUser } from '../lib/auth-utils';
import { logger } from '../lib/logger';
import { NotFoundError, ValidationError, UnprocessableError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';
import { verifyLicense, type LicensePayload } from '../lib/license-verifier';

const router = Router();

// ─── Stripe setup ────────────────────────────────────────────────────────────
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5210';

// Only initialize Stripe when the key is provided (allows graceful dev mode without Stripe)
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// ─── Plan config ─────────────────────────────────────────────────────────────
export type PlanId = 'free' | 'solo' | 'pro' | 'team';

export interface PlanConfig {
  name: string;
  priceMonthly: number;
  stripePriceId: string;
}

// Price IDs are set via env vars — each Stripe account has unique IDs
export const PLANS: Record<Exclude<PlanId, 'free'>, PlanConfig> = {
  solo: {
    name: 'Solo',
    priceMonthly: 10,
    stripePriceId: process.env.STRIPE_PRICE_SOLO || '',
  },
  pro: {
    name: 'Pro',
    priceMonthly: 25,
    stripePriceId: process.env.STRIPE_PRICE_PRO || '',
  },
  team: {
    name: 'Team',
    priceMonthly: 59,
    stripePriceId: process.env.STRIPE_PRICE_TEAM || '',
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
interface SubscriptionRow {
  id: string;
  user_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  plan: string;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_started_at: string | null;
  trial_ends_at: string | null;
}

async function getUserPlan(userId: string): Promise<PlanId> {
  // BL-002: Check for active trial first
  const trial = await queryOne<{ plan: string }>(
    `SELECT plan FROM subscriptions
     WHERE user_id = $1 AND status = 'trialing' AND trial_ends_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (trial) return (trial.plan as PlanId) || 'pro';

  const row = await queryOne<{ plan: string }>(
    `SELECT plan FROM users WHERE id = $1`,
    [userId]
  );
  return (row?.plan as PlanId) || 'free';
}

async function getOrCreateCustomer(userId: string): Promise<SubscriptionRow | null> {
  const row = await queryOne<SubscriptionRow>(
    `SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return row || null;
}

// ─── Seat counting ──────────────────────────────────────────────────────────
async function getSeatsUsed(userId: string): Promise<{ used: number; limit: number | null }> {
  // Count team members where user is team owner
  const row = await queryOne<{ cnt: number }>(
    `SELECT COUNT(DISTINCT tm.user_id)::int as cnt
     FROM teams t
     JOIN team_members tm ON tm.team_id = t.id
     WHERE t.owner_id = $1`,
    [userId]
  );
  const used = (row?.cnt ?? 0) + 1; // +1 for owner
  const plan = await getUserPlan(userId);
  const limits: Record<string, number | null> = { free: 1, solo: 1, pro: 5, team: null };
  return { used, limit: limits[plan] ?? 1 };
}

/**
 * @swagger
 * /api/billing/status:
 *   get:
 *     tags: [Billing]
 *     summary: Get current billing status
 *     operationId: getBillingStatus
 *     description: Returns the current user plan, subscription status, seat usage, available plans, and whether Stripe is configured.
 *     responses:
 *       200:
 *         description: Billing status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 plan: { type: string, enum: [free, solo, pro, team] }
 *                 subscription: { type: object, nullable: true }
 *                 seats: { type: object, properties: { used: { type: integer }, limit: { type: integer, nullable: true } } }
 *                 plans: { type: object }
 *                 stripeConfigured: { type: boolean }
 */
router.get('/status', async (req: Request, res: Response) => {
  const authReq = req as Request & { user: AuthUser };
  const plan = await getUserPlan(authReq.user.id);
  const sub = await getOrCreateCustomer(authReq.user.id);
  const seats = await getSeatsUsed(authReq.user.id);

  // Fetch license info if present
  const licenseRow = await queryOne<{ license_key: string | null; activated_at: string | null; expires_at: string | null }>(
    `SELECT license_key, activated_at, expires_at FROM subscriptions WHERE user_id = $1 AND license_key IS NOT NULL ORDER BY activated_at DESC LIMIT 1`,
    [authReq.user.id]
  );

  // BL-013: Check RORCA_LICENSE_KEY env var status
  let selfHostedLicense: { set: boolean; valid: boolean; plan?: string; expiresAt?: string | null; error?: string } = { set: false, valid: false };
  const envLicenseKey = process.env.RORCA_LICENSE_KEY;
  if (envLicenseKey) {
    selfHostedLicense.set = true;
    const envLicense = verifyLicense(envLicenseKey);
    selfHostedLicense.valid = envLicense.valid;
    selfHostedLicense.plan = envLicense.plan;
    selfHostedLicense.expiresAt = envLicense.expiresAt ? envLicense.expiresAt.toISOString() : null;
    if (envLicense.error) {
      selfHostedLicense.error = envLicense.error;
    }
  }

  // BL-002: Compute trial fields
  const isTrialing = sub?.status === 'trialing' && sub.trial_ends_at != null && new Date(sub.trial_ends_at) > new Date();
  const trialEndsAt = sub?.trial_ends_at || null;
  const daysRemaining = isTrialing && trialEndsAt
    ? Math.max(0, Math.ceil((new Date(trialEndsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : null;

  res.json({
    plan: selfHostedLicense.valid && selfHostedLicense.plan && selfHostedLicense.plan !== 'free'
      ? selfHostedLicense.plan
      : plan,
    subscription: sub ? {
      status: sub.status,
      plan: sub.plan,
      currentPeriodStart: sub.current_period_start,
      currentPeriodEnd: sub.current_period_end,
      stripeSubscriptionId: sub.stripe_subscription_id,
    } : null,
    isTrialing,
    trialEndsAt,
    daysRemaining,
    license: licenseRow?.license_key ? {
      licenseKey: '...' + licenseRow.license_key.slice(-8),
      activatedAt: licenseRow.activated_at,
      expiresAt: licenseRow.expires_at,
    } : null,
    seats,
    plans: {
      free: { name: 'Free', priceMonthly: 0, features: ['Spec generation only', '1 workspace', 'No pipeline execution'] },
      solo: { name: 'Solo', priceMonthly: 10, features: ['Pipeline execution', '3 workspaces', 'Full spec generation', 'Direction stack'] },
      pro: { name: 'Pro', priceMonthly: 25, features: ['Everything in Solo', 'Unlimited workspaces', 'Git worktree isolation', 'Priority support', 'Up to 5 seats'] },
      team: { name: 'Team', priceMonthly: 59, features: ['Everything in Pro', 'Team collaboration', 'Shared direction stack', 'Admin controls', 'Unlimited seats'] },
    },
    selfHostedLicense,
    stripeConfigured: !!stripe,
  });
});

/**
 * @swagger
 * /api/billing/invoices:
 *   get:
 *     tags: [Billing]
 *     summary: List Stripe invoices
 *     operationId: listBillingInvoices
 *     description: Returns up to 24 most recent Stripe invoices for the authenticated user. Returns empty array if Stripe is not configured or no billing account exists.
 *     responses:
 *       200:
 *         description: Invoice list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 invoices:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       number: { type: string }
 *                       status: { type: string }
 *                       amountDue: { type: integer }
 *                       amountPaid: { type: integer }
 *                       currency: { type: string }
 *                       created: { type: string, nullable: true }
 *                       hostedInvoiceUrl: { type: string, nullable: true }
 *                       invoicePdf: { type: string, nullable: true }
 *       500:
 *         description: Failed to fetch invoices
 */
router.get('/invoices', async (req: Request, res: Response) => {
  if (!stripe) {
    res.json({ invoices: [], stripeConfigured: false });
    return;
  }

  const authReq = req as Request & { user: AuthUser };
  const sub = await getOrCreateCustomer(authReq.user.id);

  if (!sub?.stripe_customer_id) {
    res.json({ invoices: [] });
    return;
  }

  try {
    const invoices = await stripe.invoices.list({
      customer: sub.stripe_customer_id,
      limit: 24,
    });

    res.json({
      invoices: invoices.data.map(inv => ({
        id: inv.id,
        number: inv.number,
        status: inv.status,
        amountDue: inv.amount_due,
        amountPaid: inv.amount_paid,
        currency: inv.currency,
        created: inv.created ? new Date(inv.created * 1000).toISOString() : null,
        periodStart: inv.period_start ? new Date(inv.period_start * 1000).toISOString() : null,
        periodEnd: inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null,
        hostedInvoiceUrl: inv.hosted_invoice_url,
        invoicePdf: inv.invoice_pdf,
      })),
    });
  } catch (err) {
    handleRouteError(res, err, '[Billing] Fetch invoices');
  }
});

/**
 * @swagger
 * /api/billing/checkout:
 *   post:
 *     tags: [Billing]
 *     summary: Create a Stripe checkout session
 *     operationId: createBillingCheckout
 *     description: Creates a Stripe Checkout session for subscribing to a paid plan. Returns a redirect URL to the Stripe-hosted checkout page.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [plan]
 *             properties:
 *               plan: { type: string, enum: [solo, pro, team] }
 *     responses:
 *       200:
 *         description: Checkout session URL
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url: { type: string }
 *       400:
 *         description: Invalid plan
 *       503:
 *         description: Stripe not configured
 *       500:
 *         description: Failed to create checkout session
 */
router.post('/checkout', async (req: Request, res: Response) => {
  if (!stripe) {
    res.status(503).json({ error: 'Stripe is not configured. Set STRIPE_SECRET_KEY in backend/.env' });
    return;
  }

  const authReq = req as Request & { user: AuthUser };
  const { plan } = req.body as { plan?: string };

  if (!plan || !(plan in PLANS)) {
    throw new ValidationError(`Invalid plan. Choose one of: ${Object.keys(PLANS).join(', ')}`);
    return;
  }

  const planConfig = PLANS[plan as Exclude<PlanId, 'free'>];
  if (!planConfig.stripePriceId) {
    res.status(503).json({ error: `Stripe price ID not configured for plan: ${plan}. Set STRIPE_PRICE_${plan.toUpperCase()} in backend/.env` });
    return;
  }

  try {
    // Get or create Stripe customer
    let sub = await getOrCreateCustomer(authReq.user.id);
    let customerId: string;

    if (sub?.stripe_customer_id) {
      customerId = sub.stripe_customer_id;
    } else {
      const customer = await stripe.customers.create({
        email: authReq.user.email,
        metadata: { rorca_user_id: authReq.user.id },
      });
      customerId = customer.id;

      // Upsert subscription record with just the customer ID
      const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await execute(
        `INSERT INTO subscriptions (id, user_id, stripe_customer_id, plan, status) VALUES ($1, $2, $3, 'free', 'active')`,
        [id, authReq.user.id, customerId]
      );
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: planConfig.stripePriceId, quantity: 1 }],
      success_url: `${FRONTEND_URL}?billing=success&plan=${plan}`,
      cancel_url: `${FRONTEND_URL}?billing=canceled`,
      metadata: { rorca_user_id: authReq.user.id, plan },
    });

    res.json({ url: session.url });
  } catch (err) {
    handleRouteError(res, err, '[Billing] Stripe checkout');
  }
});

/**
 * @swagger
 * /api/billing/portal:
 *   post:
 *     tags: [Billing]
 *     summary: Create a Stripe billing portal session
 *     operationId: createBillingPortal
 *     description: Creates a Stripe Billing Portal session for managing subscriptions, payment methods, and invoices. Returns a redirect URL.
 *     responses:
 *       200:
 *         description: Portal session URL
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url: { type: string }
 *       404:
 *         description: No billing account found
 *       503:
 *         description: Stripe not configured
 *       500:
 *         description: Failed to create portal session
 */
router.post('/portal', async (req: Request, res: Response) => {
  if (!stripe) {
    res.status(503).json({ error: 'Stripe is not configured' });
    return;
  }

  const authReq = req as Request & { user: AuthUser };
  const sub = await getOrCreateCustomer(authReq.user.id);

  if (!sub?.stripe_customer_id) {
    throw new NotFoundError('No billing account found. Subscribe to a plan first.');
    return;
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${FRONTEND_URL}?panel=settings`,
    });
    res.json({ url: session.url });
  } catch (err) {
    handleRouteError(res, err, '[Billing] Stripe portal');
  }
});

// ─── GET /api/billing/quotas ─────────────────────────────────────────────────

interface QuotaRow {
  plan_name: string;
  feature: string;
  quota_limit: number;
}

async function getFeatureUsage(userId: string, feature: string): Promise<number> {
  switch (feature) {
    case 'workspaces': {
      const row = await queryOne<{ cnt: number }>('SELECT COUNT(*)::int as cnt FROM workspaces');
      return row?.cnt ?? 0;
    }
    case 'specs_per_month': {
      const row = await queryOne<{ cnt: number }>(
        `SELECT COUNT(*)::int as cnt FROM wal_events
         WHERE event_type = 'generate' AND ts >= NOW() - INTERVAL '30 days'`
      );
      return row?.cnt ?? 0;
    }
    case 'team_members': {
      const row = await queryOne<{ cnt: number }>(
        `SELECT COUNT(DISTINCT tm.user_id)::int as cnt
         FROM teams t
         JOIN team_members tm ON tm.team_id = t.id
         WHERE t.owner_id = $1`,
        [userId]
      );
      return (row?.cnt ?? 0) + 1;
    }
    case 'marketplace_publish':
    case 'exa_search':
      return 0;
    default:
      return 0;
  }
}

/**
 * @swagger
 * /api/billing/quotas:
 *   get:
 *     tags: [Billing]
 *     summary: Get current user's plan quotas and usage
 *     operationId: getBillingQuotas
 *     description: Returns the current user's plan, usage counts, and remaining quotas for each feature.
 *     responses:
 *       200:
 *         description: Plan quotas and usage
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 plan:
 *                   type: string
 *                   enum: [free, solo, pro, team]
 *                 quotas:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       feature: { type: string }
 *                       limit: { type: integer, description: "-1 = unlimited, 0 = disabled" }
 *                       used: { type: integer }
 *                       remaining: { type: integer, nullable: true, description: "null if unlimited" }
 */
router.get('/quotas', async (req: Request, res: Response) => {
  const authReq = req as Request & { user: AuthUser };
  const userId = authReq.user?.id;
  const plan = await getUserPlan(userId || 'local-admin');

  const rows = await query<QuotaRow>(
    'SELECT feature, quota_limit FROM plan_quotas WHERE plan_name = $1',
    [plan]
  );

  const quotas = await Promise.all(rows.map(async row => {
    const used = await getFeatureUsage(userId || 'local-admin', row.feature);
    return {
      feature: row.feature,
      limit: row.quota_limit,
      used,
      remaining: row.quota_limit === -1 ? null : Math.max(0, row.quota_limit - used),
    };
  }));

  res.json({ plan, quotas });
});

// ─── POST /api/billing/activate-license ──────────────────────────────────────

/**
 * @swagger
 * /api/billing/activate-license:
 *   post:
 *     tags: [Billing]
 *     summary: Activate a license key
 *     operationId: activateLicense
 *     description: Accepts an RS256-signed JWT license key, verifies it, and activates the corresponding plan. Used by both cloud-issued licenses and self-hosted offline activation. Idempotent — activating the same key twice returns success.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [licenseKey]
 *             properties:
 *               licenseKey: { type: string, description: "RS256-signed JWT license key" }
 *     responses:
 *       200:
 *         description: License activated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 activated: { type: boolean }
 *                 plan: { type: string }
 *                 expiresAt: { type: string, nullable: true }
 *       422:
 *         description: Invalid license key
 */
router.post('/activate-license', async (req: Request, res: Response, next) => {
  try {
  const authReq = req as Request & { user: AuthUser };
  const { licenseKey } = req.body as { licenseKey?: string };

  if (!licenseKey || typeof licenseKey !== 'string') {
    throw new ValidationError('licenseKey is required');
  }

  const verification = verifyLicense(licenseKey);
  if (!verification.valid || verification.plan === 'free' || !verification.payload) {
    throw new UnprocessableError('Invalid license key');
  }

  const userId = authReq.user.id;
  const plan = verification.payload.plan;
  const expiresAt = verification.expiresAt ? verification.expiresAt.toISOString() : null;

  // Upsert subscription row with license info
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );

  if (existing) {
    await execute(
      `UPDATE subscriptions
       SET plan = $1, status = 'active', license_key = $2, activated_at = NOW(), expires_at = $3, updated_at = NOW()
       WHERE id = $4`,
      [plan, licenseKey, expiresAt, existing.id]
    );
  } else {
    const id = `sub_license_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await execute(
      `INSERT INTO subscriptions (id, user_id, stripe_customer_id, plan, status, license_key, activated_at, expires_at)
       VALUES ($1, $2, $3, $4, 'active', $5, NOW(), $6)`,
      [id, userId, 'license', plan, licenseKey, expiresAt]
    );
  }

  // Sync user plan
  await execute('UPDATE users SET plan = $1, updated_at = NOW() WHERE id = $2', [plan, userId]);

  res.json({
    activated: true,
    plan,
    expiresAt,
  });
  } catch (err) { next(err); }
});

// ─── POST /api/billing/webhook (Stripe webhook — no auth) ───────────────────
// NOTE: This route is registered BEFORE authRequired in server.ts
export const webhookRouter = Router();

/**
 * @swagger
 * /api/billing/webhook:
 *   post:
 *     tags: [Billing]
 *     summary: Stripe webhook receiver
 *     operationId: handleBillingWebhook
 *     description: Receives Stripe webhook events. Verifies the Stripe-Signature header using STRIPE_WEBHOOK_SECRET. Handles customer.subscription.created, customer.subscription.updated, and customer.subscription.deleted events to keep the local subscriptions table and user plan synchronized.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Raw Stripe event payload (verified by signature)
 *     responses:
 *       200:
 *         description: Webhook processed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 received: { type: boolean }
 *       400: { description: "Missing or invalid Stripe signature" }
 *       503: { description: "Stripe webhooks not configured" }
 *       500: { description: "Webhook processing failed" }
 */
webhookRouter.post('/webhook', async (req: Request, res: Response) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    res.status(503).json({ error: 'Stripe webhooks not configured' });
    return;
  }

  const sig = req.headers['stripe-signature'] as string;
  const rawBody = (req as any).rawBody as Buffer | undefined;

  if (!sig || !rawBody) {
    throw new ValidationError('Missing signature or body');
    return;
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.error({ err }, 'Webhook signature verification failed');
    throw new ValidationError('Invalid signature');
    return;
  }

  try {
    // BL-012: Idempotency check — skip already-processed events
    const alreadyProcessed = await queryOne<{ id: string }>(
      `SELECT id FROM stripe_webhook_events WHERE id = $1`,
      [event.id]
    );
    if (alreadyProcessed) {
      res.json({ received: true });
      return;
    }

    // Process event + record idempotency key in a single transaction
    await transaction(async (client) => {
      switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          const subscription = event.data.object as Stripe.Subscription;
          const customerId = subscription.customer as string;

          // Look up plan from price ID
          const priceId = subscription.items.data[0]?.price?.id;
          let plan: PlanId = 'free';
          for (const [key, config] of Object.entries(PLANS)) {
            if (config.stripePriceId === priceId) {
              plan = key as Exclude<PlanId, 'free'>;
              break;
            }
          }

          // Map Stripe status to our status
          let status: string = 'active';
          if (subscription.status === 'canceled' || subscription.status === 'unpaid') {
            status = 'canceled';
            plan = 'free';
          } else if (subscription.status === 'past_due') {
            status = 'past_due';
          } else if (subscription.status === 'incomplete') {
            status = 'incomplete';
          }

          // Extract period dates from subscription (cast for compatibility with different Stripe SDK versions)
          const subAny = subscription as unknown as Record<string, unknown>;
          const periodStart = typeof subAny.current_period_start === 'number'
            ? new Date(subAny.current_period_start * 1000).toISOString()
            : null;
          const periodEnd = typeof subAny.current_period_end === 'number'
            ? new Date(subAny.current_period_end * 1000).toISOString()
            : null;

          // Upsert subscription row
          const existingResult = await client.query(
            `SELECT id, user_id FROM subscriptions WHERE stripe_customer_id = $1`,
            [customerId]
          );
          const existing = existingResult.rows[0] as { id: string; user_id: string } | undefined;

          if (existing) {
            await client.query(
              `UPDATE subscriptions SET stripe_subscription_id = $1, plan = $2, status = $3,
               current_period_start = $4, current_period_end = $5, updated_at = NOW()
               WHERE id = $6`,
              [subscription.id, plan, status, periodStart, periodEnd, existing.id]
            );

            // Update user plan
            await client.query(
              'UPDATE users SET plan = $1, updated_at = NOW() WHERE id = $2',
              [plan, existing.user_id]
            );
          }
          break;
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object as Stripe.Subscription;
          const customerId = subscription.customer as string;

          const existingResult = await client.query(
            `SELECT id, user_id FROM subscriptions WHERE stripe_customer_id = $1`,
            [customerId]
          );
          const existing = existingResult.rows[0] as { id: string; user_id: string } | undefined;

          if (existing) {
            await client.query(
              `UPDATE subscriptions SET plan = 'free', status = 'canceled', updated_at = NOW() WHERE id = $1`,
              [existing.id]
            );
            await client.query(
              'UPDATE users SET plan = $1, updated_at = NOW() WHERE id = $2',
              ['free', existing.user_id]
            );
          }
          break;
        }
      }

      // Record the event ID for idempotency
      await client.query(
        `INSERT INTO stripe_webhook_events (id, event_type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [event.id, event.type]
      );
    });

    res.json({ received: true });
  } catch (err) {
    handleRouteError(res, err, '[Billing] Webhook processing');
  }
});

// ─── BL-012: Weekly cleanup of old webhook idempotency records ──────────────
const WEBHOOK_CLEANUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
const WEBHOOK_RETENTION_DAYS = 90;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startWebhookCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(async () => {
    try {
      const result = await execute(
        `DELETE FROM stripe_webhook_events WHERE processed_at < NOW() - INTERVAL '${WEBHOOK_RETENTION_DAYS} days'`
      );
      if (result.rowCount > 0) {
        logger.info({ deleted: result.rowCount }, 'Cleaned up old Stripe webhook events');
      }
    } catch (err) {
      logger.error({ err }, 'Failed to clean up Stripe webhook events');
    }
  }, WEBHOOK_CLEANUP_INTERVAL_MS);
  // Don't block process exit
  cleanupTimer.unref();
}

export function stopWebhookCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

// Start cleanup on module load (only when Stripe is configured)
if (stripe) {
  startWebhookCleanup();
}

export default router;
