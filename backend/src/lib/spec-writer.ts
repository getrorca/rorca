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

export interface GenesisProvenance {
  packageId: string;
  packageHash: string;
  contentHash: string;
  canonicalStore: 'pglite+genesis-vault' | 'pglite+pgvector+genesis-vault' | 'pglite+vault' | 'genesis-pglite-and-local-vault';
  citationSummary: string;
  warningCount: number;
  skippedEvidenceCount: number;
  freshnessTs: string;
  bridgeVersion: string;
  [key: string]: unknown;
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
  genesis?: GenesisProvenance;
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
  authoring?: Record<string, unknown>;
}

export interface WriteResult {
  id: string;
  specPath: string;
  diagramsPath: string;
}

export function buildSpecDocument(spec: GeneratedSpec, generatedAt = new Date().toISOString()): Record<string, unknown> {
  const canonicalSlug = spec.slug;
  return {
    id: canonicalSlug,
    slug: canonicalSlug,
    title: spec.title,
    generatedAt,
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
    ...(spec.authoring ? { authoring: spec.authoring } : {}),
  };
}

export function buildSpecDiagramsDocument(spec: GeneratedSpec, generatedAt = new Date().toISOString()): string {
  const diagramSections = Object.entries(spec.diagrams).map(([type, output]) =>
    `## ${type}\n\n### Mermaid\n\`\`\`mermaid\n${output.mermaid}\n\`\`\`\n\n### ASCII\n\`\`\`\n${output.ascii}\n\`\`\``
  ).join('\n\n');
  return `# ${spec.title} — Diagrams\n\nGenerated: ${generatedAt}\n\n${diagramSections}\n`;
}

function specWriterFailpoint(name: string): void {
  if (process.env.NODE_ENV === 'test' && process.env.RORCA_AUTHORING_FAILPOINT === name) {
    throw new Error(`[authoring-failpoint] ${name}`);
  }
}

function publishFile(targetPath: string, content: string): void {
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const descriptor = fs.openSync(temporaryPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporaryPath, targetPath);
    const directoryDescriptor = fs.openSync(path.dirname(targetPath), fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch { /* best-effort removal of an unpublished temp file */ }
    throw error;
  }
}

export function writeSpecDiagramArtifact(workspacePath: string, spec: GeneratedSpec): string {
  const diagramsPath = path.join(workspacePath, 'forge', 'specs', 'pending', `${spec.slug}-diagrams.md`);
  fs.mkdirSync(path.dirname(diagramsPath), { recursive: true });
  publishFile(diagramsPath, buildSpecDiagramsDocument(spec));
  return diagramsPath;
}

export function writeSpec(workspacePath: string, spec: GeneratedSpec): WriteResult {
  const pendingDir = path.join(workspacePath, 'forge', 'specs', 'pending');
  const specPath = path.join(pendingDir, `${spec.slug}.json`);
  const diagramsPath = path.join(pendingDir, `${spec.slug}-diagrams.md`);
  const canonicalSlug = path.basename(specPath, '.json');

  if (fs.existsSync(specPath)) {
    throw new Error(`Spec '${spec.slug}' already exists at ${specPath}. Delete it first or use a different title.`);
  }

  fs.mkdirSync(pendingDir, { recursive: true });
  publishFile(specPath, JSON.stringify(buildSpecDocument({ ...spec, slug: canonicalSlug }), null, 2));
  specWriterFailpoint('persist_after_spec_file_before_diagram');
  publishFile(diagramsPath, buildSpecDiagramsDocument(spec));

  return { id: canonicalSlug, specPath, diagramsPath };
}
