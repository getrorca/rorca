# @rorca/capture

Standalone API-only context capture sidecar for Rorca.

- Product requirements: [`../../docs/prds/rorca-context-capture-sidecar/PRD.md`](../../docs/prds/rorca-context-capture-sidecar/PRD.md)
- Architecture contract: [`../../docs/rorca-capture-sidecar-contract.md`](../../docs/rorca-capture-sidecar-contract.md)
- Operator rollout guide: [`../../docs/rorca-capture-sidecar-operator-guide.md`](../../docs/rorca-capture-sidecar-operator-guide.md)

The implementation owner is the `rorca-capture` binary. `rorca capture ...` is only a thin compatibility alias that shells out to this package.

## Commands

```sh
rorca-capture --help
rorca-capture setup --always-on --policy metadata-only
rorca-capture status
rorca-capture pause
rorca-capture resume
rorca-capture service install --workspace rorca
rorca-capture emit shell --workspace rorca --policy metadata-only --phase end --command "git status" --exit-code 0
rorca-capture remember "Prefer API-only capture writes" --category Decision --files docs/notes.md
rorca-capture ingest-commit HEAD
rorca-capture ingest-git --since origin/main
rorca-capture ingest-git --since last-rorca-run --json
rorca-capture ingest-pr --ci --json --provider github --repo owner/repo --pr-number 42 --merge-sha <sha> --changed-files src/app.ts --ci-run-id $GITHUB_RUN_ID
rorca-capture install-hooks
rorca-capture install-hooks --strict       # explicit blocking mode
rorca-capture install-hooks --uninstall    # restore any preserved prior hook
rorca-capture daemon --scan-once --workspace rorca --max-commits-per-scan 25
rorca-capture daemon --status --workspace rorca --json
rorca-capture daemon --stop --workspace rorca
rorca-capture daemon
```

`remember` creates a pending memory candidate through `POST /api/memory/candidates` by default. `--approve` only promotes after submission when `operatorAutoApprove` (or `RORCA_CAPTURE_OPERATOR_AUTO_APPROVE=true`) is explicitly enabled.

`ingest-commit` normalizes one git commit into a `git_commit` context event. `ingest-git --since <ref>` scans `<ref>..HEAD` oldest-first; `--since last-rorca-run` resolves the latest completed Rorca pipeline run pointer from the API. Add `--dry-run` to inspect without API writes or queue changes.

`ingest-pr` is the non-interactive CI/PR merge mode. It accepts metadata from flags, a JSON file (`--input`/`--json-file`), or environment variables (`RORCA_PR_*`, GitHub Actions, GitLab CI, Azure DevOps), with precedence `flags > JSON > env`. Submissions create pending memory candidates through `POST /api/memory/candidates`, include merge SHA, PR URL/number, repo/provider, author/title/body, changed files, CI run metadata, deterministic UUIDv5 idempotency from `mergeSha:ciRunId`, and exit `2` for duplicate/idempotent PR submissions.

`install-hooks` installs a managed `.git/hooks/post-commit` wrapper in the resolved Rorca workspace path. It preserves an existing hook as `post-commit.pre-rorca`, chains it before capture, and marks the wrapper with `# RORCA MANAGED HOOK` plus `# RORCA_PREV_HOOK:` metadata. Default hooks are best-effort and append `|| true` to the capture command so Rorca outages never block commits. `--strict` removes that fallback and prints an install-time warning. `--uninstall` removes the managed wrapper and restores the preserved prior hook when present.

`daemon` reconciles local git commits from `$HOME/.rorca/capture-cursor-<workspaceId>.json`, writes status/PID heartbeats under `$HOME/.rorca/` plus a workspace-local monitoring mirror at `.rorca/capture/status.json`, flushes the JSONL queue after `GET /api/health` succeeds, and backs off exponentially on repeated API errors. Use `--dry-run` to scan without network calls, queue writes, or cursor advancement.

`setup --always-on` requires an explicit policy. `metadata-only` is the production default and retains hashes/timing/source identity without command summaries, commit subjects, output, or transcripts. `repo-and-command` is an explicit opt-in for redacted summaries; `full` permits only explicitly supplied bounded session summaries. Setup writes only Rorca-managed reversible shell/IDE/agent/service artifacts, persists policy through `/api/context-capture`, and reuses this package's existing daemon rather than installing a second capture implementation. Use `pause`, `resume`, `teardown [--all]`, and `service <install|start|stop|restart|status|uninstall>` as operator controls.

All Rorca writes go through stable `x-rorca-public-api: true` routes with `Authorization: Bearer $(cat ~/.rorca/mcp-token)`. Hook files reference the token path at runtime and never embed token values. This package must not read `DATABASE_URL`, connect directly to PostgreSQL, or write Rorca DB tables outside the public API contract.
