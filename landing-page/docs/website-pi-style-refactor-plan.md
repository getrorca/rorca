# Rorca Website Refactor Plan — Pi.dev-Inspired Direction

Date: 2026-05-16

This document is a **full audit of the current website state** plus a **formal refactor plan** for reshaping the landing page into a cleaner, more premium, Pi.dev-inspired experience.

It is based on the current `landing-page/` code, the recent repository changes over the last 2–3 weeks, and the current product truth in the main Rorca repo.

---

## 1) Executive summary

The current website is good-looking in isolation, but it is no longer aligned with what Rorca has become.

The product has moved forward significantly:
- explicit skill-first spec persistence now exists
- MCP surfaces are stronger and more reliable
- GraphRAG / retrieval feedback / telemetry are real backend capabilities
- Pi has become a first-class operator surface
- the root README now reflects a much more honest, modern product story

The landing page has not fully caught up.

As a result, the site currently feels like:
- a premium SaaS marketing site,
- a developer tool landing page,
- and a partially finished docs portal,

all at once.

That is the main problem.

### What the new website should feel like

The target should be closer to **Pi.dev** in tone and structure:
- calm, premium, editorial
- visually minimal, not noisy
- strong typography hierarchy
- generous spacing
- fewer, better sections
- product-led rather than hype-led
- one clear narrative, not multiple competing stories

Not a clone — but the same kind of confidence and restraint.

---

## 2) Audit of recent changes over the last 2–3 weeks

### 2.1 Product / backend changes that the website now needs to reflect

The repo changed materially in ways the site does not yet express:

- backend-native retrieval became much more real
- GraphRAG moved from “idea” toward an actual retrieval loop
- retrieval telemetry and feedback were added
- explicit spec persistence became a canonical path
- the MCP contract was hardened and clarified
- Pi extension support became first-class
- the root README now tells a more truthful, OSS-friendly story

### 2.2 Website-specific state during the same window

The landing page itself has not meaningfully evolved at the same pace.
It still contains several legacy or half-finished patterns:

- homepage CTA mismatch
- docs CTA points to the wrong place
- footer placeholder links
- login/signup hardcoded to localhost API endpoints
- stale sitemap routes
- canonical domain inconsistency
- docs page that behaves like a waitlist instead of docs
- changelog page build failure
- pricing page that still feels too SaaS-shaped for the current product truth

### 2.3 Important conclusion from the audit

There is a **story drift** problem.

The product has become more precise, more OSS-friendly, more MCP-native, and more execution-oriented.
The site still communicates an older version of that product.

So the refactor should not just be visual.
It must also be **truth-alignment work**.

---

## 3) Current website diagnosis

### 3.1 What is working

- The site has a strong dark visual foundation.
- Typography is already directionally good.
- Motion is present and can be polished rather than rebuilt from scratch.
- The product pages have enough substance to become a strong technical marketing site.
- The download page is already the closest thing to a strong conversion page.

### 3.2 What is not working

#### A. The site has too many product identities
It currently reads as if Rorca is:
- hosted SaaS
- local binary
- developer platform
- AI agent router
- docs portal
- account system

That ambiguity is the biggest strategic flaw.

#### B. The homepage is not sharp enough
The hero is stylish but too generic.
The CTAs are wrong.
The “docs” button is broken in spirit.
The page does not quickly answer:
- what is Rorca?
- who is it for?
- why is it different?
- how do I start?

#### C. Placeholder / fake surface behavior hurts trust
Anything that looks like a placeholder feels unfinished:
- `href="#"`
- docs coming soon page
- localhost auth calls
- stale sitemap routes
- build errors on public pages

#### D. Secondary pages are too dense for a public website
The architecture / memory / execution pages contain real value, but their current presentation feels closer to internal docs than a polished web product.

#### E. Technical readiness is not consistent
The site should not ship with a build failure.
The changelog page currently blocks production builds.
That alone is enough to justify a refactor sprint.

---

## 4) Pi.dev-style direction: what to borrow, what not to copy

### 4.1 What to borrow from Pi.dev

Pi.dev has a very specific feel that works well for a technical product:

- concise, centered hero
- strong product identity immediately visible
- premium dark palette
- very intentional whitespace
- modular sections with clear rhythm
- simple top-level navigation
- polished motion that never becomes noisy
- developer-focused, not startup-hype-focused
- the site feels like a product, not a brochure

### 4.2 What to translate into Rorca

Rorca should adopt the same principles, but tuned for its own story:

- **One clear hero message**: spec-first autonomous software development
- **One primary CTA**: install / start locally
- **One secondary CTA**: read docs / view source
- **One visual narrative**: brief → spec → run → feedback
- **One style language**: dark, premium, calm, technical

### 4.3 What not to copy

- do not over-minimize and lose product explanation
- do not become purely aesthetic with no substance
- do not bury the OSS install story
- do not make the site feel like a vague AI brand page
- do not copy Pi.dev’s format so literally that Rorca loses its own identity

---

## 5) New site strategy

### Positioning statement

> Rorca is a local-first AI spec orchestration platform for autonomous software development.

That should be the root story.

### Supporting story layers

1. **Spec-first workflow**
   - turn a brief into a structured spec
   - review and approve before execution

2. **Backend-native retrieval**
   - CAG, RAG, and knowledge graph work together
   - context is scored and fed back over time

3. **Cross-client control plane**
   - dashboard
   - MCP
   - Pi extension
   - future client wrappers

4. **Execution engine**
   - story-by-story autonomous runs
   - retries, telemetry, workflow integration

5. **OSS / self-hosted credibility**
   - install locally
   - understand the architecture
   - view source
   - use it with the tools developers already have

---

## 6) Proposed information architecture

### Top-level navigation
Recommended nav order:

- Product
- Install
- Architecture
- Memory
- Execution
- Changelog
- GitHub

Optional:
- Pricing or Support, only if it is genuinely current

### Page roles

#### Home
The product story page.
Its job is to explain Rorca in under 30 seconds.

#### Install / Download
The strongest conversion page.
Its job is to get someone running the product locally.

#### Docs
A real docs index or docs hub.
Not a coming-soon page.

#### Architecture
The system explanation page.
Should be strong, but readable.

#### Memory
The retrieval / GraphRAG page.
Should explain CAG → RAG → graph → feedback.

#### Execution
The run engine page.
Should explain how approved specs become work.

#### Changelog
Release notes and proof of active development.
Must build cleanly.

#### Pricing
Only if pricing is truthful and operationally ready.
If not ready, it should be a deployment/support page instead.

---

## 7) Full audit of current website issues

### P0 — must fix before any serious redesign launch

1. **Homepage CTA mismatch**
   - “Read the Docs” currently points to `/download`
   - needs to go to a real docs surface

2. **Footer placeholder links**
   - `href="#"` appears in multiple places
   - this is unacceptable for launch quality

3. **Docs page is a waitlist, not docs**
   - wrong for an OSS/product-developer site

4. **Auth pages hardcode localhost API endpoints**
   - not deploy-safe
   - breaks external usage and looks unfinished

5. **Changelog page breaks `next build`**
   - production blocker
   - motion/client boundaries need fixing

6. **Sitemap contains stale routes**
   - references `/engine` and `/compute`
   - actual public routes are different

7. **Canonical / OG domain identity is inconsistent**
   - `rorca.app` vs `rorca.ai` vs localhost fallbacks
   - must be unified

8. **Pricing page conflicts with the current product story**
   - too SaaS-shaped, too ambiguous
   - likely needs repositioning or simplification

### P1 — high-value strategic fixes

9. **Hero copy is too generic**
   - stylish, but not specific enough

10. **The site overclaims in a few places**
    - exact numbers and broad claims should be more defensible

11. **The site lacks a strong visual product proof block**
    - needs a screenshot / workflow / diagram anchor

12. **The homepage does not explain the new product truth**
    - explicit create-spec path
    - MCP
    - Pi
    - retrieval feedback system

13. **Secondary pages are too long and doc-like**
    - need web-friendly sectioning and rhythm

14. **Auth should not dominate top navigation**
    - for this product stage, install/docs/source matter more

### P2 — polish / conversion upgrades

15. **Add a stronger OSS action cluster**
    - GitHub
    - install
    - docs
    - MCP/Pi usage

16. **Add “who it is for” and “why it is different” sections**

17. **Create a tighter visual system**
    - fewer card styles
    - more consistent spacing
    - more deliberate motion

18. **Make the download page the best page on the site**
    - that is the most natural conversion funnel

---

## 8) Proposed Pi.dev-style homepage structure

### Section 1 — Hero
- concise headline
- one-sentence explanation
- primary CTA: Install Rorca
- secondary CTA: Read Docs
- tertiary CTA: View Source
- one beautiful product visual or diagram

### Section 2 — Why it is different
3–4 short pillars:
- spec-first
- explicit persistence
- backend-native retrieval
- MCP/Pi portability

### Section 3 — How it works
A short narrative strip:
- brief
- spec
- approve
- run
- learn

### Section 4 — Product proof
A screenshot / UI panel / architecture diagram showing the real app.

### Section 5 — Deep links
Cards for:
- Architecture
- Memory / GraphRAG
- Execution
- Download
- Changelog

### Section 6 — OSS trust block
- install locally
- inspect the repo
- use with Claude Code / Pi
- self-hosted truth

### Section 7 — Footer
Small, real, non-placeholder links only.

---

## 9) Page-by-page refactor plan

### 9.1 Home

#### Goal
Make the homepage feel like a premium technical product page, not a generic startup landing page.

#### Changes
- rewrite hero headline and subheadline
- fix CTA destinations
- reduce marketing fluff
- add product proof visuals
- add explicit product story for spec-first + GraphRAG + Pi/MCP
- align nav with the new journey

#### Design notes
- strong centered hero
- understated gradient background
- sparse copy
- premium cards
- no clutter

---

### 9.2 Download / Install

#### Goal
Turn it into the strongest conversion page on the site.

#### Changes
- keep the one-command install story
- add exact setup steps
- explain what gets started
- show frontend/backend/worker if relevant
- show how to use Claude Code, MCP, and Pi after install
- add OS-specific paths and troubleshooting links

#### Design notes
- feels like a product launch page
- include code blocks and step cards
- keep the content crisp, not sprawling

---

### 9.3 Docs

#### Goal
Replace the coming-soon pattern with a real docs entrypoint.

#### Changes
- real documentation index
- links to install, architecture, memory, execution, MCP, Pi
- no redirect delay unless there is a strong reason
- no email waitlist as the primary behavior

---

### 9.4 Architecture / Memory / Execution

#### Goal
Keep the substance, improve the presentation.

#### Changes
- shorter lead paragraphs
- more section summaries
- more diagrams / visual blocks
- more “what this means” callouts
- more readable progression

#### Design notes
- these pages should feel like polished technical essays
- not internal wiki dumps

---

### 9.5 Changelog

#### Goal
Fix the build and make it a credible release-notes page.

#### Changes
- move motion-heavy UI to a client component
- ensure build-safe file loading
- keep the page simple and reliable

---

### 9.6 Pricing

#### Goal
Decide whether the pricing page is currently truthful enough to keep as-is.

#### Options
1. **Reframe as deployment / support options**
2. **Keep only if the pricing story is operationally real**
3. **Hide from nav until the product story is settled**

---

### 9.7 Login / Signup

#### Goal
Stop giving the wrong impression that auth is the primary conversion path.

#### Changes
- remove from primary nav if not essential
- replace hardcoded localhost API calls with environment-driven URLs
- keep only if the auth flow is actually active

---

## 10) Visual design system direction

### Palette
- dark base
- soft blacks and charcoal surfaces
- restrained accent use
- avoid neon overload
- use glow sparingly and intentionally

### Typography
- large, confident headlines
- tight but readable body text
- crisp label hierarchy
- limited type scale

### Layout
- more vertical rhythm
- larger section spacing
- modular cards and panels
- strong max-width discipline
- avoid crowded top navs

### Motion
- subtle entrance motion only
- no motion for motion’s sake
- transitions should reinforce polish, not distraction

### Components to standardize
- hero section
- feature card
- metric chip
- code block
- callout panel
- screenshot frame
- CTA group
- docs section block

---

## 11) Content rules for the rewrite

### Do
- speak precisely
- tell the truth about what is live
- prefer developer-native phrasing
- show how it works
- explain why it matters

### Do not
- overhype
- use placeholder links
- hide the install path
- bury the product truth under marketing language
- pretend auth/pricing/docs are finished if they are not

### Tone target
Think:
- calm
- technical
- premium
- trustworthy
- precise

Not:
- loud
- overpromotional
- generic AI startup
- vague enterprise fluff

---

## 12) Implementation phases

### Phase 1 — correctness and truth
Fix all launch blockers:
- placeholder links
- wrong CTA destinations
- docs entrypoint
- build failure
- stale sitemap
- canonical domain mismatches
- localhost auth calls

### Phase 2 — site structure and narrative
- rewrite hero
- define a better nav
- add product proof visuals
- align home/download/docs/architecture story

### Phase 3 — Pi.dev-style visual refinement
- tighten spacing and hierarchy
- unify card system
- simplify motion
- improve section rhythm
- make the whole site feel like one polished product

### Phase 4 — polish and validation
- accessibility pass
- SEO pass
- build pass
- mobile pass
- content truth pass

---

## 13) Definition of done

The refactor is not done when it simply looks prettier.
It is done when all of the following are true:

- homepage immediately communicates what Rorca is
- install/download page is the clearest conversion path
- docs are real, not placeholder-y
- changelog builds successfully
- no `href="#"` placeholders remain in public UI
- no hardcoded localhost auth APIs remain in public pages
- sitemap matches the actual public routes
- metadata/canonical URLs are consistent
- the site feels like one coherent product instead of several competing ones
- the visual language feels premium, restrained, and intentional
- the site matches the current backend / MCP / Pi / GraphRAG truth

---

## 14) Recommended next move

The best next step is to turn this plan into a **small, sequenced website refactor backlog**:

1. fix correctness blockers
2. rewrite homepage structure and copy
3. replace docs placeholder behavior
4. make install/download the best page
5. polish secondary pages in Pi.dev style

That is the fastest path to a site that looks genuinely great without losing the current product story.
