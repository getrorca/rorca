#!/usr/bin/env node
/* Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */

let input = '';
for await (const chunk of process.stdin) input += chunk;

function reject(reason) {
  process.stdout.write(`${JSON.stringify({ verdict: 'reject', reason })}\n`);
  process.exit(2);
}

try {
  const trace = JSON.parse(input);
  if (!trace || trace.schemaVersion !== 1 || !Array.isArray(trace.events)) reject('trace shape');
  const declared = [...trace.stories].sort((a, b) => a.waveIndex - b.waveIndex || a.storyId.localeCompare(b.storyId));
  const expectedOrder = declared.map(item => item.storyId);
  const integratedOrder = trace.events.filter(item => item.type === 'integration_state' && item.state === 'integrated').map(item => item.storyId);
  if (JSON.stringify(integratedOrder) !== JSON.stringify(expectedOrder)) reject('integration order');

  const sourceCommits = new Set();
  let expectedParent = trace.baseRevision;
  for (const story of declared) {
    const events = trace.events.filter(item => item.storyId === story.storyId);
    const states = events.filter(item => item.type === 'integration_state').map(item => item.state);
    if (JSON.stringify(states) !== JSON.stringify(['prepared', 'integrating', 'integrated', 'integrated_validated', 'finalized'])) reject(`states:${story.storyId}`);
    const prepared = events.find(item => item.type === 'integration_state' && item.state === 'prepared');
    const integrated = events.find(item => item.type === 'integration_state' && item.state === 'integrated');
    const validated = events.find(item => item.type === 'integration_state' && item.state === 'integrated_validated');
    const finalized = events.find(item => item.type === 'integration_state' && item.state === 'finalized');
    if (!prepared || prepared.attempt !== story.attempt || prepared.sourceCommit !== story.sourceCommit) reject(`prepared identity:${story.storyId}`);
    if (sourceCommits.has(story.sourceCommit)) reject(`duplicate source:${story.storyId}`);
    sourceCommits.add(story.sourceCommit);
    if (prepared.expectedParentHead !== expectedParent || integrated.expectedParentHead !== expectedParent) reject(`parent chain:${story.storyId}`);
    if (!integrated.resultingHead || validated.revision !== integrated.resultingHead || finalized.revision !== integrated.resultingHead) reject(`revision chain:${story.storyId}`);
    const finalizedIndex = trace.events.indexOf(finalized);
    for (const projectionType of ['spec_story_passed', 'run_story_passed', 'story_result_passed', 'wal_story_passed']) {
      const matches = trace.events.filter(item => item.type === projectionType && item.storyId === story.storyId);
      if (matches.length !== 1 || trace.events.indexOf(matches[0]) <= finalizedIndex || matches[0].revision !== integrated.resultingHead) reject(`${projectionType}:${story.storyId}`);
    }
    expectedParent = integrated.resultingHead;
  }

  const closeout = trace.events.filter(item => item.type === 'run_closeout');
  if (closeout.length !== 1 || closeout[0].status !== 'passed' || closeout[0].revision !== expectedParent) reject('closeout');
  if (trace.pipelineRun.status !== 'passed' || trace.pipelineRun.revision !== expectedParent) reject('pipeline projection');
  if (trace.runState.status !== 'passed' || trace.runState.revision !== expectedParent) reject('run state projection');
  if (trace.processExitCode !== 0 || trace.finalRevision !== expectedParent) reject('process result');
  process.stdout.write(`${JSON.stringify({ verdict: 'accept', integrationOrder: expectedOrder, finalRevision: expectedParent })}\n`);
} catch (error) {
  reject(error instanceof Error ? error.message : 'parse failure');
}
