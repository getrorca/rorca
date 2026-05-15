# Rorca Pi Extension — Screenshot and Marketing Asset Draft

> Status: **Internal draft only**
>
> This file is for planning future store screenshots, landing-page visuals, captions, and lightweight marketing assets.

---

## 1. Screenshot strategy

If this extension is eventually shown in a store or docs gallery, the screenshots should tell a coherent story.

Recommended order:
1. Discoverability — show `/rorca-help`
2. Action — show `/rorca-forge-run`
3. Precision — show `/rorca-run --story US-001`
4. Visibility — show `/rorca-watch <runId>` widget/status
5. Power-user credibility — show `/rorca-mcp-status`

The goal is not just “pretty terminal pictures.”
The goal is to answer, in order:
- What is this?
- What can I do with it?
- Why is it useful?
- Can I trust it?
- Is it more than a thin shell wrapper?

---

## 2. Recommended screenshot set

### Screenshot 1 — Command discovery
**Title:** Rorca commands inside Pi

**What to show:**
- a clean Pi session
- `/rorca-help`
- the list of Rorca commands

**Caption:**
Get a Pi-native control surface for core Rorca workflows, including forge, approve, run, retry, watch, and MCP status.

**Why it matters:**
Immediately shows that the extension is a real Pi integration with an intentional command surface.

---

### Screenshot 2 — Forge and run in one step
**Title:** Generate and trigger runs from one command

**What to show:**
- `/rorca-forge-run @docs/brief.md --workspace rorca`
- success notification with generated spec slug and triggered run id

**Caption:**
Generate a spec from a brief, approve it, and trigger a Pi-backed Rorca run without leaving Pi.

**Why it matters:**
This is the core “aha” moment for many users.

---

### Screenshot 3 — Single-story precision
**Title:** Run one story only

**What to show:**
- `/rorca-run zz-my-spec --workspace rorca --story US-001`
- success notification with run id

**Caption:**
Target one story at a time for focused reruns, verification, or small iterative fixes.

**Why it matters:**
Shows that the extension supports precise workflows, not only coarse whole-spec execution.

---

### Screenshot 4 — Live watch widget
**Title:** Watch run progress inside Pi

**What to show:**
- an active `rorca-run` widget
- status text such as `Rorca #20260316000309: running`
- a short story list with pass/fail/running status

**Caption:**
Track active runs from inside Pi with live status updates, notifications, and watch-state persistence.

**Why it matters:**
Conveys that the extension is operational, not only command-launch oriented.

---

### Screenshot 5 — MCP bridge health
**Title:** Rorca MCP tools available in Pi

**What to show:**
- `/rorca-mcp-status`
- notification showing loaded tool count

**Caption:**
Automatically bridge Rorca’s HTTP MCP tools into Pi when the backend MCP endpoint is healthy.

**Why it matters:**
Shows the extension can act as both a command surface and a tool-bridge layer.

---

### Screenshot 6 — Status/history view
**Title:** Inspect recent Rorca runs

**What to show:**
- `/rorca-status rorca`
- a recent run list or run detail snapshot

**Caption:**
Inspect recent run history, current status, and spec context without leaving your Pi session.

**Why it matters:**
Reinforces operational continuity.

---

## 3. Screenshot style guidance

### Recommended style
- use a clean Pi theme with good contrast
- avoid excessive scrollback noise
- keep backend errors and unrelated logs out of frame
- prefer realistic but readable run ids and spec slugs
- show success notifications where possible

### Avoid
- screenshots with broken backend sessions unless the point is troubleshooting
- screenshots overloaded with unrelated tool chatter
- screenshots with secrets, tokens, or private URLs visible
- screenshots that require the viewer to already understand the system

### Visual tone
- precise
- high-signal
- operator-grade
- trustworthy
- minimal, not flashy

---

## 4. Suggested demo script for capturing screenshots

### Demo flow
1. start Pi with the extension
2. run `/rorca-help`
3. run `/rorca-forge-run "Create a tiny docs-only story" --workspace mcp-merge-sandbox`
4. capture the success output
5. run `/rorca-watch <runId>`
6. capture the widget/status view
7. run `/rorca-mcp-status`
8. run `/rorca-run <spec-slug> --workspace mcp-merge-sandbox --story US-001`
9. capture the single-story trigger confirmation
10. run `/rorca-status <runId>`
11. capture the run summary

---

## 5. Home page / docs asset blocks

### Hero headline options
1. **Operate Rorca directly from inside Pi**
2. **A Pi-native interface for Rorca workflows**
3. **Forge specs, trigger runs, and watch Rorca live in Pi**

### Recommended hero headline
**Operate Rorca directly from inside Pi**

### Hero subheadline options
1. Generate specs, approve them, run Pi-backed workflows, monitor progress, and bridge Rorca MCP tools from a single Pi session.
2. A Pi-native operator layer for Rorca that keeps Rorca as the control plane while Pi executes the work.
3. Use Rorca without leaving Pi — with slash commands, live watch widgets, retry flows, and optional MCP tool bridging.

### Recommended subheadline
**Generate specs, approve them, trigger Pi-backed runs, watch progress live, and access Rorca MCP tools from a single Pi session.**

---

## 6. Feature grid copy

### Feature 1
**Forge from briefs**
Generate Rorca specs from inline text or `@file` briefs directly in Pi.

### Feature 2
**Run on Pi**
Trigger full-spec or single-story execution with Pi as the execution backend.

### Feature 3
**Watch live progress**
Monitor active Rorca runs with Pi widgets, status text, and notifications.

### Feature 4
**Retry with precision**
Retry a run or target specific failed stories without rebuilding the whole workflow manually.

### Feature 5
**Bridge MCP tools**
Load Rorca HTTP MCP tools into Pi automatically when the backend bridge is healthy.

### Feature 6
**Keep Rorca in control**
Preserve Rorca’s run history, memory, retrieval, graph context, and PR/merge tracking model.

---

## 7. Social / short-form snippets

### X/Twitter post options
1. **New: the Rorca Pi Extension. Forge specs, trigger Pi-backed runs, watch progress live, and bridge Rorca MCP tools directly inside Pi. Rorca still orchestrates. Pi executes. The UX finally feels native.**
2. **If you use Rorca + Pi, the new Rorca Pi Extension gives you forge/approve/run/watch workflows directly inside Pi — without giving up Rorca’s memory, graph, and run-state model.**
3. **We turned Pi into a real operator surface for Rorca. Slash commands, live watch widgets, single-story reruns, and optional MCP tool bridging — all in one extension.**

### Short launch blurb
A Pi-native operator interface for Rorca with slash commands, live run watching, and optional MCP tool bridging.

### Docs landing summary
The Rorca Pi Extension gives you a clean Pi-native way to use Rorca while keeping Rorca as the orchestrator and Pi as the execution backend.

---

## 8. Product-page FAQ blocks

### Is this a replacement for the Rorca app?
No. It complements the app and TUI by adding a Pi-native workflow layer.

### Is this just a CLI wrapper?
No. It talks directly to Rorca REST and HTTP MCP, persists extension state in Pi sessions, and exposes a purpose-built command surface.

### Does it require MCP to work?
No. Slash commands are REST-first. MCP is additive.

### Can it run a single story only?
Yes. Use `/rorca-run <spec-slug> --story <story-id>`.

---

## 9. Internal prep checklist before using these assets publicly

- capture polished screenshots
- decide support URLs
- decide docs URLs
- confirm package publishing posture
- confirm compatibility statement
- confirm legal/license wording
- verify every command example against current behavior

---

## 10. Final note

These assets are deliberately written to be strong enough for a future public launch, but they should be treated as **draft marketing/editorial material** until the team decides to publish the extension more broadly.
