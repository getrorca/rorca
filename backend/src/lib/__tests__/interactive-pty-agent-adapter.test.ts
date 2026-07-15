/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Regression coverage for interactive PTY adapter primitives.
 */

import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  appendPtyCompletionInstructions,
  buildPtyCompletionMarker,
  createPtyCompletionState,
  createPtyReadinessState,
  detectCompletionMarkerAcrossChunks,
  detectPtyCliReadiness,
  injectPromptWithBracketedPaste,
} from '../interactive-pty-agent-adapter';

describe('interactive PTY agent adapter primitives', () => {
  it('injects prompts through bracketed paste and Enter', async () => {
    const writes: string[] = [];
    await injectPromptWithBracketedPaste({ write: (data) => writes.push(data) }, 'hello\nworld', { startupDelayMs: 0 });

    expect(writes).toEqual([
      BRACKETED_PASTE_START,
      'hello\nworld',
      BRACKETED_PASTE_END,
      '\r',
    ]);
  });

  it('ignores delayed fake CLI banner bytes until the split completion marker arrives', () => {
    const marker = buildPtyCompletionMarker(42, 'US-001');
    const state = createPtyCompletionState(marker);
    const splitAt = Math.floor(marker.length / 2);

    expect(detectCompletionMarkerAcrossChunks('Fake CLI booting...\r\n', state)).toBeNull();
    expect(detectCompletionMarkerAcrossChunks('\u001b[32mincremental terminal bytes\u001b[0m\r\n', state)).toBeNull();
    expect(detectCompletionMarkerAcrossChunks(`done ${marker.slice(0, splitAt)}`, state)).toBeNull();
    expect(detectCompletionMarkerAcrossChunks(`${marker.slice(splitAt)}\r\n`, state)).toEqual({
      type: 'marker',
      marker,
    });
  });

  it('waits for CLI-specific output readiness rather than a fixed spawn delay', () => {
    const state = createPtyReadinessState('claude');
    expect(detectPtyCliReadiness('spawned but silent', state)).toBeNull();
    expect(detectPtyCliReadiness('Claude Code v2.1\\r\\n', state)).toEqual({
      type: 'ready', reason: 'claude_banner_or_prompt',
    });
    expect(detectPtyCliReadiness('❯ ', state)).toBeNull();
  });

  it('detects completion markers split across chunks', () => {
    const marker = buildPtyCompletionMarker(42, 'US-001');
    const state = createPtyCompletionState(marker);
    const splitAt = Math.floor(marker.length / 2);

    expect(detectCompletionMarkerAcrossChunks(`before ${marker.slice(0, splitAt)}`, state)).toBeNull();
    expect(detectCompletionMarkerAcrossChunks(`${marker.slice(splitAt)} after`, state)).toEqual({
      type: 'marker',
      marker,
    });
    expect(detectCompletionMarkerAcrossChunks(marker, state)).toBeNull();
  });

  it('adds a completion contract without claiming story pass', () => {
    const marker = buildPtyCompletionMarker(7, 'PTY-123');
    const prompt = appendPtyCompletionInstructions({
      basePrompt: 'Implement the feature.',
      runId: 7,
      storyId: 'PTY-123',
      agentType: 'pi',
      completionMarker: marker,
      markerFilePath: '.rorca/progress/run-7/PTY-123.done.json',
    });

    expect(prompt).toContain('Implement the feature.');
    expect(prompt).not.toContain(marker);
    expect(prompt).toContain('Build it by concatenating these JSON string parts');
    expect(prompt).toContain('.rorca/progress/run-7/PTY-123.done.json');
    expect(prompt).toContain('status file is Rorca\'s primary turn-completion signal');
    expect(prompt).toContain('does not mean the story passed');
    expect(prompt).toContain('merge and validation gates');
  });

  it('does not expose the contiguous marker in prompt text, avoiding prompt-echo false completion', () => {
    const marker = buildPtyCompletionMarker(99, 'US-echo');
    const prompt = appendPtyCompletionInstructions({
      basePrompt: 'Base prompt.',
      runId: 99,
      storyId: 'US-echo',
      agentType: 'pi',
      completionMarker: marker,
      markerFilePath: '.rorca/progress/run-99/US-echo.done.json',
    });

    const echoedPromptState = createPtyCompletionState(marker);
    expect(prompt).not.toContain(marker);
    expect(detectCompletionMarkerAcrossChunks(prompt, echoedPromptState)).toBeNull();
  });
});
