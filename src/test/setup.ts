/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import '@testing-library/jest-dom/vitest';

// ─── fetch ───────────────────────────────────────────────────────────────────
window.fetch = vi.fn() as typeof fetch;

// ─── localStorage ────────────────────────────────────────────────────────────
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// ─── sessionStorage ──────────────────────────────────────────────────────────
const sessionStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
})();
Object.defineProperty(window, 'sessionStorage', { value: sessionStorageMock });

// ─── matchMedia ──────────────────────────────────────────────────────────────
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// ─── ResizeObserver ──────────────────────────────────────────────────────────
// Use a plain class with no-op functions (not vi.fn()) so vi.clearAllMocks()
// doesn't break the constructor. Recharts calls `new ResizeObserver()` in
// effects after each test's beforeEach clearAllMocks().
class MockResizeObserver {
   
  observe(_el: Element): void { /* no-op */ }
   
  unobserve(_el: Element): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
}
window.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

// ─── IntersectionObserver ────────────────────────────────────────────────────
class MockIntersectionObserver {
  root: Element | null = null;
  rootMargin = '';
  thresholds: ReadonlyArray<number> = [];
   
  observe(_el: Element): void { /* no-op */ }
   
  unobserve(_el: Element): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
  takeRecords(): IntersectionObserverEntry[] { return []; }
}
window.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;

// ─── EventSource (SSE) ───────────────────────────────────────────────────────
// jsdom does not implement EventSource — mock it globally so hooks using
// SSE (useWalSSE, usePipelineSSE) don't throw in component tests.
// Must be a class (constructor) so `new EventSource(url)` works.
class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 1;
  onopen: null = null;
  onmessage: null = null;
  onerror: null = null;
  url: string;
  withCredentials = false;
  constructor(url: string) { this.url = url; }
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  close = vi.fn();
  dispatchEvent = vi.fn(() => true);
}
window.EventSource = MockEventSource as unknown as typeof EventSource;

// ─── Reset mocks between tests ───────────────────────────────────────────────
beforeEach(() => {
  vi.clearAllMocks();
  localStorageMock.clear();
  sessionStorageMock.clear();
});
