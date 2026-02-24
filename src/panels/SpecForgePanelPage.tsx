import { useState, useCallback, useEffect } from 'react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
import SpecForgeOutput, { type GeneratedSpec } from './SpecForgeOutput';
import BatchForge from './BatchForge';

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

export default function SpecForgePanelPage() {
  const { workspaceId, workspaces } = useWorkspace();
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const [forgeMode, setForgeMode] = useState<ForgeMode>('single');

  // Section 1: Spec Identity
  const [specName, setSpecName] = useState('');
  const [specNameError, setSpecNameError] = useState('');
  const [domain, setDomain] = useState('');

  // Model selection
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);

  // Fetch available models (includes recommended badge based on workspace default)
  useEffect(() => {
    if (!workspaceId) return;
    apiFetch<{ models: ModelOption[]; defaultModel: string }>(`/api/direction/models?workspaceId=${workspaceId}`)
      .then(data => {
        setAvailableModels(data.models);
        setDefaultModelId(data.defaultModel);
      })
      .catch(() => {});
  }, [workspaceId]);

  // Section 2: Direction Stack Overrides
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [l4Override, setL4Override] = useState('');
  const [l5Override, setL5Override] = useState('');

  // Section 3: Spec Parameters
  const [storyCount, setStoryCount] = useState(8);
  const [storyCountRaw, setStoryCountRaw] = useState('8');
  const [storyPrefix, setStoryPrefix] = useState('US');
  const [includeDiagram, setIncludeDiagram] = useState(true);
  const [diagramType, setDiagramType] = useState<DiagramType>('flowchart');
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('json');

  // Section 4: Spec Brief
  const [specBrief, setSpecBrief] = useState('');

  // Generation state
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedSpec, setGeneratedSpec] = useState<GeneratedSpec | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);

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

  const handleStoryCountChange = (value: string) => {
    setStoryCountRaw(value);
    const n = parseInt(value, 10);
    if (!isNaN(n)) setStoryCount(n);
  };

  const handleStoryCountBlur = () => {
    const clamped = Math.min(500, Math.max(1, storyCount || 1));
    setStoryCount(clamped);
    setStoryCountRaw(String(clamped));
  };

  const handleStoryPrefixChange = (value: string) => {
    setStoryPrefix(value.toUpperCase().slice(0, 4));
  };

  const canGenerate = specName.length > 0 && !specNameError && specBrief.length > 0;

  const handleGenerate = async () => {
    if (!canGenerate || isGenerating) return;
    setIsGenerating(true);
    setGenerateError(null);
    const modelUsed = selectedModel || defaultModelId || 'claude-sonnet-4-5-20250929';
    try {
      const result = await apiFetch<GeneratedSpec>('/api/specs/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      setGeneratedSpec(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const alternatives = availableModels
        .filter(m => m.id !== modelUsed)
        .map(m => m.label);
      const suggestion = alternatives.length > 0
        ? ` Try an alternative model: ${alternatives.join(', ')}.`
        : '';
      setGenerateError(`Generation failed with ${availableModels.find(m => m.id === modelUsed)?.label || modelUsed}: ${message}.${suggestion}`);
    } finally {
      setIsGenerating(false);
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
                <Field label="LLM Model">
                  <div className="space-y-1.5">
                    {availableModels.map((m) => (
                      <label
                        key={m.id}
                        className={`flex items-center gap-3 px-3 py-2 rounded border cursor-pointer transition-colors ${
                          (selectedModel || defaultModelId) === m.id
                            ? 'border-accent bg-accent/5'
                            : 'border-border bg-panel hover:border-accent/40'
                        }`}
                      >
                        <input
                          type="radio"
                          name="modelSelect"
                          value={m.id}
                          checked={(selectedModel || defaultModelId) === m.id}
                          onChange={() => setSelectedModel(m.id)}
                          className="w-4 h-4 accent-accent"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-text">{m.label}</span>
                            {m.recommended && (
                              <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-accent/15 text-accent">
                                Recommended
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-xs text-muted">{m.provider}</span>
                            <span className="text-xs text-muted/60">|</span>
                            <span className="text-xs text-muted">
                              ${m.costPer1kInput}/1K in · ${m.costPer1kOutput}/1K out
                            </span>
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </Field>

                <div className="flex gap-4">
                  <Field label="Story Count" className="w-28">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={storyCountRaw}
                      onChange={(e) => handleStoryCountChange(e.target.value)}
                      onBlur={handleStoryCountBlur}
                      className="w-full px-3 py-2 text-sm bg-panel border border-border rounded text-text outline-none focus:border-accent transition-colors"
                    />
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
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted mb-4">
                Spec Brief
              </h3>
              <Field label="What does this spec build?">
                <textarea
                  rows={10}
                  value={specBrief}
                  onChange={(e) => setSpecBrief(e.target.value.slice(0, 4000))}
                  placeholder="Describe the feature, technical approach, constraints, and definition of done. Be specific — this is your L4 layer for this generation."
                  className="w-full px-3 py-2 text-sm bg-panel border border-border rounded text-text placeholder:text-muted/50 outline-none focus:border-accent transition-colors resize-y font-mono"
                  style={{ minHeight: '10rem' }}
                />
              </Field>
              <div className="flex justify-end mt-1">
                <span className={`text-xs ${specBrief.length >= 3500 ? 'text-warning' : 'text-muted/60'}`}>
                  {specBrief.length.toLocaleString()} / 4,000
                </span>
              </div>
            </section>

            {/* Generate Button */}
            <div className="space-y-2">
              <button
                onClick={handleGenerate}
                disabled={!canGenerate || isGenerating}
                className={`w-full py-2.5 rounded text-sm font-medium transition-colors ${
                  canGenerate && !isGenerating
                    ? 'bg-accent text-white hover:bg-accent-hover cursor-pointer'
                    : 'bg-accent/30 text-white/40 cursor-not-allowed'
                }`}
              >
                {isGenerating ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Generating...
                  </span>
                ) : (
                  'Generate Spec'
                )}
              </button>
              {generateError && (
                <div className="px-3 py-2 rounded border border-error/30 bg-error/5 text-xs text-error">
                  {generateError}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Right pane: Output tabs */}
      <div className="flex-1 flex flex-col bg-bg min-w-0">
        <SpecForgeOutput spec={generatedSpec} />
      </div>
    </div>
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
  label: string;
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
