/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../lib/apiFetch';

const EVENT_TYPES = [
  { key: 'review_request', label: 'Review requests', description: 'When someone requests your review on a spec' },
  { key: 'spec_approved', label: 'Spec approvals', description: 'When a spec you are assigned to gets approved' },
  { key: 'spec_rejected', label: 'Spec rejections', description: 'When a spec you are assigned to gets rejected' },
  { key: 'pipeline_completed', label: 'Pipeline completions', description: 'When a pipeline run finishes or fails' },
  { key: 'budget_alert', label: 'Budget alerts', description: 'When token spend approaches a budget threshold' },
  { key: 'mention', label: 'Mentions', description: 'When someone @mentions you in a comment' },
] as const;

interface Preferences {
  [key: string]: { inApp: boolean; email: boolean };
}

interface PreferencesResponse {
  preferences: Preferences;
}

interface NotificationPreferencesProps {
  onClose?: () => void;
}

export default function NotificationPreferences({ onClose }: NotificationPreferencesProps) {
  const [prefs, setPrefs] = useState<Preferences>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch<PreferencesResponse>('/api/notifications/preferences')
      .then(res => setPrefs(res.preferences))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const toggle = useCallback((eventType: string, channel: 'inApp' | 'email') => {
    setPrefs(prev => ({
      ...prev,
      [eventType]: {
        ...prev[eventType],
        [channel]: !prev[eventType]?.[channel],
      },
    }));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiFetch('/api/notifications/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: prefs }),
      });
      onClose?.();
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="p-4 text-sm text-muted">Loading preferences...</div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-panel border border-border rounded-lg shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-medium text-[var(--text)]">Notification Preferences</h2>
          {onClose && (
            <button onClick={onClose} className="text-muted hover:text-[var(--text)] text-lg leading-none">&times;</button>
          )}
        </div>

        <div className="px-4 py-3">
          {/* Column headers */}
          <div className="flex items-center gap-2 mb-2 text-xs text-muted">
            <span className="flex-1">Event</span>
            <span className="w-16 text-center">In-app</span>
            <span className="w-16 text-center">Email</span>
          </div>

          {EVENT_TYPES.map(({ key, label, description }) => {
            const pref = prefs[key] ?? { inApp: true, email: true };
            return (
              <div key={key} className="flex items-center gap-2 py-2 border-t border-border">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-[var(--text)]">{label}</p>
                  <p className="text-xs text-muted">{description}</p>
                </div>
                <label className="w-16 flex justify-center">
                  <input
                    type="checkbox"
                    checked={pref.inApp}
                    onChange={() => toggle(key, 'inApp')}
                    className="accent-[var(--accent)]"
                  />
                </label>
                <label className="w-16 flex justify-center">
                  <input
                    type="checkbox"
                    checked={pref.email}
                    onChange={() => toggle(key, 'email')}
                    className="accent-[var(--accent)]"
                  />
                </label>
              </div>
            );
          })}
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
          {onClose && (
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded border border-border text-muted hover:text-[var(--text)] hover:bg-bg transition-colors"
            >
              Cancel
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving...' : 'Save preferences'}
          </button>
        </div>
      </div>
    </div>
  );
}
