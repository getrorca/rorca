/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export interface PiStoryCloseoutEvidence {
  ok: boolean;
  reason?: 'pi_progress_log_failed' | 'pi_agent_end_missing' | 'pi_agent_settled_missing';
}

const PI_EVENT_PREFIX = '[PiEvent:stdout] ';
const PROGRESS_LOG_FAILURE = /^(?:\[System\]\s*)?prompt_delivery_failed:\s*pi_progress_log_(?:inaccessible|unverified)\b/;

/** Bind closeout only to host diagnostics and parsed Pi RPC events, never quoted prompt/model text. */
export function evaluatePiStoryCloseoutEvidence(logContent: string): PiStoryCloseoutEvidence {
  let terminalAgentEndSeen = false;
  let settledAfterTerminalEnd = false;

  for (const line of logContent.split(/\r?\n/)) {
    if (PROGRESS_LOG_FAILURE.test(line.trim())) {
      return { ok: false, reason: 'pi_progress_log_failed' };
    }
    if (!line.startsWith(PI_EVENT_PREFIX)) continue;

    try {
      const event = JSON.parse(line.slice(PI_EVENT_PREFIX.length)) as Record<string, unknown>;
      if (event.type === 'agent_end') {
        terminalAgentEndSeen = event.willRetry !== true;
        settledAfterTerminalEnd = false;
      } else if (event.type === 'agent_settled' && terminalAgentEndSeen) {
        settledAfterTerminalEnd = true;
      }
    } catch {
      // Partial/non-JSON protocol output is not completion authority.
    }
  }

  if (!terminalAgentEndSeen) return { ok: false, reason: 'pi_agent_end_missing' };
  if (!settledAfterTerminalEnd) return { ok: false, reason: 'pi_agent_settled_missing' };
  return { ok: true };
}
