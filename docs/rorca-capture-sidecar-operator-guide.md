# Rorca Capture Sidecar Operator Guide

Use this guide to roll out the standalone `rorca-capture` sidecar in local, VM/server-daemon, and CI modes.

## Security and API contract

The sidecar is **API-only**:

- It uses only stable Rorca routes marked `x-rorca-public-api: true` and `x-rorca-tier: public` in Swagger/OpenAPI.
- It never reads `DATABASE_URL`, imports `pg`, creates a PostgreSQL pool, or writes directly to Rorca DB tables.
- Direct DB writes for capture events, memory candidates, queue state, workspaces, WAL records, or approvals are explicitly out of contract.
- Public contract snapshots live in `docs/openapi-public-snapshot.json` and `docs/OPEN_API_CONTRACT.md`; after changing stable endpoints run `npm run build:contract` and `npm run check:contract`.

Stable sidecar/operator endpoints:

| Purpose | Stable endpoint |
| --- | --- |
| API readiness / queue flush gate | `GET /api/health` |
| Resolve local repo to workspace | `GET /api/workspaces` |
| Submit git/daemon context events | `POST /api/context-events` |
| Submit manual/PR/DuckBrain memory candidates | `POST /api/memory/candidates` |
| Optional operator-approved promotion | `POST /api/memory/candidates/{id}/approve` |
| Review queue listing/detail | `GET /api/context-candidates`, `GET /api/context-candidates/{id}` |
| Retrieval-safe candidates | `GET /api/context-candidates/retrieval` |
| Last completed Rorca run pointer | `GET /api/workspaces/{workspaceId}/capture/last-rorca-run` |
| VM/server worker liveness | `GET /api/pipeline/worker/health` |

MCP Bearer-token auth uses `~/.rorca/mcp-token` with POSIX mode `0600`. Set it up for Claude Code CLI with:

```sh
rorca mcp setup-claude
chmod 600 ~/.rorca/mcp-token
```

Rotate the token with:

```sh
rorca mcp rotate-token
chmod 600 ~/.rorca/mcp-token
```

Do not configure this sidecar through Claude Desktop; OAuth 2.1/PKCE for Claude Desktop is not implemented yet.

## Install and build

From the Rorca repo:

```sh
npm install
npm run build
node packages/rorca-capture/dist/cli.js --help
```

During development you can use either the standalone binary source or the root compatibility alias:

```sh
npx tsx packages/rorca-capture/src/cli.ts status --api-url http://localhost:3030 --workspace rorca
rorca capture status --api-url http://localhost:3030 --workspace rorca
```

`rorca capture ...` is only a thin shell-out alias to `packages/rorca-capture`; it must not reimplement behavior or write to the DB.

## Local workstation mode

Use local mode when the repository, Rorca API, and operator are on the same workstation.

1. Start Rorca:

```sh
npm run dev
curl -s http://localhost:3030/api/health | jq .
```

2. Configure capture in the repo:

```sh
mkdir -p .rorca
cat > .rorca/capture.json <<'JSON'
{
  "apiUrl": "http://localhost:3030",
  "workspaceId": "rorca",
  "mode": "local",
  "queuePath": ".rorca-capture-queue.jsonl",
  "operatorAutoApprove": false,
  "ignore": {
    "paths": ["node_modules/**", "dist/**", "coverage/**"],
    "maxFileBytes": 262144,
    "maxEventBytes": 1048576
  },
  "redaction": {
    "enabled": true,
    "replacement": "[REDACTED]"
  }
}
JSON
```

3. Verify status and submit a pending note:

```sh
rorca-capture status --workspace rorca --api-url http://localhost:3030
rorca-capture remember "Use stable public APIs for sidecar writes" \
  --category Decision \
  --title "Sidecar API boundary" \
  --files docs/rorca-capture-sidecar-operator-guide.md \
  --workspace rorca \
  --api-url http://localhost:3030
```

4. Install the opt-in post-commit hook if desired:

```sh
rorca-capture install-hooks --workspace rorca --api-url http://localhost:3030
# Blocking mode, only when you intentionally want commits to fail on capture failures:
rorca-capture install-hooks --strict --workspace rorca --api-url http://localhost:3030
# Remove managed hook and restore any prior hook:
rorca-capture install-hooks --uninstall --workspace rorca
```

The managed hook contains `# RORCA MANAGED HOOK`, preserves an existing hook as `post-commit.pre-rorca`, reads the token path at runtime, and never embeds token values.

## VM/server daemon mode

Use daemon mode when Rorca and the repo live on a long-running VM or server.

1. Run the API and worker:

```sh
npm run dev:server
npm run dev:worker
# production-style worker command from the backend package is also valid:
(cd backend && npm run worker)
```

2. Confirm process and worker health. A worker heartbeat is stale when `worker_heartbeat.last_seen` is older than 90 seconds.

```sh
curl -s http://localhost:3030/api/health | jq .
curl -s http://localhost:3030/api/pipeline/worker/health | jq '{workerActive, workerPid, queueHealth, queueDepth}'
```

3. Configure VM mode:

```sh
mkdir -p .rorca
cat > .rorca/capture.json <<'JSON'
{
  "apiUrl": "http://localhost:3030",
  "workspaceId": "rorca",
  "mode": "vm",
  "queuePath": ".rorca-capture-queue.jsonl",
  "operatorAutoApprove": false
}
JSON
```

4. Scan once, then run the daemon:

```sh
rorca-capture daemon --scan-once --workspace rorca --api-url http://localhost:3030 --max-commits-per-scan 25
rorca-capture daemon --workspace rorca --api-url http://localhost:3030 --interval 30 --max-commits-per-scan 50
```

5. Inspect and stop daemon state:

```sh
rorca-capture daemon --status --workspace rorca --json | jq .
rorca-capture daemon --stop --workspace rorca
```

Daemon cursor, PID, and status files live under `$HOME/.rorca/` with mode `0600`. The daemon checks `GET /api/health` before submitting or flushing and backs off on repeated API failures.

## CI mode

Use CI mode for PR merge/release/hotfix capture. CI mode is non-interactive: missing `RORCA_API_URL`, workspace, repo, or PR metadata fails fast.

For ephemeral CI where the worker may not always be needed, start it as optional:

```sh
RORCA_OPTIONAL_WORKER=true npm run dev:worker:optional
```

GitHub Actions example:

```yaml
name: rorca-capture
on:
  pull_request:
    types: [closed]

jobs:
  capture:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    env:
      RORCA_API_URL: http://localhost:3030
      RORCA_WORKSPACE_ID: rorca
      RORCA_OPTIONAL_WORKER: "true"
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run build
      - name: Configure MCP token
        run: |
          mkdir -p ~/.rorca
          printf '%s\n' "$RORCA_MCP_TOKEN" > ~/.rorca/mcp-token
          chmod 600 ~/.rorca/mcp-token
        env:
          RORCA_MCP_TOKEN: ${{ secrets.RORCA_MCP_TOKEN }}
      - name: Capture merged PR as a pending candidate
        run: |
          rorca-capture ingest-pr --ci --json \
            --provider github \
            --repo "${{ github.repository }}" \
            --pr-number "${{ github.event.pull_request.number }}" \
            --pr-url "${{ github.event.pull_request.html_url }}" \
            --merge-sha "${{ github.event.pull_request.merge_commit_sha }}" \
            --ci-run-id "${{ github.run_id }}" \
            --ci-run-url "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}" \
            --workspace "$RORCA_WORKSPACE_ID" \
            --api-url "$RORCA_API_URL"
```

If the API is temporarily unavailable and queueing is enabled, replay later with:

```sh
rorca-capture flush --workspace rorca --api-url http://localhost:3030
rorca-capture flush --force --workspace rorca --api-url http://localhost:3030
```

`flush` removes only successfully submitted entries from `.rorca-capture-queue.jsonl`; failed retryable entries remain with sanitized `lastError`, attempt count, and retry timing.

## Review workflow and retrieval gating

Capture creates **pending** candidates. Pending candidates are not promoted to durable Rorca memory and are not returned by retrieval-safe candidate reads by default.

List pending candidates for review:

```sh
curl -s -H "Authorization: Bearer $(cat ~/.rorca/mcp-token)" \
  "http://localhost:3030/api/context-candidates?workspaceId=rorca&status=pending" | jq .
```

Retrieve only safe candidates for context injection:

```sh
curl -s -H "Authorization: Bearer $(cat ~/.rorca/mcp-token)" \
  "http://localhost:3030/api/context-candidates/retrieval?workspaceId=rorca&minConfidence=medium" | jq .
```

`GET /api/context-candidates/retrieval` defaults to:

```text
review_status NOT IN ('pending', 'rejected')
AND confidence >= minConfidence
AND (regulated_domain = false OR review_status = 'approved')
```

Only use `includeUnsafe=true` in explicit review tools, never for default agent context injection.

Approve a candidate only after operator review:

```sh
curl -s -X POST -H "Authorization: Bearer $(cat ~/.rorca/mcp-token)" \
  -H "Content-Type: application/json" \
  -d '{"workspaceId":"rorca","reviewer":"local-operator"}' \
  "http://localhost:3030/api/memory/candidates/123/approve" | jq .
```

Regulated-domain candidates are detected with `backend/src/lib/context-safety.ts` patterns (HIPAA/PHI, PCI/cardholder data, privacy/PII, SOX/FINRA/GLBA/FedRAMP/ITAR/EAR). They require explicit confirmation:

```sh
curl -s -X POST -H "Authorization: Bearer $(cat ~/.rorca/mcp-token)" \
  -H "Content-Type: application/json" \
  -d '{"workspaceId":"rorca","reviewer":"local-operator","regulatedReviewConfirmed":true}' \
  "http://localhost:3030/api/memory/candidates/123/approve" | jq .
```

`rorca-capture remember --approve` is rejected unless `operatorAutoApprove` or `RORCA_CAPTURE_OPERATOR_AUTO_APPROVE=true` is explicitly configured.

## Secret redaction and safety filters

The canonical redaction, path filtering, size limits, and regulated-domain checks live in `backend/src/lib/context-safety.ts`; `packages/rorca-capture/src/context-safety.ts` mirrors the contract so the sidecar remains standalone.

Before data is queued or transmitted, the sidecar applies:

- default ignores such as `.git/**`, `node_modules/**`, build outputs, `.env*`, `*.pem`, `*.key`, and local capture queues;
- max file size `256 KiB` and max event size `1 MiB` unless overridden;
- redaction for Bearer tokens, API-key assignments, GitHub tokens, OpenAI keys, database URLs, AWS access keys, JWTs, and private-key blocks;
- absolute path redaction in queue payloads and errors.

Add repo-specific excludes in `.rorca-captureignore`:

```gitignore
secrets/**
fixtures/private/**
*.local.json
```

## Migration from legacy aliases or Pi slash commands

- Current `rorca capture ...` is a compatibility alias in `cli.js` that shells out to `packages/rorca-capture` (`dist/cli.js` when built, otherwise `src/cli.ts`). It does not write to Rorca DB tables.
- Prefer the standalone command in automation: `rorca-capture <command> ...`.
- If you maintain an older Pi slash command or shell alias that writes directly to a DB table, imports `pg`, reads `DATABASE_URL`, or calls a route that is not `x-rorca-public-api: true`, replace it with `rorca-capture` or with the stable endpoints listed above.
- Direct DB writes and non-public/admin/paid endpoints are out of contract and must not be used by sidecar integrations.

## Troubleshooting

| Symptom | Check | Fix |
| --- | --- | --- |
| `AUTH_ERROR` or missing token | `ls -l ~/.rorca/mcp-token` | Run `rorca mcp setup-claude`; ensure `chmod 600 ~/.rorca/mcp-token`. |
| API unreachable | `curl -s http://localhost:3030/api/health` | Start Rorca with `npm run dev` or `npm run dev:server`; verify `RORCA_API_URL`. |
| Workspace not found | `rorca-capture status --json --workspace rorca` | Register the repo in Rorca or set `RORCA_WORKSPACE_ID`/`--workspace`. |
| Worker stale on VM/server | `curl -s http://localhost:3030/api/pipeline/worker/health | jq .` | Start `npm run dev:worker` or `(cd backend && npm run worker)`; stale means `last_seen` > 90s. |
| Queue not draining | `rorca-capture status --json`, then `rorca-capture flush --force` | Fix API/token errors first; non-retryable 4xx entries stay until forced. |
| Hook blocks commits | Inspect `.git/hooks/post-commit` for `# RORCA MANAGED HOOK` | Reinstall without `--strict` or run `rorca-capture install-hooks --uninstall`. |
| Regulated candidate will not approve | Candidate has `regulatedDomain=true` and `requiresReview=true` | Re-review content and include `regulatedReviewConfirmed:true` only when policy allows. |
| Secrets in local payloads | Inspect `.rorca-captureignore` and redaction config | Add ignore/redaction patterns; defaults come from `backend/src/lib/context-safety.ts`. |
