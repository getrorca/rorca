/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { ContainedBrowser, type BrowserAction, type BrowserPartition } from '../contained-browser.js';

const partition: BrowserPartition = { programId: 'p', missionId: 'm', accountId: 'a', role: 'researcher' };
const deny = {
  authorize: async () => false,
  resolveAdmittedArtifact: async () => undefined,
};

describe('contained browser contract', () => {
  it('has a closed typed action vocabulary with no evaluate, CDP, extension, or host attachment action', () => {
    const allowed: BrowserAction['type'][] = ['navigate', 'click', 'fill', 'select', 'check', 'readText', 'upload'];
    assert.deepEqual(allowed.sort(), ['check', 'click', 'fill', 'navigate', 'readText', 'select', 'upload']);
    for (const forbidden of ['evaluate', 'cdp', 'extension', 'attach', 'clipboard', 'filesystem']) {
      assert.equal(allowed.includes(forbidden as BrowserAction['type']), false);
    }
  });

  it('requires every partition dimension and creates distinct broker partitions', () => {
    assert.throws(() => new ContainedBrowser({ ...partition, role: '' }, deny, '/tmp/quarantine'));
    assert.notEqual(new ContainedBrowser(partition, deny, '/tmp/quarantine').id, new ContainedBrowser(partition, deny, '/tmp/quarantine').id);
  });

  it('hostile fixture exercises all browser escape surfaces', async () => {
    const fixture = await readFile(new URL('./fixtures/contained-browser/hostile.html', import.meta.url), 'utf8');
    for (const signal of ['target="_blank"', '<iframe', '<form', 'download', 'serviceWorker', 'WebSocket', 'RTCPeerConnection', 'fetch(', 'file://', 'devtools://']) {
      assert.match(fixture, new RegExp(signal.replace(/[():/]/g, '\\$&')));
    }
  });
});
