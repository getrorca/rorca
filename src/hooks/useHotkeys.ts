/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useEffect, useCallback, useRef } from 'react';

export interface HotkeyBinding {
  /** e.g. 'mod+k', 'mod+shift+r', '?', 'escape' */
  key: string;
  handler: () => void;
  /** Prevent default browser behavior (default: true) */
  preventDefault?: boolean;
}

/**
 * Parse a hotkey string into its parts.
 * 'mod' resolves to Meta on macOS, Ctrl elsewhere.
 */
function parseHotkey(hotkey: string) {
  const parts = hotkey.toLowerCase().split('+');
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  return {
    mod: parts.includes('mod'),
    ctrl: parts.includes('ctrl'),
    meta: parts.includes('meta'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
    key: parts.filter((p) => !['mod', 'ctrl', 'meta', 'shift', 'alt'].includes(p))[0] || '',
    isMac,
  };
}

function matchesHotkey(e: KeyboardEvent, parsed: ReturnType<typeof parseHotkey>): boolean {
  // Check modifier keys
  const modKey = parsed.isMac ? e.metaKey : e.ctrlKey;
  if (parsed.mod && !modKey) return false;
  if (parsed.ctrl && !e.ctrlKey) return false;
  if (parsed.meta && !e.metaKey) return false;
  if (parsed.shift && !e.shiftKey) return false;
  if (parsed.alt && !e.altKey) return false;

  // If no modifiers required, ensure none are pressed (except for special keys)
  if (!parsed.mod && !parsed.ctrl && !parsed.meta) {
    if (e.metaKey || e.ctrlKey) return false;
  }
  if (!parsed.shift && e.shiftKey && parsed.key !== '?') return false;
  if (!parsed.alt && e.altKey) return false;

  // Match key
  const eventKey = e.key.toLowerCase();
  if (parsed.key === 'escape') return eventKey === 'escape';
  if (parsed.key === 'enter') return eventKey === 'enter';
  if (parsed.key === 'backspace') return eventKey === 'backspace';
  if (parsed.key === '/') return eventKey === '/';
  if (parsed.key === '?') return eventKey === '?';
  if (parsed.key === '\\') return eventKey === '\\';
  return eventKey === parsed.key;
}

const MOBILE_BREAKPOINT = 768;

/**
 * Register global keyboard shortcuts. Ignores events from inputs/textareas
 * unless the key includes modifiers. Disabled on mobile (< 768px) where no
 * hardware keyboard is assumed.
 */
export function useHotkeys(bindings: HotkeyBinding[]) {
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Disable all hotkeys on mobile — no hardware keyboard assumed
    if (window.innerWidth < MOBILE_BREAKPOINT) return;

    // Skip if target is an input/textarea/contenteditable (unless modifier key is held)
    const target = e.target as HTMLElement;
    const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

    for (const binding of bindingsRef.current) {
      const parsed = parseHotkey(binding.key);
      if (matchesHotkey(e, parsed)) {
        // For non-modifier shortcuts (like '?'), skip when typing in inputs
        const hasModifier = parsed.mod || parsed.ctrl || parsed.meta || parsed.alt;
        if (isInput && !hasModifier) continue;

        if (binding.preventDefault !== false) {
          e.preventDefault();
        }
        binding.handler();
        return;
      }
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}

/** Platform-aware modifier label */
export function modLabel(): string {
  return navigator.platform.toUpperCase().indexOf('MAC') >= 0 ? '\u2318' : 'Ctrl';
}
