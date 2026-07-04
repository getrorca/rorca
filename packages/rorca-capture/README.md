# @rorca/capture

Standalone API-only context capture sidecar for Rorca.

- Product requirements: [`../../docs/prds/rorca-context-capture-sidecar/PRD.md`](../../docs/prds/rorca-context-capture-sidecar/PRD.md)
- Architecture contract: [`../../docs/rorca-capture-sidecar-contract.md`](../../docs/rorca-capture-sidecar-contract.md)

The implementation owner is the `rorca-capture` binary. `rorca capture ...` is only a thin compatibility alias that shells out to this package.

## Commands

```sh
rorca-capture --help
rorca-capture status
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

`daemon` reconciles local git commits from `$HOME/.rorca/capture-cursor-<workspaceId>.json`, writes status/PID heartbeats under `$HOME/.rorca/`, flushes the JSONL queue after `GET /api/health` succeeds, and backs off exponentially on repeated API errors. Use `--dry-run` to scan without network calls, queue writes, or cursor advancement.

All Rorca writes go through `POST /api/...` with `Authorization: Bearer $(cat ~/.rorca/mcp-token)`. Hook files reference the token path at runtime and never embed token values. This package must not read `DATABASE_URL` or connect directly to PostgreSQL.
