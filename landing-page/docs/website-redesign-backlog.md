# Rorca Website Redesign Backlog

Date: 2026-05-16

This backlog turns the Pi.dev-inspired website plan into a concrete, page-by-page execution list.

## Goals

1. Make the website feel premium, calm, and editoral — closer to Pi.dev.
2. Align the site with current Rorca truth:
   - explicit spec persistence
   - MCP-first control surfaces
   - backend-native GraphRAG / retrieval feedback
   - Pi extension support
3. Remove placeholder / broken / misleading surfaces.
4. Make the install/download journey the clearest conversion path.
5. Keep the site technical, honest, and visually excellent.

---

## Execution principles

- **Truth before beauty**: fix broken or misleading content first.
- **One page, one job**: every page should have a clear purpose.
- **Pi.dev style, not Pi.dev clone**: borrow restraint, clarity, spacing, and typography.
- **No placeholder links**: every public link must go somewhere real.
- **No hidden product drift**: the website must match the current app architecture.
- **Small reversible edits**: ship in slices and validate each slice.

---

## Phase 1 — Correctness and information architecture cleanup

This phase removes the biggest trust breaks and makes the site structurally sound.

### 1. Homepage

**Goal:** make the hero clear, precise, and conversion-oriented.

#### Tasks
- Replace the current generic headline with a more specific positioning line.
- Fix the CTA destinations:
  - primary CTA → `/download`
  - secondary CTA → real docs path or GitHub/README path
- Remove the “TODO: Update to /docs” style placeholder behavior.
- Rework subheadline copy to mention:
  - spec-first workflow
  - backend-native retrieval
  - MCP / Pi portability
- Add a short “why this is different” row immediately under the hero.
- Add one visual proof element near the top:
  - product screenshot
  - spec flow diagram
  - or a dashboard panel mock

#### Success criteria
- A new visitor can understand what Rorca is in under 10 seconds.
- The CTAs are all valid and intentional.
- The page feels like a premium product page, not a template.

#### Dependencies
- Confirm docs destination.
- Confirm whether the homepage should point to GitHub or docs for the secondary CTA.

---

### 2. Nav / shell

**Goal:** align top-level navigation with the product journey.

#### Tasks
- Reorder nav to prioritize the actual journey:
  - Product / Overview
  - Install
  - Architecture
  - Memory
  - Execution
  - Changelog
  - GitHub
- Demote or remove login/signup from the primary nav if auth is not the main public path.
- Make the nav feel visually lighter and closer to Pi.dev.
- Ensure the shell works cleanly on mobile.

#### Success criteria
- Navigation reflects install/docs/source first, not SaaS-auth first.
- No crowded or conflicting top-right CTA cluster.

---

### 3. Footer

**Goal:** remove all placeholder behavior and make the footer credible.

#### Tasks
- Replace every `href="#"` link with a real destination or remove it.
- Keep only real public links.
- Make GitHub / Docs / Changelog visible and correct.
- Remove fake social/terms/privacy links if they do not exist yet.

#### Success criteria
- No placeholder links remain in the public footer.
- Footer looks intentional and not template-generated.

---

### 4. Docs page

**Goal:** replace the coming-soon pattern with a real docs entrypoint.

#### Tasks
- Remove the “docs coming soon” / waitlist-first behavior.
- Replace with a real docs hub:
  - Install
  - Quickstart
  - Architecture
  - Memory / GraphRAG
  - Execution
  - MCP
  - Pi extension
- If a redirect is still needed, make it instant and clearly purposeful.
- If email capture remains, move it behind a proper backend/API route.

#### Success criteria
- “Read the docs” leads to something real.
- The page helps developers start, not wait.

---

### 5. Changelog

**Goal:** fix production build and keep release notes stable.

#### Tasks
- Move motion-heavy UI into a client component.
- Ensure server page only does stable data loading.
- Harden changelog file loading.
- Verify `next build` succeeds.

#### Success criteria
- Changelog no longer blocks production builds.
- Release notes render in production without SSR/client boundary errors.

---

### 6. Sitemap / metadata / canonical identity

**Goal:** make SEO and share metadata coherent.

#### Tasks
- Fix sitemap routes:
  - remove stale `/engine` and `/compute`
  - include current public routes if desired
- Unify canonical domain / OG identity.
- Ensure metadata / JSON-LD / robots / sitemap all agree.
- Remove localhost-origin fallbacks from production-facing metadata where possible.

#### Success criteria
- Canonical URLs are consistent.
- Sitemap matches the actual site.
- Metadata does not undermine trust.

---

### 7. Login / signup

**Goal:** stop the site from reading like a broken SaaS dashboard.

#### Tasks
- Replace hardcoded localhost API URLs with environment-driven values.
- Decide whether auth is part of the public journey at all.
- If auth is not core, remove from nav emphasis.

#### Success criteria
- No public page hardcodes localhost backend URLs.
- Auth surfaces do not dominate the site narrative.

---

## Phase 2 — Page-by-page visual and content refactor

This phase changes the structure and storytelling of each major page.

### 8. Download / Install page

**Goal:** make this the best page on the site.

#### Tasks
- Keep the one-command install story, but present it more elegantly.
- Add a short “what happens when you run this” section.
- Add explicit local service details:
  - frontend
  - backend
  - worker
- Add one short quickstart for using Rorca with Claude Code / MCP / Pi.
- Add a clean troubleshooting teaser link to the troubleshooting page.
- Reduce visual noise in the platform download area.

#### Success criteria
- The download page becomes the primary conversion path.
- It feels polished and trustworthy.

---

### 9. Architecture page

**Goal:** explain the system clearly without reading like internal notes.

#### Tasks
- Shorten lead copy.
- Add a hero summary that explains the architecture in one sentence.
- Break sections into more digestible chunks.
- Add a visual “system map” block.
- Highlight the relationship between:
  - spec lifecycle
  - direction stack
  - retrieval
  - execution engine
  - MCP surfaces

#### Success criteria
- A technical reader can scan the page and understand the stack quickly.

---

### 10. Memory / GraphRAG page

**Goal:** make the retrieval story elegant and credible.

#### Tasks
- Reframe from “memory implementation details” to “how context stays relevant.”
- Explain CAG → RAG → graph retrieval → feedback system in simple language.
- Add one clean diagram or staged visual.
- Emphasize the feedback system and telemetry.

#### Success criteria
- The page explains the retrieval system without overwhelming the reader.

---

### 11. Execution page

**Goal:** show how specs become shipped work.

#### Tasks
- Reframe from generic engine description to an execution narrative.
- Show the story lifecycle visually.
- Make the multi-engine section simpler and more premium.
- Reduce overclaiming around speed / savings unless backed by real data.
- Explain the role of isolated subprocesses and story waves.

#### Success criteria
- Execution reads like a product capability page, not a technical dump.

---

### 12. Pricing page

**Goal:** decide whether pricing is truly ready to be public.

#### Tasks
- Reassess whether the current pricing model reflects the actual product.
- If pricing is not fully operational, reframe the page as:
  - deployment modes
  - support options
  - enterprise/contact flow
- Remove anything that looks like pseudo-live checkout if it is not real.

#### Success criteria
- The pricing page never feels misleading.

---

### 13. Troubleshooting page

**Goal:** keep it useful, lighter, and more visually aligned.

#### Tasks
- Ensure the page is easy to scan.
- Make issue blocks more compact.
- Add stronger hierarchy and better section grouping.
- Link it from download/install and docs.

#### Success criteria
- It is actually helpful during install and feels like part of the system.

---

## Phase 3 — Pi.dev-style visual system

This phase makes the whole site feel cohesive and polished.

### 14. Visual language overhaul

#### Tasks
- Tighten typography scale.
- Reduce the number of card variations.
- Use a more restrained accent system.
- Increase whitespace.
- Standardize section spacing.
- Make motion subtler and more deliberate.

#### Success criteria
- The site feels premium and calm.
- No page looks like a different design system.

---

### 15. Component system consolidation

#### Tasks
- Standardize:
  - hero sections
  - feature cards
  - code blocks
  - callout panels
  - section headers
  - CTA groups
- Reuse the same component patterns across pages.
- Remove redundant or ornamental variants.

#### Success criteria
- New pages can be built quickly without visual drift.

---

### 16. Product proof content

#### Tasks
- Add real screenshots or product UI captures.
- Add one strong architecture diagram.
- Add one strong install flow visual.
- Add one real workflow example:
  - brief → spec → persist → review → run → feedback

#### Success criteria
- The site feels like a real product, not just a beautiful concept.

---

## Phase 4 — Trust, SEO, and final polish

### 17. Accessibility pass

#### Tasks
- Verify heading order.
- Check contrast across cards, labels, and muted text.
- Ensure interactive elements have obvious states.
- Validate keyboard focus behavior.

### 18. SEO / metadata pass

#### Tasks
- Confirm all pages have coherent titles/descriptions.
- Confirm canonical URLs.
- Confirm sitemap accuracy.
- Confirm OG image fallbacks.

### 19. Mobile / responsive pass

#### Tasks
- Verify hero fits on smaller screens.
- Simplify the nav and page spacing on mobile.
- Ensure code blocks and tables don’t overflow awkwardly.

### 20. Final truth pass

#### Tasks
- Check every claim against the current product.
- Remove or soften anything not backed by current behavior.
- Ensure the site reflects the OSS / MCP / Pi / GraphRAG reality.

---

## Suggested implementation order

### Sprint 1
- homepage
- nav
- footer
- docs
- changelog
- sitemap / metadata
- login/signup cleanup

### Sprint 2
- download/install page
- architecture page
- memory page
- execution page
- pricing page decision

### Sprint 3
- visual system consolidation
- product proof visuals
- accessibility / SEO / mobile polish

---

## Definition of done

The redesign is complete when:

- the site has one clear product story
- the hero is specific and credible
- all CTAs go somewhere real
- the docs path is real
- the install page is excellent
- the architecture/memory/execution pages are readable and premium
- the site feels closer to Pi.dev in tone
- no placeholder / broken / fake behavior remains
- the site matches current Rorca architecture and product truth

---

## Notes

This backlog is intentionally sequenced so that a small team or a single agent can execute it safely.
Start with correctness, then reshape the narrative, then polish the visuals.
