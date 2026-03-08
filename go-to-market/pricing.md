# Pricing

## Tier Structure

```
┌─────────────────────────────────────────────────────────────────┐
│  Self-Hosted          Cloud Solo           Cloud Team            │
│  Free forever         Free forever         $79–89/mo             │
│  Fully featured       Fully featured       5 seats included      │
│  Your infra           rorca.app            ~$16/seat             │
└─────────────────────────────────────────────────────────────────┘
```

## Self-Hosted — Free, Forever

**Price**: $0
**Limit**: None — fully featured, unlimited everything
**Who it's for**: Technical users comfortable running `npm i -g rorca && rorca start`

Self-hosted is not a "lite" tier. It is the full product. Users bring their own inference (Claude subscription, OpenCode API key, or ChatGPT subscription). Rorca does not touch inference — we are the orchestration layer.

This is the generous free tier. It converts on word of mouth ("I just self-host it, it's free"), earns developer trust, and creates an install base that eventually generates cloud upgrades for collaboration features.

## Cloud Solo — Free, Forever

**Price**: $0
**What's unlocked**: 1 pipeline run per month on cloud (5 stories max) to create a natural upgrade moment
**Who it's for**: Developers who want the convenience of `rorca.app` without running their own server

Cloud solo is a **convenience tier**, not a feature gate. Users get the full Rorca experience hosted for them. The 1-run/month limit creates exactly one real moment where the upgrade conversation happens naturally — not an artificial paywall, but a genuine "you're getting value, ready to get more?" moment.

Solo users who hit the limit convert to self-hosted (free, fully featured) or upgrade to Team if they want the collaboration layer.

## Cloud Team — $79–89/mo

**Price**: $79/mo (5 seats) or $89/mo (5 seats, annual billing clarity)
**Per seat**: ~$16/seat at 5 seats
**Additional seats**: $14/seat/month
**Who it's for**: Engineering teams who want shared direction stacks, collaborative spec review, and team-level pipeline management

This is the only paid tier. Team features cannot be replicated by self-hosting two instances — they require a shared server with multi-user auth, RBAC, and synchronized state.

## Pricing Rationale

### Why not $5–10/mo

$5–10 signals "toy" or "side project." Rorca replaces hours of developer time per spec. Even at $5/mo, the value-to-price ratio looks broken in the wrong direction — users won't trust a $5 tool to run autonomous multi-story specs against their production codebase.

### Why not $25–29/mo (solo)

Clean model: the only reason to pay is team/collaboration features. Gating solo features behind usage limits creates friction and confusion ("why can't I run more stories? I'm not on a team."). The cleaner model is: solo is free, team is paid. This reduces support burden, reduces churn from frustrated solo users, and makes the upgrade path obvious.

### Why $79–89/mo (team)

- Benchmarks: Linear ~$8/seat, GitHub ~$4/seat, Cursor Team $16/seat
- Rorca is infrastructure, not a utility — closer to Cursor Team pricing
- $79/mo (5 seats) = $15.80/seat — competitive with AI-tool pricing
- Headcount who hits the 5-seat base: ~3-10 person eng teams, exactly the sweet spot for early adopters
- At $79/mo, a team of 5 each needs to save ~1.5 hours/month to break even at $50/hr — extremely low bar

### Why BYOB (no inference markup)

Every other tool in this space charges for inference because it's the easiest billing lever. We don't. This is a deliberate moat:

1. Users already have Claude / ChatGPT / API key subscriptions — no new spend feels required
2. Rorca's value is in orchestration, not inference routing — charging for inference would misrepresent what we are
3. Teams who use Claude Max ($100/mo) or OpenCode with their API budget can use Rorca at $79/mo on top — the math is clear and additive

### Why cloud free (not freemium)

Freemium with hard feature gates causes resentment. Cloud solo free creates goodwill. The upgrade from cloud solo to team is motivated by genuine need (collaboration), not artificial limits. Users who never need team features are not the target customer for Team anyway — keeping them happy and evangelizing is worth more than a $10/mo solo tier.

## Future Pricing Evolution

| Phase | Change |
|-------|--------|
| Launch | Self-hosted + Cloud Solo (free), Cloud Team ($79/mo) |
| Post-PMF | Enterprise tier (SSO, audit log, SLA, custom seats) |
| Mature | Usage-based add-ons (e.g. hosted compute for users without Claude sub) — only if Rorca ever enters the inference business, which requires Phase 3 cloud hosting |

## Pricing Page Copy (Draft)

**Self-Hosted** — Free
"Run Rorca on your own machine. Fully featured, no limits, no account required. One command: `npm i -g rorca && rorca start`."

**Cloud Solo** — Free
"Rorca hosted for you. No server to maintain. 1 pipeline run per month included. Perfect for getting started."

**Cloud Team** — $79/mo
"Shared direction stacks. Collaborative spec review. Team pipeline history. Role-based access. 5 seats included."
