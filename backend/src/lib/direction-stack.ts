export interface SynthesizeParams {
  l1?: string;           // Global Brain YAML
  l2?: string;           // Domain Profile YAML
  l3?: string;           // Project Brief YAML
  specBrief: string;     // L4 — always required
  storyAnnotations?: string; // L5 — optional per-story overrides
}

export function synthesize(params: SynthesizeParams): string {
  const sections: string[] = [];
  if (params.l1?.trim()) sections.push(`=== GLOBAL STANDARDS (L1) ===\n${params.l1.trim()}`);
  if (params.l2?.trim()) sections.push(`=== DOMAIN PROFILE (L2) ===\n${params.l2.trim()}`);
  if (params.l3?.trim()) sections.push(`=== PROJECT CONTEXT (L3) ===\n${params.l3.trim()}`);
  sections.push(`=== SPEC BRIEF (L4) ===\n${params.specBrief.trim()}`);
  if (params.storyAnnotations?.trim()) sections.push(`=== STORY ANNOTATIONS (L5) ===\n${params.storyAnnotations.trim()}`);
  return sections.join('\n\n');
}
