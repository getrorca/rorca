/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLI_VERSION,
  MIN_BACKEND_API_VERSION,
  MIN_BACKEND_VERSION,
  checkVersion,
} from './version-check.js';

const BASE_URL = 'http://127.0.0.1:3030';

function makeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('checkVersion returns success for a compatible backend', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => makeResponse(200, {
    version: MIN_BACKEND_VERSION,
    apiVersion: MIN_BACKEND_API_VERSION,
    schemaVersion: '20260502120000',
    minCliVersion: CLI_VERSION,
    capabilities: { pi: true, docker: false, age: false },
  });

  try {
    const result = await checkVersion(BASE_URL);
    assert.equal(result.ok, true);
    assert.equal(result.backend?.version, MIN_BACKEND_VERSION);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkVersion returns mismatch when backend is too old', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => makeResponse(200, {
    version: '0.0.9',
    apiVersion: MIN_BACKEND_API_VERSION,
    schemaVersion: '79',
    minCliVersion: '0.1.0',
    capabilities: { pi: true, docker: false, age: false },
  });

  try {
    const result = await checkVersion(BASE_URL);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /Backend 0\.0\.9 < required 0\.1\.0/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkVersion returns mismatch when apiVersion differs', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => makeResponse(200, {
    version: MIN_BACKEND_VERSION,
    apiVersion: '2.0',
    schemaVersion: '79',
    minCliVersion: '0.1.0',
    capabilities: { pi: true, docker: false, age: false },
  });

  try {
    const result = await checkVersion(BASE_URL);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /API version 2\.0 != 1\.0/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkVersion returns mismatch when CLI is below backend minimum', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => makeResponse(200, {
    version: MIN_BACKEND_VERSION,
    apiVersion: MIN_BACKEND_API_VERSION,
    schemaVersion: '79',
    minCliVersion: '9.9.9',
    capabilities: { pi: true, docker: false, age: false },
  });

  try {
    const result = await checkVersion(BASE_URL);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /CLI 0\.1\.0 < backend minimum 9\.9\.9/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkVersion returns failure when backend responds with 404', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => makeResponse(404, { error: 'Not found' });

  try {
    const result = await checkVersion(BASE_URL);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'Backend health check failed (404)');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkVersion returns failure when backend is unreachable', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('connect ECONNREFUSED');
  };

  try {
    const result = await checkVersion(BASE_URL);
    assert.equal(result.ok, false);
    assert.equal(result.reason, `Cannot reach backend at ${BASE_URL}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
