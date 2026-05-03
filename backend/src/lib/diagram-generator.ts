/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

export interface GeneratedStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
}

export interface DiagramOutput {
  mermaid: string;
  ascii: string;
}

export function generateStoryDepsDiagram(stories: GeneratedStory[]): DiagramOutput {
  const hasDeps = stories.some(s => s.dependsOn && s.dependsOn.length > 0);

  if (!hasDeps) {
    return {
      mermaid: 'graph LR\n  start([All stories are independent])',
      ascii: 'All stories are independent (no dependencies declared)'
    };
  }

  const mermaidLines = ['graph LR'];
  for (const story of stories) {
    mermaidLines.push(`  ${story.id}["${story.id}"]`);
  }
  for (const story of stories) {
    for (const dep of (story.dependsOn || [])) {
      mermaidLines.push(`  ${dep} --> ${story.id}`);
    }
  }

  const asciiLines: string[] = [];
  const roots = stories.filter(s => !s.dependsOn || s.dependsOn.length === 0);
  const visited = new Set<string>();

  function walk(id: string, depth: number) {
    if (visited.has(id)) return;
    visited.add(id);
    const prefix = depth === 0 ? '' : '  '.repeat(depth) + '└─ ';
    asciiLines.push(prefix + id);
    const children = stories.filter(s => s.dependsOn?.includes(id));
    for (const child of children) walk(child.id, depth + 1);
  }

  for (const root of roots) walk(root.id, 0);

  for (const story of stories) {
    if (!visited.has(story.id)) asciiLines.push(story.id + ' (orphaned)');
  }

  return { mermaid: mermaidLines.join('\n'), ascii: asciiLines.join('\n') };
}

export type DiagramType = 'storyDeps' | 'architecture' | 'userFlow' | 'dataFlow' | 'erd';

export function generateDiagramBundle(
  stories: GeneratedStory[],
  requestedTypes: DiagramType[]
): Record<string, DiagramOutput> {
  const bundle: Record<string, DiagramOutput> = {};

  bundle.storyDeps = generateStoryDepsDiagram(stories);

  for (const type of requestedTypes) {
    if (type !== 'storyDeps') {
      bundle[type] = {
        mermaid: `%% ${type} diagram — LLM generation added in Phase 2`,
        ascii: `[ ${type} diagram — LLM generation added in Phase 2 ]`
      };
    }
  }

  return bundle;
}
