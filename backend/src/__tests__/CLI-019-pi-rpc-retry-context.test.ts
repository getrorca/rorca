/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { preparePiRpcSession } from '../lib/execution-engine';

describe('CLI-019: pi RPC retry context', () => {
  test('uses new_session on first attempt and captures sessionId from get_state', async () => {
    const sendCommand = jest.fn()
      .mockResolvedValueOnce({ success: true, data: { cancelled: false } })
      .mockResolvedValueOnce({ success: true, data: { sessionId: 'session-1' } });

    const sessionId = await preparePiRpcSession(sendCommand);

    expect(sessionId).toBe('session-1');
    expect(sendCommand).toHaveBeenNthCalledWith(1, { type: 'new_session' });
    expect(sendCommand).toHaveBeenNthCalledWith(2, { type: 'get_state' });
  });

  test('uses clone on retry attempts greater than zero and captures sessionId', async () => {
    const sendCommand = jest.fn()
      .mockResolvedValueOnce({ success: true, data: { cancelled: false } })
      .mockResolvedValueOnce({ success: true, data: { sessionId: 'session-2' } });

    const sessionId = await preparePiRpcSession(sendCommand, { isRetry: true, attempt: 1 });

    expect(sessionId).toBe('session-2');
    expect(sendCommand).toHaveBeenNthCalledWith(1, { type: 'clone' });
    expect(sendCommand).toHaveBeenNthCalledWith(2, { type: 'get_state' });
  });

  test('three attempts produce three distinct session IDs: one new session then two clones', async () => {
    const sessionIds = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333'];
    let stateIndex = 0;
    const commands: object[] = [];
    const sendCommand = jest.fn(async (command: object) => {
      commands.push(command);
      const type = (command as { type?: string }).type;
      if (type === 'new_session' || type === 'clone') {
        return { success: true, data: { cancelled: false } };
      }
      if (type === 'get_state') {
        return { success: true, data: { sessionId: sessionIds[stateIndex++] } };
      }
      throw new Error(`Unexpected command: ${JSON.stringify(command)}`);
    });

    const first = await preparePiRpcSession(sendCommand, { isRetry: false, attempt: 0 });
    const second = await preparePiRpcSession(sendCommand, { isRetry: true, attempt: 1 });
    const third = await preparePiRpcSession(sendCommand, { isRetry: true, attempt: 2 });

    expect(new Set([first, second, third]).size).toBe(3);
    expect(commands).toEqual([
      { type: 'new_session' },
      { type: 'get_state' },
      { type: 'clone' },
      { type: 'get_state' },
      { type: 'clone' },
      { type: 'get_state' },
    ]);
  });
});
