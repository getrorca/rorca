# OVH path-only GitHub webhook ingress (deployment artifact)

**Review/runbook only. No DNS, VPS, GitHub, Traefik, service, database, or deployment change is authorized by this file.** Apply only after this change is merged and a human grants explicit deployment authority.

Target design:

- DNS name: `hooks.rorca.ai`
- Intended DNS A target: `15.204.89.98` (documented only; do not mutate DNS here)
- Public surface: **only** `POST /api/webhooks/github`
- Private upstream: Rorca backend port 3030
- Artifact: `deploy/ovh/github-webhook-traefik.dynamic.yml`
- TLS: Traefik ACME resolver named `letsencrypt`
- Request body ceiling: 1 MiB at Traefik and Express

The current VPS checkout was reported at `9c0ed311d29f8e19fd2f1a744dec2d0538b5279b`. Back it up and upgrade it only after merge and explicit deployment authorization. Never patch that checkout in place from this worktree.

## Preflight after authorization

1. Snapshot/backup the current VPS checkout, deployment config, Traefik dynamic config, certificate storage, and environment (without copying secret values into logs).
2. Confirm the merged commit includes the migration and that the normal migration backup/rollback procedure is approved. Do not touch `pgboss.*`.
3. Confirm Traefik and the Rorca backend share a private network where `rorca-backend:3030` resolves; otherwise replace only the artifact's private service URL with the approved internal address.
4. Confirm `hooks.rorca.ai` resolves to `15.204.89.98`; this runbook does not authorize changing it.
5. Confirm ports 80/443, ACME challenge, and the `letsencrypt` resolver are configured. TLS must validate for `hooks.rorca.ai`; do not allow insecure webhook TLS.
6. Set `RORCA_GITHUB_WEBHOOK_URL=https://hooks.rorca.ai/api/webhooks/github`. Keep the App webhook secret only in the encrypted integration vault.

## Path isolation checks

Before GitHub configuration, verify externally:

```bash
# Exact path reaches Rorca but an unsigned request is rejected.
curl -i -X POST https://hooks.rorca.ai/api/webhooks/github \
  -H 'content-type: application/json' --data '{}'
# Expected: 401/400, never 2xx.

# Every other API path must be absent at this host.
curl -i https://hooks.rorca.ai/api/health/live
curl -i https://hooks.rorca.ai/api/workspaces
curl -i https://hooks.rorca.ai/api/docs/openapi.json
# Expected: Traefik 404, never a Rorca response.
```

Check the certificate SAN/issuer and HTTPS redirect on the exact path. Do not expose a catch-all host router, dashboard, `/api`, health, docs, MCP, static UI, or backend port.

## HMAC and identity validation

A healthy ingress is not a healthy webhook. Rorca accepts a delivery only when all are true:

- raw body is at most 1 MiB;
- event is `ping`, `push`, or `pull_request`;
- `X-GitHub-Delivery` is present and atomically unclaimed;
- `X-Hub-Signature-256` matches the vaulted App webhook secret;
- payload installation id, repository id, repository owner id/login, and owner/name match one active immutable workspace binding.

After explicit GitHub authorization, use GitHub's signed delivery/redelivery UI. Confirm one success, `lastWebhookAt`, and one deduplicated redelivery. Never use a fabricated unsigned request as proof. Confirm unsupported events, bad signatures, wrong installation/repository ids, and oversized bodies are rejected without WAL/domain side effects.

Private backend health can be checked from the VPS/network with `/api/health/live`; it is used by the Traefik service health check but must not be publicly routed.

## Rollback

1. Disable/remove only the `rorca-github-webhook-*` dynamic config and reload Traefik.
2. Confirm `hooks.rorca.ai` returns no route for all paths.
3. Leave App bindings disabled/invalid rather than deleting audit history; do not enable broad ambient fallback.
4. Restore the backed-up deployment checkout/config only under the approved rollback procedure. Database migration rollback requires a separate reviewed data-preservation plan; do not drop tables ad hoc.
5. DNS rollback, if ever needed, is a separately authorized operator action.

Rollback of ingress does not authorize policy changes, merges, deployment, GitHub App uninstall, secret rotation, or database mutation.
