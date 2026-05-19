# Rorca Landing Page + KingMode Setup — Implementation Plan

## Part 1: KingMode (Apex Predator Edition)

### Refined KingMode Prompt

```
<KING_MODE>
You are operating in KingMode. This is a behavioral discipline layer. You are the apex predator of this codebase.

HARD RULES:
- **Zero Friction**: No warm-up prose, "Sure!", or "I can help with that". Direct execution only.
- **Apex efficiency**: If a task can be done with one complex `sed` command or a multi-file `grep`, do it. Don't crawl files sequentially if unnecessary.
- **No Permission Theater**: Do not ask "Should I...?" for standard engineering decisions (naming, placement, refactoring). Just do it and document in the summary.
- **Concurrency**: Use parallel tool calls for research and verification whenever possible.
- **Orca Pulse**: Be assertive, precise, and hunt for bugs with zero mercy.

ULTRATHINK TRIGGER:
When you see ULTRATHINK, spend ONE silent planning pass (≤10s) before tool calls. No prose. Then execute.

SCOPE DISCIPLINE:
- Change ONLY what is requested.
- "While I'm here" refactors are prohibited unless they fix a direct blocker.

OUTPUT FORMAT:
- Code blocks > Prose.
- Terminal commands must be absolute and copy-paste ready.
- End immediately after the last tool/code block. No "hope this helps!"
</KING_MODE>
```

### Placement
- **`rorca.md`** skill file
- **`AGENTS.md`** at the project root (so all Rorca-specific agents inherit this discipline)

---

## Part 2: Rorca "Linear/Vercel" Landing Page

### Design Direction: Production Grade

Premium, dark-mode focused "Linear/Vercel" aesthetic reflecting a production-grade infrastructure product.

#### Design Tokens (Zinc Dark UI)
| Token | Value |
|---|---|
| Background | `zinc-950` (`#09090b`) with a barely visible `violet-500` top radial gradient |
| Surface | `zinc-900` (`#18181b`) for cards and floating elements |
| Text Primary | `zinc-50` |
| Text Secondary | `zinc-400` |
| Borders | Subdued glassmorphism (`rgba(255, 255, 255, 0.08)`) |
| Accents | Subtle glows (`violet-500` and white flares) |

#### Simplicity (Linear/Vercel Style)
- **Hero**: Subdued pill badge at the top. Massive text with a `zinc-300` to `zinc-500` gradient text clip. Strict spacing.
- **Nav**: Glassmorphic, sticky top nav with a refined geometric logo, simple links, and subdued buttons.
- **Cards**: A bento grid using tight borders and a very subtle white gradient hover reveal.

### Feature Set
- Context Routing Engine
- Parallel Worktrees
- Real-Time Telemetry
- Spec Forge
- Native Deployments
- Command Palette

---

## Part 3: Platform Extension Page (`/architecture`)

Based on approved/pending specs (Domain Profiles, Spec Templates, Pipeline Webhooks), a dedicated `/architecture` page showcases Rorca's engineering depth.

### Design Concept: "The Glass Data-Center"
A high-end, vertical timeline layout (Linear/Vercel style) that simulates scrolling through Rorca's platform layers.

#### Section 1: The Spec Forge & Template Library
- **Visual**: A mock UI of the "Spec Templates" grid (`REST CRUD API`, `OAuth Login`).
- **Copy**: "Stop writing from scratch. Inject parameterized templates with `{{VARIABLE}}` substitution directly into the Spec Forge. Rorca synthesizes the context instantly."

#### Section 2: Command & Control (L2 Domain Profiles)
- **Visual**: A code-editor-style block showing how `L2 Domain Profiles` (e.g., `typescript`, `saas-api`) apply globally across workspaces.
- **Copy**: "Global context enforcement. A single L2 Domain Profile mandates rules across all associated workspaces automatically."

#### Section 3: The Pipeline Monitor (Real-Time SSE)
- **Visual**: A glowing, animated terminal block catching push-based Webhooks (`POST /api/pipeline/webhook/story-result`).
- **Copy**: "Live telemetry without polling. Rorca streams Server-Sent Events directly to your dashboard, so you can watch worktrees and story progress in real time."

---

## Verification Plan
1. **KingMode Test**: Ask a question with "ULTRATHINK" and verify the silent planning + direct answer.
2. **Landing Page**: Verify the bento grid, typography (Geist), and exact Vercel/Linear color scheme.
3. **Architecture Page**: Verify the `/architecture` route hosts the new deep-dive features accurately reflecting the JSON specs.
