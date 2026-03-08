# Rorca — Go-to-Market

**Rorca** is spec-driven development infrastructure. It turns a plain-English brief into a structured spec, then executes each story as an isolated subprocess with the full tool set — no context limits, resumable, runs to completion autonomously.

## Documents in this folder

| File | Contents |
|------|----------|
| [positioning.md](positioning.md) | What Rorca is, what it's not, competitive differentiation |
| [pricing.md](pricing.md) | Tier structure, numbers, rationale |
| [packaging.md](packaging.md) | Feature-by-feature breakdown per tier |
| [free-tier-strategy.md](free-tier-strategy.md) | Self-hosted vs. cloud free vs. team paid logic |

## One-liner

> "Generate specs with any model. Ship them with Claude."

## The category

Rorca owns **spec-driven development** — unclaimed terminology, no Google results. This is deliberate. We are not an AI IDE (Cursor/Windsurf), not a task agent (Devin), not a document tool (ChatPRD). We are the orchestration layer between "what to build" and "it's built."

## The engine (non-negotiable brand statement)

> Every story runs as a fresh isolated subprocess with the full tool set — bash, edit, read, write, glob, grep. No context limits. A spec can run forever. That's the Rorca engine.

## The moat (3 layers)

1. **Direction stack** — persistent context cascade across all stories (L1–L5). No other tool has this.
2. **Per-story subprocess isolation** — infinite effective context window, runs to completion.
3. **Triple execution engine** — `claude --print` (Claude sub) + `opencode run` (75+ providers) + `codex` (ChatGPT sub) — same tool set, same quality, user brings their own inference.

## BYOB (Bring Your Own Brain)

Rorca never pays for inference. Users bring their own subscription or API key. This is not a limitation — it's the moat. Every other tool in this space is in the inference business. Rorca is in the orchestration business.

## Distribution summary

```
Self-hosted → free, fully featured, forever
Cloud solo  → free, fully featured, forever (convenience tier)
Cloud team  → $79–89/mo, 5 seats included (~$16/seat)
```

See [pricing.md](pricing.md) for details.
