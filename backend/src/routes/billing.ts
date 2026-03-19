import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { query, queryOne, execute } from '../db/index';
import type { AuthUser } from './auth';
import { logger } from '../lib/logger';
import { NotFoundError, ValidationError } from '../lib/errors';
import { verifyLicense } from '../lib/license';

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
  license_key: string | null;
  activated_at: string | null;
  expires_at: string | null;
}

async function getUserPlan(userId: string): Promise<PlanId> {
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
    `SELECT COUNT(DISTINCT tm.user_id) as cnt
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

  // License info: show last 8 chars only for security
  const licenseKey = sub?.license_key
    ? `...${sub.license_key.slice(-8)}`
    : null;

  res.json({
    plan,
    subscription: sub ? {
      status: sub.status,
      plan: sub.plan,
      currentPeriodStart: sub.current_period_start,
      currentPeriodEnd: sub.current_period_end,
      stripeSubscriptionId: sub.stripe_subscription_id,
    } : null,
    licenseKey,
    activatedAt: sub?.activated_at || null,
    expiresAt: sub?.expires_at || null,
    seats,
    plans: {
      free: { name: 'Free', priceMonthly: 0, features: ['Spec generation only', '1 workspace', 'No pipeline execution'] },
      solo: { name: 'Solo', priceMonthly: 10, features: ['Pipeline execution', '3 workspaces', 'Full spec generation', 'Direction stack'] },
      pro: { name: 'Pro', priceMonthly: 25, features: ['Everything in Solo', 'Unlimited workspaces', 'Git worktree isolation', 'Priority support', 'Up to 5 seats'] },
      team: { name: 'Team', priceMonthly: 59, features: ['Everything in Pro', 'Team collaboration', 'Shared direction stack', 'Admin controls', 'Unlimited seats'] },
    },
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
    logger.error({ err }, 'Failed to fetch invoices');
    res.status(500).json({ error: 'Failed to fetch invoice history' });
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
    logger.error({ err }, 'Stripe checkout error');
    res.status(500).json({ error: 'Failed to create checkout session' });
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
    logger.error({ err }, 'Stripe portal error');
    res.status(500).json({ error: 'Failed to create billing portal session' });
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
      const row = await queryOne<{ cnt: number }>('SELECT COUNT(*) as cnt FROM workspaces');
      return row?.cnt ?? 0;
    }
    case 'specs_per_month': {
      const row = await queryOne<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM wal_events
         WHERE event_type = 'generate' AND ts >= NOW() - INTERVAL '30 days'`
      );
      return row?.cnt ?? 0;
    }
    case 'team_members': {
      const row = await queryOne<{ cnt: number }>(
        `SELECT COUNT(DISTINCT tm.user_id) as cnt
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
 *     description: Verifies an RS256-signed JWT license key and activates the corresponding plan. Used for both cloud-issued licenses and self-hosted offline activation. Idempotent — activating the same key twice returns success.
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
router.post('/activate-license', async (req: Request, res: Response) => {
  const { licenseKey } = req.body as { licenseKey?: string };

  if (!licenseKey || typeof licenseKey !== 'string') {
    res.status(422).json({ error: 'Invalid license key' });
    return;
  }

  const payload = verifyLicense(licenseKey);
  if (!payload) {
    res.status(422).json({ error: 'Invalid license key' });
    return;
  }

  const authReq = req as Request & { user: AuthUser };
  const userId = authReq.user.id;
  const plan = payload.plan as PlanId;
  const expiresAt = payload.exp
    ? new Date(payload.exp * 1000).toISOString()
    : null;

  // Upsert: check if user already has a subscription row
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
       VALUES ($1, $2, '', $3, 'active', $4, NOW(), $5)`,
      [id, userId, plan, licenseKey, expiresAt]
    );
  }

  // Update user plan
  await execute(
    'UPDATE users SET plan = $1, updated_at = NOW() WHERE id = $2',
    [plan, userId]
  );

  res.json({
    activated: true,
    plan,
    expiresAt,
  });
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
        const existing = await queryOne<{ id: string; user_id: string }>(
          `SELECT id, user_id FROM subscriptions WHERE stripe_customer_id = $1`,
          [customerId]
        );

        if (existing) {
          await execute(
            `UPDATE subscriptions SET stripe_subscription_id = $1, plan = $2, status = $3,
             current_period_start = $4, current_period_end = $5, updated_at = NOW()
             WHERE id = $6`,
            [
              subscription.id,
              plan,
              status,
              periodStart,
              periodEnd,
              existing.id,
            ]
          );

          // Update user plan
          await execute(
            'UPDATE users SET plan = $1, updated_at = NOW() WHERE id = $2',
            [plan, existing.user_id]
          );
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;

        const existing = await queryOne<{ id: string; user_id: string }>(
          `SELECT id, user_id FROM subscriptions WHERE stripe_customer_id = $1`,
          [customerId]
        );

        if (existing) {
          await execute(
            `UPDATE subscriptions SET plan = 'free', status = 'canceled', updated_at = NOW() WHERE id = $1`,
            [existing.id]
          );
          await execute(
            'UPDATE users SET plan = $1, updated_at = NOW() WHERE id = $2',
            ['free', existing.user_id]
          );
        }
        break;
      }
    }

    res.json({ received: true });
  } catch (err) {
    logger.error({ err }, 'Webhook processing error');
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
