/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { apiFetch } from '../lib/apiFetch';

export function useDirectionLayer(workspaceId: string | null, layer: 1 | 2 | 3, opts?: { skipValidation?: boolean }) {
  const [content, setContentRaw] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const savedRef = useRef(''); // tracks last-saved value
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipValidation = opts?.skipValidation ?? false;

  // Load on mount / when workspace or layer changes
  useEffect(() => {
    if (!workspaceId) return;
    apiFetch<{ contentYaml: string }>(`/api/direction?layer=${layer}&workspaceId=${workspaceId}`)
      .then((data) => {
        setContentRaw(data.contentYaml);
        savedRef.current = data.contentYaml;
        setIsDirty(false);
      })
      .catch(console.error);
  }, [workspaceId, layer]);

  // Auto-save (debounced 500ms)
  const save = useCallback(
    (value: string) => {
      if (!workspaceId) return;
      setIsSaving(true);
      apiFetch<{ ok: boolean }>('/api/direction', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layer, workspaceId, contentYaml: value, ...(skipValidation ? { skipValidation: true } : {}) }),
      })
        .then(() => {
          savedRef.current = value;
          setIsDirty(false);
        })
        .catch(console.error)
        .finally(() => setIsSaving(false));
    },
    [workspaceId, layer, skipValidation],
  );

  const setContent = useCallback(
    (value: string) => {
      setContentRaw(value);
      setIsDirty(value !== savedRef.current);

      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        if (value !== savedRef.current) save(value);
      }, 500);
    },
    [save],
  );

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { content, setContent, isSaving, isDirty };
}
