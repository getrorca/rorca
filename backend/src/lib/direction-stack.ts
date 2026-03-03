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

export interface SynthesizeMeta {
  standards: boolean;
  conventions: boolean;
  project: boolean;
  memory: boolean;
  schema: boolean;
  totalTokens: number;
}

export interface SynthesizeResult {
  text: string;
  meta: SynthesizeMeta;
}

export function synthesize(params: SynthesizeParams): string {
  return synthesizeWithMeta(params).text;
}

export function synthesizeWithMeta(params: SynthesizeParams): SynthesizeResult {
  const sections: string[] = [];
  const effectiveL1 = params.teamL1?.trim() || params.l1?.trim();
  const effectiveL2 = params.teamL2?.trim() || params.l2?.trim();
  if (effectiveL1) sections.push(`=== GLOBAL STANDARDS (L1) ===\n${effectiveL1}`);
  if (effectiveL2) sections.push(`=== DOMAIN PROFILE (L2) ===\n${effectiveL2}`);
  if (params.l3?.trim()) sections.push(`=== PROJECT CONTEXT (L3) ===\n${params.l3.trim()}`);
  if (params.schemaSnapshot?.trim()) {
    sections.push(`=== DATABASE SCHEMA (Auto-Hydrated) ===\n${params.schemaSnapshot.trim()}`);
  }
  if (params.gitMemory?.trim()) {
    sections.push(`=== PROJECT MEMORY (Git History) ===\n${params.gitMemory.trim()}`);
  }
  sections.push(`=== SPEC BRIEF (L4) ===\n${params.specBrief.trim()}`);
  if (params.storyAnnotations?.trim()) sections.push(`=== STORY ANNOTATIONS (L5) ===\n${params.storyAnnotations.trim()}`);

  const text = sections.join('\n\n');
  // Rough token estimate: ~4 chars per token
  const totalTokens = Math.ceil(text.length / 4);

  return {
    text,
    meta: {
      standards: !!effectiveL1,
      conventions: !!effectiveL2,
      project: !!params.l3?.trim(),
      memory: !!params.gitMemory?.trim(),
      schema: !!params.schemaSnapshot?.trim(),
      totalTokens,
    },
  };
}
