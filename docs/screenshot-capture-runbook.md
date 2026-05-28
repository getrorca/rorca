# Screenshot capture runbook

## Purpose
Capture real, product-accurate screenshots for the docs and getting started pages.

These screenshots should show:
- how the product looks in a real session
- the exact place a new user should click or type
- the success state of each step

Do **not** use mockups unless a real capture is impossible.

## What to capture
Priority order:
1. Getting Started
2. CLI
3. Pi extension
4. TUI
5. Execution / architecture support shots

## Recommended capture stack
### UI / web
- Use **Playwright** for repeatable browser screenshots.
- Best for dashboard, settings, marketplace, spec review, and run pages.

### CLI / TUI / Pi
- Use a fixed terminal window and the OS screenshot tool.
- Best on macOS with:
  - `Cmd+Shift+4` for crops
  - `Cmd+Shift+5` for window captures
  - `screencapture` if you want scripting

## Before you capture
### 1) Prepare a clean demo workspace
Use a predictable workspace that already has:
- one real repo registered
- one connected execution path
- a few installed skills
- at least one approved spec
- at least one active or completed run

### 2) Freeze the visual environment
Keep these stable:
- browser zoom: 100%
- terminal font: fixed and readable
- terminal theme: dark
- window size: consistent
- sidebar state: stable and intentional
- no notifications or popups

### 3) Decide the exact story each image tells
Every screenshot should answer one question:
- Where do I start?
- Where do I connect providers?
- Where do I install skills?
- What does spec review look like?
- What does a run look like?
- What does retry look like?

## Capture workflow
### Phase 1 — seed the state
Create or open the exact state you want to show.

Examples:
- dashboard home with docs/surface cards visible
- Providers & Models with one connected provider
- Marketplace with a skill search result visible
- spec review with a story excluded
- run view showing live progress
- TUI board with a selected run
- Pi with a slash command and result visible

### Phase 2 — clean the frame
Before capture:
- close unrelated panels
- collapse noisy sidebars if needed
- scroll the page to the target section
- keep only one action visible
- remove any debugging output

### Phase 3 — capture
Capture the smallest usable frame that still gives enough context.

### Phase 4 — review
Check:
- text is readable
- the active UI state is obvious
- no private/local secrets are visible
- the image is not too wide or too tall
- the screenshot matches the doc copy exactly

## Naming convention
Use descriptive names that match the doc section.

Examples:
- `01-dashboard-home.png`
- `02-providers-models.png`
- `03-marketplace-skills.png`
- `04-spec-review.png`
- `05-run-progress.png`
- `cli-01-start.png`
- `cli-02-forge.png`
- `cli-03-run.png`
- `cli-04-doctor.png`
- `cli-05-retry.png`
- `tui-01-board.png`
- `tui-02-watch.png`
- `tui-03-stream-switching.png`
- `tui-04-workspace-switcher.png`
- `pi-01-extension-installed.png`
- `pi-02-create-spec.png`
- `pi-03-run.png`
- `pi-04-watch-retry.png`
- `pi-05-status.png`

Recommended storage:
- `public/docs-images/getting-started/`
- `public/docs-images/cli/`
- `public/docs-images/tui/`
- `public/docs-images/pi-extension/`
- `public/docs-images/execution/`

## Capture checklist by surface

### A) Getting Started / UI screenshots
#### 1. Dashboard home
Capture:
- top nav
- dashboard entry surface
- docs or onboarding callout if present
- enough layout to orient a new user

#### 2. Providers & Models
Capture:
- Settings → Providers & Models
- visible connection state
- one usable model path
- tabs or sections showing the available setup areas

#### 3. Marketplace / skills
Capture:
- search results in Marketplace
- install action or installed state
- at least one visible skill detail or registry card

#### 4. Spec review
Capture:
- brief/spec area
- generated story list
- acceptance criteria visible
- exclude/include controls if possible

#### 5. Run progress
Capture:
- active run state
- passed / failed / running story statuses
- terminal output or activity panel

### B) CLI screenshots
#### 1. Start
Capture:
- `rorca start`
- local URLs and startup confirmation

#### 2. Forge
Capture:
- `rorca forge <brief...>`
- draft output or spec summary

#### 3. Run
Capture:
- `rorca run <specSlug>`
- execution progress / attached output

#### 4. Doctor
Capture:
- `rorca doctor`
- health checks and pass/fail lines

#### 5. Retry
Capture:
- `rorca retry` or `rorca run --sequential` flow
- targeted failed story or narrow retry scope

### C) TUI screenshots
#### 1. Board view
Capture:
- board layout
- pending / approved / running items
- selected row visible

#### 2. Watch mode
Capture:
- live run panel
- stream/output visible
- selected run obvious

#### 3. Stream switching
Capture:
- combined run stream
- a story substream
- key hints like `Tab`, `Esc`, `b`

#### 4. Workspace picker
Capture:
- workspace switcher
- current workspace
- enough context to show the action is deliberate

#### 5. Story detail
Capture:
- story/run detail pane
- status and logs
- any visible action buttons

### D) Pi extension screenshots
#### 1. Installed extension / help
Capture:
- Pi with Rorca extension available
- `/rorca-help` or command list visible

#### 2. Create spec
Capture:
- `/rorca-create-spec`
- brief or file prompt
- workspace flag if relevant

#### 3. Run
Capture:
- `/rorca-run`
- flags visible if used
- queued or starting state visible

#### 4. Watch / retry
Capture:
- `/rorca-watch`
- `/rorca-retry`
- live status or retry confirmation

#### 5. Status
Capture:
- `/rorca-status`
- `/rorca-mcp-status`
- useful success state or summary response

## Good screenshot rules
- Show **one task per screenshot**.
- Prefer **success states** over error states.
- If you show an error, explain the fix in the surrounding text.
- Keep browser chrome minimal unless it helps orientation.
- Keep the terminal readable; don’t cram too much output into one frame.
- Show the active state clearly: selected row, active tab, open panel, or typed command.

## Capturing with Playwright
Use Playwright for deterministic UI captures.

Suggested flow:
1. start the app
2. navigate to the route
3. seed the desired state
4. set viewport
5. capture PNG

Recommended usage patterns:
- fixed viewport size
- wait for all async content to settle
- avoid animation frames if they make the screenshot noisy
- prefer `locator.screenshot()` for small regions and `page.screenshot()` for full-page shots

## Capturing CLI / TUI / Pi
### Terminal setup
Use a fixed-size terminal with:
- dark theme
- readable monospace font
- stable font size
- no translucent background
- enough rows to show context

### Recommended approach
1. open the app/tool
2. run the command
3. wait for the stable output state
4. capture the terminal window or crop

### For TUI
Make sure the screenshot clearly shows:
- board vs live mode
- selected item
- current run/story
- the key hints if the screen uses them

### For Pi
Make sure the screenshot clearly shows:
- the slash command
- the Pi-native context
- the resulting state or response

## Quality checklist before publishing
For every image confirm:
- readable at doc width
- no accidental secrets
- no irrelevant browser chrome
- no partial loading spinners unless intentional
- the screenshot matches the copy beside it
- alt text is written
- caption is written

## Suggested alt text style
Describe what the user is meant to learn, not just what is visible.

Examples:
- “Rorca dashboard home showing the onboarding entry points for providers, skills, specs, and runs.”
- “Providers & Models settings page with one connected execution path and visible model options.”
- “CLI output for `rorca doctor` showing health checks and local environment status.”
- “Pi extension command surface showing `/rorca-create-spec` and `/rorca-run`.”

## Final rule
If a screenshot does not teach a new user something specific, do not include it.
