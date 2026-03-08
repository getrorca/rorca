# Free Tier Strategy

## The Core Insight

**Self-hosted IS the generous free tier.**

Most SaaS products treat free tiers as crippled versions of the paid product — limited features, artificial caps, upgrade pressure. That model works for products where the vendor controls hosting costs. Rorca's architecture makes a different approach possible and more compelling:

Rorca's execution costs are borne entirely by the user (their Claude subscription, their API key, their ChatGPT Pro account). Rorca's hosting cost on cloud is compute + storage — trivially small for a solo user. The real cost is engineering time to build multi-user collaboration features. That's what the team tier pays for.

Result: generous free tiers everywhere, upgrade only when you genuinely need team collaboration.

## The Three Tiers Explained

### Self-Hosted — Fully Free, Forever

```
npm i -g rorca && rorca start
```

No account. No usage limits. No feature gates. Full product.

Self-hosting is the primary distribution channel for technical users — the exact audience most likely to become evangelists, write blog posts, and bring Rorca into their teams. Locking the self-hosted tier behind limits or registration would poison this relationship.

The self-hosted user is not a "lost" customer — they are the most valuable type: a power user who understands the product deeply and converts their team to cloud when collaboration becomes the bottleneck.

**Self-hosted conversion path**: Self-hosted solo → team uses it for 3 months → "we need shared direction stacks and shared run history" → Cloud Team at $79/mo. This is the intended funnel.

### Cloud Solo — Free, Forever

Why offer cloud solo free at all if self-hosted is free?

**Convenience is a distinct value proposition.** Not everyone wants to run a backend server locally. The developer who just wants to try Rorca, or who wants to use it from multiple machines, or whose company laptop has corporate restrictions — that person benefits from a hosted option. Charging them $5–10/mo for what is essentially a convenience tax creates unnecessary friction at the awareness stage.

The 1-run/month limit on cloud solo is not a feature gate. It's an **upgrade moment** — the first time a user hits it, they're already invested in the product and experiencing real value. That's the right time to present the upgrade conversation, not at signup. No credit card wall, no feature crippling, no paywalled interface. One natural moment.

**Cloud solo conversion path**: Cloud solo → hits 1-run/month limit → upgrades to self-hosted (free, no limit) OR evaluates team features → Cloud Team if collaboration needed.

### Cloud Team — $79/mo

This is where Rorca monetizes. Not by charging for individual use, but by charging for the infrastructure that enables teams to move together.

The team tier is not "more of the same" — it's a qualitatively different product:
- **Shared direction stack** → team conventions encoded once, applied everywhere
- **Collaborative spec review** → specs become team artifacts, not individual notebooks
- **Role-based access** → orgs with multiple devs running autonomous pipelines need access controls
- **Shared run history** → post-run learning accumulates at the team level, not just individually

Teams pay $79/mo because they're not buying "more pipeline runs" — they're buying organizational alignment. The direction stack alone (if adopted seriously) creates enough consistency benefit to justify the price.

## What We Don't Do

### No artificial solo usage caps

It would be easy to gate "more than 3 workspaces" or "more than 10 stories per spec" behind a paid solo tier at $15–25/mo. We don't, for three reasons:

1. **It misrepresents the product.** Rorca's value is proportional to how much you use it. Capping usage for solo users caps value — and creates resentment exactly when users are most excited.

2. **It creates the wrong upgrade pressure.** We want users to upgrade when they genuinely need collaboration, not because they hit an arbitrary story limit. Premature monetization via usage caps converts users who are getting value into users who are frustrated.

3. **It signals scarcity in a product built on abundance.** The whole point of per-story subprocess isolation is no context limits. Capping stories per run directly contradicts the product's core promise.

### No inference in the business model

We do not resell or proxy inference. Ever. This is structural — not a launch decision.

If Rorca ever entered the inference business (pay us, we run Claude), we'd be competing with Anthropic, OpenAI, and every hosted AI provider. The margins are thin, the competition is intense, and it would obscure what Rorca actually is.

BYOB (bring your own brain) is a moat: users feel no new spend because they already have the subscriptions. Rorca is additive infrastructure on top of existing tooling.

## Upgrade Triggers

The moments most likely to drive upgrades:

| Trigger | Tier Change |
|---------|------------|
| Hit 1-run/month on cloud solo | → Self-hosted (free) or Cloud Team |
| Need colleague to review a spec | → Cloud Team |
| Want to share direction stack with a teammate | → Cloud Team |
| Want team-level run history ("why did this spec fail last week?") | → Cloud Team |
| Engineering lead wants to enforce conventions across devs | → Cloud Team |
| Compliance/audit needs (who approved this spec?) | → Cloud Team (Enterprise later) |

Notice: none of these upgrade triggers are "you ran out of stories" or "you have too many workspaces." They're all genuine collaboration inflection points.

## Long-Term Free Tier Sustainability

The self-hosted free tier is sustainable indefinitely because:
- Hosting cost = $0 (user's machine)
- Support cost = minimal (well-documented self-install, active community)
- Marketing value = high (power users who write about it)

The cloud solo free tier is sustainable because:
- Per-user hosting cost at low utilization = cents/month
- Conversion to team is the payoff — not monetizing solo directly
- Goodwill generated is worth more than $0 → $10 solo conversion

## Summary

| Tier | Free? | Why |
|------|-------|-----|
| Self-hosted | Forever | Trust-building, developer evangelism, zero hosting cost to us |
| Cloud solo | Forever (1 run/mo) | Convenience tier, creates natural upgrade moment without artificial pressure |
| Cloud team | $79/mo | Genuine collaboration features that require shared infrastructure |
