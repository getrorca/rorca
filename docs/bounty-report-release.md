# Local bounty reports and exact readiness (`bounty.report.v1`)

Rorca creates Markdown and canonical JSON **locally** from one durably admitted finding and admitted evidence. Generation does not request or consume approval: the exact bytes, citation manifest, and redaction manifest must exist before a provider human can approve them.

## Report gate

The validator rejects a report unless it contains:

- exactly one root-cause claim;
- an attacker, at least one precondition, and the affected asset;
- realized (not merely unknown/hypothetical) impact;
- admitted raw-proof references for every citation;
- at least one remediation;
- an explicit unique/duplicate/unknown deduplication result;
- severity no higher than every severity-rationale citation supports.

Every claim has admitted evidence IDs, an explicit uncertainty status and detail, and exact redaction IDs. Confidential evidence must have an admitted redacted hash and each claim using it must reference its redaction entry. The renderer carries those qualifications into both output formats rather than making uncertain language definite or restoring redacted material.

The production store resolves `bounty_finding_admissions` and `bounty_evidence` in the draft transaction. A `draft.release` decision is not consulted during generation.

## Exact readiness and edits

A generated revision starts as `draft-unreleased`. Its bundle hash binds:

- exact UTF-8 Markdown bytes and hash;
- exact canonical JSON bytes and hash;
- citation manifest and hash;
- redaction manifest and hash;
- finding admission decision, report policy, and revision.

A provider-human `draft.release` receipt must target that exact bundle, policy hash, and revision. Consumption appends an immutable `submission-ready` fact. Draft and release rows cannot be updated or deleted. Any edit therefore creates a new `draft-unreleased` revision with a different bundle hash and requires a new exact provider-human decision. `submission-ready` means only that a human judged the immutable draft ready.

## Capability and submission boundary

`BOUNTY_REPORT_OPERATION_INVENTORY` closes transitively over validation, local rendering, local persistence, and readiness marking. The reporter runtime has local compute only. It has no network, broker, browser, credential, clipboard, email, chat, platform, or subprocess capability. `BOUNTY_REPORT_PUBLIC_TOOL_INVENTORY` is deliberately empty and an executable assertion rejects forbidden or submission-like operations.

There is no report submission route, MCP/public tool, adapter, destination, delivery outbox, platform account, or indirect submit operation. External bug-bounty platform submission is always a separate manual human action outside Rorca.
