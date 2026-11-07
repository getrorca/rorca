---
name: stripe
description: Stripe integration conventions — checkout, webhooks, subscription management
globs:
  - "src/lib/stripe/**"
  - "src/app/api/webhooks/**"
  - "src/app/api/billing/**"
  - "src/app/api/checkout/**"
alwaysApply: false
---

# Stripe Conventions

## Client Setup

```typescript
// src/lib/stripe/client.ts
import Stripe from 'stripe';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-06-20',
  typescript: true,
});
```

**Never** use the Stripe secret key on the client side. Server-only.

## Checkout Flow

### Creating a Checkout Session
```typescript
const session = await stripe.checkout.sessions.create({
  customer: stripeCustomerId,
  mode: 'subscription',
  line_items: [{ price: priceId, quantity: 1 }],
  success_url: `${baseUrl}/billing?success=true`,
  cancel_url: `${baseUrl}/billing?canceled=true`,
  metadata: { userId },
});
```

- Always pass `metadata.userId` — needed to link session to user in webhook.
- Use `success_url` and `cancel_url` with query params for status feedback.
- Never build a custom payment form — use Stripe Checkout or Stripe Elements.

## Webhook Handling

### Route Setup
```typescript
// src/app/api/webhooks/stripe/route.ts
import { headers } from 'next/headers';

export async function POST(req: Request) {
  const body = await req.text();  // Raw body for signature verification
  const signature = headers().get('stripe-signature')!;

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    return new Response('Webhook signature verification failed', { status: 400 });
  }

  // Process event...
  return new Response('OK', { status: 200 });
}
```

### Required Event Handlers
| Event | Action |
|-------|--------|
| `checkout.session.completed` | Create/activate subscription in DB |
| `customer.subscription.updated` | Update plan, status, period end in DB |
| `customer.subscription.deleted` | Mark subscription as canceled in DB |
| `invoice.payment_failed` | Send payment failed email, flag account |

### Idempotency
- Store processed event IDs. Skip duplicates.
- Stripe retries failed webhooks — handler must be idempotent.

```typescript
const existingEvent = await prisma.stripeEvent.findUnique({
  where: { stripeEventId: event.id },
});
if (existingEvent) return new Response('Already processed', { status: 200 });
```

## Subscription Management

### Price Model
- Define plans in Stripe Dashboard, reference by Price ID.
- Mirror plan metadata in local DB for fast reads (name, features, limits).
- Use `lookup_key` on prices for stable references across environments.

### Customer Portal
```typescript
const portalSession = await stripe.billingPortal.sessions.create({
  customer: stripeCustomerId,
  return_url: `${baseUrl}/billing`,
});
// Redirect to portalSession.url
```
- Use Stripe Customer Portal for plan changes, payment method updates, invoice history.
- Configure in Stripe Dashboard: allowed changes, cancellation policy, proration behavior.

## Testing
- Use Stripe CLI for local webhook testing: `stripe listen --forward-to localhost:3000/api/webhooks/stripe`.
- Test mode API keys only — never real keys in development.
- Use Stripe's test card numbers: `4242424242424242` for success, `4000000000000002` for decline.

## Security
- `STRIPE_SECRET_KEY` — server-only, never in `NEXT_PUBLIC_*`.
- `STRIPE_WEBHOOK_SECRET` — per-endpoint, rotate if compromised.
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — safe for client, used for Stripe.js initialization.
