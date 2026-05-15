# Rorca Pi Extension — Screenshot Capture Checklist

> Status: **Internal draft only**
>
> This checklist is for capturing polished screenshots later if you choose to publish or present the extension more broadly.

---

## 1. Purpose of this checklist

A screenshot set should do more than prove the extension exists.

It should answer, in sequence:
1. What is this?
2. What can I do with it?
3. Why is it useful?
4. Does it look real and trustworthy?
5. Is it more than a thin wrapper?

This checklist is meant to make that repeatable.

---

## 2. Recommended screenshot sequence

Capture in this order:

1. `/rorca-help`
2. `/rorca-forge-run ...`
3. `/rorca-run ... --story US-001`
4. `/rorca-watch <runId>`
5. `/rorca-mcp-status`
6. `/rorca-status <runId>` or `/rorca-status <workspace>`

This sequence tells a clear story from discovery to operation.

---

## 3. Environment prep checklist

Before capturing anything:

- [ ] use a clean Pi session
- [ ] ensure the extension is loaded
- [ ] ensure the backend is running
- [ ] ensure the worker is running
- [ ] use a workspace with safe demo data
- [ ] confirm no secrets or personal paths are visible
- [ ] choose whether to capture from the sandbox workspace or a docs/demo workspace
- [ ] confirm commands succeed before capturing

Recommended demo workspace:
- `mcp-merge-sandbox`

Reason:
- safe
- small
- disposable
- easy to explain

---

## 4. Visual setup guidelines

### Terminal size
Recommended:
- width: wide enough to avoid ugly line wrapping
- height: enough to show one coherent unit of output without scrolling too far

Practical recommendation:
- 120–140 columns
- 36–48 rows

### Theme
Use:
- dark theme with high contrast
- readable font
- clear color distinction for success/info/warning

Avoid:
- low contrast themes
- novelty fonts
- cluttered multipane layouts
- tabs or shells showing unrelated work

### Crop discipline
Each image should show:
- the command
- the important result
- enough surrounding UI to prove it is Pi

Each image should avoid:
- huge empty space
- unrelated commands
- unrelated logs
- machine-specific distractions

---

## 5. Privacy / cleanup checklist

Before taking final screenshots, remove or obscure:

- [ ] tokens
- [ ] admin secrets
- [ ] local filesystem paths you do not want public
- [ ] private branch names unrelated to the demo
- [ ] personal email addresses
- [ ] internal ngrok URLs unless intentionally public
- [ ] noisy stack traces or unrelated warnings

If necessary, use a demo environment or temporary workspace.

---

## 6. Screenshot 1 — `/rorca-help`

### Goal
Show that the extension has a real command surface and is easy to discover.

### Command
```text
/rorca-help
```

### Should show
- command invocation
- command list
- readable flags/examples if visible

### Should not show
- unrelated backend errors
- random prior shell output

### Suggested caption
**Rorca commands inside Pi** — forge specs, approve them, run Pi-backed workflows, inspect status, retry failures, and check MCP bridge health.

### Capture checklist
- [ ] command visible
- [ ] at least 6–8 commands visible
- [ ] output readable without zooming far in

---

## 7. Screenshot 2 — `/rorca-forge-run`

### Goal
Show the core “do real work now” workflow.

### Command
Example:
```text
/rorca-forge-run "Create a tiny docs-only story that updates README.md" --workspace mcp-merge-sandbox
```

### Should show
- command
- generated spec slug or success message
- run id notification
- optional story preview if returned

### Suggested caption
**Generate and trigger in one step** — go from a brief to a Pi-backed Rorca run directly inside Pi.

### Capture checklist
- [ ] workspace visible if useful
- [ ] spec slug visible
- [ ] run id visible
- [ ] no ambiguous failure noise in frame

---

## 8. Screenshot 3 — single-story run

### Goal
Show precise control, not just whole-spec execution.

### Command
Example:
```text
/rorca-run zz-postpatch-specific-story-verify --workspace mcp-merge-sandbox --story US-001
```

### Should show
- explicit `--story US-001`
- successful trigger output
- run id

### Suggested caption
**Run a single story only** — ideal for reruns, focused verification, and tight iteration loops.

### Capture checklist
- [ ] `--story US-001` clearly visible
- [ ] success output visible
- [ ] layout not overly busy

---

## 9. Screenshot 4 — watch mode

### Goal
Show that the extension is operational and live, not just a launcher.

### Command
Example:
```text
/rorca-watch 20260316000309
```

### Should show
- Pi widget area with run info
- Pi status line if visible
- story progress items
- current run id

### Suggested caption
**Watch runs live** — monitor active Rorca runs from Pi widgets and session status updates.

### Capture checklist
- [ ] widget title visible
- [ ] run id visible
- [ ] story statuses readable
- [ ] not too much vertical noise

---

## 10. Screenshot 5 — MCP bridge status

### Goal
Show that the extension can also bring tools into Pi, not only trigger REST workflows.

### Command
```text
/rorca-mcp-status
```

### Should show
- healthy MCP notification
- tool count
- endpoint or “healthy” summary if clean

### Suggested caption
**Bridge Rorca MCP tools into Pi** — automatically register backend tools when the MCP endpoint is healthy.

### Capture checklist
- [ ] success wording visible
- [ ] tool count visible
- [ ] no auth/token noise in frame

---

## 11. Screenshot 6 — status/history

### Goal
Show operational continuity after launch.

### Command options
```text
/rorca-status 20260316000309
```

or

```text
/rorca-status mcp-merge-sandbox
```

### Should show
- either run detail or recent runs
- clear status labels
- useful but compact output

### Suggested caption
**Inspect runs without leaving Pi** — check recent history, current status, and run context from the same session.

### Capture checklist
- [ ] output is understandable without prior context
- [ ] statuses are visible
- [ ] layout feels tidy

---

## 12. Exact demo commands (recommended draft)

Use or adapt this sequence later:

```text
/rorca-help
/rorca-forge-run "Create a tiny docs-only story that updates README.md" --workspace mcp-merge-sandbox
/rorca-watch <runId>
/rorca-mcp-status
/rorca-run zz-postpatch-specific-story-verify --workspace mcp-merge-sandbox --story US-001
/rorca-status <runId>
```

If you want to avoid generating fresh data while capturing, pre-stage the runs and only capture read-only screens.

---

## 13. Capture workflow suggestion

### Option A — capture during a live demo run
Pros:
- authentic
- dynamic
- impressive

Cons:
- timing-sensitive
- more risk of noisy output

### Option B — capture after pre-staging the state
Pros:
- clean
- controllable
- repeatable

Cons:
- slightly less “live” feeling

### Recommended approach
Use a hybrid:
- capture `/rorca-help`, `/rorca-mcp-status`, and `/rorca-status` from pre-staged state
- capture at least one real `/rorca-forge-run` or `/rorca-run --story` live
- capture watch mode from a real active run if possible

---

## 14. Naming and file organization

Suggested screenshot filenames:

```text
01-rorca-help.png
02-rorca-forge-run.png
03-rorca-single-story-run.png
04-rorca-watch-widget.png
05-rorca-mcp-status.png
06-rorca-status.png
```

Suggested folder:

```text
packages/rorca-pi-extension/marketing/screenshots/
```

If you do not want these in git yet, keep them outside the repo until needed.

---

## 15. Post-capture polish checklist

After capturing:

- [ ] crop consistently
- [ ] ensure text is readable at smaller sizes
- [ ] verify no secrets remain visible
- [ ] verify command names are current
- [ ] verify captions match what is actually shown
- [ ] ensure screenshot order tells a coherent story

---

## 16. Recommended alt text drafts

### Screenshot 1 alt text
Pi session showing the Rorca extension help command and the available slash commands.

### Screenshot 2 alt text
Pi session showing a forge-and-run command that generates a Rorca spec and triggers a run.

### Screenshot 3 alt text
Pi session showing a single-story Rorca run using the `--story` flag.

### Screenshot 4 alt text
Pi session showing a live Rorca run watch widget with story statuses.

### Screenshot 5 alt text
Pi session showing MCP bridge health and the number of registered Rorca tools.

### Screenshot 6 alt text
Pi session showing Rorca run status or recent run history.

---

## 17. Final reminder

The best screenshot set makes the extension feel:
- understandable
- credible
- operational
- useful on day one

Do not optimize for visual flash.
Optimize for clarity and trust.
