<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
-->

# Decision Record: Always-On Capture Policy Baseline

**Status:** Accepted — 2026-07-14
**Owners:** Local Rorca operator and Rorca maintainers
**Applies to:** Every workspace using `rorca-capture`

## Decision

Rorca's production default and the active policy for this workspace are
**`metadata-only`**. Do not escalate a workspace automatically based on a
source becoming available, a model request, or an agent configuration.

`metadata-only` is useful without retaining developer-authored command text:
it records bounded, local repository/event identity such as source, timestamp,
workspace hash, Git object identity, command hash, exit code, duration, and
redaction diagnostics. Commit subjects and command summaries are omitted. Raw
TTY streams, stdout/stderr, shell history, environment values, clipboard data,
provider credentials, editor keystrokes, proprietary chat panes, and raw
transcripts are not captured.

All capture continues through the local API and canonical
`backend/src/lib/context-safety.ts` redaction/size/ignore controls. Pending
capture records remain reviewable evidence; capture does not make text
retrieval-visible by itself.

## Mode assessment

| Mode | Captured automatically | Security and privacy posture | Production decision |
| --- | --- | --- | --- |
| `off` | Nothing is submitted; local emitters should not spool new events. | Strongest privacy boundary; use for sensitive, incident, or untrusted workspaces. | Supported. |
| `metadata-only` | Bounded source/repo identity, hashes, timing, exit status, and redaction/ignore counts. No command summary or commit subject. | Lowest useful retention. Hashes still identify repeated activity, so data remains local operator data. | **Default and active.** |
| `repo-and-command` | Metadata-only plus redacted commit subjects and redacted command summaries. No raw output or terminal stream. | Command lines and commit text can include customer names, URLs, file names, inline secrets, and regulated identifiers. Regex redaction reduces—not eliminates—risk. Offline queues can retain these redacted summaries. | Available only by deliberate workspace opt-in. |
| `ide-assisted` | `repo-and-command` scope plus standard VS Code-compatible API events where the extension host is available. | Adds file/diagnostic/selection metadata and expands the accidental disclosure surface. It cannot read proprietary chat panes or keystrokes. | Experimental; do not select as a default. |
| `full` | Reserved for explicitly supplied, bounded session summaries/imports. It is **not** authorization for background raw terminal, editor, or provider transcript collection. | Raw transcript inputs are difficult to redact reliably and may include secrets, PII, legal data, and third-party content. | Not enabled for automatic capture; requires a separately reviewed source-specific implementation and operator action. |

### Why not escalate now

There is no evidence that broader automatic capture is necessary for the
current service: metadata-only already provides repo daemon, git-hook, shell,
agent-adapter, and explicit-memory provenance while keeping the stored event
surface small. Current redaction is deterministic and bounded, but it is not a
complete data-loss-prevention system; it cannot establish that an arbitrary
command, commit message, or transcript contains no sensitive information.
That is insufficient evidence to make command summaries, IDE events, or raw
transcripts the default.

## Explicit `repo-and-command` opt-in

An operator who has reviewed the repository's data classification,
`.rorca-captureignore`, installed shell/agent integrations, and local-retention
requirements may opt in per workspace:

```bash
# This is an intentional policy change. It updates only Rorca-managed artifacts.
rorca-capture setup --always-on --policy repo-and-command --workspace-id <workspace-id>
rorca-capture service restart --workspace-id <workspace-id>
rorca-capture status --workspace-id <workspace-id>
```

Confirm the final status reports `policyMode: "repo-and-command"`,
`paused: false`, a running managed service, and expected active integrations
before relying on summary capture. Re-running setup updates only artifacts with
the Rorca-managed sentinel; non-managed files are left untouched and reported
as degraded.

The opt-in is reversible:

```bash
# Return to the default policy.
rorca-capture setup --always-on --policy metadata-only --workspace-id <workspace-id>
rorca-capture service restart --workspace-id <workspace-id>

# Or immediately stop submissions; uninstall is available if capture must be removed.
rorca-capture pause --workspace-id <workspace-id>
rorca-capture uninstall --all --workspace-id <workspace-id>
```

Before enabling `repo-and-command`, add workspace-specific sensitive paths to
`.rorca-captureignore`, verify that generated shell snippets and pass-through
agent wrappers carry the selected policy, and understand that redacted offline
queue entries are still sensitive local data. Do not use this mode to capture
password prompts, `.env` files, keys, unredacted build logs, or proprietary AI
chat content.

## Operational checks and review triggers

- `rorca-capture status --workspace-id <workspace-id>` and Settings → Workspace
  Context → Capture Status are the authoritative operator surfaces. They show
  the persisted policy, pause state, queue depth, integrations, and redaction
  diagnostics without echoing secret values.
- If status, local `policy.json`/`sidecar.json`, and generated managed snippets
  disagree, pause capture and rerun explicit setup rather than assuming a
  broader mode took effect.
- Escalation beyond `metadata-only` requires a documented workspace reason,
  review of local retention and ignore rules, and a post-change status check.
- Any redaction miss, unexpected content, queue retention concern, or
  unavailable source requires pausing capture and returning to
  `metadata-only` or `off` while the issue is investigated.
- A future request for automatic transcript capture needs a separate security
  review, source-specific consent design, retention/deletion implementation,
  adversarial redaction evaluation, and explicit production-readiness decision.
