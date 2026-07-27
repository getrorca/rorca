# Portable Agent Skill packages

Rorca supports standard directory Agent Skills and its legacy flat Markdown format at the same time.

## Install a shared canon

A portable package entrypoint must be named `SKILL.md`:

```text
.rorca/skills/
  engineering-canon/
    architecture/
      architecture-review/
        SKILL.md
        references/...
        assets/...
        scripts/...
```

For an installed `@rorca/engineering-canon` package, copy its skill tree into the workspace:

```bash
mkdir -p .rorca/skills/engineering-canon
cp -R node_modules/@rorca/engineering-canon/skills/. .rorca/skills/engineering-canon/
```

Copy the tree; do not use a nested symlink to a directory outside the allowed skill root. Rorca rejects nested symlinks and resolved paths that escape `.rorca/skills` or `.claude/skills`. An operator can repeat the copy during package upgrades.

Rorca discovers recursively nested `SKILL.md` files. It does **not** register other package Markdown, references, assets, or scripts as skills. At execution, only the matched entrypoint guidance is injected. The package root is included so a capable agent can open a referenced file on demand. Merely installing or discovering a script never executes it.

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
---
```

Portable flat aliases such as `rorca.phases`, `rorca.artifacts`, and `rorca.risks` are also accepted. Values may be YAML arrays or comma-separated strings.

Selector rules are deterministic:

- every populated selector dimension must intersect the story/spec context;
- a missing constrained phase, artifact, or risk makes that skill ineligible;
- story fields and `phase:*`, `artifact:*`, and `risk:*` tags provide explicit context;
- normal implementation matching defaults to `implementation_review`; QA/journey matching defaults to `validation_review`;
- an LLM may rerank only the eligible names shown for that story;
- unknown, malformed, disabled, or ineligible names are stripped after ranking.

`priority: required` reserves injection budget **only after the skill was selected**. It does not auto-select guidance or create a policy gate. Rorca preserves arbitrary metadata for portability but ignores enforcement/governance claims; application-owned governance remains authoritative.

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

Claude duplicate suppression recognizes both `.claude/skills/<name>.md` and `.claude/skills/<name>/SKILL.md`. Pi receives exact matched entrypoints through its existing repeatable `--skill` option. OpenCode and Codex retain their existing Rorca prompt/native-context behavior; Rorca does not invent unsupported CLI flags.

## Safe degradation

- Entry points larger than 256 KiB, malformed packages, empty guidance, unreadable files, nested symlinks, and path escapes are skipped with diagnostics.
- Discovery is depth/entry bounded.
- Prompt budgeting skips an item that does not fit and continues to later smaller guidance; omissions are logged and included in prompt loading notes.
- Removing a package skill through the general skills API removes only validated entrypoints. Package support files require explicit operator cleanup.
