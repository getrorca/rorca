# Architecture v1

A qualification has four one-way boundaries:

1. the isolated fixture/model runtime emits normalized assertions, never raw prompts, payloads, stacks, credentials, or terminal transcripts;
2. `wave-qualification-evidence.ts` admits enumerated fields, hashes local identities, bounds cardinality, canonicalizes keys, and derives production-gate availability;
3. a trusted issuer authenticates the canonical report hash in a strict receipt;
4. the admin publication route recomputes Git/workspace and versioned file digests, verifies expiry/scenarios/signature, then appends the receipt to immutable storage.

The canonical JSON report body is hashed independently of the receipt, avoiding a circular signature. The artifact envelope, receipt JSON, and Markdown are deterministic from the same normalized inputs. Local filesystem paths are used only while recomputing identity and never cross the portable boundary.

The append-only database table is historical evidence, not run authority. `run_closeout` plus validated exactly-once integration evidence remains the source of run success. A receipt can only make the separate production-enable gate available after that authority is already successful.
