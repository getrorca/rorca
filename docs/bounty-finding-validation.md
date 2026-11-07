# Bounty finding validation policy (`bounty.validation.v1`)

A hunter output is a **candidate**, never a finding. Rorca creates a blind validation packet for a fresh validator whose worker process, context nonce, credential lineage, and operation lineage are all distinct from the producer. The packet contains claim/evidence hashes but never hunter reasoning or proposed severity.

## Admission rule

The initial evidence-confidence threshold is **0.85**. Confidence is computed from gateway-verified integrity and lineage counts; model self-ratings are ignored. A validator must also:

- satisfy the class oracle and its negative control without triggering the baseline;
- actively falsify alternatives;
- produce the class minimum in fresh runs with distinct operation IDs;
- stay at or below the candidate harm ceiling and use no prohibited proof;
- return the report under the packet's current one-use nonce and exact validator identity.

Ambiguous evidence remains `inconclusive`. Unsupported classes and the human classes below remain `human-required`; model agreement cannot promote them. Human admission consumes an exact one-use `finding.admit` provider-human receipt under [the approval matrix](bounty-approval-matrix.md).

| Release-routable class | Oracle | Negative control | Minimum fresh runs | Disposition |
|---|---|---|---:|---|
| Reflected XSS | Cross-principal script execution | Encoded payload remains inert | 2 | Auto |
| Stored XSS | Fresh-principal stored execution | Clean unprivileged record | 2 | Human |
| IDOR | Cross-account object access | Control account is denied | 2 | Auto |
| Server-side callback | Broker server callback receipt | Browser-origin callback absent | 2 | Human |
| Exposed private key | Private material verified | Public material rejected | 2 | Human |
| Known vulnerability | Version-specific safe exploit oracle | Banner-only match rejected | 2 | Human |
| Source-code control edge | Runtime reachability observed | Inferred-only edge rejected | 2 | Human |

This table is closed over every class that can be routed to release. A new class requires a policy-version change and an explicit oracle, negative control, minimum, and disposition.

## Active falsification and atomic stop

Active checks return through the same target-effect broker under a validator grant that is no wider in targets, actions, harm, or operation count. Destructive actions remain denied, and an effect with unknown outcome is never replayed. The validator receives separate credential lineage.

Admission takes deterministic PostgreSQL advisory transaction locks for both candidate and affected target. In that one transaction Rorca consumes any exact human receipt, inserts the finding, inserts the affected-target stop fence, and records the admission. Candidate replay returns the original finding; a changed replay or competing candidate for the stopped target fails closed. Unique constraints and append-only triggers are the final concurrency and bypass fences.

Anti-cheat fixtures cover baseline triggering, stale nonce, self-XSS, browser-origin callback, false IDOR, public-key confusion, banner-only CVE matching, inferred code edges, duplicate reproduction, and prohibited proof.
