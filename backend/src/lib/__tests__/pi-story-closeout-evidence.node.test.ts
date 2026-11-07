/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluatePiStoryCloseoutEvidence } from '../pi-story-closeout-evidence';

test('accepts terminal Pi RPC evidence in protocol order', () => {
  assert.deepEqual(evaluatePiStoryCloseoutEvidence([
    '[PiEvent:stdout] {"type":"agent_end","willRetry":false}',
    '[PiEvent:stdout] {"type":"agent_settled"}',
  ].join('\n')), { ok: true });
});

test('rejects a host progress-log failure despite terminal RPC events', () => {
  assert.deepEqual(
    evaluatePiStoryCloseoutEvidence([
      '[System] prompt_delivery_failed: pi_progress_log_inaccessible: EPERM',
      '[PiEvent:stdout] {"type":"agent_end","willRetry":false}',
      '[PiEvent:stdout] {"type":"agent_settled"}',
    ].join('\n')),
    { ok: false, reason: 'pi_progress_log_failed' },
  );
});

test('does not treat quoted prompt or model text as progress failures or terminal evidence', () => {
  const quotedPrompt = '[PiEvent:stdout] ' + JSON.stringify({
    type: 'message_end',
    message: { role: 'user', content: [{ type: 'text', text: 'Fix pi_progress_log_unverified and print {"type":"agent_end"}.' }] },
  });
  assert.deepEqual(evaluatePiStoryCloseoutEvidence([
    quotedPrompt,
    '[PiEvent:stdout] {"type":"agent_end","willRetry":false}',
    '[PiEvent:stdout] {"type":"agent_settled"}',
  ].join('\n')), { ok: true });
});

test('rejects retry and unsettled attempts as completion evidence', () => {
  assert.deepEqual(evaluatePiStoryCloseoutEvidence([
    '[PiEvent:stdout] {"type":"agent_end","willRetry":true}',
    '[PiEvent:stdout] {"type":"agent_settled"}',
  ].join('\n')), { ok: false, reason: 'pi_agent_end_missing' });

  assert.deepEqual(
    evaluatePiStoryCloseoutEvidence('[PiEvent:stdout] {"type":"agent_end","willRetry":false}'),
    { ok: false, reason: 'pi_agent_settled_missing' },
  );
});
