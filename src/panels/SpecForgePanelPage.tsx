import { useState, useCallback } from 'react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
import SpecForgeOutput, { type GeneratedSpec } from './SpecForgeOutput';

type DiagramType = 'flowchart' | 'sequenceDiagram' | 'ascii';
type OutputFormat = 'json' | 'markdown' | 'both';

const KEBAB_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export default function SpecForgePanelPage() {
  const { workspaceId, workspaces } = useWorkspace();
  const workspace = workspaces.find((w) => w.id === workspaceId);

  // Section 1: Spec Identity
  const [specName, setSpecName] = useState('');
  const [specNameError, setSpecNameError] = useState('');
  const [domain, setDomain] = useState('');

  // Section 2: Direction Stack Overrides
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [l4Override, setL4Override] = useState('');
  const [l5Override, setL5Override] = useState('');

  // Section 3: Spec Parameters
  const [storyCount, setStoryCount] = useState(8);
  const [storyPrefix, setStoryPrefix] = useState('US');
  const [includeDiagram, setIncludeDiagram] = useState(true);
  const [diagramType, setDiagramType] = useState<DiagramType>('flowchart');
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('json');

  // Section 4: Spec Brief
  const [specBrief, setSpecBrief] = useState('');

  // Generation state
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedSpec, setGeneratedSpec] = useState<GeneratedSpec | null>(null);

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
    const n = parseInt(value, 10);
    if (isNaN(n)) return;
    setStoryCount(Math.min(500, Math.max(1, n)));
  };

  const handleStoryPrefixChange = (value: string) => {
    setStoryPrefix(value.toUpperCase().slice(0, 4));
  };

  const canGenerate = specName.length > 0 && !specNameError && specBrief.length > 0;

  const handleGenerate = async () => {
    if (!canGenerate || isGenerating) return;
    setIsGenerating(true);
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
        }),
      });
      setGeneratedSpec(result);
    } catch (err) {
      console.error('Generate failed:', err);
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
    <div className="flex h-full gap-px bg-border">
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
                <div className="flex gap-4">
                  <Field label="Story Count" className="w-28">
                    <input
                      type="number"
                      min={3}
                      max={500}
                      value={storyCount}
                      onChange={(e) => handleStoryCountChange(e.target.value)}
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
          </div>
        </div>
      </div>

      {/* Right pane: Output tabs */}
      <div className="flex-1 flex flex-col bg-bg min-w-0">
        <SpecForgeOutput spec={generatedSpec} />
      </div>
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
