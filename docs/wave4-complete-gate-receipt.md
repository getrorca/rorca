# Wave 4 Integration Complete-Gate Receipt

| Field | Receipt |
|---|---|
| Integration branch | `wave4-integration-20260805` |
| Reviewed base | Wave 3 packet `a66537fc3a5607a80f6b1010ebdde238d3b6ce8f` (accepted by security + release reviewers, zero findings) |
| Wave 2 prerequisite | `1420fb4c819aad692894da9449bc4958ed74dd49` |
| Lane commits | core `81b66c5f545dc35260fc90e2344d988fcd032e23` (W4-001..W4-009), ops `7ee25f9e0bb025ac5e2aa86c4f7261016e352761` (W4-011..W4-014) |
| Integration fixes | `55973e03176d0551e70f3e12185873206738b69d` (federation wire contracts + launch classification), `e413fa76ef819ef05f49ded7487e7b33f1bdcd22` (deterministic rate-limit options + body parser restore) |
| Gated code head (all gates below ran on this tree) | `a3efe85b701ba35030c399fc4ba0e684c4638298` / tree `2196c37550b1fe6379158557609a25fe196ef9f5` |
| Final packet commit/tree | the commit containing this receipt; its tree differs from the gated code head ONLY by this receipt (reviewers verify `git diff --name-only 2196c375… HEAD`) |
| Review chain | round-1 at `3b53b23e` REJECT (security 18: 14 P1/4 P2; release 4: 3 P1/1 P2) → remediation → security re-review 14/18 accepted → 4 P1s fixed (`214e04d5`) → security final: 3/4 accepted, P1 #4 refined (no production circuit callsite + wake-replay state divergence) → wired into worker.ts + immutable wake results (`06253081`) → security final 2: wake-loop regenerates changed requests for handled source receipts → skip handled receipts + reload durable state (`a3efe85b`) → gated green at `a3efe85b` |
## Complete backend gate (decisive)

Result: **8/8 shards passed, 0 failed**; 515 suites; 5,792 tests passed; 7 skipped by declared platform/capability conditions (final run on the code head `a3efe85b`).

Per-shard: 692, 828 (+2 skipped), 753, 614 (+4 skipped), 636, 749, 734 (+1 skipped), 786.

Previous definitive runs: `e413fa76` 8/8 (5,761 passed); `b6cb9163` 8/8 (5,788 passed); `27a715f2` 8/8 (5,790 passed); `06253081` 8/8 (5,791 passed).

Full-gate flake disclosure (Wave 2-documented intermittent status-code class plus two REAL Wave 4 defects; every flaked file proven green in isolation; both Wave 4 defects fixed and re-gated):
- Attempt 1: 13 suites / 189 tests failed in shard 8 — REAL defect: mission-control wire-contract registration missing for the 11 federation paths (server import threw). Fixed at `55973e03`; focused rerun 4 suites / 21 tests PASS.
- Attempt 2: `federated-runtime.test.ts` rate-limit race — the 121-request loop raced the 60 s wall-clock window under shard load (429 vs 200) — REAL test robustness defect; fixed by injectable rate-limit options + a deterministic 3-request assertion (6/6 PASS under exact shard worker flags). Also restored the router's `json` body parser (dropped in the first fix edit; caught by the same suite — 413 test).
- Attempt 3 (pre-remediation tree `e413fa76`): 8/8 PASS, 0 failed.
- Attempt 4 (remediation tree `b6cb9163`): 8/8 PASS, 0 failed (5,788 passed).
- Attempt 5 (final code head `27a715f2`): `webhook-route-boundaries` isolated 6/6; `delivery-governance` + `QRW-014-spec-generation-reasoning-field` isolated 36/36 combined; `retry-merge` isolated 8/8 — all Wave 2-era intermittent class.
- Attempt 6 (final code head `27a715f2`): `run-activity-store.integration` FAILED — REAL date-boundary defect: fixture pinned `validUntil: 2026-08-06T00:00:00Z` and the wall clock crossed midnight, permanently expiring every fixture observation. Fixed with clock-relative fixture dates (isolated 11/11 PASS).
- Attempt 7 (final code head `27a715f2`): 8/8 PASS, 0 failed (the receipted run above; no flakes).
- Attempt 8 (code head `06253081`, after the worker circuit wiring + immutable wake-replay fixes): 8/8 PASS, 0 failed (5,791 passed).
- Attempt 9 (final code head `a3efe85b`, after the handled-wake-receipt skip fix): 8/8 PASS, 0 failed (the receipted run above; no flakes).
## Fast gates (all at the final tree)

- Backend `npx tsc --noEmit`: PASS. Backend `npm run lint`: PASS (0 errors, 46 pre-existing warnings).
- Root `npm run typecheck` / `npm run lint`: PASS (0 errors).
- Frontend `npx vitest run`: PASS — 92 files / 1,050 tests.
- Audits (root + backend): 0 vulnerabilities.
- Governed-contract drift: PASS — 38 files stable (Wave 4 did not touch shared/generated files).
- Production Compose split-principal empty-volume smoke: PASS (29.2s; project `rorca-wave2-wave4final2-20260806`; 282 migrations; zero owned resources left; worker initializes the durable Wave 4 idle cost controller fail-closed).

## Lane receipts

- W4A core (W4-001..W4-009): federation gate binder (exact Wave 2/3 SHAs + reviews + one-runtime + no-release-authority); one-runtime credential registry (rotation/revocation/replay/RLS/immutable audit); 11 authenticated HTTP seams (discover/acquire/read/renew/release/events/activity/results/cancellation/plan-change/recover) with atomic offer claims + one-active-execution enforcement + 256 KiB/AppError boundary; exact-revision host Git verifier (8 adversarial matrices); Wave 2 event + Wave 3B activity delegation with federation binding; host-observed result proposals through the shared closeout resolver (no completion shortcut); durable cancellation + plan-change proposals; canonical-record-only recovery; managed/federated conformance incl. a real HTTP fixture lifecycle (33 tests). Matrix closure: 58 focused tests + 4 production repairs (offer JSON credential constraint, cancellation delivery state, duplicate replay binding, evidence shape/hashing). Migration `20260805101000_wave4_federated_runtime.sql`.
- W4B ops (W4-011..W4-014): governed Doctor (8-phase, observe-only canonical truth, dry-run default); event-driven cost circuit breaker (versioned hard maxima, atomic suspension, wake allowlist); canonical resource inventory + staged saga (quarantine, identity-preserving PATCH, separately authorized offboarding, vault-reference-only credentials); noisy-neighbor fault harness (15 budget dimensions, workspace B isolation) + clean-room certificate model; 24 focused tests + 5 DB integration. Migration `20260805110000_wave4_governed_operations.sql`.

## W4-014 real-host certification — outstanding

The clean-room reconstruction implementation is a deterministic synthetic certificate model + focused fixtures. The spec additionally requires: an ACTUAL reconstruction executed in a fresh isolated host namespace (exact commands, hashes, host observations, cleanup), and an independent exact-packet architecture/security/operations review before the final pilot demonstration. Both are recorded OUTSTANDING (integration-phase activities; W4-014 criterion 8 and the real-host packet). Residual limits for the final review packet: W4-010 GitHub App credentials and W4-014 real-host certification + independent review.

## Security/release remediation receipts (round 1 → green)

- W4-001 gate: readiness now binds hashes of COMMITTED Wave 3 artifacts — `sha256:c998212b…` (docs/wave3-complete-gate-receipt.md @ a66537fc), `sha256:dc093ac2…` (docs/wave3-redaction-review-receipt.md @ a66537fc), `sha256:51cca9d2…` (Wave 3 verdict ledger @ 305df001), `sha256:4e9ef68f…` (3-document bundle), spec revisions `249b8fc3…`/`992cdad5…` (frozen spec files @ a66537fc); reviewer IDs Wave3SecFinal2/Wave3RelFinal2 with verdict accepted / 0 findings; `loadCanonicalWave4FederationGate` re-verifies the row against these constants and calls `verifyWave4Prerequisites` before every admission.
- Federation (core): federated auth mounted ahead of browser auth/CSRF; TLS trusts only configured proxies (`req.secure` + trust-proxy allowlist); federated event idempotency key enforced end to end; identical result replay returns the stored receipt before re-verification; runtime outcome never becomes host-observed evidence status; source-checkout-inside-worktree overlap rejected; every undeclared Git remote/push URL rejected; active policy activation rechecked on every mutation; recovery binds turn/cursor identity; conformance exercises the real HTTP transport. Focused: gate 1 suite, contracts 2 suites, host verifier 12 real-Git tests, integration DB 3+1, conformance 53 (40 real-HTTP/router), routes 6 — combined wrapper green, 282/282 migrations.
- Ops: redactor covers quoted/free-text secret forms; Doctor exact capability + pre/postcondition hashes; budget amounts validated; circuit state + wake CAS durable (restart fixture); wake sources authenticated via verified receipts; offboarding derives authority + blockers from canonical state (pre-delete re-query race fixture); runtime principal Wave 4 DML revoked (SELECT only; canonical-writer SECURITY DEFINER for Doctor mutations); clean-room certificates built from executed verifier receipts. Focused: 25/25 pure + 6/6 DB integration; typecheck exit 0.
- Release: receipt binds the gated code head `b6cb9163…`/tree `648bc7b0…`; W4-014 real-host certification + independent review recorded outstanding; flake disclosure corrected to name the two real Wave 4 defects.

## W4-010 pilot demonstration — status

All pre-demo machinery (host-verified closeout through the federated lane, evidence envelopes, conformance) is implemented and gated. The required real repository-scoped GitHub App draft PR/Check projection is BLOCKED on the operator's GitHub App credentials (no App ID/private key present in this environment; `.env.example` carries only PAT placeholders, and the spec forbids PAT/manual-PR substitutes). Residual limit recorded for the final review packet; merge and deployment remain separate explicit human actions.

## Cleanup disposition

No invocation-owned Compose container, volume, network, image, Jest root, or wrapper database remains.

## Authority statement

This receipt records host-observed gate evidence only. It grants no merge, deployment, approval, production, or lifecycle authority.
