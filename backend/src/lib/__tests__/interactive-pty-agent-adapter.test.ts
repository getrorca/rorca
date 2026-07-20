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
  handlePtyCliStartupPrompt,
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
    expect(detectPtyCliReadiness('Claude Code v2.1\\r\\n', state)).toBeNull();
    expect(detectPtyCliReadiness('❯ Try a task\\r\\n accept edits on (shift+tab to cycle)', state)).toEqual({
      type: 'ready', reason: 'claude_banner_or_prompt',
    });
  });

  it('accepts Claude first-run confirmations before declaring prompt readiness', () => {
    const writes: string[] = [];
    const pty = { write: (data: string) => writes.push(data) };
    const state = createPtyReadinessState('claude');

    expect(handlePtyCliStartupPrompt(
      pty,
      'Accessing workspace: /tmp/canary\n❯ 1. Yes, I trust this folder\n  2. No, exit',
      state,
    )).toBe(true);
    expect(writes).toEqual(['\r']);
    expect(detectPtyCliReadiness('Claude Code running in Bypass Permissions mode\n❯ 1. No, exit', state)).toBeNull();

    const bypassState = createPtyReadinessState('claude');
    expect(handlePtyCliStartupPrompt(
      pty,
      'WARNING: Claude Code running in Bypass Permissions mode\n  1. No, exit\n  2. Yes, I accept',
      bypassState,
    )).toBe(true);
    expect(writes).toEqual(['\r', '\x1b[B\r']);
    expect(bypassState.ready).toBe(false);
  });

  it('does not treat non-Claude output as an onboarding prompt', () => {
    const writes: string[] = [];
    const state = createPtyReadinessState('pi');
    expect(handlePtyCliStartupPrompt(
      { write: (data: string) => writes.push(data) },
      'Pi coding agent ›',
      state,
    )).toBe(false);
    expect(writes).toEqual([]);
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
      generationId: '11111111-1111-4111-8111-111111111111',
      generationToken: '22222222-2222-4222-8222-222222222222',
      attempt: 2,
    });

    expect(prompt).toContain('Implement the feature.');
    expect(prompt).not.toContain(marker);
    expect(prompt).toContain('Build it by concatenating these JSON string parts');
    expect(prompt).toContain('.rorca/progress/run-7/PTY-123.done.json');
    expect(prompt).toContain('generationId "11111111-1111-4111-8111-111111111111"');
    expect(prompt).toContain('generationToken "22222222-2222-4222-8222-222222222222"');
    expect(prompt).toContain('and attempt 2');
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
