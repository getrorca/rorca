# Rorca private operator deployment guide

Rorca OSS is a local, single-operator application. It does not ship a hosted multi-user login/token flow. The supported Compose topology keeps the API/UI private with `AUTH_REQUIRED=false`. Provider-neutral local review bundles are the default delivery path and require no public ingress, GitHub, PAT, webhook, remote account, or network provider. If the legacy optional GitHub-specific surfaces are explicitly configured, only the signed webhook callback may be exposed publicly through the reviewed exact-path ingress; this does not constitute a provider-neutral `GitHubDeliveryAdapter`.

## Supported topology

- API and static UI: `127.0.0.1:3030` by default (`RORCA_BIND_ADDRESS` / `RORCA_PORT`). Use SSH or another operator-controlled private access path when administering a remote host.
- PostgreSQL 16: private Compose network only.
- Worker: private Compose network only.
- Public ingress, when explicitly authorized: exact `Host(hooks.rorca.ai) && Path(/api/webhooks/github) && Method(POST)` with the 1 MiB request bound in `deploy/ovh/github-webhook-traefik.dynamic.yml`.
- No public router for the ordinary UI, API, health endpoints, or webhook administration routes.

Do not set `AUTH_REQUIRED=true`: no production browser login flow is provided. Do not change the loopback bind to `0.0.0.0` or attach the ordinary service to a broad Traefik router.

## Configure

```bash
cp deploy/env.production.example .env
```

Required local secrets:

- `JWT_SECRET`: strong independent value used for encryption/signing internals; it does not enable a login flow.
- `RORCA_INTERNAL_SERVICE_TOKEN`: independent unpredictable server↔worker credential of at least 32 bytes. A separately deployed Hermes process must receive this exact value as its `RORCA_API_TOKEN`; Hermes sends it only as a Bearer credential with `X-Rorca-Service: hermes`. Do not use a browser JWT, MCP token, provider token, or a second independently generated value for that service link.
- `RORCA_DISPATCH_RECEIVER_TOKEN`: a second, independently generated credential of at least 32 bytes for the receiving transport only. The receiver uses it as Bearer together with `X-Rorca-Service: dispatch-receiver` and `X-Rorca-Receiver-Id: rorca-dispatch-receiver`; generic internal credentials are rejected on that endpoint.
- `RORCA_OPERATOR_CAPABILITY_SHA256`: SHA-256 digest only. Keep the preimage outside env files, browser storage, URLs, logs, the repository, and the database.
- Four independent PostgreSQL passwords and three explicit application URLs from `deploy/env.production.example`. `db-role-bootstrap` receives the offline bootstrap credential and creates/reasserts distinct constrained migration-owner, runtime, and canonical-writer roles. `db-migrate` alone receives the owner URL; API receives runtime+writer; worker receives runtime only. Do not reuse or collapse these identities.

Keep:

```dotenv
AUTH_REQUIRED=false
RORCA_BIND_ADDRESS=127.0.0.1
RORCA_PORT=3030
CORS_ORIGIN=http://127.0.0.1:3030
RORCA_BASE_URL=http://127.0.0.1:3030
RORCA_EXPERIMENTAL_WAVE_PARALLEL=false
```

Generate secrets outside shell history where practical. Capability or provider credential generation/rotation is a separately authorized operator procedure.

## Static review before startup

The normal release checks must pass before an authorized deployment:

- root/backend TypeScript and affected tests;
- tier, OpenAPI placeholder/MCP, Swagger, contract 9.0.0, license, YAML/Compose, and migration checks;
- PostgreSQL image policy: no seed/dump/archive in Git or build contexts, extensions-only init, exact AGE package pin, and no application migration touching `pgboss.*`;
- exact OVH webhook host/path/method/body-limit rules;
- built-Linux sandbox/egress probe.

This guide does not authorize image builds, container starts, database access, provider calls, deployment, DNS/OVH/Coolify changes, or policy activation.

## Authorized Compose startup

Only after the relevant operator authorizes deployment:

```bash
docker compose build
docker compose up -d
```

The canonical root Compose file has no public Traefik router and binds the UI/API to loopback. The OVH overlay only adds the private upstream alias used by the separate exact-path dynamic configuration.

## Local delivery (default)

Local review bundles are written under the local Rorca data directory (override with `RORCA_DELIVERY_ARTIFACT_ROOT`) and are canonicalized in PostgreSQL. Keep that directory on a private local filesystem with normal backup/retention controls. Bundle creation is a CSRF-protected human-admin operation; safe reads expose hashes and integrity only. It grants no merge or deployment authority and opens no network listener.

## Optional GitHub operator ceremony

Read-only Settings > GitHub views work while provider changes are locked. For an intentional provider/release-authority mutation:

1. Open the private local UI.
2. Enter the capability preimage in **Provider changes lock**.
3. Perform the intended operation.
4. Explicitly lock the capability afterward.

The preimage is memory-only and is cleared on navigation, sign-out, rejection/configuration errors, or explicit lock. Missing or wrong capability produces an actionable fail-closed UI. It is never provided to autonomous children.

See `docs/operations/github-app-setup.md` for App setup/binding and exact repository authority.

## Database initialization, split principals, upgrades, and backups

A fresh PostgreSQL image initializes only `vector`, `age`, and `pgcrypto`. The one-shot `db-role-bootstrap` service then creates three mutually non-member, login-capable, non-superuser roles and transfers database ownership to the migration role. The one-shot `db-migrate` service is the only application image given `RORCA_MIGRATION_DATABASE_URL`; it applies Rorca migrations and installs/upgrades the pg-boss-owned schema before exiting successfully. API/worker receive only runtime `DATABASE_URL` plus `RORCA_MIGRATIONS_PREAPPLIED=true` and `RORCA_PGBOSS_PREAPPLIED=true`; both boundaries fail closed instead of attempting owner DDL. Only API additionally receives `RORCA_CANONICAL_WRITER_DATABASE_URL` for governed canonical transitions; worker receives neither owner nor writer credentials. Worker startup creates required queues through the narrowly granted pg-boss functions, not schema migration authority. No seed or backup is restored automatically.

For a **pre-split existing Compose volume**, stop API/worker and back up the database first. Keep the old database owner as `RORCA_POSTGRES_BOOTSTRAP_USER` for the upgrade ceremony, start only `db`, run the one-shot `db-role-bootstrap`, then pipe `docker/postgres/upgrade-split-owner.sql` into `psql` as that old owner with exact `previous_owner` and `migration_user` variables. The script transfers only Rorca application objects and leaves extension ownership offline. Inspect ownership and role attributes before running `db-migrate` and starting API/worker. Example shape (replace identities; do not paste secrets into shell history):

```bash
docker compose up -d db
docker compose run --rm db-role-bootstrap
# Export PGPASSWORD from an operator-controlled secret input (not a literal):
docker compose exec -T -e PGPASSWORD db psql -U OLD_OWNER -d rorca \
  -v previous_owner=OLD_OWNER -v migration_user=rorca_migrator \
  < docker/postgres/upgrade-split-owner.sql
docker compose run --rm db-migrate
```

The ownership transfer and Wave 2 migrations are forward-only: rollback means restoring the pre-upgrade database snapshot and old application together; never point an old runtime at the upgraded canonical schema or collapse credentials to simulate rollback.

The opt-in empty-volume proof is `scripts/wave2-compose-empty-volume-smoke.sh`. It requires `RORCA_WAVE2_COMPOSE_SMOKE=I_ACKNOWLEDGE_INVOCATION_OWNED_EMPTY_VOLUME`, creates a unique Compose project and volume, checks startup/migrations/principal attributes and memberships, proves runtime direct canonical DML denial, and always removes its owned volume. It is destructive only to that generated project and is not deployment authority.

Store database backups outside the repository and every Docker build context. Never commit raw or compressed exports. See `docs/security/database-export-incident-response.md` for containment, Git-history truth, and separately authorized credential rotation.

## Required staging evidence

Source/static checks are not runtime proof. Before production enablement, separately authorized staging must still prove:

1. a genuinely fresh PostgreSQL 16 cluster contains only extensions, application migrations, and pg-boss bootstrap state—no user/workspace/run/integration seed rows;
2. dirty migration and pg-boss runtime behavior;
3. built-Linux bubblewrap/model-egress behavior under the target kernel/seccomp/AppArmor/capability posture;
4. live GitHub Manifest/token/webhook/ref/PR/Check/branch-protection races;
5. deployed OVH exact-path isolation.

Do not claim these staging results from source-only validation.
