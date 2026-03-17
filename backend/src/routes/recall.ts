Both merge conflicts are resolved:

1. **`recall.ts`** — was already clean in the working tree (both sides added the same content). Staged it to mark as resolved.
2. **`recall-types.ts`** — the HEAD version was corrupted (contained a prose description instead of code). Replaced it with the actual TypeScript code from MERGE_HEAD, which has the full type definitions (`RunSummary`, `ActiveRun`, `SkillPreview`, `WorkspaceMetadata`, `RecallResponse`, `RecallMeta`, `RetrievalTier`, and the Zod `RecallQuerySchema`).

All conflicts are fixed. You can now run `git commit` to conclude the merge.
