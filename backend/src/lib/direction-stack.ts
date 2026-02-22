export interface SynthesizeParams {
  l1?: string;           // Global Brain YAML
  l2?: string;           // Domain Profile YAML
  l3?: string;           // Project Brief YAML
  specBrief: string;     // L4 — always required
  storyAnnotations?: string; // L5 — optional per-story overrides
  // Auto-injected by hydration engine:
  schemaSnapshot?: string;  // Raw CREATE TABLE blocks
  gitMemory?: string;       // Synthesized memory.yaml
}

export function synthesize(params: SynthesizeParams): string {
  const sections: string[] = [];
  if (params.l1?.trim()) sections.push(`=== GLOBAL STANDARDS (L1) ===\n${params.l1.trim()}`);
  if (params.l2?.trim()) sections.push(`=== DOMAIN PROFILE (L2) ===\n${params.l2.trim()}`);
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
