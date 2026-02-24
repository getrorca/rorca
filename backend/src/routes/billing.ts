import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { db } from '../db/index';
import type { AuthUser } from './auth';

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
}

function getUserPlan(userId: string): PlanId {
  const row = db.prepare(
    `SELECT plan FROM users WHERE id = ?`
  ).get(userId) as { plan: string } | undefined;
  return (row?.plan as PlanId) || 'free';
}

function getOrCreateCustomer(userId: string): SubscriptionRow | null {
  return db.prepare(
    `SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`
  ).get(userId) as SubscriptionRow | undefined || null;
}

// ─── GET /api/billing/status ─────────────────────────────────────────────────
router.get('/status', (req: Request, res: Response) => {
  const authReq = req as Request & { user: AuthUser };
  const plan = getUserPlan(authReq.user.id);
  const sub = getOrCreateCustomer(authReq.user.id);

  res.json({
    plan,
    subscription: sub ? {
      status: sub.status,
      currentPeriodEnd: sub.current_period_end,
      stripeSubscriptionId: sub.stripe_subscription_id,
    } : null,
    plans: {
      solo: { name: 'Solo', priceMonthly: 10 },
      pro: { name: 'Pro', priceMonthly: 25 },
      team: { name: 'Team', priceMonthly: 59 },
    },
  });
});

// ─── POST /api/billing/checkout ──────────────────────────────────────────────
router.post('/checkout', async (req: Request, res: Response) => {
  if (!stripe) {
    res.status(503).json({ error: 'Stripe is not configured. Set STRIPE_SECRET_KEY in backend/.env' });
    return;
  }

  const authReq = req as Request & { user: AuthUser };
  const { plan } = req.body as { plan?: string };

  if (!plan || !(plan in PLANS)) {
    res.status(400).json({ error: `Invalid plan. Choose one of: ${Object.keys(PLANS).join(', ')}` });
    return;
  }

  const planConfig = PLANS[plan as Exclude<PlanId, 'free'>];
  if (!planConfig.stripePriceId) {
    res.status(503).json({ error: `Stripe price ID not configured for plan: ${plan}. Set STRIPE_PRICE_${plan.toUpperCase()} in backend/.env` });
    return;
  }

  try {
    // Get or create Stripe customer
    let sub = getOrCreateCustomer(authReq.user.id);
    let customerId: string;

    if (sub?.stripe_customer_id) {
      customerId = sub.stripe_customer_id;
    } else {
      const customer = await stripe.customers.create({
        email: authReq.user.email,
        metadata: { rorcha_user_id: authReq.user.id },
      });
      customerId = customer.id;

      // Upsert subscription record with just the customer ID
      const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      db.prepare(
        `INSERT INTO subscriptions (id, user_id, stripe_customer_id, plan, status) VALUES (?, ?, ?, 'free', 'active')`
      ).run(id, authReq.user.id, customerId);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: planConfig.stripePriceId, quantity: 1 }],
      success_url: `${FRONTEND_URL}?billing=success&plan=${plan}`,
      cancel_url: `${FRONTEND_URL}?billing=canceled`,
      metadata: { rorcha_user_id: authReq.user.id, plan },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ─── POST /api/billing/portal ────────────────────────────────────────────────
router.post('/portal', async (req: Request, res: Response) => {
  if (!stripe) {
    res.status(503).json({ error: 'Stripe is not configured' });
    return;
  }

  const authReq = req as Request & { user: AuthUser };
  const sub = getOrCreateCustomer(authReq.user.id);

  if (!sub?.stripe_customer_id) {
    res.status(404).json({ error: 'No billing account found. Subscribe to a plan first.' });
    return;
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${FRONTEND_URL}?panel=settings`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe portal error:', err);
    res.status(500).json({ error: 'Failed to create billing portal session' });
  }
});

// ─── POST /api/billing/webhook (Stripe webhook — no auth) ───────────────────
// NOTE: This route is registered BEFORE authRequired in server.ts
export const webhookRouter = Router();

webhookRouter.post('/webhook', async (req: Request, res: Response) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    res.status(503).json({ error: 'Stripe webhooks not configured' });
    return;
  }

  const sig = req.headers['stripe-signature'] as string;
  const rawBody = (req as any).rawBody as Buffer | undefined;

  if (!sig || !rawBody) {
    res.status(400).json({ error: 'Missing signature or body' });
    return;
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    res.status(400).json({ error: 'Invalid signature' });
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
        const existing = db.prepare(
          `SELECT id, user_id FROM subscriptions WHERE stripe_customer_id = ?`
        ).get(customerId) as { id: string; user_id: string } | undefined;

        if (existing) {
          db.prepare(
            `UPDATE subscriptions SET stripe_subscription_id = ?, plan = ?, status = ?,
             current_period_start = ?, current_period_end = ?, updated_at = datetime('now')
             WHERE id = ?`
          ).run(
            subscription.id,
            plan,
            status,
            periodStart,
            periodEnd,
            existing.id,
          );

          // Update user plan
          db.prepare('UPDATE users SET plan = ?, updated_at = datetime(\'now\') WHERE id = ?')
            .run(plan, existing.user_id);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;

        const existing = db.prepare(
          `SELECT id, user_id FROM subscriptions WHERE stripe_customer_id = ?`
        ).get(customerId) as { id: string; user_id: string } | undefined;

        if (existing) {
          db.prepare(
            `UPDATE subscriptions SET plan = 'free', status = 'canceled', updated_at = datetime('now') WHERE id = ?`
          ).run(existing.id);
          db.prepare('UPDATE users SET plan = \'free\', updated_at = datetime(\'now\') WHERE id = ?')
            .run(existing.user_id);
        }
        break;
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook processing error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
