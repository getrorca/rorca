# PR notes — Always-On Context production readiness

## Proposed title

`fix(capture): productionize monitoring, policy, and login recovery`

## Base and scope

- **Incremental review base:** remote UCC branch
  `origin/feat/always-on-universal-agent-context-capture` at `981a28b58`.
- **Do not target current `origin/main` directly.** `origin/main` is independently
  at `9c0ed311d`, already merged the separate CCS sidecar implementation, and
  shares only `df78d3b6d` with this UCC line. Twenty-one committed paths overlap
  divergent UCC/CCS implementations; a main-targeted PR requires a dedicated
  port/reconciliation branch and cannot be represented as a routine rebase.
- Local `main` merge `f6ad9aa76` is the activation/runtime base only, not a
  remotely available PR base.
- Existing scoped hardening commits on the local branch:
  - `7b4ba177a fix(capture): keep managed daemon running`
  - `cd866cca9 fix(capture): accept canonical context diagnostics`
  - `cc07dd39d test(capture): cover metadata-only queue privacy`
- No remote branch was changed and nothing should be pushed without explicit
  operator approval.

## Summary

- adds aggregate, workspace-scoped monitoring for offline/API queue depth,
  failed `context:capture` and `context:distill` jobs, daemon `last_seen` and
  `lastFlush`, persisted distillation errors, redaction/audit counts, and worker
  heartbeat;
- adds a read-only fail-closed operator monitor that also checks managed
  backend/worker/capture service state and separates active failures from one
  exact, migration-bounded accepted brownfield error baseline;
- fixes the canonical brownfield `memory_candidates` mismatch that caused
  distillation to fail on missing `payload`, then would have failed required
  `title`/`rule` constraints;
- keeps new UCC candidate review actions aligned with the canonical
  `review_status` ledger while preserving immutable event evidence;
- makes external-import idempotency stable across import times while allowing
  changed content under the same vendor/original id to stage a new candidate;
- ingests bounded git-hook signals into the durable queue, preserves
  metadata-only commit privacy, and propagates explicit policy changes to
  Codex/OpenCode wrappers;
- adds deterministic managed backend/worker/capture launchd recovery, a
  fail-closed login readiness gate, and an interactive-only reboot smoke with
  durable dirty-work/evidence snapshots;
- documents production alerts, recovery, optional VS Code/Pi/Codex/OpenCode
  behavior, and the non-destructive UCC-012 stale-tracking disposition.

## Files for the monitoring/candidate commit

```text
backend/src/db/pg-migrations/20260714143000_context_capture_candidate_compatibility.sql
backend/src/lib/context-capture-controls.ts
backend/src/lib/context-distillation.ts
backend/src/lib/external-memory-import-adapters.ts
backend/src/lib/__tests__/context-capture-monitoring.test.ts
backend/src/lib/__tests__/external-memory-import-adapters.test.ts
backend/src/routes/context-capture.ts
backend/src/routes/__tests__/context-capture-validation.test.ts
scripts/monitor-always-on-context.mjs
docs/always-on-context-production-readiness.md
```

## Files for the policy/hook/login lifecycle commit

```text
docs/always-on-capture-policy-decision.md
docs/always-on-login-readiness.md
docs/local-managed-services.md
docs/universal-context-capture.md
packages/rorca-pi-extension/extensions/rorca/__tests__/capture-bootstrap.test.ts
packages/rorca-pi-extension/extensions/rorca/__tests__/capture-service.test.ts
packages/rorca-pi-extension/extensions/rorca/capture-bootstrap.js
packages/rorca-pi-extension/extensions/rorca/capture-bootstrap.ts
packages/rorca-pi-extension/extensions/rorca/capture-service.js
packages/rorca-pi-extension/extensions/rorca/capture-service.ts
scripts/always-on-reboot-smoke.mjs
scripts/rorca-managed-services.mjs
scripts/verify-always-on-login-readiness.mjs
```

`docs/always-on-context-pr-notes.md` belongs in a final packaging-only commit so
it can record the resulting commit hashes and commands. The shared
`.always-on-capture-activation-progress.md` operator log remains a local handoff
artifact and is excluded from the PR unless an operator explicitly requests it.

## Explicit exclusions

Do not stage broad `git add .` / `git add -A`. The checkout contains unrelated
pre-existing work for interactive PTY, FinOps, operator chat, task manifests,
Pi/tmux extensions, backup cleanup, and other initiatives. It also contained stabilized but mixed-provenance Always-On
lifecycle/policy/git-hook files. They were committed only through the exact
allowlist after reviewing the combined patch as one coherent capture package;
they must not spill into the monitoring commit.

In particular, the mass deletion of `backend/backups/*.sql` and unrelated
changes under frontend panels/components, pipeline execution, Hermes audits,
and PTY progress files are outside this PR package.

## Migration and rollout

1. Preserve a database backup and existing dirty checkout snapshot.
2. Apply normal PostgreSQL migrations. Never alter `pgboss.*` manually.
3. Load the updated backend and worker only after `/api/health` confirms zero
   active runs and the managed-service takeover gate passes.
4. Validate one harmless metadata-only event. Confirm the capture and
   distillation queues drain, a new event does not become
   `distillation_status=error`, and `lastFlush` advances.
5. Run:

   ```bash
   node scripts/monitor-always-on-context.mjs --workspace-id <id> --root "$PWD"
   ```

6. Historical distillation error rows remain evidence. Do not mass-update them;
   replay only through a separately reviewed canonical repair path. The monitor
   treats only the exact pre-`20260714143000` missing-`payload` failures as an
   accepted advisory, and only while the migration record and repaired column
   both exist; all post-fix or different errors remain active failures.

The migration is additive (`ADD COLUMN IF NOT EXISTS`) and does not rewrite
existing candidates or context events.

## Security and privacy review

- Monitoring responses contain counts, timestamps, job ids, process ids, source
  event ids, and classified error types only.
- No captured payload, command summary, raw provider error, secret value, token,
  or raw redaction match is returned.
- Adapter artifacts retain token **paths** only and preserve metadata-only
  policy unless an operator explicitly changes it.
- No adapter writes directly to PostgreSQL.

## Validation checklist

```bash
node --check scripts/monitor-always-on-context.mjs
cd backend && npx tsc --noEmit --pretty false
cd backend && JEST_SKIP_RUNTIME_MIGRATIONS=true npx jest \
  src/lib/__tests__/context-capture-monitoring.test.ts \
  src/lib/__tests__/external-memory-import-adapters.test.ts \
  src/routes/__tests__/context-capture-validation.test.ts --runInBand
npm run test:capture
npx vitest run --config packages/rorca-pi-extension/vitest.config.ts
npx tsc -p packages/rorca-pi-extension/vscode-extension/tsconfig.json --noEmit
npm run typecheck
npm run build
npm run lint:tier
npm run lint:swagger
npm run check:contract   # only against the canonical updated backend
```

Record any baseline-only failure; do not modify unrelated code or weaken a test
to make the package green.

## Commit / patch plan

1. Keep the three existing hardening commits unchanged.
2. Keep completed monitoring commit `9769a2831 fix(capture): add production
   monitoring and candidate compatibility`.
3. Keep completed lifecycle commit `be71e9d6b fix(capture): harden policy hooks
   and login recovery`; it excludes local generated `.rorca` state and
   `.rorca-captureignore`.
4. Commit this PR note alone as packaging documentation. Keep the shared
   activation progress log local and uncommitted.
5. Verify each commit with `git show --check`, then construct a clean linear
   review branch from the remote UCC feature base by cherry-picking the scoped
   commits. This removes the local activation merge commit from review history.
6. Do not push or force-push.

## Prepared push / PR commands (approval required)

The final package should be created in an isolated worktree. Resolve the final
notes-only tip before adding the worktree so every cherry-pick is unambiguous:

```bash
git fetch origin main feat/always-on-universal-agent-context-capture
pr_notes_commit=$(git rev-parse fix/always-on-capture-integration-hardening)
git worktree add /private/tmp/rorca-ucc-pr-review \
  -b review/always-on-context-production-readiness \
  origin/feat/always-on-universal-agent-context-capture

git -C /private/tmp/rorca-ucc-pr-review cherry-pick \
  7b4ba177a cd866cca9 cc07dd39d \
  9769a2831 be71e9d6b "$pr_notes_commit"

git -C /private/tmp/rorca-ucc-pr-review show --check --oneline \
  origin/feat/always-on-universal-agent-context-capture..HEAD
git -C /private/tmp/rorca-ucc-pr-review diff --name-status \
  origin/feat/always-on-universal-agent-context-capture..HEAD
```

Only after explicit push approval:

```bash
git -C /private/tmp/rorca-ucc-pr-review push --set-upstream origin \
  review/always-on-context-production-readiness
cd /private/tmp/rorca-ucc-pr-review
gh pr create \
  --base feat/always-on-universal-agent-context-capture \
  --head review/always-on-context-production-readiness \
  --title 'fix(capture): productionize monitoring, policy, and login recovery' \
  --body-file docs/always-on-context-pr-notes.md
```

A later PR to `main` must start from current `origin/main` and explicitly port
UCC behavior onto the merged `packages/rorca-capture`/CCS architecture; do not
merge or force-rebase this divergent branch onto main without that review.
