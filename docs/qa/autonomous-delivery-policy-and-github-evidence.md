<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# Autonomous delivery policy and exact-SHA GitHub evidence

Date: 2026-07-17

Validated implementation commit: `67a53f6d9241e08cdf53a55ee196409f95aa2dc1`

Combined candidate base: `363cf0ef89347fb958530b37970f44d6750aa568`

> Historical foundation report: items 3–7 were subsequently implemented and validated in [`autonomous-reviewed-delivery-closeout.md`](./autonomous-reviewed-delivery-closeout.md).

## Scope and result

The first two remaining autonomous reviewed-delivery seams are implemented:

1. **Standing operator-owned autonomous delivery policy** — complete.
2. **Exact-SHA GitHub PR evidence ingestion** — complete.

Items 3–7 remain intentionally unimplemented in this change: Lifecycle gate consumption, exact-SHA merge authorization/actuation, bounded CI/conflict recovery, idempotent merged-SHA closeout, and risk-tiered autonomous continuation. No code in this change may infer that persisted PR evidence authorizes merge.

No policy was enabled outside the disposable test database. No branch was pushed, PR updated, repository mutated, deployment performed, production database contacted, or recovery mode armed.

## Item 1: standing policy

### Contract

`rorca.autonomous-delivery-policy.v1` binds:

- workspace-derived GitHub repository;
- explicit base branch;
- standing-automation risk allowlist (`low` and optional `medium` only);
- one or more exact required check names;
- minimum current-SHA approvals (at least one);
- optional required reviewer logins;
- optional code-owner-review requirement;
- stale-approval dismissal requirement;
- merge method (`merge`, `squash`, or `rebase`);
- bounded remediation attempts and elapsed minutes;
- maximum 90-day expiry;
- immutable policy digest and operator identity.

Deployment remains separate at every layer. The API rejects caller deployment fields, normalized DTOs always return `deploymentAllowed: false`, and PostgreSQL enforces `deployment_allowed = FALSE`.

### Activation and revocation

- Creation always persists `status=disabled`.
- Activation is a separate workspace-admin route.
- Activation requires the exact policy digest, `Idempotency-Key`, unexpired policy, and the literal confirmation `ENABLE_AUTONOMOUS_PR_DELIVERY`.
- At most one policy can be active per workspace.
- A replacement activation revokes the previous active revision transactionally.
- Scope/authority fields are immutable.
- Revocation is one-way, rationale-bound, idempotent, and audit retained.
- High and critical risk cannot enter standing autonomy.
- Policy and event rows cannot be deleted through normal SQL operations.

### Operator UI

Workspace Settings → GitHub now displays:

- explicit disabled state;
- disabled policy drafting;
- exact digest/repository/base/check/review preview;
- explicit review-and-enable confirmation;
- one-way revocation with rationale;
- a statement that deployment authority remains separate.

The UI does not activate a policy during load or draft creation.

## Item 2: exact-SHA provider evidence

The observer accepts only:

- a canonical Rorca run ID; and
- the full expected PR head SHA.

Rorca derives repository, PR number, branch, target binding, and workspace credential server-side. Before persistence it rejects:

- run/workspace mismatch;
- missing canonical PR or branch binding;
- repository mismatch;
- unexpected PR URL or number;
- branch mismatch;
- changed head SHA;
- missing workspace GitHub credential.

GitHub access is read-only. The observer fetches:

- PR state, draft state, exact head/base SHA, mergeability, and mergeability state;
- latest check runs and combined commit statuses;
- PR reviews with the reviewed commit SHA;
- base-to-head comparison, ahead/behind counts, and freshness.

The normalized evidence:

- is capped at 500 checks and 500 reviews;
- strips provider URL query/fragment/userinfo and permits GitHub HTTPS URLs only;
- distinguishes current-head approvals from stale approvals;
- marks missing, pending, failing, or truncated checks ineligible;
- marks changes-requested, missing required reviewers, stale approvals, truncation, and unverified code-owner requirements ineligible;
- requires active policy repository/base scope to match;
- is payload-hashed and append-only;
- returns exact replay idempotently;
- writes only bounded identifiers/booleans/digests to WAL;
- never stores the GitHub token.

Observation is evidence only. `allRequiredChecksPassed` or `reviewSatisfied` cannot mutate a lifecycle phase, merge a PR, or deploy.

## Persistence and migration

Migration: `20260715210000_autonomous_delivery_governance.sql`

Tables:

- `autonomous_delivery_policies`
- `autonomous_delivery_policy_events`
- `github_pr_delivery_evidence`

The migration:

- does not touch `pgboss.*`;
- has no duplicate migration prefix;
- preserves append-only evidence/events;
- permits only one-way policy activation/revocation transitions;
- enforces exact evidence identity and bounded JSON arrays;
- uses existing workspace/run foreign-key authority.

Fresh disposable migration result:

- 178 ledger entries;
- 177 applied and one intentional legacy graph skip;
- second and subsequent runs: zero applied, 178 skipped.

Database used: `rorca_delivery_governance_20260716_test`

Verified server identity:

- database: `rorca_delivery_governance_20260716_test`
- role: `rorca_test_runner`
- owner: `rorca_test_runner`

The pre-existing `rorca_test` owner drift was not changed; the safety guard refused it as designed. After validation, `rorca_delivery_governance_20260716_test` was identity-checked, connections were confirmed absent, and only that review-created database was removed. Temporary credential and verification-script files were removed.

## Validation

### Focused backend

- New policy/evidence/service/route/migration matrix: 4 suites, **23/23 passed**.
- Combined lifecycle/recovery compatibility matrix: 8 suites, **48/48 passed**.
- Canonical Recovery Wave 4 regression matrix: 15 suites, **137/137 passed**.
- Canonical SSDLC lifecycle/retry/closeout matrix: 32 suites, **341/341 passed**.
- Real PostgreSQL assertions proved:
  - creation remains disabled;
  - create and activate exact replay are idempotent;
  - activation is digest/confirmation/expiry bound;
  - immutable policy scope cannot be edited;
  - revoked policy cannot reactivate;
  - evidence update and delete are blocked.

### Frontend

- New settings UI: **4/4 passed**.
- Focused workspace/lifecycle settings: 5 files, **41/41 passed**.
- Full frontend: 83 files, **971/971 passed**.

### Static/build/governance

- Root frontend TypeScript: passed.
- Backend TypeScript: passed.
- Focused ESLint: zero errors.
- Production build: passed.
- Tier lint: passed; all six new operations are `admin`, leaving public routes at 116 and MCP tools at 163.
- Public contract 8.0.0: unchanged at 116 routes; regeneration and stability check passed.
- Swagger coverage: no new omission; 18 existing warnings remain.
- Apache-2.0 source header check: 1,160 files passed.
- License boundary check: passed/skipped under the single Apache-2.0 repository license.
- `git diff --check`: passed.

### Read-only live-provider verification

The exact observer was run against PR 16 with a canonical fixture binding in the disposable database and a transient GitHub credential used only in process memory. GitHub requests were GET-only.

Observed:

- PR: `getrorca/rorca#16`
- head: `9f899df5cb044ea3eb6f90ce84a3a10e25942862`
- base: `6f87e79b0035985463739b05245cdd6e34969717`
- state: open/draft
- mergeability: `true`, state `unstable`
- branch comparison: ahead, zero commits behind
- checks: 23
- reviews: 0
- active policy: absent
- required checks satisfied: false
- review policy satisfied: false

Retained redacted result: [`evidence/autonomous-delivery-pr16-observation.json`](./evidence/autonomous-delivery-pr16-observation.json)

## Security conclusion

Items 1 and 2 are fail-closed and production-safe:

- no model, agent, request body, or UI state can arm policy;
- creation is not activation;
- policy cannot grant deployment authority;
- high/critical risk cannot use standing autonomy;
- evidence cannot select its own repository/PR/branch;
- stale or changed SHA cannot replay as current;
- provider unavailability or truncation cannot become success;
- current evidence cannot yet authorize or execute merge.

## Remaining work

1. Map eligible PR evidence into the existing Lifecycle Validation/Merge gates without creating another policy engine.
2. Require the current canonical Merge gate and active policy immediately before any PR merge.
3. Add bounded existing-worker recovery for classified CI failures and merge conflicts, followed by a new exact-SHA observation/review cycle.
4. Execute merge idempotently through the existing GitHub/worker boundary and persist exact merged SHA/WAL evidence.
5. Permit automatic continuation only for active-policy low/medium risk; high/critical remains explicit-human.

Until those seams pass, this implementation provides the safe switch and evidence foundation but does not claim closed-loop autonomous reviewed merge.
