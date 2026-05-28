# Docs imagery plan

## Recommendation
Yes — add screenshots, but do it selectively.

The docs and getting-started pages will benefit most from **real UI captures** that show the user where to click and what success looks like. The goal is not decoration; it is to reduce ambiguity for first-time users.

Use screenshots for:
- first-run onboarding
- provider/model setup
- skill installation
- spec creation and review
- execution and retry flows
- CLI/TUI/Pi operator surfaces

Avoid screenshots where text alone is clearer.

## Core rules
- Use **real product screenshots**, not mock illustrations.
- Prefer **one screenshot per major step**.
- Keep overlays minimal; the point is orientation, not marketing polish.
- Highlight one action per image with callouts or crop focus.
- Always pair each image with a short caption and alt text.
- Capture both **happy path** and **decision point** states.

## Recommended image folder structure
- `public/docs-images/getting-started/`
- `public/docs-images/cli/`
- `public/docs-images/tui/`
- `public/docs-images/pi-extension/`
- `public/docs-images/execution/`

Suggested naming:
- `01-dashboard-home.png`
- `02-providers-models.png`
- `03-marketplace-skills.png`
- `04-spec-review.png`
- `05-run-progress.png`
- `cli-01-start.png`
- `tui-01-board.png`
- `pi-01-command-palette.png`

## Getting started page: where photos should go

### 1) Intro section
**Placement:** after the “Zero to first successful Rorca run” intro, before the first numbered step.

**Photo:** `01-dashboard-home.png`

**What it should show:**
- the Rorca dashboard homepage
- the left navigation
- the main surface cards / docs entry points
- enough of the top bar to orient the user

**Why:**
New users need to immediately understand that the dashboard is the first control surface.

**Caption idea:**
“Start in the dashboard, then move into providers, skills, specs, and runs.”

---

### 2) Providers & Models setup
**Placement:** inside the step that tells users to configure providers and models.

**Photo:** `02-providers-models.png`

**What it should show:**
- Settings → Providers & Models
- the Connections tab or equivalent
- visible model/provider entries
- enough of the tabs to show the available setup areas

**Best variant:**
A screenshot where one provider is clearly connected and at least one model is visible.

**Why:**
This is the most important “it is real now” step. Users often fail here first.

**Caption idea:**
“Connect one execution path first; don’t try to wire everything at once.”

---

### 3) Skills / Marketplace
**Placement:** immediately after the skills explanation, before talking about automatic matching.

**Photo:** `03-marketplace-skills.png`

**What it should show:**
- Marketplace view
- a skills registry search result
- an install button or installed state
- ideally one visible skill detail panel

**Best variant:**
Show a skill being selected from Marketplace, with the install action obvious.

**Why:**
The words “skills” and “matching” are abstract until users see the install flow.

**Caption idea:**
“Install a few high-signal skills that match your stack.”

---

### 4) Spec creation
**Placement:** in the section that says “Create your first spec from a plain-English brief.”

**Photo:** `04-spec-review.png`

**What it should show:**
- the forge/spec creation UI
- a brief input area or drafted spec summary
- generated stories list
- acceptance criteria visible for at least one story

**Why:**
Users need to see that a brief becomes a structured spec.

**Caption idea:**
“Write a brief, then review the generated stories before you run anything.”

---

### 5) Story selection / exclude before run
**Placement:** in the section that explains include/exclude and safer first runs.

**Photo:** same as `04-spec-review.png`, or a second crop: `05-spec-story-selection.png`

**What it should show:**
- story list with include/exclude controls
- at least one excluded story
- the approval state or approval button nearby

**Why:**
This is one of the biggest “new user” comprehension points.

**Caption idea:**
“Exclude the stories you do not want yet, then approve the smaller run.”

---

### 6) Run progress / watch state
**Placement:** in the final step about watching and retrying.

**Photo:** `05-run-progress.png`

**What it should show:**
- active run view
- per-story progress
- status transitions (queued / running / passed / failed)
- visible log or terminal output panel

**Why:**
This shows what success looks like once execution begins.

**Caption idea:**
“Watch progress, inspect failures, then retry narrowly.”

---

## Docs page imagery: where photos should go

### `/docs/tools`
Use small screenshots or UI strips for each surface.

**Add images for:**
- CLI command list
- TUI board view
- Pi slash command flow

This page should feel like a cross-surface map, not a giant gallery.

---

### `/docs/cli`
Use screenshots to anchor the command examples.

**Add images for:**
1. `cli-01-start.png`
   - terminal with `rorca start`
   - backend starting
   - local URLs visible

2. `cli-02-forge.png`
   - `rorca forge <brief...>`
   - spec draft output in terminal

3. `cli-03-run.png`
   - `rorca run <specSlug>`
   - execution progress / attach state

4. `cli-04-doctor.png`
   - `rorca doctor`
   - health checks and pass/fail output

5. `cli-05-retry.png`
   - retry command with a failed story targeted

**Placement:**
- one hero screenshot near the top
- one screenshot in the `run` section
- one in the `doctor`/troubleshooting section

---

### `/docs/tui`
Use screenshots that prove the TUI is an actual operator surface, not just a terminal wrapper.

**Add images for:**
1. `tui-01-board.png`
   - board overview
   - pending / approved / running items visible

2. `tui-02-watch.png`
   - selected run in watch mode
   - stream panel visible

3. `tui-03-stream-switching.png`
   - combined run stream and a story substream
   - visible key hints like Tab / Esc / b

4. `tui-04-workspace-switcher.png`
   - workspace picker open
   - current workspace visible

5. `tui-05-story-detail.png`
   - story detail or run detail panel
   - status, logs, and selection state visible

**Placement:**
- board screenshot in the intro
- watch screenshot in the live section
- stream switching screenshot near shortcut explanation

---

### `/docs/pi-extension`
Use screenshots that prove Pi is a real operator entry point.

**Add images for:**
1. `pi-01-extension-installed.png`
   - Pi command palette / extension installed state
   - `/rorca-help` visible or surfaced

2. `pi-02-create-spec.png`
   - `/rorca-create-spec` invocation
   - brief input or attached file prompt visible

3. `pi-03-run.png`
   - `/rorca-run` command with flags
   - run starting or queued status shown

4. `pi-04-watch-retry.png`
   - `/rorca-watch` or `/rorca-retry`
   - live status / retry confirmation

5. `pi-05-status.png`
   - `/rorca-status` or `/rorca-mcp-status`
   - clear successful response state

**Placement:**
- one install screenshot near the top
- one create-spec screenshot in the command list section
- one run/watch screenshot in the execution section

---

## UI / CLI / TUI / Pi screenshot requirements

### UI screenshots should show
- current route and visible nav context
- one clear next action
- one stable success state
- no unnecessary browser chrome unless it helps orientation

### CLI screenshots should show
- full command line input
- command output with status indicators
- enough terminal context to prove the command worked
- no huge walls of logs unless that is the point

### TUI screenshots should show
- the board layout or live stream layout clearly
- keyboard hints where relevant
- active selection state
- a visible run/story status

### Pi screenshots should show
- the slash command being entered or invoked
- the extension output/state
- the agent is inside Pi, not the browser or raw shell
- the command surface remains Pi-native and distinct from the CLI

## Accessibility notes
Every image should have:
- a short caption
- alt text that describes the action, not just the screen
- a linked text fallback nearby

Example alt text:
- “Rorca dashboard showing Providers & Models settings with one connected execution path.”
- “Terminal running rorca doctor with health checks listed line by line.”
- “Pi command palette showing /rorca-create-spec and /rorca-run commands.”

## Priority order
If we do these in phases, do them in this order:
1. Getting started
2. CLI
3. Pi extension
4. TUI
5. Execution / architecture polish images

That sequence matches the actual beginner journey.

## Final recommendation
Yes: add photos/screenshots, but make them **surgical**.

The best payoff is:
- **Getting started**: dashboard, providers, skills, spec review, run progress
- **CLI**: start, forge, run, doctor, retry
- **TUI**: board, watch, stream switching, workspace switching
- **Pi extension**: install, create-spec, run, watch, status

That gives new users a visual path from “what is this?” to “I can run work now.”
