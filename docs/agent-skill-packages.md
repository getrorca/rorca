# Portable Agent Skill packages

Rorca supports standard directory Agent Skills and its legacy flat Markdown format at the same time.

## Install and configure a shared canon

`@rorca/engineering-canon` is optional and deliberately is **not** a production dependency of Rorca. Install a published package in an operator-managed location, then configure that installed package root in the workspace's `.rorca/config.json`:

```json
{
  "engineeringCanon": {
    "enabled": true,
    "packageRoot": "/operator/configured/install/node_modules/@rorca/engineering-canon",
    "skillRoot": "skills",
    "tokenBudget": 8000,
    "reservedTokens": 1000
  }
}
```

The adapter defaults to disabled so existing workspaces remain unchanged; enable it explicitly after installation. `RORCA_ENGINEERING_CANON_PACKAGE_ROOT` is an operational override when `packageRoot` is omitted. Never commit a machine-specific path. The adapter validates the exact package name, rejects symlink roots and path escape, imports only the package's public ESM resolver, and discovers only its configured skill tree. A normal package-manager install supplies transitive dependencies; Rorca manifests and lockfiles contain no unpublished `file:` dependency.

Rorca still supports reviewed workspace copies under `.rorca/skills` for legacy deployments, but copied files have no package resolver/receipt identity and should be migrated to the configured adapter. Do not symlink `.rorca/skills`, `.claude/skills`, or a nested package. Rorca rejects symbolic-link roots, nested symlinks, and resolved paths that escape an allowed root.

Rorca discovers recursively nested `SKILL.md` files. It does **not** register other package Markdown, references, assets, fixtures, or scripts as skills. At execution, only the selected exact entrypoint body is injected. The package root is retained for explicit progressive disclosure, but support files are not loaded and scripts are never run merely because they exist.

## Frontmatter and optional eligibility

`name` and `description` are required for directory packages. Put Rorca hints inside the standard Agent Skills `metadata` field:

```yaml
---
name: architecture-review
description: Reviews architecture decisions for high-risk SDD work.
metadata:
  rorca:
    phases: [architecture_review, implementation_review]
    artifact-types: [sdd, code]
    risk-levels: [high, critical]
    priority: required
    scope: specialist
    appliesToStages: [design]
    enforcement: required
---
```

Portable flat aliases such as `rorca.phases`, `rorca.artifacts`, and `rorca.risks` are also accepted. Values may be YAML arrays or comma-separated strings.

### Universal scope, stage applicability, and enforcement

Three Rorca fields control how a skill is injected across the 7-stage SSDLC (`general-sdlc-7`: `planning`, `requirements`, `design`, `development`, `testing`, `deployment`, `maintenance`):

- `scope` (`universal` | `specialist`): `universal` skills are always selected within the token budget for their applicable stages; `specialist` skills (or skills without a scope) stay LLM-reranked over the deterministic eligible set. Pi/OMP runs receive universal skill text through the direction-stack context path.
- `appliesToStages` (array of general-sdlc-7 stage ids): the stages a universal skill applies to. An unknown stage id — including a legacy six-stage id such as `build`, `verify`, or `release` — rejects the entrypoint with an `invalid-metadata` validation warning instead of broadening the skill into an unconstrained one.
- `enforcement` (`advisory` | `required`): injection-priority hint only. `required` reserves injection budget **after** the skill was selected; it never auto-selects a skill and never creates a policy gate.

The stage ids come from the canonical `general-sdlc-7` profile (version 1,
`backend/src/ssdlc/profiles/general-sdlc-7.ts`), which projects the 11 canonical
phases onto exactly seven stages:

| Stage | Phase categories |
|---|---|
| planning | intake |
| requirements | requirements |
| design | architecture |
| development | implementation |
| testing | validation, security, qa |
| deployment | staging, merge, production |
| maintenance | learn |

`appliesToStages` accepts exactly these ids; `backend/src/ssdlc/schema/control-schema.ts`
derives its phase→stage mapping from the same profile, so skills and the lifecycle
projection can never disagree about what a stage contains. Stage derivation for
universal auto-injection first maps review-style phases (`implementation_review`,
`validation_review`) to their canonical phase and then projects to the stage
(`deriveSdlcStageIds` in `backend/src/lib/skill-execution.ts`).

Both nested (`metadata.rorca.*`) and portable flat aliases (`rorca.scope`, `rorca.appliesToStages`, `rorca.enforcement`) are accepted. The parsed values persist on skill metadata and are listed in the catalog prompt (`scope=…; stages=…; enforcement=…`).

Selector rules are deterministic:

- every populated selector dimension must intersect the story/spec context;
- a missing constrained phase, artifact, or risk makes that skill ineligible;
- story fields and `phase:*`, `artifact:*`, and `risk:*` tags provide explicit context;
- normal implementation matching defaults to `implementation_review`; QA/journey matching defaults to `validation_review`;
- an LLM may rerank only the eligible names shown for that story;
- unknown, malformed, disabled, or ineligible names are stripped after ranking;
- malformed selector values reject the entrypoint instead of broadening it into an unconstrained skill;
- matching and execution share the same phase/artifact/risk fields and tag interpretation.

`priority: required` reserves injection budget **only after the skill was selected**. It does not auto-select guidance or create a policy gate. `enforcement: required` behaves the same way — it reserves budget after selection but never creates a gate; advisory and required skills are selected identically. Rorca preserves arbitrary metadata for portability but ignores governance claims; application-owned governance remains authoritative.

## Baseline universal pack

Rorca ships a baseline universal pack under `.rorca/skills/universal/` with four `scope: universal` skills that apply to all seven general-sdlc-7 stages (`appliesToStages` lists every stage id) with `enforcement: required`:

| Skill | Guidance |
|---|---|
| `evidence-discipline` | Every claim and closeout carries concrete, re-runnable evidence — commands, outputs, file references. |
| `reversible-changes` | Small revertible steps; destructive actions require explicit confirmation and a named rollback path. |
| `no-placeholder-delivery` | Never present stubs, TODOs, mocked fallbacks, or scaffolds as delivered work; verify the real run. |
| `traceability` | Every change and artifact links back to its story requirement and acceptance criterion. |

The pack is discovered like any other `.rorca/skills` package, so workspaces rooted at a Rorca checkout receive the four universal skills automatically within the token budget. Copy or extend these packages rather than renaming them — skill names are the stable reference.

## Compatibility and precedence

Legacy files continue to work:

```text
.rorca/skills/security.md
.claude/skills/security.md
```

Resolution is deterministic:

1. `.rorca/skills` before `.claude/skills`;
2. standard `SKILL.md` packages before flat Markdown within one root;
3. lexical root-relative path as the final filesystem tie-breaker;
4. DB-only installed skills last.

The winner is used and every shadowed duplicate produces a warning naming the winner. Skill names remain the stable spec/API reference; execution resolves that name back through the registry identity and exact canonical entrypoint rather than constructing a filename.

Claude native discovery recognizes both `.claude/skills/<name>.md` and `.claude/skills/<name>/SKILL.md`. Inline injection is suppressed only when the deterministic winner itself is Claude-native; a differing lower-precedence Claude candidate never discards the Rorca winner. Pi receives exact matched entrypoints through its existing repeatable `--skill` option. OpenCode and Codex retain their existing Rorca prompt/native-context behavior; Rorca does not invent unsupported CLI flags.

## Bounded coverage and trust boundaries

Before matching/readiness and pipeline dispatch, Rorca constructs a strict task-scoped request from canonical spec/story/run metadata. It passes only known taxonomy values for lifecycle phase, artifact, risk, changed surfaces, technologies, domains, obligations, operation, evidence classes, active skills, approved domain authorities, approved N/A confirmations, approved Genesis package references, compatibility, and token budget. Absent optional dimensions remain empty. Any explicitly declared unknown taxonomy value—including a mixed known/unknown dimension—returns `request_incomplete`, as does an absent required phase/artifact/operation identity; Rorca never narrows that input or substitutes a claim of sufficiency.

The package resolver owns deterministic overlay precedence, conflict/version checks, token accounting, and receipt hashing. Rorca exposes a bounded projection: status, selected layers and hashes, covered/uncovered cells, omissions, authority/evidence reference counts, compatibility, versions, receipt hash, and safe next actions. Raw restricted evidence is never passed or returned. Spec-authored `approved`/`redacted` booleans are ignored. Evidence, domain authorities, and N/A confirmations remain empty unless an authoritative store adapter is available; this release intentionally does not expose a structural caller input that could self-attest approval. Genesis evidence may enter only after a host verifies a published approved export package, with `approved_export_only` provenance and redacted chunk IDs. Until then, the resulting gap remains visible.

The current package's 43 skills are all review candidates. Frontmatter cannot self-promote a canon skill: even `active` plus a receipt-shaped string remains unselectable until an authoritative host verifier marks that receipt verified. They remain discoverable with lifecycle metadata, but candidate/draft/deprecated/superseded skills and active canon skills without genuine promotion receipts are excluded from catalogs, matching, inline injection, Pi `--skill` arguments, and execution. Existing non-canon skills without lifecycle metadata remain backward-compatible active guidance. An LLM can rerank only the deterministic selectable set; it cannot close a coverage gap, invent a skill, promote a candidate, establish domain authority, or create evidence.

Coverage diagnostics are advisory unless an existing governed lifecycle policy maps the underlying requirement to a blocking gate. Rorca does not add a parallel gate. `run_anyway` can bypass only the pre-existing operational readiness gate where already permitted; it cannot change a receipt, activate a skill, approve authority/evidence, or manufacture a confirmation.

Stable diagnostics include `engineering_canon_unavailable`, `missing_required_skill`, `missing_domain_authority`, `insufficient_evidence`, `canon_compatibility_conflict`, and `canon_token_omission`. Safe actions point to configuration, human review/promotion, approved authority/evidence, compatibility repair, or a narrower/larger bounded token allocation.

### Migration

1. Install a published compatible canon package; do not add a local `file:` dependency.
2. Configure `packageRoot` outside committed shared configuration (or use the environment override).
3. Inspect `/api/workspaces/{id}/skills` and spec readiness. Confirm 43 candidates are visible and `selectable: false` until genuine promotion.
4. Keep existing legacy active skills during migration; they continue to match and execute.
5. Review deterministic receipts and resolve gaps. Do not copy candidate status into an active record.
6. Remove old copied canon entrypoints only after specs/runs no longer reference them. Package support files always require explicit operator cleanup.

## Safe degradation

- An absent, disabled, invalid, incompatible, or failed optional resolver returns explicit degraded coverage with `receipt: null` and `compatible: false`; it never reports sufficient.
- Entry points larger than 256 KiB, malformed packages, empty guidance, unreadable files, nested symlinks, and path escapes are skipped with diagnostics.
- Discovery is depth/entry bounded.
- Prompt budgeting includes headers, exact entrypoint/package provenance, progressive-disclosure instructions, and bounded omission notes—not only the guidance body. It skips an item that does not fit, continues to later smaller guidance, logs every omission, and keeps the complete injected section within budget.
- Removing a package skill through the general skills API removes only validated entrypoints. Package support files require explicit operator cleanup.
