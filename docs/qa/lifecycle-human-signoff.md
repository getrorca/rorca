<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# Lifecycle human staging and visual QA record

> **Gate status: PENDING — NOT APPROVED**
>
> This file is the required human-owned gate. An agent, test, screenshot generator, or successful QA/Journey execution must not change the status to approved. Approval is valid only when every required field and checklist row is complete and bound to the final immutable revision.

## Immutable review identity

| Field | Required value |
|---|---|
| Final commit SHA | `PENDING` |
| Built artifact digest | `PENDING` |
| Staging deployment ID/URL (non-production) | `PENDING` |
| Evidence bundle digest/path | `PENDING` |
| Browser/OS | `PENDING` |
| Review started/completed (UTC) | `PENDING` |
| Human approver name | `PENDING` |
| Human approver role/authority | `PENDING` |
| Approval decision | `PENDING` (`APPROVED` or `REJECTED`) |
| Signed rationale | `PENDING` |

A changed commit, artifact, or deployment invalidates the approval and resets this record to pending. Never copy credentials into this record.

## Staging-quality journey

- [ ] Canonical skill-first persist → post-save → lifecycle compile completed for the reviewed revision.
- [ ] Implementation, QA, and Journey execution outcomes are separately visible from lifecycle phase status.
- [ ] Primary blocked → evidence → smallest retry → recovery journey passed from canonical data.
- [ ] Major negatives passed: wrong workspace/revision, conflicting evidence, stale preview, missing approval, unavailable adapter, duplicate request.
- [ ] Recovery passed: refresh-required, recompile, adapter recovery, retry regeneration, approval revocation/reapproval, dependent lineage staleness.
- [ ] QA execution success remained lifecycle-blocked until this explicit human approval.
- [ ] Merge/deploy/external-send/production remained disabled; no credential was copied.
- [ ] Learn closeout produced a provenance-linked review-required candidate and did not rewrite delivery outcome.
- [ ] No P0/P1 functional, security, accessibility, UX, or light-theme defect remains.

## Visual capture matrix

Review the deterministic fixture names/paths from `src/fixtures/lifecycleVisualRegression.ts` against both source layouts listed in `docs/qa/lifecycle-lfc-028-visual-review.md`.

| State | 1440×900 light | 1024×768 light | 390×844 light | Notes/defect ID |
|---|---|---|---|---|
| Default board | ☐ | ☐ | ☐ | |
| Blocked phase drawer | ☐ | ☐ | ☐ | |
| Retry preview/dialog | ☐ | ☐ | ☐ | |
| Evidence inspector | ☐ | ☐ | ☐ | |
| Empty workspace | ☐ | ☐ | ☐ | |
| Filtered zero state | ☐ | ☐ | ☐ | |
| Loading geometry | ☐ | ☐ | ☐ | |
| Recoverable error | ☐ | ☐ | ☐ | |
| Adapter unavailable | ☐ | ☐ | ☐ | |
| Permission restricted | ☐ | ☐ | ☐ | |
| Stale/refresh-required | ☐ | ☐ | ☐ | |
| Approval state | ☐ | ☐ | ☐ | |

Additional parity:

- [ ] Dark theme parity reviewed for default, blocked drawer, retry preview, empty, loading, recoverable error, and stale states.
- [ ] Reduced-motion mode removes non-essential animation without hiding feedback or changing geometry.
- [ ] Default, blocked drawer, retry preview, and mobile navigation remain usable at browser 200% zoom.
- [ ] Keyboard-only flow reaches matrix, drawer, evidence inspector, retry/approval controls, close actions, and restores focus deterministically.
- [ ] Screen-reader status has visible text; no ambiguous icon-only state/action exists.
- [ ] No uncontrolled gradient/glass, heavy shadow stack, decorative chart clutter, nested-card clutter, inconsistent control placement, clipped label, low-contrast tint, or placeholder/TODO primary flow is present.

## Residual work decision

List every residual item. If any item can affect lifecycle truth, core action, light theme, responsive use, accessibility, safety, recovery, or operational support, the decision must be `REJECTED`.

| Item | Owner | Impact | Workaround | Non-critical evidence |
|---|---|---|---|---|
| `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` |

## Approval statement

`PENDING`

Required approved form:

> I reviewed the staging-quality Lifecycle journey and required visual matrix on commit `<sha>`, artifact `<digest>`, deployment `<id>`. I found no P0/P1 functional, security, accessibility, or UX defect; all primary, major negative, and recovery journeys passed from canonical data; listed residuals are non-critical polish only. I approve this immutable revision for release-readiness evaluation. This is not merge or deployment authorization.
