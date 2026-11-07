# Open-Source Publication Plan — Rorca

Status: draft for execution
Created: 2026-11-04
Destination: `github.com/getrorca/rorca` (repo exists, currently **PRIVATE**, `main`, last push 2026-08-20)
Working remote: Forgejo (`forgejo-vps.tail7a4b39.ts.net/rorca/rorca`)
Scope exclusions: **Supabase/BYOP setup verification is deferred to the final phase** (Phase 8). Everything else is in scope.

Priority order (as directed): **security leaks first, then setup correctness, then publication mechanics.**

---

## Verified baseline (2026-11-04)

| Fact | Value | Source |
|---|---|---|
| Tracked files | 3,627 | `git ls-files` |
| `.git` size | 1.3 GB | `du -sh .git` |
| Stale `github/*` refs | 475 | `git branch -r` |
| Commits in history | 5,757 | gitleaks scan |
| History secret findings | 4 (2 files) | `/tmp/gl-history.json` |
| Worktree secret findings | 48, **1** in a tracked path (placeholder `XXXX` in a build cache) | `/tmp/gl-worktree.json` |
| License | Apache-2.0 declared, **5,142 B / 61 lines** vs canonical 11,358 B / 202 lines | `LICENSE` vs apache.org |
| GitHub license detection | **NOASSERTION** | `gh api repos/getrorca/rorca` |
| GitHub Actions | none (9 workflows deleted in `54f4b11c6`, 2026-08-17) | `git log --diff-filter=D` |
| GitHub vs local | local is **148 commits ahead** of `github/main` | `git rev-list --left-right --count github/main...HEAD` |
| Stale open PRs on GitHub | 5 (#2 draft, #3, #6, #21, #30) | `gh pr list` |
| Missing SPDX headers | 34 files | `npm run check:licenses` → exit 1 |
| OpenCore boundary (candidate) | 111 shareable / 6 review / 32 blocked / 212 unknown of 361 | `npm run split:check -- --candidate` → exit 1 |
| Typecheck | **passes** after `npm install` | `npm run typecheck` → exit 0 |
| Frontend tests | **128 files / 1,370 tests pass** | `npx vitest run` → exit 0 |
| Migrations on disk | 385 | `ls backend/src/db/pg-migrations/*.sql` |
| Docker DB applied migrations | 380, last `20260824120400_...` | `public.schema_migrations` @5432 |
| Native DB applied migrations | 353 | `public.schema_migrations` @5433 |
| Historical pipeline success | 20 done / 325 runs (6%) | `rorca.pipeline_runs` |
| Last successful run | 2026-09-29 | `rorca.pipeline_runs` |
| Stuck queued runs | 2, 63 days old (ids 20260316000291, 20260316000324) | `rorca.pipeline_runs` |

---

## Phase 1 — Security: secrets (BLOCKER)

### 1.1 Revoke the Resend credential
- [ ] Revoke `RESEND_API_KEY` (`re_…`, 36 chars) in the Resend dashboard and issue a replacement **only if** the landing page later needs it.
- [ ] Record the revocation date in the publication evidence file.
- Rationale: the key is dead code inside Rorca (nothing imports `backend/src/lib/email.ts`) but it is a **live credential at Resend**, leaked in commit `99018930` (2026-05-28).

### 1.2 Choose and execute a history policy
Recommendation: **squash to a fresh initial commit** rather than `filter-repo`.
- [ ] Confirm decision (squash vs rewrite)
- [ ] `git checkout --orphan public-main && git add -A && git commit` from the final cleaned tree
- [ ] Verify new history: `gitleaks detect --source . --log-opts="--all"` → **0 findings**
- [ ] Verify size drop (expect << 1.3 GB) and that no `github/*` / `origin/*` stale refs survive
- Why squash: eliminates the leaked key, the 1.3 GB history, the 475 dead refs, the `.pi-supervisor` transcripts, and the committed third-party source trees in one operation.

### 1.3 Remove the dead email surface
- [ ] Delete `backend/src/lib/email.ts`
- [ ] Delete `backend/src/lib/__tests__/email-security.test.ts`
- [ ] Drop `resend@^6.12.2` and `nodemailer@9.0.3` from `backend/package.json`
- [ ] Remove `SMTP_*`, `RESEND_API_KEY`, `RORCA_EMAIL_FROM` block from `.env.example:135-143`
- [ ] `cd backend && npm install` and re-run `npm test -- email` to confirm no dangling references
- Evidence: 0 callers of `sendVerificationEmail`, `sendPasswordResetEmail`, `sendRunCompleteEmail`; sole consumer of `sendTeamInviteEmail` is the test itself.

### 1.4 Re-scan and gate
- [ ] Worktree scan: `gitleaks detect --source . --no-git` → 0 findings in tracked paths
- [ ] History scan → 0 findings
- [ ] Review `.gitleaks.toml` allowlist — the `paths` allowlist is broad (`\.md$`, `docs/.*`, `tests?/.*`); confirm it cannot mask a real leak in `docs/`
- [ ] Add the secret scan to the restored GitHub CI as a **required** check

### 1.5 Personal-data sweep in tracked files
- [ ] 155 tracked files reference the author's home path / username (mostly `.pi-supervisor` archives and progress docs) — resolved by 3.1 + squash
- [ ] 37 tracked files reference private project names (`categoric`) — decide per file whether it is OSS-appropriate
- [ ] Tailnet/internal hostname leak: 1 file (`backend/src/lib/__tests__/forgejo-authority-provider-adapter.test.ts`) — scrub or accept as a fixture

**Exit criteria:** 0 secret findings in history and worktree; no live credential reachable from the published tree.

---

## Phase 2 — License integrity (BLOCKER)

### 2.1 Verbatim license
- [ ] Replace `LICENSE` with the byte-exact Apache-2.0 text from `https://www.apache.org/licenses/LICENSE-2.0.txt`
- [ ] Add `NOTICE` (or extend `LICENSE-NOTICES.md`) with the copyright holder line
- [ ] Verify: `diff <(curl -s https://www.apache.org/licenses/LICENSE-2.0.txt) LICENSE` → empty
- Current defect: Section 3 drops the patent-termination clause, 4(d) drops the NOTICE-reading requirement, and the APPENDIX is absent.

### 2.2 Per-file headers
- [ ] Add SPDX headers to the 34 files `npm run check:licenses` reports (mostly `backend/src/lib/eco-*.ts`, `backend/src/routes/eco-provider.ts`)
- [ ] `npm run check:licenses` → exit 0
- [ ] Confirm `package.json` `"license": "Apache-2.0"` and every workspace package

### 2.3 Confirm GitHub detection
- [ ] After the first push, `gh api repos/getrorca/rorca --jq .license.spdx_id` → `Apache-2.0` (currently `NOASSERTION`)

---

## Phase 3 — Repository content hygiene (BLOCKER)

`.gitignore` never retroactively untracks. Each item below is evaluated as *ship / delete / move*.

### 3.1 Untrack local state and build artifacts
| Path | Tracked files | Action |
|---|---|---|
| `.pi-supervisor/` | 158 | **delete** — local agent session transcripts and autopilot archives |
| `backend/node-compile-cache/` | 116 | **delete** — V8 cache; one file matches a private-key pattern |
| `tmp/` | 8 | **delete** — includes `tmp/official-hermes-native-approval-source/` and `tmp/native-target-delivery-source/`, third-party source trees (attribution problem, not clutter) |
| `MEMORY.md` | 1 | **delete** — internal engineering memory ledger; already in `.gitignore` |
| `state/`, `dist/`, `node_modules/` | 0 | already untracked, keep it that way |

- [ ] `git rm -r --cached` the four paths above, then `git rm -r` them from the tree
- [ ] Add `.pi-supervisor/`, `tmp/`, `backend/node-compile-cache/` to `.gitignore`
- [ ] Re-run the tracked-junk inventory to prove 0

### 3.2 Decide internal working material (not automatic deletes)
- [ ] `forge/` — 143 tracked files, Rorca's own spec corpus. **Recommendation:** ship a curated subset (approved specs only) and drop `forge/specs/logs/` (prompt logs and run logs).
- [ ] `docs/` — 160 tracked files have no boundary rule. **Recommendation:** ship all except `docs/implementation/evidence/`, `docs/workplans/`, `docs/qa/evidence/`, and `docs/archive/` which are author-side validation packets.
- [ ] Root `*.md` progress ledgers (`.wave2-*-progress.md`, `.always-on-*-progress.md`, etc.) — **delete** before publication.

**Exit criteria:** no local transcripts, caches, third-party sources, or personal ledgers in the published tree.

---

## Phase 4 — OpenCore boundary (BLOCKER for `split:check`)

### 4.1 Resolve the decision the manifest already encodes
`docs/SECURITY-MODEL.md` states the Apache-2.0 repo **must not** ship hosted identity (Supabase auth, GitHub web sign-in), billing, subscriptions, seat limits, or hosted entitlements — those belong in `rorca-opencore`.

Current tree state: the identity surface is already OSS-shaped —
- `src/lib/supabase.ts` is a 20-line no-op stub (no credentials, no network)
- `src/contexts/AuthContext.tsx` documents itself as "local single-user auth state for the OSS edition"
- `authRequired` is deliberately disabled in `backend/src/server.ts`
- `backend/src/lib/email.ts` (hosted email) was dead code → removed in Phase 1.3

- [ ] **Decision A — identity:** confirm OSS ships the local stubs and `rorca-opencore` never exists in public. (Recommended; matches `SECURITY-MODEL.md` and requires no extraction.)
- [ ] **Decision B — entitlements:** 17 `paid`-tier and 232 `admin`-tier routes exist. The GTM spec (`forge/specs/approved/rorca-go-to-market-v1.json` US-006) prices "full pipeline execution" at Pro $15/mo, which contradicts SECURITY-MODEL.md. Choose: pipeline free in OSS / paywall moves to OpenCore / paywall stays but is documented as a hosted-service gate.
- [ ] **Decision C — `rorca-opencore`:** `scripts/sync-opencore-push.mjs` targets `../rorca-opencore`, which **does not exist**. Either create it or retire the sync script from the public tree.

### 4.2 Make the boundary gate green
- [ ] Extend `config/open-core-boundaries.json` so the 212 unknown candidate paths and the 160 unknown `docs/` paths have explicit rules
- [ ] `npm run split:check -- --candidate --report-review-boundary` → exit 0
- [ ] Record the review-set (6 files) disposition in the plan evidence

---

## Phase 5 — CI/CD on GitHub (BLOCKER: public repo must have working checks)

### 5.1 Restore workflows
9 workflows exist at `54f4b11c6^`:
`ci.yml`, `contract-check.yml`, `license-check.yml`, `secret-scan.yml`, `smoke-test.yml`, `release.yml`, `always-on-packaging-platform.yml`, `publish-vscode.yml`, `wave-qualification.yml`

- [ ] Restore each to `.github/workflows/`
- [ ] `ci.yml` was `ubuntu-latest` × 7 jobs — verify no self-hosted labels and no Forgejo-only assumptions (`.forgejo/` runners use `ci-amd64` and `[macos, arm64]`, which do not exist on GitHub)
- [ ] `wave-qualification.yml` / `always-on-packaging-platform.yml`: decide ship or drop (they may encode internal evidence paths)
- [ ] Add required status checks on `main`
- [ ] Keep `.forgejo/workflows/` for the private working remote; confirm the two sets do not contradict

### 5.2 Release pipeline (currently broken for users)
`scripts/install.sh:9` and `scripts/install.ps1:7` point at `getrorca/rorca` GitHub Releases, and there are **no releases** — `curl | sh` 404s today.
- [ ] Restore/repair `release.yml` (US-012): build 4 platform binaries on `v*` tag, publish assets
- [ ] Cut a test tag, verify `scripts/install.sh` succeeds on macOS arm64
- [ ] Verify `bin/rorca.js` bundled CLI matches the released binary

### 5.3 Repository settings
- [ ] `CODEOWNERS` currently `* @sysgazer` — keep or broaden
- [ ] Add a `SECURITY.md` reporting path that works (`security@rorca.app` is claimed — verify the mailbox)
- [ ] Issue templates: none exist; add bug/feature templates or state that Discussions is the channel

---

## Phase 6 — Database setup verification: native + Docker (Supabase deferred)

**Answer to "do you need env vars in Supabase to test this out?" — No.**
BYOP sends nothing to Supabase-specific code. The only inputs are:
1. a `postgres://…?sslmode=require` connection string (direct port 5432, not the 6543 pooler),
2. the `vector` extension installed on that database,
3. SSL not disabled — `sslmode=disable` is rejected by `validateByopConnection`.

Rorca persists it to `~/.rorca/database-url` (mode `0600`) and shows host/db redacted. There are **no `SUPABASE_*` variables to set**; the only `SUPABASE_SERVICE_ROLE_KEY` string in the codebase is in the sandbox env-strip list (`backend/src/lib/autonomous-command-guard.ts`), not something a user configures. Supabase setup remains deferred as instructed, but the BYOP **code path** can be tested without a Supabase account (see 6.3).

### 6.1 What each mode requires

| Mode | DB target | Principals required | Extensions | Expected graph |
|---|---|---|---|---|
| native | Postgres 16 on `localhost:5433` | `rorca_runtime`, `rorca_canonical` (migration owner, `authenticated`, `anon`) | `vector` required, `age` optional | Full Graph if AGE present, else Lite |
| docker | `rorca db start` builds AGE image on `:5432` | provisioned by `docker/postgres/bootstrap-roles.sh` (bootstrap / migration / runtime / canonical writer) | `age`, `vector`, `pgcrypto` | Full Graph |
| byop | any reachable Postgres with SSL | runtime principal as above | `vector` required, `age` optional | Lite unless AGE |

### 6.2 Test matrix to execute now (native + docker)

For each cell: fresh database, run the onboarding path, assert `/api/health`.

| # | Scenario | Setup | Assertions |
|---|---|---|---|
| N1 | native, fresh DB, no AGE | `createdb` on 5433, `RORCA_DB_MODE=native` | `dbMode=native`, `graphMode=lite`, `pgvectorReady=true`, migration count = 385 |
| N2 | native, AGE present | 5433 already has `age` | `graphMode=full`, graph read/write smoke succeeds |
| N3 | native, missing principals | drop `rorca_runtime` | **must fail with an actionable message**, not a raw `42501` (currently a raw PL/pgSQL error — file a fix) |
| N4 | native, pgvector missing | drop `vector` | rejection names `CREATE EXTENSION IF NOT EXISTS vector;` |
| D1 | docker, fresh volume | `rorca db reset` then `rorca db start` | roles exist, `age`/`vector`/`pgcrypto` present, `graphMode=full` |
| D2 | docker, existing volume behind head | current 5432 (380 applied) | migrations 381–385 apply cleanly, no manual step |
| D3 | mode switch native → docker | wizard switch | `~/.rorca/database-url` cleared, health reflects docker |
| D4 | docker down | `rorca db stop` | health degrades with a named fix path, no crash loop |
| B1 | byop validation rejections (no Supabase) | see 6.3 | `sslmode=disable` rejected; missing pgvector rejected; bad host rejected |

### 6.3 Testing BYOP without a Supabase account
- [ ] Spin a local Postgres 16 with TLS + pgvector in Docker and point the BYOP field at it — this exercises `validateByopConnection`, the `0600` persistence path, redaction, and Graph Lite fallback exactly as Supabase would.
- [ ] Assert the stored URL is `0600` and that `/api/health` never echoes credentials.
- [ ] Keep the real Supabase run for Phase 8.

### 6.4 Known drift to fix during Phase 6
- Native DB at 5433 is at **353** applied vs 385 on disk (32 behind) and lacks the `rorca_migration` role.
- Docker DB at 5432 is at **380** applied (5 behind).
- An unconfigured checkout fails startup with a raw `registered Wave 2 runtime principal is required` (42501) and "HTTP listener not opened" — no guidance. **Fix: a startup preflight that checks `RORCA_RUNTIME_DATABASE_USER` / `DATABASE_URL` and prints the exact remediation.**
- 2 pipeline runs stuck in `queued` for 63 days; run logs referenced by DB rows are missing on disk.

### 6.5 Acceptance harness (new deliverable)
- [ ] `scripts/verify-db-modes.mjs` — provisions a disposable DB per mode, boots the backend on an ephemeral port, asserts the `/api/health` contract (`dbMode`, `graphMode`, `pgvectorReady`, `capabilities`), tears down, and writes a JSON report. Wiring it into CI makes mode coverage permanent instead of manual.

---

## Phase 7 — Certification and publication

- [ ] Clean tree, exact SHA, no untracked scratch
- [ ] Gate 0 (`--phase gate0`) on the candidate: capability classification, static/OpenAPI/MCP/license/OpenCore gates, builds, live Hermes↔Rorca pair
- [ ] Gate 1 (`--phase gate1`): clean exact pair + real-platform boundaries manifest + broad classified corpus
- [ ] Sync `github/main` to the certified SHA (148 commits behind today)
- [ ] Close or port the 5 stale GitHub PRs (#2, #3, #6, #21, #30)
- [ ] Flip repository visibility to public
- [ ] Post-flip verification: `gh api repos/getrorca/rorca --jq .license.spdx_id` = `Apache-2.0`; first contributor PR triggers the restored checks; `curl -fsSL …/install.sh | sh` works

---

## Phase 8 — Supabase / BYOP end-to-end (deferred, last)

- [ ] Create/choose a Supabase project
- [ ] `CREATE EXTENSION IF NOT EXISTS vector;`
- [ ] Copy the direct connection string (port 5432, `sslmode=require`)
- [ ] Run the BYOP wizard path, confirm `graphMode=lite` and `pgvectorReady=true`
- [ ] Confirm redaction in UI, API, and logs; confirm `~/.rorca/database-url` is `0600`
- [ ] Document the Graph Lite expectation (already in `docs/supabase-setup.md`)

---

## Verification log

### 2026-11-04 — Phase 1.3 + 2.1 (dependency + license change)

Commands run and observed results:

| Check | Command | Result |
|---|---|---|
| Install tree valid after `npm uninstall resend` | `cd backend && npm ls --depth=0` | no `invalid` / `missing` / `UNMET` entries — clean tree |
| Removed dep no longer resolves | `cd backend && node -e "require.resolve('resend')"` | **exit 1**, `MODULE_NOT_FOUND` |
| Removed dep absent from tree | `cd backend && npm ls resend` | **exit 1**, `└── (empty)` |
| Import smoke (module graph loads) | `cd backend && npx tsx -e "import('./src/lib/index.ts')…"` | **exit 0**, `OK lib barrel imported, exports: 83` |
| Project check (whole backend, incl. dependency type resolution) | `cd backend && npx tsc --noEmit` | **exit 0** |
| Backend lint | `cd backend && npm run lint` | **exit 1** — 7 pre-existing unused-var errors in `server.ts`, `worker.ts`, `worker-supervisor.ts` (files untouched by this change) |
| Dependency-pin test | `cd backend && npx jest src/__tests__/security-dependency-regression.test.ts` | **blocked before running**: `[test-db-safety] Jest requires a nonce-scoped invocation owner; direct/fixed database fallback is forbidden` |
| License text integrity | `diff <(curl -s https://www.apache.org/licenses/LICENSE-2.0.txt) LICENSE` | **empty** — byte-identical, 202 lines / 11,358 bytes |

### Open items raised by this verification

- [ ] `backend/src/__tests__/security-dependency-regression.test.ts` pins `nodemailer 9.0.1` while `backend/package.json` declares `9.0.3` — the test cannot be run directly (nonce-gated globalSetup) so this may already be red. Run it through the governed runner before Phase 5 and reconcile the pin.
- [x] **CI risk (corrected):** the earlier note that backend Jest "requires a nonce-scoped owner to be set explicitly" was wrong. `npm test` runs `tsx scripts/run-isolated-jest.ts`, which allocates the invocation itself. The real constraint is that `provisionIsolatedTestDatabase()` always provisions its **own** cluster — local PG16 binaries (with the `vector.control` extension file) or a Docker image `rorca-postgres:pg16-age` — and ignores any service-container `DATABASE_URL`. A GitHub runner therefore needs `postgresql-16` + `postgresql-16-pgvector` installed; the rewritten `backend-tests` job does exactly that.
---

## Decisions required from you

1. **History policy** — squash to a fresh initial commit (recommended) or rewrite history with `filter-repo`?
2. **Decision B (entitlements)** — is pipeline execution free in OSS, or does the Pro gate move to `rorca-opencore`?
3. **`docs/` and `forge/` scope** — ship curated subsets (recommended) or everything?
4. **Pipeline fix in v1 or documented limitation** — last successful run 2026-09-29, 20/325 historical success. Publishing with a 6% success rate needs an honest known-limitations section at minimum.

## Sequencing

Phase 1 → 2 → 3 can run in parallel with Phase 4.1 decisions. Phase 5 needs Phase 3 complete (workflows reference tracked paths). Phase 6 needs Phase 1 (env cleanup) and runs independently of 4/5. Phase 7 is last. Phase 8 after everything.

Estimated effort: **7–13 working days**, with Phase 6.4 and Phase 5.2 carrying the most uncertainty.
