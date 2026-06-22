/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PersistedPostSavePolicyMetadata } from './post-save-policy';

export interface DiagramOutput {
  mermaid: string;
  ascii: string;
}

export interface SuggestedSkill {
  name: string;
  relevance: number; // 1-10
  reason: string;
}

export interface GeneratedStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  complexity?: number;
  priority?: number;  // 1=urgent, 2=high, 3=normal (default), 4=low
  timeoutMinutes?: number;  // 5-120, default 45
  suggestedSkills?: SuggestedSkill[];
  suggestedPersona?: string;
  suggestedReviewers?: string[];
}

export interface ContextUsedMeta {
  standards: boolean;     // L1 was present
  conventions: boolean;   // L2 was present
  project: boolean;       // L3 was present
  memory: boolean;        // memory entries were present
  schema: boolean;        // schemaSnapshot was present
  scopesMatched: string[];
  totalTokens: number;
}

export interface ContextUsed {
  text: string;
  meta: ContextUsedMeta;
}

export interface SpecReasoning {
  enabled: boolean;
  effort?: string;
}

export interface GeneratedSpec {
  title: string;
  slug: string;
  stories: GeneratedStory[];
  diagrams: Record<string, DiagramOutput>;
  mermaidDiagram?: string;
  model?: string;
  contextUsed?: ContextUsed;
  contextSummary?: Record<string, unknown>;
  reasoning?: SpecReasoning;
  source?: string;
  postSavePolicy?: PersistedPostSavePolicyMetadata;
}

export interface WriteResult {
  specPath: string;
  diagramsPath: string;
}

export function writeSpec(workspacePath: string, spec: GeneratedSpec): WriteResult {
  const pendingDir = path.join(workspacePath, 'forge', 'specs', 'pending');
  const specPath = path.join(pendingDir, `${spec.slug}.json`);
  const diagramsPath = path.join(pendingDir, `${spec.slug}-diagrams.md`);

  if (fs.existsSync(specPath)) {
    throw new Error(`Spec '${spec.slug}' already exists at ${specPath}. Delete it first or use a different title.`);
  }

  fs.mkdirSync(pendingDir, { recursive: true });

  // Write spec in run-loop.sh compatible format
  const specJson: Record<string, unknown> = {
    title: spec.title,
    generatedAt: new Date().toISOString(),
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.reasoning ? { reasoning: spec.reasoning } : {}),
    autoWorktree: true,
    userStories: spec.stories.map(s => ({
      id: s.id,
      title: s.title,
      description: s.description,
      acceptanceCriteria: s.acceptanceCriteria,
      dependsOn: s.dependsOn,
      ...(s.complexity != null ? { complexity: s.complexity } : {}),
      ...(s.priority != null ? { priority: s.priority } : {}),
      ...(s.timeoutMinutes != null ? { timeoutMinutes: s.timeoutMinutes } : {}),
      ...(s.suggestedSkills?.length ? { suggestedSkills: s.suggestedSkills } : {}),
      ...(s.suggestedPersona ? { suggestedPersona: s.suggestedPersona } : {}),
      ...(s.suggestedReviewers?.length ? { suggestedReviewers: s.suggestedReviewers } : {}),
      passes: false
    })),
    ...(spec.mermaidDiagram ? { mermaidDiagram: spec.mermaidDiagram } : {}),
    ...(spec.contextUsed ? { contextUsed: spec.contextUsed } : {}),
    ...(spec.contextSummary ? { contextSummary: spec.contextSummary } : {}),
    ...(spec.source ? { source: spec.source } : {}),
    ...(spec.postSavePolicy ? { postSavePolicy: spec.postSavePolicy } : {}),
  };
  fs.writeFileSync(specPath, JSON.stringify(specJson, null, 2), 'utf8');

  // Write diagrams as markdown
  const diagramSections = Object.entries(spec.diagrams).map(([type, output]) =>
    `## ${type}\n\n### Mermaid\n\`\`\`mermaid\n${output.mermaid}\n\`\`\`\n\n### ASCII\n\`\`\`\n${output.ascii}\n\`\`\``
  ).join('\n\n');
  const diagramsMd = `# ${spec.title} — Diagrams\n\nGenerated: ${new Date().toISOString()}\n\n${diagramSections}\n`;
  fs.writeFileSync(diagramsPath, diagramsMd, 'utf8');

  return { specPath, diagramsPath };
}
