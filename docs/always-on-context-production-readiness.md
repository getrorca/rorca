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

### Managed schedule (supported local production scope)

macOS launchd is the supported scheduler. Review the deterministic artifact in
a disposable directory first; `render` never loads or signals a job:

```bash
review_dir="$(mktemp -d)"
node scripts/manage-always-on-monitor.mjs render \
  --workspace-id <id> --root "$PWD" --plist-dir "$review_dir"
plutil -lint "$review_dir"/*.plist
```

Operator installation and reversal are explicit:

```bash
node scripts/manage-always-on-monitor.mjs install --workspace-id <id> --root "$PWD"
node scripts/manage-always-on-monitor.mjs status --workspace-id <id> --root "$PWD"
node scripts/manage-always-on-monitor.mjs uninstall --workspace-id <id> --root "$PWD"
```

Installation is idempotent: it atomically replaces and reloads only
`com.rorca.monitor.<checkout>.<workspace>`. Uninstall refuses an unowned plist,
unloads only that exact label, and retains status, alert, and historical log
files as operator evidence. The schedule runs at login and every 300 seconds.
It does not restart or signal backend, worker, capture, or execution processes.
The API URL is restricted to loopback HTTP.

Each run atomically writes mode-0600
`.rorca/services/always-on-monitor-status.json`, appends one count/status-only
record to `always-on-monitor.ndjson`, and runs managed log retention. A missing,
invalid, timed-out, or unreachable dependency is degraded/unknown rather than
implicitly healthy. There is no managed `--allow-degraded` override.

### Alert sink contract

The built-in sink is `local-file` only. It writes mode-0600 transition/reminder
events to `.rorca/services/always-on-alerts.ndjson`; `none` is available for an
operator's diagnostic invocation. External email/chat/webhook delivery is not
implemented and must be a separate reviewed adapter consuming this v1 record:

```json
{
  "schemaVersion": 1,
  "kind": "rorca.always_on.health",
  "observedAt": "ISO-8601",
  "state": "healthy|degraded",
  "previousState": "healthy|degraded|unknown",
  "severity": "critical|recovery",
  "reasonCodes": ["classified_code_only"],
  "counts": {
    "localQueueDepth": 0,
    "captureQueueDepth": 0,
    "captureFailed": 0,
    "distillationQueueDepth": 0,
    "distillationFailed": 0,
    "activeDistillationErrors": 0,
    "logRotationBlocked": 0
  }
}
```

No monitor output or alert may contain captured payloads, prompts, command text,
file content, secrets/tokens, connection strings, raw provider/database errors,
URLs, paths, process arguments, or arbitrary upstream reason strings. Unknown
upstream data is collapsed to a classified reason code. Do not ship local files
externally without an explicit telemetry/security decision.

For macOS login/reboot validation, also follow
[Always-On Login Readiness](./always-on-login-readiness.md). For backend/worker
ownership and graceful takeover, follow
[Local managed backend and worker](./local-managed-services.md).

## Explicit local-production SLOs

| Surface | Objective | Alert / fail-closed rule |
| --- | --- | --- |
| Process liveness | `GET /api/health/live` returns 200 without dependency, filesystem, or executable probes | Any failed local supervisor probe is critical. |
| Readiness and restart gate | `GET /api/health` and `/api/health/ready` make a decision within the coded 750 ms deadline and confirm `db_connected` plus an integer `active_runs` | Timeout/error returns 503, `readiness.confirmed=false`, and `active_runs=null`; unknown is never treated as zero. |
| Monitor schedule | One status observation every 300 s; status age no more than 600 s (one missed interval) | Missing/stale/invalid local status is critical and fail-closed. |
| Capture/queue | Local and pg-boss queue depths return to zero within two scan intervals; failed count remains zero; oldest pending remains below 300 s | Any failed job is critical. Non-zero depth after two intervals is warning; oldest pending >=300 s or local depth >= `queueWarnSize` is critical. |
| Freshness | `last_seen` within three configured scans (minimum 180 s); worker heartbeat within 90 s; `lastFlush` advances within the same threshold whenever local queue depth is non-zero | Stale service plus manager not running is critical; stale flush with pending work is critical. |
| Distillation/audit privacy | Active distillation errors remain zero; accepted historical errors are advisory; emitted records remain count/status-only | Any active error is critical. Any forbidden field/value in monitor/alert output is a privacy incident: pause capture and preserve classified evidence. |
| Logs | At each 300 s maintenance boundary each managed active log is <=10 MiB plus writes since the boundary; <=7 archives per log; archives <=14 days | Rotation journal/block/symlink refusal is critical. Capacity planning assumes at most 80 MiB per stream (active burst plus seven 10 MiB archives). |

SLOs apply to the supported single-user local production scope; they do not
claim internet-scale availability. Alert reminders are at most once per 15
minutes while degraded, plus state transitions and recovery.

## Bounded log rotation and retention

The managed monitor applies retention only to the known backend, worker,
capture, and monitor stdout/stderr paths. It snapshots one oldest chunk of at
most 10 MiB, fsyncs and atomically publishes the archive, then compacts the same
inode so launchd-held descriptors remain valid. A first pass repeats bounded
chunks until a historical active file is within the limit. Writes observed after the snapshot are
preserved as the new active tail. A mode-0600 per-log journal records
`copying`/`archived`; after a crash, an incomplete copy is discarded without
truncation, while a published archive is completed before another rotation.
Symlinks/non-regular files and invalid journals fail closed and are never
truncated. Retention pruning runs even when the active file is below threshold.

Do not manually rename/delete managed live logs. Review status and stop the
read-only monitor schedule before forensic copying. The Wave 1 validation used
only disposable temporary logs; it did not rotate current live files.

## Failure triage

1. **Protect active work.** Confirm `/api/health` returns
   `readiness.confirmed: true` and integer `active_runs: 0` before any
   backend/worker restart. `null`, missing, timeout, 503, or malformed data is a
   hard refusal. Never force-kill an execution engine.
2. **Capture daemon:** inspect `rorca-capture service status`,
   `.rorca/capture/service.log`, and the already-redacted offline queue. Restart
   only through `rorca-capture service restart`.
3. **Worker/pg-boss:** verify a fresh `worker_heartbeat`; inspect failed job
   metadata by job id. Do not delete `pgboss.*` rows or hand-edit its schema.
4. **Distillation errors:** preserve the immutable `context_events` row. Fix the
   processor/schema first. Replay only through a reviewed canonical queue path;
   do not set `distillation_status` to success by hand.
5. **Log retention:** if `log_retention_blocked`, stop automatic remediation,
   inspect only file type/mode/size and the classified rotation journal stage,
   then preserve archives. Never delete the active file or bypass a symlink/
   invalid-journal refusal.
6. **Monitor schedule:** inspect `manage-always-on-monitor.mjs status`, local
   status age, and classified reason codes. Render/review before reinstalling;
   uninstall does not erase evidence.
7. **Privacy anomaly:** pause capture first, preserve count-only evidence, then
   inspect policy/source configuration locally. Never paste queue payloads,
   command text, raw errors, paths, or secrets into tickets/alerts.

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

Migration `20260715130000_always_on_context_mainline_reconciliation.sql` extends
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
