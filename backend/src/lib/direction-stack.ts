export interface SynthesizeParams {
  l1?: string;           // Global Brain YAML
  l2?: string;           // Domain Profile YAML
  l3?: string;           // Project Brief YAML
  specBrief: string;     // L4 — always required
  storyAnnotations?: string; // L5 — optional per-story overrides
  // Team-scoped layers (override global, overridden by workspace)
  teamL1?: string;       // Team-level L1 override
  teamL2?: string;       // Team-level L2 override
  // Auto-injected by hydration engine:
  schemaSnapshot?: string;  // Raw CREATE TABLE blocks
  gitMemory?: string;       // Synthesized memory.yaml
}

export function synthesize(params: SynthesizeParams): string {
  const sections: string[] = [];
  // Team L1 overrides global L1; if no team L1, fall back to global
  const effectiveL1 = params.teamL1?.trim() || params.l1?.trim();
  const effectiveL2 = params.teamL2?.trim() || params.l2?.trim();
  if (effectiveL1) sections.push(`=== GLOBAL STANDARDS (L1) ===\n${effectiveL1}`);
  if (effectiveL2) sections.push(`=== DOMAIN PROFILE (L2) ===\n${effectiveL2}`);
  if (params.l3?.trim()) sections.push(`=== PROJECT CONTEXT (L3) ===\n${params.l3.trim()}`);
  // Auto-hydrated sections (injected when workspace has been hydrated)
  if (params.schemaSnapshot?.trim()) {
    sections.push(`=== DATABASE SCHEMA (Auto-Hydrated) ===\n${params.schemaSnapshot.trim()}`);
  }
  if (params.gitMemory?.trim()) {
    sections.push(`=== PROJECT MEMORY (Git History) ===\n${params.gitMemory.trim()}`);
  }
  sections.push(`=== SPEC BRIEF (L4) ===\n${params.specBrief.trim()}`);
  if (params.storyAnnotations?.trim()) sections.push(`=== STORY ANNOTATIONS (L5) ===\n${params.storyAnnotations.trim()}`);
  return sections.join('\n\n');
}
