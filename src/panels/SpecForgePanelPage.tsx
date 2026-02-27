import { useState, useCallback, useEffect, useRef } from 'react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useGlobalToast } from '../contexts/ToastContext';
import { apiFetch } from '../lib/apiFetch';
import SpecForgeOutput, { type GeneratedSpec } from './SpecForgeOutput';
import BatchForge from './BatchForge';
import DirectionPreviewSidebar from '../components/DirectionPreviewSidebar';
import SpecForgeProgress from '../components/SpecForgeProgress';
import SpecForgePreview from '../components/SpecForgePreview';
import TemplatePickerModal from '../components/TemplatePickerModal';

import type { PanelId } from '../components/Sidebar';

type ForgeMode = 'single' | 'batch';
type DiagramType = 'flowchart' | 'sequenceDiagram' | 'ascii';
type OutputFormat = 'json' | 'markdown' | 'both';

interface ModelOption {
  id: string;
  label: string;
  provider: string;
  costPer1kInput: number;
  costPer1kOutput: number;
  recommended: boolean;
}

const KEBAB_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export default function SpecForgePanelPage({ onNavigate, onNavigateToRun, initialBrief }: { onNavigate?: (panel: PanelId) => void; onNavigateToRun?: (runId: number) => void; initialBrief?: string | null }) {
  const { workspaceId, workspaces } = useWorkspace();
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const [forgeMode, setForgeMode] = useState<ForgeMode>('single');

  // Section 1: Spec Identity
  const [specName, setSpecName] = useState('');
  const [specNameError, setSpecNameError] = useState('');
  const [domain, setDomain] = useState('');

  // Model selection (persisted in localStorage)
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState(() => {
    try { return localStorage.getItem('rorca:forge:model') ?? ''; } catch { return ''; }
  });
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);
  const [activeProvider, setActiveProvider] = useState<string>('claude-cli');

  // Fetch available models and active provider
  useEffect(() => {
    if (!workspaceId) return;
    Promise.all([
      apiFetch<{ models: ModelOption[]; defaultModel: string }>(`/api/direction/models?workspaceId=${workspaceId}`),
      apiFetch<{ provider: string }>(`/api/vault/keys/default-provider?workspaceId=${workspaceId}`),
    ]).then(([modelData, providerData]) => {
      setAvailableModels(modelData.models);
      setDefaultModelId(modelData.defaultModel);
      setActiveProvider(providerData.provider);
    }).catch(() => {});
  }, [workspaceId]);

  // Persist model selection to localStorage
  useEffect(() => {
    try {
      if (selectedModel) {
        localStorage.setItem('rorca:forge:model', selectedModel);
      } else {
        localStorage.removeItem('rorca:forge:model');
      }
    } catch { /* quota */ }
  }, [selectedModel]);

  // Section 2: Direction Stack Overrides
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [l4Override, setL4Override] = useState('');
  const [l5Override, setL5Override] = useState('');

  // Section 3: Spec Parameters
  const STORY_COUNT_PRESETS = [3, 5, 8, 10, 15, 20] as const;
  const [storyCount, setStoryCount] = useState(() => {
    try {
      const saved = localStorage.getItem('rorca:forge:storyCount');
      if (saved) { const n = parseInt(saved, 10); if (!isNaN(n) && n >= 1) return n; }
    } catch { /* ignore */ }
    return 8;
  });
  const isCustomCount = !STORY_COUNT_PRESETS.includes(storyCount as typeof STORY_COUNT_PRESETS[number]);
  const [showCustomInput, setShowCustomInput] = useState(isCustomCount);
  const [storyCountRaw, setStoryCountRaw] = useState(String(storyCount));
  const [storyPrefix, setStoryPrefix] = useState('US');
  const [includeDiagram, setIncludeDiagram] = useState(true);
  const [diagramType, setDiagramType] = useState<DiagramType>('flowchart');
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('json');

  // Section 4: Spec Brief (persisted in localStorage)
  const [specBrief, setSpecBrief] = useState(() => {
    try { return localStorage.getItem('rorca:forge:brief') ?? ''; } catch { return ''; }
  });
  const briefRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea between 6 and 16 rows
  const autoResizeBrief = useCallback(() => {
    const el = briefRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
    const minH = lineHeight * 6;
    const maxH = lineHeight * 16;
    el.style.height = `${Math.min(maxH, Math.max(minH, el.scrollHeight))}px`;
  }, []);

  // Persist brief to localStorage
  useEffect(() => {
    try { localStorage.setItem('rorca:forge:brief', specBrief); } catch { /* quota */ }
  }, [specBrief]);

  // Auto-resize on mount and when brief changes
  useEffect(() => { autoResizeBrief(); }, [specBrief, autoResizeBrief]);

  // Apply initialBrief from command palette
  useEffect(() => {
    if (initialBrief != null && initialBrief.length > 0) {
      setSpecBrief(initialBrief);
      setTimeout(() => briefRef.current?.focus(), 100);
    }
  }, [initialBrief]);

  // Token estimate: word count × 1.3
  const estimatedTokens = Math.ceil((specBrief.trim().split(/\s+/).filter(Boolean).length) * 1.3);

  // Generation state
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedSpec, setGeneratedSpec] = useState<GeneratedSpec | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [apiDone, setApiDone] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);

  const validateSpecName = useCallback((value: string) => {
    if (!value) {
      setSpecNameError('');
      return;
    }
    if (!KEBAB_RE.test(value)) {
      setSpecNameError('Must be kebab-case (e.g. user-auth-oauth)');
    } else {
      setSpecNameError('');
    }
  }, []);

  // Persist story count to localStorage
  useEffect(() => {
    try { localStorage.setItem('rorca:forge:storyCount', String(storyCount)); } catch { /* quota */ }
  }, [storyCount]);

  const handleStoryCountSelect = (value: string) => {
    if (value === 'custom') {
      setShowCustomInput(true);
      setStoryCountRaw(String(storyCount));
    } else {
      setShowCustomInput(false);
      const n = parseInt(value, 10);
      if (!isNaN(n)) {
        setStoryCount(n);
        setStoryCountRaw(value);
      }
    }
  };

  const handleCustomCountChange = (value: string) => {
    setStoryCountRaw(value);
    const n = parseInt(value, 10);
    if (!isNaN(n) && n >= 1) setStoryCount(n);
  };

  const handleCustomCountBlur = () => {
    const clamped = Math.min(500, Math.max(1, storyCount || 1));
    setStoryCount(clamped);
    setStoryCountRaw(String(clamped));
  };

  const handleStoryPrefixChange = (value: string) => {
    setStoryPrefix(value.toUpperCase().slice(0, 4));
  };

  // Quick Run state
  const [isQuickRunning, setIsQuickRunning] = useState(false);
  const { show: showToast } = useGlobalToast();

  const canGenerate = specName.length > 0 && !specNameError && specBrief.length > 0;
  const canQuickRun = specBrief.trim().length > 0 && !!workspaceId;

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsGenerating(false);
    setApiDone(false);
    setGenerateError(null);
  }, []);

  const handleGenerate = async () => {
    if (!canGenerate || isGenerating) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setIsGenerating(true);
    setGenerateError(null);
    setApiDone(false);
    const modelUsed = selectedModel || defaultModelId || 'claude-sonnet-4-5-20250929';
    try {
      const result = await apiFetch<GeneratedSpec>('/api/specs/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          workspaceId,
          specName,
          domain,
          l4Override: l4Override || undefined,
          l5Override: l5Override || undefined,
          storyCount,
          storyPrefix,
          includeDiagram,
          diagramType: includeDiagram ? diagramType : undefined,
          outputFormat,
          specBrief,
          model: selectedModel || undefined,
        }),
      });
      setApiDone(true);
      setGeneratedSpec(result);
      // Brief delay so user sees the validating stage complete
      setTimeout(() => setIsGenerating(false), 800);
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      setApiDone(true);
      const message = err instanceof Error ? err.message : String(err);
      const alternatives = availableModels
        .filter(m => m.id !== modelUsed)
        .map(m => m.label);
      const suggestion = alternatives.length > 0
        ? ` Try an alternative model: ${alternatives.join(', ')}.`
        : '';
      setGenerateError(`Generation failed with ${availableModels.find(m => m.id === modelUsed)?.label || modelUsed}: ${message}.${suggestion}`);
      setIsGenerating(false);
    }
  };

  const handleQuickRun = async () => {
    if (!canQuickRun || isQuickRunning) return;
    setIsQuickRunning(true);
    try {
      const res = await apiFetch<{ runId?: number; specId?: string; conflict?: boolean; activeRunId?: number }>(
        '/api/pipeline/quick-run',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId,
            brief: specBrief.trim(),
            model: selectedModel || undefined,
          }),
        },
      );
      if (res.conflict) {
        showToast('Another run is active in this workspace', 'error');
        if (res.activeRunId && onNavigateToRun) {
          onNavigateToRun(res.activeRunId);
        }
      } else if (res.runId) {
        showToast('Quick run started', 'success');
        if (onNavigateToRun) onNavigateToRun(res.runId);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Quick run failed', 'error');
    } finally {
      setIsQuickRunning(false);
    }
  };

  if (!workspaceId) {
    return (
      <div className="flex items-center justify-center h-full text-muted">
        Select a workspace to use Spec Forge.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Mode toggle: Single / Batch */}
      <div className="flex border-b border-border shrink-0 bg-bg">
        {(['single', 'batch'] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => setForgeMode(mode)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 ${
              forgeMode === mode
                ? 'text-text border-accent'
                : 'text-muted hover:text-text border-transparent'
            }`}
          >
            {mode === 'single' ? 'Single' : 'Batch'}
          </button>
        ))}
      </div>

      {forgeMode === 'batch' ? (
        <BatchForge />
      ) : (
    <div className="flex flex-1 min-h-0 gap-px bg-border">
      {/* Left pane: Form (~50% width) */}
      <div className="flex-1 flex flex-col bg-bg min-w-0">
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-xl mx-auto px-6 py-6 space-y-8">

            {/* Section 1: Spec Identity */}
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted mb-4">
                Spec Identity
              </h3>
              <div className="space-y-4">
                <Field label="Spec Name" error={specNameError}>
                  <input
                    type="text"
                    value={specName}
                    onChange={(e) => setSpecName(e.target.value)}
                    onBlur={() => validateSpecName(specName)}
                    placeholder="user-auth-oauth"
                    className="w-full px-3 py-2 text-sm bg-panel border border-border rounded text-text placeholder:text-muted/50 outline-none focus:border-accent transition-colors"
                  />
                </Field>
                <Field label="Domain">
                  <input
                    type="text"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    placeholder="backend, frontend, infra"
                    className="w-full px-3 py-2 text-sm bg-panel border border-border rounded text-text placeholder:text-muted/50 outline-none focus:border-accent transition-colors"
                  />
                </Field>
                <Field label="Target Workspace">
                  <span className="inline-flex items-center px-2.5 py-1 rounded text-xs font-medium bg-accent/10 text-accent border border-accent/20">
                    {workspace?.name ?? workspaceId}
                  </span>
                </Field>
              </div>
            </section>

            {/* Section 2: Direction Stack Overrides (collapsed by default) */}
            <section>
              <button
                onClick={() => setOverridesOpen(!overridesOpen)}
                className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted hover:text-text transition-colors w-full"
              >
                <svg
                  className={`w-3 h-3 transition-transform ${overridesOpen ? 'rotate-90' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                Direction Stack Overrides
              </button>
              {overridesOpen && (
                <div className="mt-4 space-y-4">
                  <Field label="L4 Spec Brief">
                    <textarea
                      rows={4}
                      value={l4Override}
                      onChange={(e) => setL4Override(e.target.value)}
                      placeholder="One paragraph describing what this spec builds"
                      className="w-full px-3 py-2 text-sm bg-panel border border-border rounded text-text placeholder:text-muted/50 outline-none focus:border-accent transition-colors resize-none font-mono"
                    />
                  </Field>
                  <Field label="L5 Story Annotations">
                    <textarea
                      rows={4}
                      value={l5Override}
                      onChange={(e) => setL5Override(e.target.value)}
                      placeholder="Per-story hints, constraints, or design decisions"
                      className="w-full px-3 py-2 text-sm bg-panel border border-border rounded text-text placeholder:text-muted/50 outline-none focus:border-accent transition-colors resize-none font-mono"
                    />
                  </Field>
                  <p className="text-xs text-muted/70">
                    These override L4/L5 from the Direction Stack Composer for this generation only
                  </p>
                </div>
              )}
            </section>

            {/* Section 3: Spec Parameters */}
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted mb-4">
                Spec Parameters
              </h3>
              <div className="space-y-4">
                <Field label={
                  <span className="flex items-center gap-2">
                    LLM Model
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded ${
                      activeProvider === 'claude-cli'
                        ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                        : 'bg-accent/10 text-accent border border-accent/20'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        activeProvider === 'claude-cli' ? 'bg-green-500' : 'bg-accent'
                      }`} />
                      {activeProvider === 'claude-cli' ? 'Subscription' :
                       activeProvider === 'anthropic' ? 'Anthropic API' :
                       activeProvider === 'openai-compat' ? 'OpenAI Compat' :
                       activeProvider === 'openrouter' ? 'OpenRouter' :
                       activeProvider}
                    </span>
                  </span>
                }>
                  <select
                    value={selectedModel || defaultModelId || ''}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-panel border border-border rounded text-text outline-none focus:border-accent transition-colors appearance-none cursor-pointer bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23888%22%20stroke-width%3D%222%22%3E%3Cpath%20d%3D%22M6%209l6%206%206-6%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[right_0.75rem_center]"
                    aria-label="Select LLM model"
                  >
                    {availableModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} — {m.provider}{m.recommended ? ' (Recommended)' : ''} · ${m.costPer1kInput}/1K in · ${m.costPer1kOutput}/1K out
                      </option>
                    ))}
                  </select>
                </Field>

                <div className="flex gap-4">
                  <Field label="Story Count" className="w-40">
                    <div className="flex gap-2">
                      <select
                        value={showCustomInput ? 'custom' : String(storyCount)}
                        onChange={(e) => handleStoryCountSelect(e.target.value)}
                        className="flex-1 px-3 py-2 text-sm bg-panel border border-border rounded text-text outline-none focus:border-accent transition-colors appearance-none cursor-pointer bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23888%22%20stroke-width%3D%222%22%3E%3Cpath%20d%3D%22M6%209l6%206%206-6%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[right_0.5rem_center]"
                        aria-label="Select story count"
                      >
                        {STORY_COUNT_PRESETS.map((n) => (
                          <option key={n} value={n}>{n} stories</option>
                        ))}
                        <option value="custom">Custom</option>
                      </select>
                      {showCustomInput && (
                        <input
                          type="text"
                          inputMode="numeric"
                          value={storyCountRaw}
                          onChange={(e) => handleCustomCountChange(e.target.value)}
                          onBlur={handleCustomCountBlur}
                          className="w-16 px-2 py-2 text-sm bg-panel border border-border rounded text-text outline-none focus:border-accent transition-colors text-center"
                          aria-label="Custom story count"
                          autoFocus
                        />
                      )}
                    </div>
                  </Field>
                  <Field label="Story Prefix" className="w-28">
                    <input
                      type="text"
                      maxLength={4}
                      value={storyPrefix}
                      onChange={(e) => handleStoryPrefixChange(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-panel border border-border rounded text-text outline-none focus:border-accent transition-colors font-mono"
                    />
                  </Field>
                </div>

                <div className="space-y-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeDiagram}
                      onChange={(e) => setIncludeDiagram(e.target.checked)}
                      className="w-4 h-4 rounded border-border bg-panel accent-accent"
                    />
                    <span className="text-sm text-text">Include diagram</span>
                  </label>

                  {includeDiagram && (
                    <div className="ml-6 space-y-2">
                      <RadioOption
                        name="diagramType"
                        value="flowchart"
                        checked={diagramType === 'flowchart'}
                        onChange={() => setDiagramType('flowchart')}
                        label="Mermaid flowchart"
                      />
                      <RadioOption
                        name="diagramType"
                        value="sequenceDiagram"
                        checked={diagramType === 'sequenceDiagram'}
                        onChange={() => setDiagramType('sequenceDiagram')}
                        label="Mermaid sequenceDiagram"
                      />
                      <RadioOption
                        name="diagramType"
                        value="ascii"
                        checked={diagramType === 'ascii'}
                        onChange={() => setDiagramType('ascii')}
                        label="ASCII block"
                      />
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <span className="text-xs font-medium text-muted">Output Format</span>
                  <div className="space-y-2">
                    <RadioOption
                      name="outputFormat"
                      value="json"
                      checked={outputFormat === 'json'}
                      onChange={() => setOutputFormat('json')}
                      label="JSON for run-loop.sh"
                    />
                    <RadioOption
                      name="outputFormat"
                      value="markdown"
                      checked={outputFormat === 'markdown'}
                      onChange={() => setOutputFormat('markdown')}
                      label="Markdown spec doc"
                    />
                    <RadioOption
                      name="outputFormat"
                      value="both"
                      checked={outputFormat === 'both'}
                      onChange={() => setOutputFormat('both')}
                      label="Both"
                    />
                  </div>
                </div>
              </div>
            </section>

            {/* Section 4: Spec Brief (main input) */}
            <section>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
                  Spec Brief
                </h3>
                <button
                  onClick={() => setShowTemplatePicker(true)}
                  className="text-xs text-accent hover:text-accent-hover transition-colors"
                >
                  Start from template &rarr;
                </button>
              </div>
              <Field label="What does this spec build?">
                <textarea
                  ref={briefRef}
                  rows={6}
                  value={specBrief}
                  onChange={(e) => setSpecBrief(e.target.value.slice(0, 4000))}
                  placeholder="Describe what you want to build..."
                  className="w-full px-3 py-2 text-sm bg-panel border border-border rounded text-text placeholder:text-muted/50 outline-none focus:border-accent transition-colors resize-none font-mono"
                />
              </Field>
              <div className="flex items-center justify-between mt-1.5">
                <div className="flex items-center gap-3">
                  <span className={`text-xs ${estimatedTokens >= 2000 ? 'text-warning' : 'text-muted/60'}`}>
                    ~{estimatedTokens.toLocaleString()} tokens
                  </span>
                  <span className={`text-xs ${specBrief.length >= 3500 ? 'text-warning' : 'text-muted/60'}`}>
                    {specBrief.length.toLocaleString()} chars
                  </span>
                </div>
                {estimatedTokens >= 2000 && (
                  <span className="text-xs text-warning">
                    Brief is long — consider breaking into smaller specs
                  </span>
                )}
              </div>
            </section>

            {/* Generate Button / Progress Indicator */}
            <div className="space-y-2">
              {isGenerating || (generateError && !generatedSpec) ? (
                <SpecForgeProgress
                  isActive={isGenerating}
                  onCancel={handleCancel}
                  error={generateError}
                  apiDone={apiDone}
                />
              ) : !generatedSpec ? (
                <>
                  <button
                    onClick={handleGenerate}
                    disabled={!canGenerate || isGenerating}
                    className={`w-full py-2.5 rounded text-sm font-medium transition-colors ${
                      canGenerate && !isGenerating
                        ? 'bg-accent text-white hover:bg-accent-hover cursor-pointer'
                        : 'bg-accent/30 text-white/40 cursor-not-allowed'
                    }`}
                  >
                    Generate Spec
                  </button>
                  {canQuickRun && (
                    <button
                      onClick={handleQuickRun}
                      disabled={isQuickRunning || isGenerating}
                      className={`w-full py-2 rounded text-sm font-medium transition-colors border ${
                        isQuickRunning || isGenerating
                          ? 'bg-panel/50 border-border/50 text-muted/40 cursor-not-allowed'
                          : 'bg-panel border-border text-text hover:bg-accent/10 hover:border-accent/30 cursor-pointer'
                      }`}
                    >
                      {isQuickRunning ? (
                        <span className="flex items-center justify-center gap-2">
                          <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                          Generating & running...
                        </span>
                      ) : (
                        'Quick Run'
                      )}
                    </button>
                  )}
                </>
              ) : null}
            </div>

            {/* Inline spec preview after generation */}
            {generatedSpec && !isGenerating && (
              <SpecForgePreview
                spec={generatedSpec}
                workspaceId={workspaceId}
                onRegenerate={handleGenerate}
                onEditBrief={() => {
                  setGeneratedSpec(null);
                  setGenerateError(null);
                  setApiDone(false);
                  setTimeout(() => briefRef.current?.focus(), 50);
                }}
                isRegenerating={isGenerating}
                onNavigate={onNavigate}
                onNavigateToRun={onNavigateToRun}
              />
            )}
          </div>
        </div>
      </div>

      {/* Center pane: Direction preview sidebar (30% width) */}
      <div className="w-[30%] shrink-0 min-w-[200px] max-w-[320px]">
        <DirectionPreviewSidebar onNavigateToStack={onNavigate ? () => onNavigate('stack') : undefined} />
      </div>

      {/* Right pane: Output tabs */}
      <div className="flex-1 flex flex-col bg-bg min-w-0">
        <SpecForgeOutput spec={generatedSpec} />
      </div>
    </div>
      )}

      {showTemplatePicker && (
        <TemplatePickerModal
          onClose={() => setShowTemplatePicker(false)}
          onSelect={(tpl) => {
            setSpecBrief(tpl.brief);
            setStoryCount(tpl.storyCount);
            setShowTemplatePicker(false);
            setTimeout(() => briefRef.current?.focus(), 50);
          }}
        />
      )}
    </div>
  );
}

/* ─── Helpers ──────────────────────────────────────────────────────── */

function Field({
  label,
  error,
  className,
  children,
}: {
  label: React.ReactNode;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <label className="block text-xs font-medium text-muted mb-1.5">{label}</label>
      {children}
      {error && <p className="mt-1 text-xs text-error">{error}</p>}
    </div>
  );
}

function RadioOption({
  name,
  value,
  checked,
  onChange,
  label,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="w-4 h-4 border-border bg-panel accent-accent"
      />
      <span className="text-sm text-text">{label}</span>
    </label>
  );
}
