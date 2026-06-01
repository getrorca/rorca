/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect } from 'react';
import { Key, Loader2, Trash2, Plus, Check, AlertTriangle, Eye, EyeOff } from 'lucide-react';
import { apiFetch } from '../../lib/apiFetch';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useGlobalToast } from '../../contexts/ToastContext';

interface VaultKey {
  id: string;
  provider: string;
  label: string;
  masked_key: string;
  created_at: string;
}

export default function ApiKeysSection() {
  const toast = useGlobalToast();
  const { workspaceId } = useWorkspace();
  const [keys, setKeys] = useState<VaultKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newProvider, setNewProvider] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newKey, setNewKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const fetchKeys = () => {
    if (!workspaceId) return;
    setLoading(true);
    apiFetch<{ keys: VaultKey[] }>(`/api/vault/keys?workspaceId=${workspaceId}`)
      .then((data) => setKeys(data.keys || []))
      .catch(() => setError('Failed to load API keys'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchKeys(); }, [workspaceId]);

  const handleAdd = async () => {
    if (!workspaceId || !newProvider || !newKey) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch('/api/vault/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, provider: newProvider, label: newLabel || newProvider, key: newKey }),
      });
      setShowAdd(false);
      setNewProvider('');
      setNewLabel('');
      setNewKey('');
      toast.show('API key added', 'success');
      fetchKeys();
    } catch (err: any) {
      const msg = err.message || 'Failed to add key';
      setError(msg);
      toast.show(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (keyId: string) => {
    if (!workspaceId) return;
    setDeleting(keyId);
    try {
      await apiFetch(`/api/vault/keys/${keyId}?workspaceId=${workspaceId}`, { method: 'DELETE' });
      toast.show('API key removed', 'success');
      fetchKeys();
    } catch (err: any) {
      const msg = err.message || 'Failed to delete key';
      setError(msg);
      toast.show(msg, 'error');
    } finally {
      setDeleting(null);
    }
  };

  if (!workspaceId) {
    return (
      <div className="h-48 flex items-center justify-center text-muted text-sm">
        Select a workspace to manage API keys.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text)]">API Keys</h2>
          <p className="text-sm text-muted mt-1">Encrypted API keys stored in the AES-256-GCM vault for LLM providers.</p>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent/90 transition-colors"
        >
          <Plus size={14} />
          Add Key
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-500 bg-red-500/5 border border-red-500/20 rounded p-3">
          <AlertTriangle size={14} />
          {error}
        </div>
      )}

      {showAdd && (
        <div className="border border-border rounded-lg p-4 bg-surface-100 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-muted mb-1">Provider</label>
              <select
                value={newProvider}
                onChange={(e) => setNewProvider(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none"
              >
                <option value="">Select provider...</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="google">Google</option>
                <option value="openrouter">OpenRouter</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">Label</label>
              <input
                type="text"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="e.g. Production key"
                className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">API Key</label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder="sk-..."
                className="w-full px-3 py-2 pr-10 text-sm bg-bg border border-border rounded focus:border-accent outline-none font-mono"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2 top-2 p-1 text-muted hover:text-[var(--text)]"
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleAdd}
              disabled={saving || !newProvider || !newKey}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              {saving ? 'Saving...' : 'Save Key'}
            </button>
            <button
              onClick={() => { setShowAdd(false); setNewProvider(''); setNewLabel(''); setNewKey(''); }}
              className="px-3 py-1.5 text-sm text-muted hover:text-[var(--text)] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-muted text-sm py-8 justify-center">
          <Loader2 size={16} className="animate-spin" /> Loading keys...
        </div>
      ) : keys.length === 0 ? (
        <div className="border border-border rounded-lg p-8 text-center">
          <Key size={32} className="mx-auto text-muted/40 mb-3" />
          <p className="text-sm text-muted">No API keys configured</p>
          <p className="text-xs text-muted/70 mt-1">Add a key to use with OpenCode execution or spec generation.</p>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="grid grid-cols-[1fr_120px_140px_40px] gap-2 px-4 py-2 bg-bg text-[10px] text-muted font-medium uppercase tracking-wider border-b border-border">
            <span>Provider / Label</span>
            <span>Key</span>
            <span>Added</span>
            <span />
          </div>
          {keys.map((k) => (
            <div key={k.id} className="grid grid-cols-[1fr_120px_140px_40px] gap-2 px-4 py-2.5 border-b border-border last:border-b-0 items-center">
              <div>
                <p className="text-sm text-[var(--text)] font-medium">{k.label}</p>
                <p className="text-[10px] text-muted capitalize">{k.provider}</p>
              </div>
              <span className="text-xs text-muted font-mono">{k.masked_key}</span>
              <span className="text-xs text-muted">
                {new Date(k.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
              <button
                onClick={() => handleDelete(k.id)}
                disabled={deleting === k.id}
                className="p-1 text-muted hover:text-red-500 transition-colors disabled:opacity-50"
                title="Delete key"
              >
                {deleting === k.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
