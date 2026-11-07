/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Wave Compiler — compiles a spec's userStories into topologically-ordered
 * execution waves using Kahn's algorithm. Each wave contains stories whose
 * dependsOn are all satisfied by earlier waves, meaning they can run concurrently.
 *
 * Execution-engine-agnostic: used by both run-loop.ts and execution-engine.ts.
 */

export interface UserStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  passes?: boolean;
  complexity?: number;
  priority?: number;
  timeoutMinutes?: number;
  excluded?: boolean;
}

export interface Wave {
  index: number;
  stories: UserStory[];
}

export interface CycleError {
  cycle: true;
  involvedIds: string[];
}

/**
 * Compile stories into ordered execution waves via Kahn's algorithm.
 *
 * - Stories with `passes: true` are excluded (already done).
 * - Dependencies referencing passed or unknown story IDs are treated as satisfied.
 * - Returns CycleError if the remaining DAG contains a cycle.
 */
export function compileWaves(stories: UserStory[]): Wave[] | CycleError {
  // Partition: passed stories are already done, pending stories need compilation
  const passedIds = new Set(stories.filter(s => s.passes).map(s => s.id));
  const pending = stories.filter(s => !s.passes);

  if (pending.length === 0) return [];

  const pendingIds = new Set(pending.map(s => s.id));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep -> stories that depend on it

  for (const s of pending) {
    inDegree.set(s.id, 0);
    dependents.set(s.id, []);
  }

  for (const s of pending) {
    let count = 0;
    for (const dep of s.dependsOn) {
      // Only count deps that are pending — passed/unknown deps are satisfied
      if (pendingIds.has(dep) && !passedIds.has(dep)) {
        count++;
        dependents.get(dep)!.push(s.id);
      }
    }
    inDegree.set(s.id, count);
  }

  const waves: Wave[] = [];
  let queue = pending.filter(s => inDegree.get(s.id) === 0);
  const storyMap = new Map(pending.map(s => [s.id, s]));
  let processed = 0;

  while (queue.length > 0) {
    waves.push({ index: waves.length, stories: queue });
    processed += queue.length;

    const nextQueue: UserStory[] = [];
    for (const story of queue) {
      for (const depId of dependents.get(story.id) ?? []) {
        const newDeg = inDegree.get(depId)! - 1;
        inDegree.set(depId, newDeg);
        if (newDeg === 0) nextQueue.push(storyMap.get(depId)!);
      }
    }
    queue = nextQueue;
  }

  // Cycle detection: if not all pending stories were processed, a cycle exists
  if (processed < pending.length) {
    const involvedIds = pending
      .filter(s => inDegree.get(s.id)! > 0)
      .map(s => s.id);
    return { cycle: true, involvedIds };
  }

  return waves;
}

/** Type guard for CycleError */
export function isCycleError(result: Wave[] | CycleError): result is CycleError {
  return (result as CycleError).cycle === true;
}
