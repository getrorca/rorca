# Governed bounty qualification and operations runbook

The bounty candidate is **disabled by default**. Hermetic fixture success is not production enablement. An exact post-commit receipt must verify against identities recomputed from the checkout; any prompt, skill, router, oracle, persona, model, runtime, policy, broker, adapter, migration, configuration, corpus, or evidence change invalidates it.

## Enable

1. Keep `RORCA_BOUNTY_DEPLOYMENT_POLICY` absent or explicitly `disabled` throughout qualification. Confirm `GET /api/admin/bounty/policy` reports `enabled=false` and `GET /api/admin/bounty/qualification` reports `releaseEnableAvailable=false` for this candidate.
2. Freeze the source commit and private corpus versions. Run every suite in `config/bounty-qualification.v1.json` inside the isolated qualification environment. Database suites use a disposable PostgreSQL 16 database; pg-boss suites use a unique schema and call `createQueue` before send. Browser/adapter targets must resolve only to declared hermetic transports.
3. Regenerate the receipt with the exact commit in `RORCA_BOUNTY_SOURCE_SHA`, independently recompute every binding, and call `verifyBountyQualificationReceipt(receipt, currentBindings)`. A fixture receipt, dirty tree, failed/omitted suite, skipped control, unknown corpus, or identity mismatch blocks enablement.
4. This checked-in candidate intentionally cannot be enabled from its fixture status. A future release must add an audited promotion gate that accepts only a trusted post-commit receipt before a credential-authenticated human administrator may advance `/api/admin/bounty/policy`; until then, keep policy disabled. Never enable from a spec, prompt, worker, Hermes, MCP, or schedule.

## Preflight

- Confirm Linux+bwrap probes deny direct DNS/TCP/UDP, host process/files, arbitrary sockets, inherited descriptors, secrets, stale capabilities and executable roots.
- Verify one hunter, an independent validator, disjoint credential/operation lineages, broker-only effect sockets, current scope/epoch/expiry, DNS and every redirect hop.
- Verify credential handles are adapter/origin/action/epoch-bound; no credential material appears in prompts, logs, evidence, UI, or receipt artifacts.
- Verify exact budget, concurrency, callback, evidence-retention and stop fences; unknown/destructive/submission effects remain denied.
- Compare all 16 HackBot and 9 P0 rows in `bounty-qualification-matrix.v1.json` to named passing evidence. Confirm all 14 suite classes, seven controls, ten metric families, corpus digests, evidence root and receipt hash.

## Observe

Use Mission Control's redacted authority, session, evidence, finding, hold, draft and telemetry projections. Monitor class success, false-positive and rejection rates, oracle failures, cost, input/output tokens, worker activity, cache spend and authentication spend. Alert on receipt gaps, stale epochs, redirect denial, credential failures, uncertain sent effects, evidence quarantine, budget pressure, or any direct-egress/submission attempt. Never render raw corpus, credentials, target bodies, or validator hidden state.

## Nudge

A nudge is a new bounded Controller proposal, not text injected into a running worker. Re-read current authority, pause if necessary, create one immutable work package with a narrower objective and limits, independently review it, then release through the Controller. A nudge cannot widen scope, restore revoked capabilities, alter an oracle, add a tool, change model/runtime, or bypass Rule of Two; those changes require requalification.

## Pause

Use the credential-authenticated Mission Control approval preview, verify mission/contract/scope hashes and epoch, provide a reason, then pause. The Controller must first commit the replacement epoch and cancel prepared effects, then revoke credentials/callbacks/browser partitions, then terminate process groups. Treat sent/unknown effects as held and reconcile them; never retry them.

## Kill

Use emergency kill when containment, credential, egress, scope, evidence-integrity or submission controls are uncertain. Verify the exact preview, commit kill, and observe this order: epoch fence and prepared-effect cancellation; credential/callback/browser revocation; SIGTERM to process groups; bounded grace; SIGKILL for survivors. Rotate affected credentials, retain tamper-evident evidence, and keep the mission terminal.

## Resume

Resume only a paused (never killed/stopped) mission after all uncertain effects are reconciled, holds are resolved by a human, scope and credentials are fresh, callbacks/browser partitions are reissued at the replacement epoch, budgets remain valid and preflight passes again. Resume requires a fresh exact approval; stale previews fail closed. Any changed requalification identity requires a new complete receipt before resume.

## Closeout

Stop remaining work, reconcile queue/outbox/leases and sent/unknown effects, verify evidence manifests and broker-receipt lineage, complete independent validation, and record local report readiness. Compare actual metrics with qualification metrics and preserve the immutable receipt/evidence roots. There is no provider submission path: an authenticated human exports and submits the exact reviewed draft outside worker/Hermes/MCP authority.

## Rollback

Immediately set operator policy to `disabled` at the next revision (or remove an enabling deployment policy), kill active missions, stop bounty workers/queues, revoke all credentials/callbacks/browser partitions, rotate secrets and preserve evidence. Restore the last qualified source/config/migrations as one bound set; do not downgrade database state or hand-edit pg-boss tables. Reconcile crash cuts and uncertain effects, rerun all suites, issue a new receipt, and require a fresh human enable decision. A previous receipt cannot authorize rolled-back or forward-changed inputs.
