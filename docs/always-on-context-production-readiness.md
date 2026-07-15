# Always-On Context production readiness

This runbook is the production/operator companion to
[Universal Context Capture](./universal-context-capture.md). The accepted default
remains `metadata-only`; see
[Always-On Capture Policy Baseline](./always-on-capture-policy-decision.md).

## One-command monitoring

```bash
cd /path/to/workspace
node scripts/monitor-always-on-context.mjs \
  --workspace-id <workspace-id> \
  --root "$PWD"
```

The check is read-only and exits non-zero when degraded. Use `--json` for an
agent/cron payload and `--allow-degraded` only for diagnostics where the caller
must not fail. It combines:

- `.rorca/capture/status.json`: daemon process state, offline queue depth,
  backoff, `last_seen`, `lastFlush`, policy, pause state, and source capability;
- `GET /api/context-capture/{workspaceId}/monitoring`: pg-boss capture and
  distillation queue states, failed jobs, persisted distillation outcomes,
  audit/redaction counters, and worker heartbeat;
- macOS launchd state for `com.rorca.backend.<checkout>`,
  `com.rorca.worker.<checkout>`, and `com.rorca.capture.<workspace-id>`.

The endpoint defaults to a 24-hour failed-job/audit window and accepts
`windowHours=1..720`. It returns aggregate counts and classified distillation
errors only. Persisted distillation outcomes report `errors` (all preserved
error evidence), `activeErrors` (page/degrade), and
`acceptedHistoricalErrors` (advisory only). It never returns captured payloads,
command text, raw provider errors, tokens, or redacted secret values.

### Alert policy

| Signal | Warning | Critical / page | Recovery check |
| --- | --- | --- | --- |
| Offline daemon queue | Any sustained non-zero depth | Depth reaches `queueWarnSize` or `queueMaxSize`; oldest work does not drain | API is reachable, `backoffMs=0`, queue decreases, `lastFlush` advances |
| pg-boss `context:capture` / `context:distill` | Depth remains non-zero for two scan intervals | Any failed job in the selected window, or oldest pending exceeds five minutes | Worker heartbeat fresh; failed count stops growing; queue reaches zero |
| `last_seen` | Older than three configured scan intervals (minimum 180s) | Service manager says not running or status is missing/invalid | `last_seen` advances after service restart |
| `lastFlush` | Old while offline queue is non-zero | Queue non-zero and flush age exceeds freshness threshold | Flush advances and both local/API queue depths fall |
| Persisted distillation | Any new active `distillation_status=error`; accepted historical count is advisory | `activeErrors` grows after deployment or affects explicit memory events | Fix schema/processor, then use a reviewed replay; do not rewrite event evidence |
| Audit/redaction | Unexpected zero audit events during known activity | Redaction/regulated counts spike unexpectedly or raw-content policy changes | Pause capture, inspect aggregate audit plus local policy, correct source/policy |
| Managed services | Loaded but stopped during an intentional handoff | Backend/worker/capture not running outside a documented maintenance gate | `scripts/verify-always-on-login-readiness.mjs` and monitor both pass |

Suggested cron (every five minutes):

```cron
*/5 * * * * cd /path/to/workspace && /absolute/path/to/node scripts/monitor-always-on-context.mjs --workspace-id <id> --root "$PWD" --json >> .rorca/services/always-on-monitor.ndjson 2>&1
```

Keep the file workspace-local, rotate it, and do not ship it externally without
an explicit telemetry decision. For macOS login/reboot validation, also follow
[Always-On Login Readiness](./always-on-login-readiness.md). For backend/worker
ownership and graceful takeover, follow
[Local managed backend and worker](./local-managed-services.md).

## Failure triage

1. **Protect active work.** Confirm `/api/health` reports `active_runs: 0`
   before any backend/worker restart. Never force-kill an execution engine.
2. **Capture daemon:** inspect `rorca-capture service status`,
   `.rorca/capture/service.log`, and the already-redacted offline queue. Restart
   only through `rorca-capture service restart`.
3. **Worker/pg-boss:** verify a fresh `worker_heartbeat`; inspect failed job
   metadata by job id. Do not delete `pgboss.*` rows or hand-edit its schema.
4. **Distillation errors:** preserve the immutable `context_events` row. Fix the
   processor/schema first. Replay only through a reviewed canonical queue path;
   do not set `distillation_status` to success by hand.
5. **Privacy anomaly:** pause capture first, preserve count-only evidence, then
   inspect policy/source configuration. Never paste queue payloads into tickets.

## Optional adapter validation and behavior

| Adapter | Production behavior | Validation | Expected degradation |
| --- | --- | --- | --- |
| VS Code-compatible | Uses stable extension-host APIs for workspace/file/diagnostic metadata and explicit remember commands. Workspace Trust disables submissions in untrusted workspaces. Proprietary chat panes are never scraped. | `npx tsc -p packages/rorca-pi-extension/vscode-extension/tsconfig.json --noEmit` and its Vitest suite; package metadata/host-detection tests cover VS Code, VSCodium, Cursor, and Windsurf compatibility rules. | Missing extension host is `degraded`, not failed, while repo daemon/git hook/shell remain active. Cursor/Windsurf chat remains unavailable unless the vendor exposes a hook/export/API. |
| Pi | Generated `.pi/extensions/rorca/capture-command.json` exposes `/rorca-remember` and routes explicit summaries through CLI/API with `source_system`, `tool_name`, and `session_id`. No direct DB writes. | Pi compatibility E2E plus JSON inspection; token artifact stores only `~/.rorca/mcp-token`, never token bytes. | If the alias is unavailable, use `rorca-capture remember`; repo/shell/git capture continues. |
| Codex | Generated wrapper passes arguments unchanged, preserves native exit status, emits only policy-allowed lifecycle metadata, then submits an explicit session-end summary. | `bash -n`, bootstrap wrapper tests, and a fake native binary exit-code test. | Native binary absent returns `127` and documents shell/explicit-memory fallback. It is optional and must not make setup fail. |
| OpenCode | Same pass-through/exit-code contract as Codex, with OpenCode source identity and selected capture policy propagated into lifecycle emits. | `bash -n`, bootstrap wrapper tests, and a fake native binary exit-code test. | Native binary absent returns `127`; shell/git/repo and explicit remember remain available. |

Generated adapter JSON is configuration, not proof that a native host is
installed. Report both artifact status and host status. Never install an editor
extension or invoke a real provider session in unattended production validation
without operator approval.

## Mainline/brownfield candidate compatibility

Migration `20260714150000_always_on_context_mainline_reconciliation.sql` extends
the canonical CCS `context_events` and `memory_candidates` ledgers additively.
It does **not** add a second `status`, `category`, `content`, or candidate
`payload` model. Distillation/import writes populate canonical
`suggested_category`, `title`, `rule`, `context`, and `review_status` fields;
approval continues through the existing candidate promotion path.

The migration adds only operational envelope, distillation, provenance,
dedupe/import, policy, and count-only audit fields/tables. It never touches
`pgboss.*`; the worker creates `context:capture` and `context:distill` through
`boss.createQueue()` before send/work registration. It leaves historic events,
candidates, and distillation errors unchanged.

External-import dedupe excludes import time: repeated identical exports remain
idempotent, while changed content under the same vendor/original id may stage a
new pending candidate. Pending/imported/distilled candidates are not durable
memory and do not enter default retrieval until canonical approval/promotion.

Monitoring retains one narrow advisory classification for the pre-reconciliation
missing-`payload` error produced by the divergent UCC branch. It is advisory
only when the exact error predates recorded migration `20260714150000` and the
reconciled `memory_candidates.dedupe_key` column exists. Every different or
post-migration error remains active. Never mass-update, delete, or mark historic
errors successful; replay only through a separately reviewed repair path.
