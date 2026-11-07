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
  createPtyPostInjectionState,
  createPtyReadinessState,
  detectCompletionMarkerAcrossChunks,
  detectPtyCliReadiness,
  getPtyReadinessTimeoutMs,
  getPtySubmitDelayMs,
  handleOmpPasteChooserOutput,
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

  it('allows OMP subscription and extension startup to finish before prompt injection', () => {
    expect(getPtyReadinessTimeoutMs('omp')).toBe(60_000);
  });

  it('lets OMP materialize a bracketed-paste attachment before Enter', () => {
    expect(getPtySubmitDelayMs('omp')).toBe(500);
    expect(getPtySubmitDelayMs('pi')).toBe(75);
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

  it('uses a prebound receipt for interactive PTY without model-transcribed authority ids', () => {
    const marker = buildPtyCompletionMarker(7, 'PTY-123');
    const prompt = appendPtyCompletionInstructions({
      basePrompt: 'Implement the feature.',
      runId: 7,
      storyId: 'PTY-123',
      agentType: 'pi',
      completionMarker: marker,
      markerFilePath: '.rorca/progress/run-7/PTY-123.done.json',
      preparedMarkerFilePath: '.rorca/progress/run-7/PTY-123.done.json.bound.pending',
      generationId: '11111111-1111-4111-8111-111111111111',
      generationToken: '22222222-2222-4222-8222-222222222222',
      attempt: 2,
    });

    expect(prompt).toContain('Implement the feature.');
    expect(prompt).not.toContain(marker);
    expect(prompt).toContain('atomically move ".rorca/progress/run-7/PTY-123.done.json.bound.pending"');
    expect(prompt).toContain('to ".rorca/progress/run-7/PTY-123.done.json"');
    expect(prompt).toContain('Do not recreate, edit, or transcribe the receipt.');
    expect(prompt).toContain('Build the visible completion marker by concatenating');
    expect(prompt).not.toContain('11111111-1111-4111-8111-111111111111');
    expect(prompt).not.toContain('22222222-2222-4222-8222-222222222222');
    expect(prompt).toContain('does not mean the story passed');
    expect(prompt).toContain('merge and validation gates');
  });


  it('uses a prebound receipt for structured RPC without exposing opaque authority ids', () => {
    const marker = buildPtyCompletionMarker(7, 'AFM-001');
    const prompt = appendPtyCompletionInstructions({
      basePrompt: 'Implement the feature.',
      runId: 7,
      storyId: 'AFM-001',
      agentType: 'omp',
      completionMarker: marker,
      markerFilePath: '.rorca/progress/run-7/AFM-001.done.json',
      preparedMarkerFilePath: '.rorca/progress/run-7/AFM-001.done.json.bound.pending',
      generationId: '8d4fc987-8c08-4dfd-aa0e-366fd1239495',
      generationToken: 'fc601067-454e-4208-b121-d5969f8662de',
      attempt: 1,
      executionProfile: 'structured-rpc',
    });

    expect(prompt).toContain('atomically move ".rorca/progress/run-7/AFM-001.done.json.bound.pending"');
    expect(prompt).toContain('to ".rorca/progress/run-7/AFM-001.done.json"');
    expect(prompt).toContain('Do not recreate, edit, or transcribe the receipt.');
    expect(prompt).not.toContain('8d4fc987-8c08-4dfd-aa0e-366fd1239495');
    expect(prompt).not.toContain('fc601067-454e-4208-b121-d5969f8662de');
    expect(prompt).not.toContain(marker);
    expect(prompt).toContain('does not mean the story passed');
  });
  it('recovers an OMP paste chooser by selecting the default and submitting', () => {
    const writes: string[] = [];
    const pty = { write: (data: string) => writes.push(data) };
    const state = createPtyPostInjectionState('omp');

    // Chooser menu renders after the prompt paste; the submit Enter was dropped.
    expect(handleOmpPasteChooserOutput(
      pty,
      'Pasted 622 lines\n ❯ Attach as a wrapped block\n   Attach as local file\n   Paste inline\n   Esc to paste inline',
      state,
    )).toBe(true);
    expect(writes).toEqual(['\r']);

    // Composer confirms the attachment is staged; submit it.
    expect(handleOmpPasteChooserOutput(pty, '╭── π  > ⬢ GPT-5.6-Sol · ◒ high ───╮\n╰─ [Paste #1, +624 lines] ─╯', state)).toBe(true);
    expect(writes).toEqual(['\r', '\r']);
    expect(state.chooserEnterSent).toBe(true);
    expect(state.submitEnterSent).toBe(true);

    // Never re-sends after both steps completed.
    expect(handleOmpPasteChooserOutput(pty, 'Pasted 622 lines\n Attach as a wrapped block', state)).toBe(false);
    expect(writes).toEqual(['\r', '\r']);
  });

  it('dismisses OMP crash-report consent and the LSP toolbox exactly once', () => {
    const writes: string[] = [];
    const pty = { write: (data: string) => writes.push(data) };
    const state = createPtyPostInjectionState('omp');

    expect(handleOmpPasteChooserOutput(
      pty,
      'Your agent is melting down over a tool. Mop up by alerting the devs? Tool + what melted it, no personal info. ? Yes  No',
      state,
    )).toBe(true);
    expect(writes).toEqual(['\x1b[B\r']);
    expect(handleOmpPasteChooserOutput(pty, 'Your agent is melting down over a tool. Yes No', state)).toBe(false);

    expect(handleOmpPasteChooserOutput(pty, 'Toolbox\nLSP Servers\nclangd', state)).toBe(true);
    expect(writes).toEqual(['\x1b[B\r', '\x1b']);
    expect(handleOmpPasteChooserOutput(pty, 'LSP Servers', state)).toBe(false);
  });

  it('dismisses an OMP startup toolbox before readiness and prompt injection', () => {
    const writes: string[] = [];
    const state = createPtyReadinessState('omp');

    expect(handlePtyCliStartupPrompt(
      { write: (data: string) => writes.push(data) },
      'Toolbox\nLSP Servers\nc · cpp · clangd',
      state,
    )).toBe(true);
    expect(writes).toEqual(['\x1b']);
    expect(state.ready).toBe(false);
    expect(handlePtyCliStartupPrompt(
      { write: (data: string) => writes.push(data) },
      'LSP Servers',
      state,
    )).toBe(true);
    expect(writes).toEqual(['\x1b']);
  });

  it('does not send recovery keys for non-OMP agents or healthy output', () => {
    const writes: string[] = [];
    const pty = { write: (data: string) => writes.push(data) };
    const piState = createPtyPostInjectionState('pi');
    expect(handleOmpPasteChooserOutput(pty, 'Pasted 622 lines\n Attach as a wrapped block\n Paste inline', piState)).toBe(false);
    expect(writes).toEqual([]);

    const ompState = createPtyPostInjectionState('omp');
    expect(handleOmpPasteChooserOutput(pty, 'Running tests...\r\n ✓ 12 passed', ompState)).toBe(false);
    expect(writes).toEqual([]);
    expect(ompState.chooserEnterSent).toBe(false);
  });

  it('submits a staged OMP paste even when the chooser repaint was missed', () => {
    const writes: string[] = [];
    const pty = { write: (data: string) => writes.push(data) };
    const state = createPtyPostInjectionState('omp');

    expect(handleOmpPasteChooserOutput(pty, '╰─ [Paste #1, +624 lines] ─╯', state)).toBe(true);
    expect(writes).toEqual(['\r']);
    expect(state.chooserEnterSent).toBe(false);
    expect(state.submitEnterSent).toBe(true);
    expect(handleOmpPasteChooserOutput(pty, '╰─ [Paste #1, +624 lines] ─╯', state)).toBe(false);
    expect(writes).toEqual(['\r']);
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
