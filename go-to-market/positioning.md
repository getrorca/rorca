# Positioning

## What Rorca Is

**Spec-driven development infrastructure.**

Rorca sits between "here's what I want to build" and "it's built and committed." It:

1. Turns a plain-English brief into a structured spec (user stories with acceptance criteria and dependencies)
2. Executes each story as an isolated subprocess — fresh agent context per story, full tool set, no context limits
3. Commits each passing story to git, emits structured events to the pipeline monitor
4. Persists conventions, patterns, and decisions as first-class artifacts your whole team (and every AI tool) benefits from

## What Rorca Is NOT

| What people will compare it to | Why that's wrong |
|-------------------------------|-----------------|
| **Cursor / Windsurf / Copilot** | Those are IDE assistants. They help you write code in real time. Rorca executes autonomous multi-story specs while you sleep. No IDE required. |
| **Devin / SWE-agent** | Task agents. One task, one run, pay per use, $500/mo. No spec structure, no direction stack, no pipeline monitoring. |
| **ChatPRD / Linear / Notion** | Document tools. They produce artifacts. Rorca executes them. |
| **LangChain / LlamaIndex** | Frameworks for building AI apps. Rorca is an app. It uses Claude Code / OpenCode / Codex as execution engines. |
| **GitHub Actions / CI/CD** | CI runs tests. Rorca writes the code that CI will test. Different layer. |

## The Kiro Comparison (Important)

Kiro ($20/mo) is expensive-feeling not because of the price — it's because it competes directly with Cursor ($20/mo) and Windsurf (free/paid) in the AI-IDE category where users already have established tools. Switching cost is high, value delta is unclear.

Rorca is not in that category. Rorca's switching cost is **near zero** — it doesn't replace your IDE. It augments your entire dev workflow regardless of which IDE you use. The value proposition is additive, not substitutive.

## Competitive Positioning (One Line Each)

- **vs ChatPRD**: "ChatPRD writes the plan. Rorca ships it."
- **vs Devin**: "Devin is a task agent at $500/mo. Rorca is spec-driven development infrastructure — bring your own Claude subscription."
- **vs Cursor/Windsurf**: "We're not competing. Use both. Rorca builds the spec; your IDE is where you review the diff."
- **vs MetaGPT**: "Academic research project, no UI, no production pipeline, no direction stack."

## Target Customer

**Solo developers and small teams who:**
- Are already using Claude, ChatGPT, or Gemini subscriptions
- Regularly tackle features that take 3–10 files and multiple sessions to ship
- Have experienced context window loss killing multi-session work
- Understand the value of structured specs (or are willing to learn)
- Self-host comfortably (technical users)

**Secondary (cloud team):**
- Engineering leads who want consistency across their team's AI-assisted development
- Teams who want shared direction stacks (conventions, standards, patterns)
- Orgs with multiple developers who shouldn't be rebuilding context from scratch each session

## The Trojan Horse

Rorca's filesystem-native output (CLAUDE.md, MEMORY.md, AGENTS.md, .rorca/) makes **every other AI tool smarter**. Cursor gets better. Copilot gets better. Raw Claude Code gets better. Rorca is ambient infrastructure — it compounds over time and creates structural dependency without lock-in. Users stay because the output is genuinely valuable, not because we've made switching hard.

## Category Creation Strategy

Own **"spec-driven development"** — no existing Google results, no competitors in this framing. Every blog post, every tweet, every doc uses this terminology. Make Rorca synonymous with the category before anyone else notices the framing opportunity.

The Terraform analogy (from our collaborator Alexis Okuwa): "The problem isn't the tooling — it's the lack of conventions." Every team reinvents project structure, patterns, and standards session by session. Rorca encodes those decisions and makes them durable.
