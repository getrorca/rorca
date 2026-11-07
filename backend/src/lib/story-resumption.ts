/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

/** Resolve a bounded, exact-story commit chain for a one-story recovery run. */

import { execFileSync } from 'node:child_process';

const SHA_1 = /^[0-9a-f]{40}$/;
const MAX_RETAINED_STORY_COMMITS = 32;

export interface RetainedStoryResumption {
  /** Parent of the oldest retained commit; use as the closeout diff baseline. */
  startHead: string;
  /** Ordered oldest-to-newest host-observed commits for this exact story. */
  commitShas: string[];
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  }).trim();
}

function storyMarker(storyId: string): string | null {
  const normalized = storyId.trim();
  return /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(normalized) ? `(${normalized})` : null;
}

/**
 * Retain only a contiguous first-parent suffix whose commit subjects identify
 * the same story. This makes an interrupted explicit story recoverable without
 * accidentally attributing an earlier or neighboring story's code to it.
 */
export function resolveRetainedStoryResumption(
  cwd: string,
  storyId: string,
): RetainedStoryResumption | null {
  const marker = storyMarker(storyId);
  if (!marker) return null;

  let output: string;
  try {
    output = git(cwd, [
      'log', '--first-parent', `--max-count=${MAX_RETAINED_STORY_COMMITS}`,
      '--format=%H%x00%s', 'HEAD',
    ]);
  } catch {
    return null;
  }

  const newestFirst = output
    .split('\n')
    .flatMap((line) => {
      const separator = line.indexOf('\u0000');
      if (separator <= 0) return [];
      const sha = line.slice(0, separator).toLowerCase();
      const subject = line.slice(separator + 1);
      return SHA_1.test(sha) ? [{ sha, subject }] : [];
    });

  const retainedNewestFirst: string[] = [];
  for (const commit of newestFirst) {
    if (!commit.subject.includes(marker)) break;
    retainedNewestFirst.push(commit.sha);
  }
  if (retainedNewestFirst.length === 0) return null;

  const oldest = retainedNewestFirst.at(-1)!;
  let startHead: string;
  try {
    startHead = git(cwd, ['rev-parse', `${oldest}^`]).toLowerCase();
  } catch {
    return null;
  }
  if (!SHA_1.test(startHead)) return null;

  return {
    startHead,
    commitShas: [...retainedNewestFirst].reverse(),
  };
}
