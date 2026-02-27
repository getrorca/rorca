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

// ─── Seat counting ──────────────────────────────────────────────────────────
function getSeatsUsed(userId: string): { used: number; limit: number | null } {
  // Count team members where user is team owner
  const row = db.prepare(
    `SELECT COUNT(DISTINCT tm.user_id) as cnt
     FROM teams t
     JOIN team_members tm ON tm.team_id = t.id
     WHERE t.owner_id = ?`
  ).get(userId) as { cnt: number } | undefined;
  const used = (row?.cnt ?? 0) + 1; // +1 for owner
  const plan = getUserPlan(userId);
  const limits: Record<string, number | null> = { free: 1, solo: 1, pro: 5, team: null };
  return { used, limit: limits[plan] ?? 1 };
}

// ─── GET /api/billing/status ─────────────────────────────────────────────────
router.get('/status', (req: Request, res: Response) => {
  const authReq = req as Request & { user: AuthUser };
  const plan = getUserPlan(authReq.user.id);
  const sub = getOrCreateCustomer(authReq.user.id);
  const seats = getSeatsUsed(authReq.user.id);

  res.json({
    plan,
    subscription: sub ? {
      status: sub.status,
      plan: sub.plan,
      currentPeriodStart: sub.current_period_start,
      currentPeriodEnd: sub.current_period_end,
      stripeSubscriptionId: sub.stripe_subscription_id,
    } : null,
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

// ─── GET /api/billing/invoices ──────────────────────────────────────────────
router.get('/invoices', async (req: Request, res: Response) => {
  if (!stripe) {
    res.json({ invoices: [], stripeConfigured: false });
    return;
  }

  const authReq = req as Request & { user: AuthUser };
  const sub = getOrCreateCustomer(authReq.user.id);

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
    console.error('Failed to fetch invoices:', err);
    res.status(500).json({ error: 'Failed to fetch invoice history' });
  }
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
        metadata: { rorca_user_id: authReq.user.id },
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
      metadata: { rorca_user_id: authReq.user.id, plan },
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
