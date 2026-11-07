# LFC-024 — Lifecycle golden journey runbook

Date: 2026-07-15
Fixture: `lfc-024-billing-anomaly-alerts-v1`

## Purpose and authority

This runbook proves one staging-quality journey; it does not add an execution mode, QA runner, release orchestrator, or lifecycle evaluator. Journey and QA executions produce attempts and evidence. Accepted story closeout and the canonical Lifecycle evaluator remain separate decisions.

Use both diagrams as review aids:

- UI journey: `docs/diagrams/rorca-ssdlc-lifecycle-board-wireframe.png`
- Runtime/evidence sequence: `docs/diagrams/hermes-rorca-ssdlc-skill-sequence-clean.png`

Validated API, evaluator, closeout, and evidence contracts override stale diagram details.

## Safety boundary

Run only against a local/test PostgreSQL database and a disposable workspace rooted below `/tmp`. The staging target must require explicit approval. Before execution, confirm that Slack credentials, merge tokens, deployment credentials, and production endpoints are absent. The fixture policy is branch-only with `autoMerge=false`, `deploy=false`, and `externalSend=false`.

The browser journey in `tests/lifecycle-golden-journey.spec.ts` uses the real Rorca frontend and existing Journey/QA UI behavior. Its deterministic transport snapshots are canonical response types, not a second evaluator. They are for repeatable browser mutation and visual proof. GitHub, Hermes, GitReins, and staging provider records are labeled `test adapter`. A release sign-off must additionally run the canonical backend/pipeline segment below; browser transport proof alone is not represented as a real pipeline run.

## Canonical local pipeline segment

1. Start from the plain-language intent recorded in `GOLDEN.intent` in `tests/fixtures/lifecycle-golden-journey.ts`.
2. Record the governed scope decision: exactly one spec, with alert evaluation, tenant-scoped delivery, operability, and validation boundaries.
3. Confirm all six requirements have one owning story and every story has one capability. Repair the BAA-005 tenant-isolation ownership gap before persistence.
4. Persist `billing-anomaly-alerts` through the existing skill-first `rorca_persist_spec`/`POST /api/specs/persist` contract. Do not use backend generation as the normal path.
5. Compile through `POST /api/lifecycle/specs/billing-anomaly-alerts/recompile`. Assert an 11-phase plan and exactly four Validation gates.
6. Start the spec through the existing Run surface with Pi and high effort. Do not alter mode detection or prompt semantics. Capture:
   - pipeline run and story IDs;
   - agent attempt packets;
   - accepted/rejected closeout packets;
   - one commit per accepted story;
   - host-observed command results;
   - canonical Lifecycle matrix/detail snapshots.
7. Preserve the first tenant-isolation failure. It must identify the missing `organizationId` scope, leave Validation at 2/4, reject BAA-005 closeout, and keep BAA-006 unscheduled.
8. Open the existing governed retry preview. Verify BAA-005 is the only executable story, BAA-001–004 are copied, BAA-006 remains pending, the worktree/revision is current, Pi model/effort is explicit, focused plus broad validation is listed, and publication remains branch-only/no-auto-merge.
9. Dispatch only the accepted preview. Ingest focused and broad host evidence for the resulting commit. BAA-006 becomes eligible only after the BAA-005 closeout is accepted.
10. Bind staging evidence to one lineage: source commit → staged artifact digest → test deployment ID. QA-mode and Journey-mode evidence may map to multiple gates but cannot directly set a phase status.
11. Record explicit staging QA approval by an authorized test approver for the same revision. A successful QA-mode story is evidence, not approval.
12. Verify merge readiness without merging. Production must remain `awaiting_approval` or `not_started`; no deployment proof is fabricated.
13. Replace only the staged artifact digest and re-evaluate. Validation remains source-commit valid; dependent QA, merge, and production proof becomes stale.
14. Generate the Learn closeout candidate. It must retain run/story/evidence/decision provenance, remain review-required, and exclude sensitive content from default retrieval.

## Browser journey and deterministic rerun

With the existing frontend dev server available at `http://localhost:5210`:

```bash
npx playwright test tests/lifecycle-golden-journey.spec.ts
```

The test covers:

- filters and saved URL state;
- roving matrix keyboard flow, selected cell, desktop/mobile drawer, and focus restoration;
- requirement traceability and normalized evidence inspector;
- spec/run links and review-only override packet;
- recompile, evidence ingest, decision/revocation, retry preview/dispatch, and approval — each with a rejection and a recovery/replay path;
- explicit distinction among attempt completion, accepted closeout, and lifecycle evaluation;
- QA evidence without approval, explicit approval, revocation, and lineage staleness;
- Production awaiting approval and a review-only Learn candidate;
- light-theme screenshots at 1440×900, 1024×768, and 390×844 for blocked/recovery, plus stale, empty, loading, error, and approval states.

Playwright writes and attaches `evidence-bundle.json` under its test output directory. Repeating the test uses the same fixture IDs, revisions, source event IDs, and mutation sequence. Idempotent replay assertions reject duplicate effects.

## Evidence bundle acceptance

The generated bundle must contain:

- executed commands and observed results (not merely expected commands for canonical sign-off);
- fixture, workspace, spec, run, story, attempt, completion-packet, and decision IDs;
- story commits and the immutable release lineage;
- approvals and revocations with actor and subject;
- every screenshot name, dimensions, and light theme;
- diagram references and explicit Journey/QA-to-gate mappings;
- remaining risks;
- cleanup confirmation and a false value for Slack, merge, deploy, and production side effects.

The browser bundle marks browser assertions as `asserted_by_playwright`. During canonical staging sign-off, merge the real pipeline's host-observed command records and IDs into the retained run artifact; do not relabel test-adapter evidence as provider-verified production evidence.

## Cleanup

1. Close Playwright contexts and confirm no browser process owned by the run remains.
2. Stop only servers/workers started by this run and wait for clean process exit.
3. Confirm no queued retry remains for runs 913/914 in the disposable fixture.
4. Remove the isolated worktree/branch only after preserving the evidence bundle.
5. Idempotently delete or reset the disposable staging workspace.
6. Verify no Slack message, merge, deploy, or production mutation occurred.
7. Record cleanup status in the evidence bundle. A missing cleanup confirmation fails the journey.
