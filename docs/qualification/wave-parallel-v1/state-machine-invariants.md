# State machine and invariants v1

The executable story/attempt/integration/wave/run transitions remain in `wave-qualification-model.ts`; stable invariants remain in `wave-parallel-invariants.json`.

Qualification evidence adds this monotonic state chain:

`collecting → normalized → reported → authenticated → locally_verified → published`

Any transition may instead enter `unavailable`. There is no transition from `unavailable` to production enabled without a new complete receipt. Publication, telemetry, report, or signing failure cannot alter semantic run closeout.

Key applications of the invariant catalog:

- WPE-INV-001/005: a passed scenario needs validated integration and exactly-once finalization proof.
- WPE-INV-002/003: rejection, conflict, failed dependency, skipped check, or blocker prevents a successful gate.
- WPE-INV-004/007: only qualification-owned resources are inventoried or cleaned; production is never targeted.
- WPE-INV-006: WAL, decisions, reports, and receipts are durable append-only history.

Counts saturate at 65,535; identities are SHA-256 labels; mode and state labels are closed enums. This bounds metrics/API cardinality and prevents attempt, lease, branch, path, prompt, payload, or stack data from becoming a label.
