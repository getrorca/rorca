/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import simpleGit from 'simple-git';
import { chatComplete } from './llm-client';

export interface GitChunkSummary {
  fromHash: string;
  toHash: string;
  commitCount: number;
  summary: string;
}

export interface GitMapOptions {
  workspacePath: string;
  fromHash?: string;
  maxCommits?: number;
  chunkSize?: number;
  concurrency?: number;
}

const MAP_PROMPT = `You are analyzing a chunk of git commit history.

Extract ONLY information that would help an AI generate better code for this project:
- Major architectural decisions (e.g. "switched from Prisma to raw SQL")
- Recurring bug patterns that were fixed (e.g. "multiple fixes for timezone handling")
- Naming conventions established (e.g. "amount fields use cents not dollars")
- Deleted features or abandoned approaches
- Security or performance constraints added

Ignore: typos, formatting, dependency bumps, merge commits, minor refactors.
Respond with plain text bullet points only. Max 10 bullets.
If nothing significant, respond: "No significant architectural changes in this chunk."`;

export async function gitMapStep(
  options: GitMapOptions
): Promise<GitChunkSummary[]> {
  const {
    workspacePath,
    fromHash,
    maxCommits = 1000,
    chunkSize = 50,
    concurrency = 5,
  } = options;

  const git = simpleGit(workspacePath);

  const isRepo = await git.checkIsRepo();
  if (!isRepo) throw new Error(`Not a git repository: ${workspacePath}`);

  const logArgs: string[] = ['--oneline', `--max-count=${maxCommits}`];
  if (fromHash) logArgs.push(`${fromHash}..HEAD`);
  const logResult = await git.raw(['log', ...logArgs]);

  const commitLines = logResult.trim().split('\n').filter(Boolean);
  if (commitLines.length === 0) return [];

  // Process oldest-first (chronological)
  commitLines.reverse();

  // Chunk commits
  const chunks: string[][] = [];
  for (let i = 0; i < commitLines.length; i += chunkSize) {
    chunks.push(commitLines.slice(i, i + chunkSize));
  }

  // Process chunks with concurrency-limited batched Promise.all
  const results: GitChunkSummary[] = [];

  for (let i = 0; i < chunks.length; i += concurrency) {
    const batch = chunks.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (chunk) => {
        const fromLine = chunk[0];
        const toLine = chunk[chunk.length - 1];
        const fromH = fromLine.split(' ')[0];
        const toH = toLine.split(' ')[0];

        // Use --stat (not --patch) to avoid token explosion
        const statOutput = await git
          .raw(['log', '--stat', '--no-merges', `${fromH}~1..${toH}`])
          .catch(() => chunk.join('\n'));

        // Truncate to 8000 chars to stay within cheap model token budget
        const truncated = statOutput.slice(0, 8000);

        const summaryResult = await chatComplete(
          [
            {
              role: 'user',
              content: `${MAP_PROMPT}\n\n---\nCOMMIT HISTORY:\n${truncated}`,
            },
          ]
        );

        return {
          fromHash: fromH,
          toHash: toH,
          commitCount: chunk.length,
          summary: summaryResult.text,
        };
      })
    );
    results.push(...batchResults);
  }

  return results;
}

export function getLatestHash(summaries: GitChunkSummary[]): string | null {
  if (summaries.length === 0) return null;
  return summaries[summaries.length - 1].toHash;
}

// --- Reduce Step ---

export interface GitReduceOptions {
  summaries: GitChunkSummary[];
  workspaceLabel: string;
}

const REDUCE_PROMPT = `You are synthesizing multiple git history summaries into a single, dense project memory document.
Output valid YAML. Use these top-level keys:

architectural_decisions:  # List of major tech choices and why
  - description: ...
    evidence: ...          # commit reference or pattern

bug_patterns:             # Recurring problems that were fixed
  - pattern: ...
    example: ...

conventions:              # Naming, data format, coding style rules discovered
  - rule: ...

avoid:                    # Approaches that were tried and abandoned
  - approach: ...
    reason: ...

Do NOT include: trivial refactors, dependency updates, formatting.
Be dense — this YAML will be injected into every future spec generation for this project.`;

export async function gitReduceStep(
  options: GitReduceOptions
): Promise<string> {
  const { summaries, workspaceLabel } = options;

  if (summaries.length === 0) return '';

  // Filter out "no significant changes" summaries
  const meaningful = summaries.filter(
    (s) => !s.summary.toLowerCase().includes('no significant')
  );
  if (meaningful.length === 0)
    return '# No significant architectural patterns detected.';

  const combinedSummaries = meaningful
    .map(
      (s, i) => `## Chunk ${i + 1} (${s.commitCount} commits)\n${s.summary}`
    )
    .join('\n\n');

  const prompt = `${REDUCE_PROMPT}\n\nProject: ${workspaceLabel}\n\nGit history summaries:\n${combinedSummaries}`;

  const result = await chatComplete(
    [{ role: 'user', content: prompt }]
  );
  return result.text;
}
