/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../lib/apiFetch';
import RunTranscript from '../RunTranscript';

vi.mock('../../lib/apiFetch', () => ({
  BASE_URL: 'http://localhost:3030',
  apiFetch: vi.fn(),
}));

const GENERATION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_GENERATION_ID = '22222222-2222-4222-8222-222222222222';

function event(seq: number, eventType: 'model_message' | 'tool_call' | 'tool_result' | 'host_notice' | 'error', payload: unknown) {
  return {
    eventId: `${seq.toString().padStart(8, '0')}-1111-4111-8111-111111111111`,
    contractVersion: 1,
    generationId: GENERATION_ID,
    runId: 77,
    storyId: 'PTY-006',
    seq,
    eventType,
    eventSource: eventType === 'model_message' ? 'terminal_normalized' : 'structured',
    role: eventType === 'tool_call' || eventType === 'tool_result' ? 'tool' : 'assistant',
    correlationId: eventType.startsWith('tool_') ? 'call-1' : null,
    payload,
    redacted: false,
    truncated: false,
    authoritative: eventType !== 'model_message',
    createdAt: '2026-07-19T00:00:00.000Z',
  };
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    generationId: GENERATION_ID,
    items: [],
    nextCursor: null,
    hasMore: false,
    gaps: [],
    ...overrides,
  };
}

describe('RunTranscript', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('loads one bounded page, preserves semantics, strips ANSI, and paginates only on demand', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(page({
        items: [
          event(1, 'model_message', { text: '\u001b[31mmodel answer\u001b[0m' }),
          event(2, 'tool_call', { name: 'read', path: 'src/app.tsx' }),
          event(3, 'error', { message: 'tool failed' }),
        ],
        nextCursor: 'cursor-page-1',
        hasMore: true,
        gaps: [{ afterSeq: 3, beforeSeq: 6, missingCount: 2, reason: 'sequence_gap' }],
      }) as never)
      .mockResolvedValueOnce(page({
        items: [event(6, 'tool_result', { output: 'done' })],
        nextCursor: 'cursor-page-2',
        hasMore: false,
      }) as never);

    render(<RunTranscript runId={77} generationId={GENERATION_ID} available archiveAvailable active />);

    expect(await screen.findByText('model answer')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('\u001b[31m');
    expect(screen.getByLabelText(/Tool call transcript event 2/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Error transcript event 3/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('transcript sequences 4–5');
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith(
      `/api/pty-evidence/runs/77/generations/${GENERATION_ID}/transcript?limit=50`,
      { silent: true },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load next 50 events' }));
    expect(await screen.findByLabelText(/Tool result transcript event 6/)).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch).toHaveBeenLastCalledWith(
      `/api/pty-evidence/runs/77/generations/${GENERATION_ID}/transcript?limit=50&cursor=cursor-page-1`,
      { silent: true },
    );
  });

  it('supports keyboard navigation with a visible tokenized focus outline', async () => {
    vi.mocked(apiFetch).mockResolvedValue(page({
      items: [event(1, 'model_message', { text: 'one' }), event(2, 'host_notice', { message: 'two' })],
    }) as never);
    render(<RunTranscript runId={77} generationId={GENERATION_ID} available archiveAvailable={false} active={false} />);

    const first = await screen.findByLabelText(/Model transcript event 1/);
    const second = screen.getByLabelText(/Host notice transcript event 2/);
    first.focus();
    fireEvent.keyDown(first.closest('ul')!, { key: 'ArrowDown' });
    expect(second).toHaveFocus();
    expect(second).toHaveStyle({ outlineColor: 'var(--terminal-focus-ring)' });
    fireEvent.keyDown(second.closest('ul')!, { key: 'Home' });
    expect(first).toHaveFocus();
  });

  it('rejects a mismatched generation page instead of mixing history', async () => {
    vi.mocked(apiFetch).mockResolvedValue(page({ generationId: OTHER_GENERATION_ID, items: [event(1, 'model_message', { text: 'wrong generation' })] }) as never);
    render(<RunTranscript runId={77} generationId={GENERATION_ID} available archiveAvailable={false} active />);

    expect(await screen.findByRole('alert')).toHaveTextContent('identity did not match the active generation');
    expect(screen.queryByText('wrong generation')).not.toBeInTheDocument();
  });

  it('requires a second explicit action and explains sensitivity and retention before archive download', async () => {
    vi.mocked(apiFetch).mockResolvedValue(page() as never);
    render(<RunTranscript runId={77} generationId={GENERATION_ID} available archiveAvailable active={false} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));

    expect(screen.queryByRole('link', { name: /Download sensitive raw archive/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Raw archive…' }));
    expect(screen.getByText('Sensitive, retention-limited evidence')).toBeInTheDocument();
    expect(screen.getByText(/may contain secrets, file contents, prompts, and operator keystrokes/i)).toBeInTheDocument();
    expect(screen.getByText(/retained only until the server’s configured expiry/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Download sensitive raw archive/ })).toHaveAttribute(
      'href',
      `http://localhost:3030/api/pty-evidence/runs/77/generations/${GENERATION_ID}/raw-archive`,
    );
  });

  it('uses responsive padding and announces incremental page completion to screen readers', async () => {
    vi.mocked(apiFetch).mockResolvedValue(page({ items: [event(1, 'model_message', { text: 'mobile event' })] }) as never);
    render(<RunTranscript runId={77} generationId={GENERATION_ID} available archiveAvailable={false} active={false} />);

    const article = await screen.findByLabelText(/Model transcript event 1/);
    expect(article.className).toContain('px-2');
    expect(article.className).toContain('sm:px-3');
    expect(screen.getByText(/1 transcript events loaded; complete history is loaded/)).toHaveClass('sr-only');
  });
});
