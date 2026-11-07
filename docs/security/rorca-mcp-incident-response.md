# Rorca MCP Incident Response

This runbook covers MCP token compromise, suspicious tool usage, and tier-boundary failures for Project Aegis.

## Detection

Primary signal source: `mcp_audit_log`

Schema:
- `ts` — event timestamp
- `tool_name`
- `token_tier` — `public` or `admin`
- `remote_addr`
- `session_id`
- `params_hash`
- `success`
- `error_code`
- `duration_ms`

Immediate indicators of compromise:
- admin-token activity from an unexpected `remote_addr`
- repeated `MCP_AUTH_INVALID` or `MCP_AUTH_INSUFFICIENT_TIER`
- unexpected calls to `rorca_admin_mcp_audit` or `rorca_admin_mcp_audit_summary`
- sudden spikes in `rorca_pipeline_trigger` or `rorca_specs_generate`

Quick checks:

```sql
SELECT ts, tool_name, token_tier, remote_addr, session_id, success, error_code
FROM mcp_audit_log
ORDER BY ts DESC
LIMIT 100;
```

```sql
SELECT remote_addr, COUNT(*) AS failures
FROM mcp_audit_log
WHERE ts >= NOW() - INTERVAL '15 minutes'
  AND error_code IN ('MCP_AUTH_REQUIRED', 'MCP_AUTH_INVALID', 'MCP_AUTH_INSUFFICIENT_TIER')
GROUP BY remote_addr
ORDER BY failures DESC;
```

## Rotation Procedure

1. Determine scope: public token only, admin token only, or both.
2. Rotate immediately:

```bash
rorca mcp rotate-token --public
rorca mcp rotate-token --admin
rorca mcp rotate-token --all
```

3. Re-link affected clients:

```bash
rorca mcp setup-claude
rorca mcp setup-claude --admin
```

4. Verify token files still have mode `0600`:

```bash
stat -f '%Sp %N' ~/.rorca/mcp-token ~/.rorca/mcp-admin-token
```

Expected disruption window:
- New MCP requests using the old token fail immediately after rotation.
- Existing browser UI traffic is unaffected because `/api/*` does not use MCP Bearer tokens.
- MCP clients usually recover as soon as they reconnect with the new token.

## Forensics Queries

Recent admin-tier activity:

```sql
SELECT ts, tool_name, remote_addr, session_id, success, error_code, duration_ms
FROM mcp_audit_log
WHERE token_tier = 'admin'
ORDER BY ts DESC
LIMIT 200;
```

Tool-specific timeline:

```sql
SELECT ts, token_tier, remote_addr, session_id, success, error_code
FROM mcp_audit_log
WHERE tool_name = 'rorca_pipeline_trigger'
ORDER BY ts DESC
LIMIT 200;
```

Suspicious high-volume callers:

```sql
SELECT remote_addr, tool_name, COUNT(*) AS call_count
FROM mcp_audit_log
WHERE ts >= NOW() - INTERVAL '1 hour'
GROUP BY remote_addr, tool_name
HAVING COUNT(*) > 25
ORDER BY call_count DESC, remote_addr ASC, tool_name ASC;
```

Auth failure storm:

```sql
SELECT remote_addr, COUNT(*) AS failure_count
FROM mcp_audit_log
WHERE ts >= NOW() - INTERVAL '5 minutes'
  AND error_code IN ('MCP_AUTH_REQUIRED', 'MCP_AUTH_INVALID', 'MCP_AUTH_INSUFFICIENT_TIER')
GROUP BY remote_addr
HAVING COUNT(*) > 10
ORDER BY failure_count DESC;
```

Anomaly patterns to watch:
- public token suddenly probing admin-only tools
- new remote address paired with a previously unseen admin session
- high failure rate followed by a successful admin call
- repeated low-latency calls across many tools from one session ID

## Disclosure Template

Use this if a token leak or confirmed unauthorized MCP access affects users:

```text
Subject: Rorca MCP token rotation notice

We detected suspicious activity affecting the local MCP authentication surface.

What happened:
- [brief timeline]

What was affected:
- [public token | admin token | both]
- [known impacted tools or “no confirmed admin-tool execution”]

What we did:
- Rotated the affected token(s)
- Reviewed recent `mcp_audit_log` activity
- Re-validated MCP tier boundaries and localhost protections

What you should do:
- Re-run `rorca mcp setup-claude` (or `--admin` if applicable)
- Verify `~/.rorca/mcp-token` and `~/.rorca/mcp-admin-token` permissions are `0600`
- Report any unexpected MCP client behavior immediately
```

## Verification Notes

Source-backed exposure counts verified on May 3, 2026 from the current checkout startup logs on `127.0.0.1:3140`:
- `423` OpenAPI operations total
- `28` public, `15` auth, `25` paid, `12` admin, `343` denied
- `44` MCP-exposed tools total: `27` public, `15` auth, `2` explicit admin overrides

There is currently no `npm run lint:mcp` script in the repo. The equivalent verification used for this documentation update was:
- `npm run lint:tier`
- backend startup exposure log: `[Rorca Tier] MCP exposure: 44 tools (public + auth only)`
- source-backed count check via `tsx` one-liners against `src/lib/swagger.ts` and `src/lib/mcp-http.ts`

Observed lint caveat on May 3, 2026:
- `npm run lint:tier` currently fails with a stale expected baseline: it still expects `10` admin routes, but the checkout contains `12`, and it still treats `GET /api/admin/mcp-audit` plus `GET /api/admin/mcp-audit/summary` as unexpected admin annotations.
- The same lint run reports `43` MCP tools for `public + auth` only; the extra `2` admin MCP overrides are counted separately by the source-backed `getMcpToolDefinitions()` catalog, bringing the full MCP-exposed total to `44`.

HTTP smoke checks captured against the source server on `127.0.0.1:3140`:

Missing token:

```bash
curl -sS -H 'Origin: http://localhost:3030' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}' \
  http://127.0.0.1:3140/mcp
```

Observed: `401` with `MCP_AUTH_REQUIRED`

Invalid token:

```bash
curl -sS -H 'Origin: http://localhost:3030' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer forged.invalid.token' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":5,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}' \
  http://127.0.0.1:3140/mcp
```

Observed: `401` with `MCP_AUTH_INVALID`

Valid public token:

```bash
curl -sS -D - \
  -H 'Origin: http://localhost:3030' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $(cat ~/.rorca/mcp-token)" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}' \
  http://127.0.0.1:3140/mcp
```

Observed: `200` and `Mcp-Session-Id` response header present

Public token against admin tool:

```bash
SID='<session id from initialize response>'
curl -sS \
  -H 'Origin: http://localhost:3030' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $(cat ~/.rorca/mcp-token)" \
  -H "Mcp-Session-Id: $SID" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"rorca_admin_mcp_audit","arguments":{}}}' \
  http://127.0.0.1:3140/mcp
```

Observed: `403` with `MCP_AUTH_INSUFFICIENT_TIER`

Disallowed browser origin preflight:

```bash
curl -sS -D - -X OPTIONS \
  -H 'Origin: http://evil.com' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,authorization' \
  http://127.0.0.1:3140/mcp
```

Observed: `204` from the global CORS middleware with `Access-Control-Allow-Origin: http://localhost:5210`, which still causes browser preflight failure because the origin does not match. This is browser-protective behavior, but it is not a JSON `403`, so future CORS changes should be reviewed carefully.
