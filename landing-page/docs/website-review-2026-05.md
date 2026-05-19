# Rorca Website Review — 2026-05

A thorough review of the public website / landing-page app, with an emphasis on:
- open-source positioning
- consistency with the current Rorca architecture
- conversion clarity
- technical correctness
- production readiness

Reviewed surfaces:
- `landing-page/src/app/page.tsx`
- `landing-page/src/components/Hero.tsx`
- `landing-page/src/components/FeatureGrid.tsx`
- `landing-page/src/components/HowItWorks.tsx`
- `landing-page/src/components/Nav.tsx`
- `landing-page/src/components/Footer.tsx`
- `landing-page/src/app/docs/page.tsx`
- `landing-page/src/app/download/*`
- `landing-page/src/app/pricing/*`
- `landing-page/src/app/login/page.tsx`
- `landing-page/src/app/signup/page.tsx`
- `landing-page/src/app/changelog/page.tsx`
- `landing-page/src/app/architecture/*`
- `landing-page/src/app/memory/*`
- `landing-page/src/app/execution/*`
- `landing-page/src/lib/metadata.ts`
- `landing-page/src/app/sitemap.ts`
- `landing-page/next.config.ts`

Validation performed:
- installed landing-page deps
- attempted a production build with `./node_modules/.bin/next build`
- reproduced a real production build failure on `/changelog`

---

## Executive summary

The site has a strong visual direction and some genuinely good raw material, but it currently has a major positioning problem:

> it feels like three different products at once.

Depending on the page, Rorca reads as:
- a hosted SaaS product with signup/login and Stripe plans
- a self-hosted binary with one-command install
- an open-source, MCP-native, Pi-compatible developer platform

Those can coexist, but right now they are not integrated into a coherent story.

The home page in particular is visually polished but strategically underpowered for an open-source launch because it:
- overclaims in places
- hides the best real differentiators
- routes key CTAs poorly
- sends users into dead ends or half-finished surfaces

The good news is that the site does not need a total redesign.
It needs:
1. message discipline,
2. a clearer information architecture,
3. removal of placeholder behavior,
4. a more truthful open-source-first conversion path,
5. and a few important technical fixes.

---

## Priority levels

- **P0** = fix before treating the site as production-ready
- **P1** = high-value UX / strategy improvements
- **P2** = polish and optimization

---

# P0 — Critical issues

## 1. The site tells conflicting stories about what Rorca is
**Where:** homepage, pricing, login/signup, download, docs, metadata copy

### Problem
The site currently mixes:
- self-hosted / open-source messaging
- SaaS signup/login flows
- Stripe pricing plans
- hosted product assumptions

This creates trust friction immediately.
A developer who lands on the homepage does not know whether Rorca is:
- an OSS local tool,
- a hosted platform,
- or a hybrid product.

### Why this matters
For open source, clarity beats ambition.
Mixed positioning lowers trust, makes pricing feel suspicious, and makes the real strengths of the product harder to understand.

### Change
Choose and express a primary story:

**Recommended primary story:**
> Rorca is a local-first, self-hosted AI orchestration platform with MCP, Pi, and autonomous execution support.

Then treat hosted/commercial/account surfaces as secondary.

### Specific actions
- Reframe homepage around **local-first orchestration**.
- Make “Install / Run locally / Use with Claude Code / Use with Pi” the main path.
- If SaaS auth/pricing is not live and central, stop treating it like the default conversion flow.

---

## 2. Homepage CTAs send users to the wrong places
**Where:** `src/components/Hero.tsx`

### Problem
- `Start Building` goes to `/download`
- `Read the Docs` also goes to `/download`
- there is even a TODO comment saying docs should be updated later

### Why this matters
This is the most important interaction on the site.
The second primary CTA is currently incorrect.
That makes the page feel unfinished and breaks trust immediately.

### Change
Recommended CTA structure:
- Primary: **Install Rorca** → `/download`
- Secondary: **Read the docs** → `/docs` or external docs URL
- Tertiary text link: **View on GitHub**

---

## 3. Footer contains placeholder links (`href="#"`)
**Where:** `src/components/Footer.tsx`

### Problem
The footer includes placeholder links for:
- Documentation
n- GitHub
- Twitter
- Discord
- Terms
- Privacy

### Why this matters
Placeholder links are a launch killer.
They make the entire site look like a template or mockup rather than a credible product.

### Change
Before public launch, every footer link should either:
- go somewhere real,
- be removed,
- or be replaced with non-clickable text if the surface does not exist yet.

Minimum replacements:
- Documentation → `/docs` or external docs URL
- GitHub → `https://github.com/getrorca/rorca`
- Privacy → `/privacy` if it exists, or root doc path if hosted elsewhere
- Terms → remove unless real
- Social links → remove unless real

---

## 4. Login and signup pages are wired to localhost backend URLs
**Where:**
- `src/app/login/page.tsx`
- `src/app/signup/page.tsx`

### Problem
These pages call:
- `http://localhost:3030/api/auth/login`
- `http://localhost:3030/api/auth/register`

### Why this matters
This breaks outside local development and makes the public site architecture look unfinished.
It also means the site cannot be safely deployed without rewriting the frontend.

### Change
Use environment-driven relative or base URLs instead.
For example:
- `NEXT_PUBLIC_API_BASE_URL`
- or same-origin API routing if the site and API are colocated

Also: if auth is not central to the open-source story, consider removing login/signup from primary nav entirely.

---

## 5. Production build is currently broken
**Where:** `src/app/changelog/page.tsx`

### Problem
I reproduced a real Next build failure:
- `/changelog` imports and uses `motion` inside a server page
- error: attempted to call a client motion component from the server

### Result
`next build` fails.

### Why this matters
This is a hard production blocker.
The site is not actually production-ready until this is fixed.

### Change
Move the animated changelog UI into a client component, similar to the architecture/memory/execution pages.
Example:
- `src/app/changelog/ChangelogClient.tsx`
- server page only loads metadata/data and renders the client wrapper

---

## 6. Sitemap is stale and points at routes that do not exist
**Where:** `src/app/sitemap.ts`

### Problem
The sitemap includes:
- `/engine`
- `/compute`

But the actual routes are:
- `/memory`
- `/execution`

### Why this matters
This hurts SEO quality and signals sloppiness to crawlers.

### Change
Update sitemap to actual public pages.
Also add `/docs`, `/changelog`, `/download`, `/troubleshooting` if they are meant to be indexed.

---

## 7. Domain/canonical/OG identity is inconsistent
**Where:** `src/lib/metadata.ts`, homepage JSON-LD

### Problem
The site mixes:
- `SITE_URL = https://rorca.app`
- homepage JSON-LD `sameAs: ['https://rorca.ai']`
- robots sitemap URL references `https://rorca.app/sitemap.xml`
- OG fallback warnings rely on `http://localhost:3002`

### Why this matters
This weakens SEO canonicals and brand clarity.
A public site needs one canonical identity.

### Change
Choose a single canonical public domain and use it consistently across:
- metadata
- canonical URLs
- Open Graph
- robots.txt
- sitemap
- JSON-LD

---

## 8. The docs page is not acceptable as an OSS docs entrypoint
**Where:** `src/app/docs/page.tsx`

### Problem
The docs page is either:
- a delayed redirect,
- or a “docs coming soon” email capture page.

### Why this matters
For an open-source launch, “Read the docs” must not land on a waitlist-style page.
That is a major mismatch with developer expectations.

### Change
At minimum, point docs to something real:
- a GitHub docs section
- generated docs
- README/docs index
- or a clean “developer docs index” page built from repo docs

If docs truly are not ready, the CTA should say that honestly and point to GitHub/README, not an email form.

---

# P1 — High-value product and UX changes

## 9. Replace the homepage headline with one that explains the real product
**Where:** `src/components/Hero.tsx`

### Current
> Ship specs. Not tickets.

### Problem
It is stylish, but vague.
It does not explain enough for first-time OSS visitors.

### Better direction
A stronger headline should communicate at least two of these three:
- spec-first orchestration
- autonomous execution
- local-first / MCP / multi-agent compatibility

### Example directions
- **Spec-first AI orchestration for real codebases**
- **Turn briefs into specs, then ship them autonomously**
- **The local-first control plane for autonomous software development**

---

## 10. Bring the new architecture into the homepage above the fold
**Where:** homepage

### Problem
The homepage underplays the strongest new differentiators:
- explicit skill-first spec persistence
- backend-native retrieval
- GraphRAG and feedback system
- Pi extension / MCP client portability

### Change
Add a short “Why Rorca is different” strip under the hero, with 3–4 bullets like:
- **Draft locally, persist explicitly**
- **Backend-native memory + graph retrieval**
- **One control plane, many clients**
- **Specs become executable work**

---

## 11. Reduce overclaiming in the feature cards
**Where:** `src/components/FeatureGrid.tsx`

### Problem
Several statements are too absolute or too specific to trust immediately:
- “75+ models”
- “No context limits”
- “A 40-minute sequential spec becomes 12 minutes”
- “Saves 40–60%”
- “updating GitHub automatically”

Some of these may be directionally true, but on the homepage they read like unverified marketing numbers.

### Change
Use phrasing that is still strong but more defensible:
- “multiple execution engines” instead of exact counts unless kept current
- “fresh per-story subprocesses” instead of “no context limits”
- “can run independent stories in parallel” instead of exact time multipliers
- “supports model cascading” instead of guaranteed savings numbers

Keep the measurable numbers for deeper pages if backed by real benchmarks.

---

## 12. The homepage needs a real product screenshot or flow visual
**Where:** homepage

### Problem
The page is all typography and cards.
It lacks a concrete product visual proving the app exists.

### Why this matters
For technical buyers and OSS users, screenshots create trust much faster than abstract claims.

### Change
Add one visual block showing one of:
- spec review UI
- Context tab with generation logs
- pipeline run view
- Pi extension flow
- MCP create-spec flow diagram

---

## 13. The nav should reflect the intended public journey
**Where:** `src/components/Nav.tsx`

### Problem
Current nav emphasizes content pages and auth:
- Home
- Architecture
- Memory
- Execution
- Pricing
- Log In
- Sign Up

For OSS, this is probably the wrong order.

### Recommended nav
- Product / Overview
- Docs
- Architecture
- Download / Install
- GitHub
- optional Pricing / Enterprise

If auth is not core to the current public journey, demote or remove it from the top nav.

---

## 14. Pricing page conflicts with open-source-first messaging
**Where:** `src/app/pricing/PricingClient.tsx`

### Problem
The pricing page currently leads with:
- Free / Pro / Team
- Stripe CTA behavior
- SaaS-style plans

But the rest of the site says:
- self-hosted is always free
- open source / local first matters

### Why this matters
This creates a trust gap: users wonder what is actually free, what is hosted, and what is gated.

### Change
Reframe pricing around deployment modes:
- **Open source / self-hosted**
- **Hosted / managed** (if real)
- **Team / enterprise support**

If hosted billing is not actually ready, turn pricing into a simple “Deployment & support” page instead.

---

## 15. The docs and README should be tightly connected
**Where:** site-wide

### Problem
The repo now has a much stronger README, but the website does not yet use that strength.

### Change
Either:
- pull key README sections into the docs site,
- or create a docs landing page that mirrors the README sections:
  - what it is
  - install
  - explicit spec creation
  - MCP
  - Pi extension
  - retrieval architecture

The README and website should reinforce each other, not tell separate stories.

---

## 16. The open-source CTA path should be explicit
**Where:** homepage, footer, download, docs

### Problem
There is no obvious OSS path like:
- View source
- Clone repo
- Run locally
- Use with Claude Code
- Use with Pi

### Change
Add a clearly visible OSS action cluster:
- **View on GitHub**
- **Install locally**
- **Read docs**
- **Use with Claude Code / MCP**

---

## 17. Secondary pages are too dense and text-heavy for web scanning
**Where:** architecture, memory, execution pages

### Problem
These pages are informative, but they read like internal architecture docs pasted into marketing surfaces.

### Change
For each long-form page:
- shorten the top explanatory paragraphs
- add section summaries
- add diagrams or small visual anchors
- use “What this means in practice” callouts
- make the left-hand nav more obviously active / sticky / progress-aware

The content is good. The presentation is not yet web-optimized.

---

## 18. The site should explicitly explain default vs fallback flows
**Where:** homepage, docs, architecture

### Problem
This is now a critical distinction in the product, and the website under-explains it:
- explicit caller-drafted spec persistence
- backend-generated draft fallback

### Change
Add a simple comparison table on homepage or docs:

| Flow | Best for | Default? |
|---|---|---|
| Explicit draft persistence | reliable cross-client creation | yes |
| Backend-generated draft | quick server-side drafting | fallback |

This helps advanced users immediately understand the architecture.

---

# P1 — Technical/content integrity fixes

## 19. `NEXT_PUBLIC_POSTHOG_API_KEY` naming is inconsistent with analytics init
**Where:**
- `src/app/docs/page.tsx`
- `src/lib/analytics.ts`

### Problem
Docs page expects `NEXT_PUBLIC_POSTHOG_API_KEY`, while analytics init expects `NEXT_PUBLIC_POSTHOG_KEY`.

### Change
Standardize the env var naming.

---

## 20. Docs email capture sends directly to PostHog ingest from the client
**Where:** `src/app/docs/page.tsx`

### Problem
This is a brittle and slightly awkward implementation for a public-facing waitlist form.

### Why this matters
It is not a great long-term pattern for a polished public site.

### Change
If you keep the email capture flow at all, move it behind a server action or API route.
But the better change is still: replace the docs waitlist page with real docs.

---

## 21. Stripe CTA behavior is suspicious / likely incorrect for real checkout
**Where:** `src/app/pricing/PricingClient.tsx`

### Problem
The page builds a Stripe checkout URL using the price ID directly:
- `https://checkout.stripe.com/pay/${priceId}`

That is not the typical Checkout Session flow and may not be production-correct.

### Change
Use a server-created Checkout Session and redirect to the returned session URL.
If billing is not production-ready, remove the pseudo-live behavior.

---

## 22. `next.config.ts` is missing root configuration despite warning
**Where:** `landing-page/next.config.ts`

### Problem
Build warns that Next inferred the wrong workspace root because of multiple lockfiles.

### Change
Set `turbopack.root` explicitly so the app builds without ambiguity.

---

## 23. OG/metadata generation falls back noisily to localhost
**Where:** `src/lib/metadata.ts`

### Problem
If env vars are missing, the build emits repeated warnings and uses localhost-based OG image prefixes.

### Change
For public deploys, fail fast or provide a cleaner single warning.
Also ensure OG image URLs never default to local origins in production.

---

## 24. Changelog path loading is clever but fragile
**Where:** `src/app/changelog/page.tsx`

### Problem
It reads `../CHANGELOG.md` relative to `process.cwd()` assumptions.
This may be okay locally, but it is worth hardening.

### Change
Either:
- make the path explicit and documented,
- or source changelog data via a stable content pipeline.

---

# P2 — UX, polish, and conversion improvements

## 25. Replace “Sign Up / Log In” with “Install / GitHub / Docs” as top-right actions
For the current stage of the product, this better matches how technical users evaluate tools.

---

## 26. Add a “Who Rorca is for” section
Right now the site says what it does, but not sharply enough who it is for.

Suggested audience framing:
- solo builders shipping with AI
- small product/engineering teams
- internal platform teams experimenting with autonomous workflows
- OSS maintainers with convention-heavy repos

---

## 27. Add a “What makes this different from generic coding agents?” section
This is one of the strongest possible conversion sections.

Suggested bullets:
- spec-first instead of prompt-only
- reviewable artifacts
- retrieval with feedback, not just one-shot search
- backend-native orchestration
- client portability via MCP

---

## 28. Use stronger trust anchors
The site currently lacks proof points like:
- real screenshots
- architecture diagrams
- exact OSS install flow
- example spec JSON
- example Pi or MCP workflow

Add at least two of these near the top half of the homepage.

---

## 29. Tighten the copy tone
The current tone is visually premium but sometimes slides into overproduced startup language.
The best tone for Rorca is:
- precise
- calm
- technical
- confident without hype

Good rule:
- prefer “what it actually does” over “what it sounds like it might do”

---

## 30. Make the download page the strongest page on the site
The download page is the most natural open-source conversion page.
It should become a showcase page, not just a utility page.

Add:
- installation prerequisites
- exact local ports
- what gets created on disk
- how to use with Claude Code MCP
- how to install Pi extension
- copy-paste quickstart after install

---

## 31. Add a short “Current product truth” section in docs or architecture
This is one of the smartest trust-building moves available.
Explain plainly:
- explicit create-spec is the reliable path
- freeform intent routing is convenience, not guarantee
- GraphRAG architecture is strong, tuning is ongoing
- Pi is first-class, but Rorca remains the control plane

That honesty will differentiate the product.

---

# Recommended new homepage structure

## Above the fold
- clear headline
- clear one-sentence product definition
- primary CTA: Install Rorca
- secondary CTA: Read docs
- tertiary CTA: View on GitHub
- screenshot / diagram

## Section 2: Why it is different
- spec-first
- explicit spec persistence
- backend-native retrieval
- multi-client / MCP / Pi support

## Section 3: How it works
- brief → spec → review → run → feedback

## Section 4: Technical trust
- execution engines
- retrieval pipeline
- worktrees / GitHub / PR flow

## Section 5: Open-source quickstart
- install
- run locally
- use with Claude Code
- use with Pi

## Section 6: Deeper links
- architecture
- memory / GraphRAG
- execution
- changelog

---

# Suggested implementation order

## Phase 1 — must-fix
1. fix homepage CTA destinations
2. remove placeholder footer links
3. fix localhost auth URLs or remove auth emphasis
4. fix changelog build failure
5. fix sitemap routes
6. unify canonical domain metadata
7. replace docs-coming-soon path with real docs target

## Phase 2 — message correction
8. rewrite homepage hero and subhead
9. reframe pricing page around open-source / self-hosted reality
10. add explicit spec creation / MCP / Pi messaging
11. reduce overclaiming language in feature cards

## Phase 3 — trust / conversion
12. add real screenshots or diagrams
13. add GitHub CTA and OSS install flow
14. add “why Rorca is different” section
15. add “current product truth” section

---

# Bottom line

The site is visually strong enough to become excellent.
The biggest issue is not the design system.
It is **strategic coherence**.

Right now the website undersells the best real improvements we just made, while simultaneously overclaiming or placeholder-linking in the wrong places.

The best next move is not a full redesign.
It is a **truth-aligned rewrite and cleanup**:
- make it obviously open-source-friendly
- make the explicit create-spec architecture central
- make backend-native retrieval and execution the hero
- remove every fake/dead/placeholder path
- turn the install/docs path into the main conversion journey
