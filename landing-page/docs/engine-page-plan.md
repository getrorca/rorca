# Engine Page — Implementation Plan

The user requested a unique extension to the landing page, heavily themed around the `KingMode` discipline and drawing from the context of the entire project (including pending specs like the Context/Intent Engine). Since `/architecture` and `/compute` already exist, a new `/engine` page was created. This page embodies the "Orca Pulse" and highlights Rorca's true differentiator: The Autonomous Engine, Virtual Context Routing, and Episodic Memory.

## Proposed Changes

### Landing Page Components

#### [NEW] `landing-page/src/app/engine/page.tsx`
Create a new Next.js page featuring the KingMode aesthetic (dark, aggressive, highly technical) using `framer-motion` and `lucide-react`.
Sections include:
1. **KingMode Discipline**: Highlighting the zero-friction, apex efficiency behavioral layer.
2. **Virtual Context Routing**: Explaining how the engine routes context (from the CIE spec) to avoid window bloating.
3. **Episodic Ledger**: Highlighting `MEMORY.md` and Rorca's ability to retain context across compaction.
4. **Soft Governance**: Highlighting `AGENTS.md` and directory-level rules.

#### [MODIFY] `landing-page/src/components/Nav.tsx`
Add a link to the new `/engine` page in the top navigation bar to ensure it is discoverable, placing it alongside `/architecture` and `/compute`.

## Verification Plan

### Automated Tests
- Run `npm run build` in the `landing-page` directory to ensure there are no TypeScript or Next.js build errors.

### Manual Verification
- N/A for this static content addition. The builds verifying successful compilation are sufficient.

## Walkthrough

The `/engine` page was successfully implemented. Key changes:

- **Created `/engine/page.tsx`**: A brand new, highly technical marketing page built with `framer-motion` and styled with Tailwind using the `abyss` and `fizz`/`accent` color palette from the Rorca aesthetic.
- **Updated `Nav.tsx`**: Injected the "Engine" link into the top navigation bar so users can seamlessly browse between Home, Architecture, Engine, and Compute.

### Page Content
The new page focuses on the structural and conceptual differences that make Rorca an autonomous engine rather than a simple wrapper:
1. **Virtual Context Routing**: Explaining how `config.json` uses glob patterns to strategically route context documents to isolated worktrees, solving the context window bloat problem.
2. **The Episodic Ledger (`MEMORY.md`)**: Highlighting how Rorca achieves long-term determinism by persisting architectural decisions, fixes, and gotchas inside a structured `MEMORY.md` file after every run.
3. **Soft Governance (`AGENTS.md`)**: Demonstrating how localized `AGENTS.md` files provide directory-level behavioral discipline.

### Validation
- **Build Passing**: `npm run build` in the `landing-page` directory completed with 0 errors.
