/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState } from 'react';
import { X, Terminal, Key, Zap, Globe, CheckCircle2, Copy, ExternalLink } from 'lucide-react';
import { Github } from './icons/GithubIcon';

// ─── Provider Setup Steps ─────────────────────────────────────────────────────

interface ProviderGuide {
  id: string;
  name: string;
  badge: string;
  badgeColor: string;
  steps: { title: string; content: string; code?: string }[];
  modelExamples: string[];
  notes?: string;
}

const PROVIDER_GUIDES: ProviderGuide[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    badge: 'API Key',
    badgeColor: 'bg-green-500/15 text-green-400',
    steps: [
      { title: 'Get an API key', content: 'Go to platform.openai.com/api-keys and create a new secret key.', code: 'https://platform.openai.com/api-keys' },
      { title: 'Add key to Rorca', content: 'Go to Settings > Model & Providers > OpenAI-Compatible > Add Key, or set in backend/.env:', code: 'OPENAI_API_KEY=sk-...' },
      { title: 'Select model', content: 'In Settings > Execution Engine, choose OpenCode and select an OpenAI model from the dropdown.' },
      { title: 'Test connection', content: 'Click "Save Engine Configuration". The status badge should turn purple showing your selected model.' },
    ],
    modelExamples: ['openai/gpt-4o', 'openai/gpt-4o-mini', 'openai/o3'],
    notes: 'GPT-4o recommended for balanced speed and quality. o3 for complex reasoning tasks.',
  },
  {
    id: 'google',
    name: 'Google (Gemini)',
    badge: 'API Key',
    badgeColor: 'bg-blue-500/15 text-blue-400',
    steps: [
      { title: 'Get an API key', content: 'Go to aistudio.google.com/apikey and create an API key.', code: 'https://aistudio.google.com/apikey' },
      { title: 'Add key to Rorca', content: 'Go to Settings > Model & Providers > Add Key for the Google provider, or set in backend/.env:', code: 'GOOGLE_API_KEY=AI...' },
      { title: 'Select model', content: 'In Settings > Execution Engine, choose OpenCode and select a Google model.' },
      { title: 'Test connection', content: 'Save and verify the status badge updates.' },
    ],
    modelExamples: ['google/gemini-2.0-flash', 'google/gemini-2.0-pro'],
    notes: 'Gemini 2.0 Flash offers a 1M token context window — great for large codebases.',
  },
  {
    id: 'anthropic',
    name: 'Anthropic API',
    badge: 'API Key',
    badgeColor: 'bg-amber-500/15 text-amber-400',
    steps: [
      { title: 'Get an API key', content: 'Go to console.anthropic.com/settings/keys and create a key.', code: 'https://console.anthropic.com/settings/keys' },
      { title: 'Add key to Rorca', content: 'Go to Settings > Model & Providers > Anthropic > Add Key, or set in backend/.env:', code: 'ANTHROPIC_API_KEY=sk-ant-...' },
      { title: 'Select model', content: 'In Settings > Execution Engine, choose OpenCode and select an Anthropic model.' },
      { title: 'Test connection', content: 'Save and verify the status badge updates.' },
    ],
    modelExamples: ['anthropic/claude-sonnet-4-5-20250929', 'anthropic/claude-haiku-3-5-20241022'],
    notes: 'Same Claude models as the subscription path, but billed per-token via API. Use this if you want API-based billing instead of a flat subscription.',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    badge: 'API Key',
    badgeColor: 'bg-purple-500/15 text-purple-400',
    steps: [
      { title: 'Get an API key', content: 'Go to openrouter.ai/keys and create an API key.', code: 'https://openrouter.ai/keys' },
      { title: 'Add key to Rorca', content: 'Go to Settings > Model & Providers > OpenRouter > Add Key, or set in backend/.env:', code: 'OPENROUTER_API_KEY=sk-or-v1-...' },
      { title: 'Select model', content: 'In Settings > Execution Engine, choose OpenCode and select an OpenRouter model.' },
      { title: 'Test connection', content: 'Save and verify.' },
    ],
    modelExamples: ['openrouter/auto'],
    notes: 'Access 200+ models through a single API key. The "auto" model routes to the best available model automatically.',
  },
  {
    id: 'ollama',
    name: 'Ollama (Local)',
    badge: 'Free',
    badgeColor: 'bg-green-500/15 text-green-400',
    steps: [
      { title: 'Install Ollama', content: 'Download from ollama.com or install via Homebrew:', code: 'brew install ollama' },
      { title: 'Start the server', content: 'Run Ollama in the background:', code: 'ollama serve' },
      { title: 'Pull a model', content: 'Download a coding-capable model:', code: 'ollama pull llama3\n# or: ollama pull codellama' },
      { title: 'Select in Rorca', content: 'In Settings > Execution Engine, choose OpenCode and select your Ollama model from the "Local" group. No API key needed.' },
    ],
    modelExamples: ['ollama/llama3', 'ollama/codellama', 'ollama/deepseek-coder'],
    notes: 'Completely free, runs on your machine. No data leaves your network. Quality depends on hardware — 16GB+ RAM recommended for 7B+ models.',
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    badge: 'Subscription',
    badgeColor: 'bg-purple-500/15 text-purple-400',
    steps: [
      { title: 'Have a Copilot subscription', content: 'You need an active GitHub Copilot Individual or Business subscription.' },
      { title: 'Connect GitHub', content: 'In Settings > Execution Engine, click "Sign in with GitHub". Authorize the OAuth app.' },
      { title: 'Select Copilot model', content: 'Choose "GitHub Copilot" from the model dropdown in the Execution Engine section.' },
      { title: 'Save', content: 'Click "Save Engine Configuration". The status should show "GitHub Copilot" with a Subscription badge.' },
    ],
    modelExamples: ['github/copilot'],
    notes: 'Uses your existing Copilot subscription — no per-token API billing. Requires GitHub OAuth sign-in.',
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function OpenCodeSetupGuide({ onClose }: { onClose: () => void }) {
  const [activeProvider, setActiveProvider] = useState<string>('openai');
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const guide = PROVIDER_GUIDES.find(g => g.id === activeProvider) ?? PROVIDER_GUIDES[0];

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCode(text);
    setTimeout(() => setCopiedCode(null), 1500);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-panel border border-border rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="text-base font-semibold text-[var(--text)]">OpenCode Setup Guide</h2>
            <p className="text-xs text-muted mt-0.5">Step-by-step setup for each provider</p>
          </div>
          <button onClick={onClose} className="p-1.5 text-muted hover:text-[var(--text)] transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Prerequisites sidebar */}
          <div className="w-56 shrink-0 border-r border-border p-3 overflow-y-auto">
            {/* Prerequisites */}
            <div className="mb-4">
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-2">Prerequisites</h3>
              <div className="space-y-2">
                <div className="flex items-start gap-2 text-xs">
                  <Terminal size={12} className="text-accent shrink-0 mt-0.5" />
                  <div>
                    <span className="text-[var(--text)]">Install OpenCode</span>
                    <code className="block text-[10px] text-muted mt-0.5 bg-bg px-1.5 py-0.5 rounded">npm i -g opencode-ai</code>
                  </div>
                </div>
                <div className="flex items-start gap-2 text-xs">
                  <CheckCircle2 size={12} className="text-accent shrink-0 mt-0.5" />
                  <div>
                    <span className="text-[var(--text)]">Verify version</span>
                    <code className="block text-[10px] text-muted mt-0.5 bg-bg px-1.5 py-0.5 rounded">opencode --version</code>
                    <span className="text-[10px] text-muted">Must be &ge; 0.1.0</span>
                  </div>
                </div>
                <div className="flex items-start gap-2 text-xs">
                  <Zap size={12} className="text-accent shrink-0 mt-0.5" />
                  <div>
                    <span className="text-[var(--text)]">Set engine</span>
                    <code className="block text-[10px] text-muted mt-0.5 bg-bg px-1.5 py-0.5 rounded">RORCA_AGENT=opencode</code>
                  </div>
                </div>
              </div>
            </div>

            {/* Provider tabs */}
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-2">Providers</h3>
            <div className="space-y-1">
              {PROVIDER_GUIDES.map(p => (
                <button
                  key={p.id}
                  onClick={() => setActiveProvider(p.id)}
                  className={`w-full flex items-center justify-between px-2.5 py-2 rounded text-xs transition-colors ${
                    activeProvider === p.id
                      ? 'bg-accent/10 text-accent'
                      : 'text-muted hover:text-[var(--text)] hover:bg-bg'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    {p.id === 'copilot' ? <Github size={12} /> : p.id === 'ollama' ? <Terminal size={12} /> : <Key size={12} />}
                    {p.name}
                  </span>
                  <span className={`px-1.5 py-0.5 text-[9px] font-semibold rounded ${p.badgeColor}`}>
                    {p.badge}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Guide content */}
          <div className="flex-1 overflow-y-auto p-6">
            <div className="flex items-center gap-3 mb-5">
              <h3 className="text-sm font-semibold text-[var(--text)]">{guide.name}</h3>
              <span className={`px-2 py-0.5 text-[10px] font-semibold rounded ${guide.badgeColor}`}>
                {guide.badge}
              </span>
            </div>

            {/* Steps */}
            <div className="space-y-4">
              {guide.steps.map((step, i) => (
                <div key={i} className="flex gap-3">
                  <div className="flex items-center justify-center w-6 h-6 rounded-full bg-accent/10 text-accent text-xs font-semibold shrink-0 mt-0.5">
                    {i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="text-sm font-medium text-[var(--text)]">{step.title}</h4>
                    <p className="text-xs text-muted mt-0.5">{step.content}</p>
                    {step.code && (
                      <div className="relative mt-2">
                        <pre className="text-[11px] bg-bg border border-border rounded px-3 py-2 overflow-x-auto font-mono text-[var(--text)]">
                          {step.code}
                        </pre>
                        {!step.code.startsWith('http') && (
                          <button
                            onClick={() => copyToClipboard(step.code!)}
                            className="absolute top-1.5 right-1.5 p-1 text-muted hover:text-[var(--text)] transition-colors"
                            title="Copy"
                          >
                            {copiedCode === step.code ? (
                              <CheckCircle2 size={12} className="text-green-400" />
                            ) : (
                              <Copy size={12} />
                            )}
                          </button>
                        )}
                        {step.code.startsWith('http') && (
                          <a
                            href={step.code}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="absolute top-1.5 right-1.5 p-1 text-muted hover:text-accent transition-colors"
                            title="Open in browser"
                          >
                            <ExternalLink size={12} />
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Model examples */}
            <div className="mt-6 border border-border rounded p-4 bg-bg">
              <h4 className="text-xs font-semibold text-[var(--text)] mb-2">Model strings for RORCA_MODEL</h4>
              <div className="flex flex-wrap gap-2">
                {guide.modelExamples.map(m => (
                  <button
                    key={m}
                    onClick={() => copyToClipboard(m)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-mono bg-panel border border-border rounded hover:border-accent/40 text-[var(--text)] transition-colors"
                    title="Click to copy"
                  >
                    {m}
                    {copiedCode === m ? (
                      <CheckCircle2 size={10} className="text-green-400" />
                    ) : (
                      <Copy size={10} className="text-muted" />
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Notes */}
            {guide.notes && (
              <div className="mt-4 px-4 py-3 rounded border border-accent/20 bg-accent/5">
                <p className="text-xs text-muted">
                  <span className="font-medium text-accent">Tip: </span>
                  {guide.notes}
                </p>
              </div>
            )}

            {/* Test connection */}
            <div className="mt-6 border border-border rounded p-4 bg-bg">
              <h4 className="text-xs font-semibold text-[var(--text)] mb-2 flex items-center gap-2">
                <Globe size={14} className="text-accent" />
                Test your setup
              </h4>
              <p className="text-xs text-muted mb-2">After configuring, verify with the health endpoint:</p>
              <div className="relative">
                <pre className="text-[11px] bg-panel border border-border rounded px-3 py-2 font-mono text-[var(--text)]">
                  curl http://localhost:3030/api/health
                </pre>
                <button
                  onClick={() => copyToClipboard('curl http://localhost:3030/api/health')}
                  className="absolute top-1.5 right-1.5 p-1 text-muted hover:text-[var(--text)] transition-colors"
                >
                  {copiedCode === 'curl http://localhost:3030/api/health' ? (
                    <CheckCircle2 size={12} className="text-green-400" />
                  ) : (
                    <Copy size={12} />
                  )}
                </button>
              </div>
              <p className="text-[10px] text-muted mt-2">
                Look for <code className="bg-panel px-1 rounded">opencodeInstalled: true</code> in the response.
                Or check the green/amber badge in Settings &gt; Execution Engine.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
