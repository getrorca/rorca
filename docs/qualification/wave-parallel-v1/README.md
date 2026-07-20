# Wave-parallel production qualification v1

Status: version 1, fail closed. This documentation set defines qualification, production governance, and executable traceability for the canonical WPE-001 through WPE-012 specification.

- [Immutable canonical requirements artifact](./requirements.json)
- [Architecture](./architecture.md)
- [State machine and invariants](./state-machine-invariants.md)
- [Qualification procedure](./qualification.md)
- [Threat model](./threat-model.md)
- [Operations](./operations.md)
- [Rollout](./rollout.md)
- [Recovery](./recovery.md)
- [Machine cross-reference](./cross-reference.json)

`requirements.json` is the checked-in immutable extraction of all 125 canonical acceptance criteria. It assigns stable `WPE-XXX-RYY` IDs and pins both the raw source-spec SHA-256 and a canonical requirements-content digest. `cross-reference.json` contains exactly one requirement → invariant → scenario → assertion → evidence mapping for each ID and pins the local artifact hash.

Run `npm run check:wave-invariants` to verify the invariant registry, exact story/criterion counts, source and artifact integrity, complete duplicate-free cross-reference coverage, and the evidence-class taxonomy. CI needs only these checked-in files; it never reads the original external spec path. The Markdown files explain operation; they do not replace canonical JSON, durable WAL/database records, Git proof, canary/soak or rollback-rehearsal artifacts, or independent-checker verdicts.
