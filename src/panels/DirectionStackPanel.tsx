import { useState, useEffect, useRef, useCallback } from 'react';
import { Store, Trash2, ExternalLink, Compass } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useDirectionLayer } from '../hooks/useDirectionLayer';
import { apiFetch } from '../lib/apiFetch';
import BootstrapContextModal from '../components/BootstrapContextModal';
import AISetupWizard from '../components/AISetupWizard';
import DirectionHealthIndicator from '../components/DirectionHealthIndicator';
import { HelpTooltip } from '../components/HelpTooltip';
import { useAppNavigate } from '../routes';

// ─── Skills sub-tab types ──────────────────────────────────────────────────

interface SkillItem {
  name: string;
  description: string;
  source: string;
  filePath: string;
}

type StackView = 'layers' | 'skills';

// ─── Skills List Component ─────────────────────────────────────────────────

function SkillsList({ workspaceId }: { workspaceId: string }) {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [loading, setLoading] = useState(true);
  const navigateTo = useAppNavigate();

  const fetchSkills = useCallback(() => {
    setLoading(true);
    apiFetch<{ skills: SkillItem[] }>(`/api/skills?workspaceId=${workspaceId}`)
      .then((data) => setSkills(data.skills))
      .catch(() => setSkills([]))
      .finally(() => setLoading(false));
  }, [workspaceId]);

  useEffect(() => { fetchSkills(); }, [fetchSkills]);

  const handleDelete = async (name: string) => {
    try {
      await apiFetch(`/api/skills/${encodeURIComponent(name)}?workspaceId=${workspaceId}`, { method: 'DELETE' });
      fetchSkills();
    } catch { /* ignore */ }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-xl mx-auto px-4 py-4 space-y-3">
        {/* Header with link to Marketplace */}
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted">
            {skills.length} skill{skills.length !== 1 ? 's' : ''} installed
          </p>
          <button
            onClick={() => navigateTo('marketplace')}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-accent hover:text-[var(--accent-hover)] transition-colors rounded"
          >
            <Store size={11} />
            Browse Marketplace
            <ExternalLink size={10} />
          </button>
        </div>

        {skills.length === 0 ? (
          <div className="py-12 text-center">
            <Store size={24} className="mx-auto text-muted mb-3" />
            <p className="text-sm text-muted mb-3">No skills installed yet.</p>
            <button
              onClick={() => navigateTo('marketplace')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent text-white rounded hover:bg-accent/90 transition-colors"
            >
              <Store size={12} />
              Install from Marketplace
            </button>
          </div>
        ) : (
          <ul className="space-y-2">
            {skills.map((skill) => (
              <li
                key={skill.name}
                className="group flex items-center gap-3 p-3 border border-border rounded-lg hover:bg-surface-200 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text">{skill.name}</span>
                    {skill.source && (
                      <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-surface-200 text-muted">
                        {skill.source}
                      </span>
                    )}
                  </div>
                  {skill.description && (
                    <p className="text-xs text-muted mt-0.5 truncate">{skill.description}</p>
                  )}
                </div>
                <button
                  onClick={() => handleDelete(skill.name)}
                  className="p-1.5 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/10 transition-all"
                  title={`Remove ${skill.name}`}
                >
                  <Trash2 size={12} className="text-red-500/60" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Direction Stack Panel ─────────────────────────────────────────────────

interface ScanResult {
  l1Draft: string;
  l2Draft: string;
  l3Draft: string;
  confidence: 'low' | 'medium' | 'high';
  filesScanned: string[];
  dirCount: number;
  l3Valid: boolean;
  l3Errors: Array<{ path: string; message: string }>;
}

type LayerTab = 1 | 2 | 3;
type ViewMode = 'simple' | 'advanced';

const LAYER_LABELS: Record<LayerTab, string> = {
  1: 'Standards',
  2: 'Conventions',
  3: 'Project',
};

const SIMPLE_LABELS: Record<LayerTab, { title: string; description: string; placeholder: string; tooltip: string }> = {
  1: {
    title: 'Standards',
    description: 'Engineering principles, coding style, and preferences that apply to all projects.',
    placeholder: 'e.g. "Always use TypeScript strict mode. Prefer functional components. Use Tailwind for styling. Never use var — always const/let."',
    tooltip: 'How you build software — engineering principles that apply to all projects',
  },
  2: {
    title: 'Conventions',
    description: 'Industry concepts, business rules, and domain-specific patterns for this workspace.',
    placeholder: 'e.g. "This is a fintech product. Follow PCI-DSS compliance for payment data. Use cents (integers) for all monetary values, never floats."',
    tooltip: 'Patterns for this type of project — framework and domain conventions',
  },
  3: {
    title: 'Project',
    description: 'What this specific project is, its tech stack, architecture, and key constraints.',
    placeholder: 'e.g. "A React + Express web app for managing customer invoices. Uses PostgreSQL, deployed on Vercel. Key modules: auth, invoicing, reporting, notifications."',
    tooltip: 'What makes this project unique — its stack, architecture, and constraints',
  },
};

const VIEW_MODE_KEY = (id: string) => `directionViewMode_${id}`;
const BOOTSTRAP_DISMISSED_KEY = (id: string) => `bootstrapDismissed_${id}`;

export default function DirectionStackPanel() {
  const { workspaceId } = useWorkspace();
  const [activeTab, setActiveTab] = useState<LayerTab>(1);
  const [showBootstrap, setShowBootstrap] = useState(false);
  const [showAISetup, setShowAISetup] = useState(false);
  const [stackView, setStackView] = useState<StackView>('layers');

  // Scan Repo state
  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  // L1/L2/L3 persisted layers — in Simple mode, skip YAML validation
  const [viewMode, setViewMode] = useState<ViewMode>('simple');
  const isSimple = viewMode === 'simple';

  const l1 = useDirectionLayer(workspaceId, 1, { skipValidation: isSimple });
  const l2 = useDirectionLayer(workspaceId, 2, { skipValidation: isSimple });
  const l3 = useDirectionLayer(workspaceId, 3, { skipValidation: isSimple });
  const layers = { 1: l1, 2: l2, 3: l3 } as const;
  const active = layers[activeTab];

  // Simple mode: track which layer is being edited inline
  const [editingLayer, setEditingLayer] = useState<LayerTab | null>(null);

  // First-run detection: show banner if all layers empty and not dismissed
  const allEmpty = !l1.content && !l2.content && !l3.content;
  const [bannerDismissed, setBannerDismissed] = useState(() =>
    workspaceId ? localStorage.getItem(BOOTSTRAP_DISMISSED_KEY(workspaceId)) === 'true' : false
  );
  const showFirstRunBanner = allEmpty && !bannerDismissed;

  // Initialize view mode from localStorage or default based on content
  useEffect(() => {
    if (!workspaceId) return;
    const stored = localStorage.getItem(VIEW_MODE_KEY(workspaceId));
    if (stored === 'simple' || stored === 'advanced') {
      setViewMode(stored);
    } else {
      // Default: Simple for new (empty) workspaces, Advanced for existing
      setViewMode(allEmpty ? 'simple' : 'advanced');
    }
  }, [workspaceId, allEmpty]);

  const handleToggleViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    setEditingLayer(null);
    if (workspaceId) localStorage.setItem(VIEW_MODE_KEY(workspaceId), mode);
  };

  const handleDismissBanner = () => {
    if (workspaceId) localStorage.setItem(BOOTSTRAP_DISMISSED_KEY(workspaceId), 'true');
    setBannerDismissed(true);
  };

  const handleBootstrapAccept = useCallback((yaml: string) => {
    active.setContent(yaml);
  }, [active]);

  const handleAISetupComplete = useCallback((layers: { l1: string; l2: string; l3: string }) => {
    l1.setContent(layers.l1);
    l2.setContent(layers.l2);
    l3.setContent(layers.l3);
  }, [l1, l2, l3]);

  const handleScanRepo = useCallback(async () => {
    if (!workspaceId) return;
    setIsScanning(true);
    setScanError(null);
    setScanResult(null);
    try {
      const result = await apiFetch<ScanResult>(`/api/workspaces/${workspaceId}/scan-direction`, {
        method: 'POST',
      });
      setScanResult(result);
    } catch (err: any) {
      setScanError(err.message || 'Scan failed');
    } finally {
      setIsScanning(false);
    }
  }, [workspaceId]);

  const handleAcceptScan = useCallback(() => {
    if (!scanResult) return;
    l1.setContent(scanResult.l1Draft);
    l2.setContent(scanResult.l2Draft);
    l3.setContent(scanResult.l3Draft);
    setScanResult(null);
    setBannerDismissed(true);
    if (workspaceId) localStorage.setItem(BOOTSTRAP_DISMISSED_KEY(workspaceId), 'true');
  }, [scanResult, l1, l2, l3, workspaceId]);

  // Synthesized preview
  const [synthesized, setSynthesized] = useState('');
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const synthTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const synthesize = useCallback(() => {
    if (!workspaceId) return;
    setIsSynthesizing(true);
    apiFetch<{ synthesized: string }>('/api/direction/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
      }),
    })
      .then((data) => setSynthesized(data.synthesized))
      .catch(console.error)
      .finally(() => setIsSynthesizing(false));
  }, [workspaceId]);

  // Debounced synthesize when any input changes
  useEffect(() => {
    if (synthTimerRef.current) clearTimeout(synthTimerRef.current);
    synthTimerRef.current = setTimeout(synthesize, 300);
    return () => {
      if (synthTimerRef.current) clearTimeout(synthTimerRef.current);
    };
  }, [l1.content, l2.content, l3.content, synthesize]);

  const handleCopy = () => {
    navigator.clipboard.writeText(synthesized).catch(console.error);
  };

  /** Generate a plain-English summary from layer content for display in Simple mode */
  const getLayerSummary = (content: string): string => {
    if (!content.trim()) return '';
    // If it looks like YAML (has key: value lines), summarize it
    const lines = content.trim().split('\n').filter(l => l.trim());
    if (lines.length === 0) return '';
    // For short content, just show it directly
    if (lines.length <= 5) return content.trim();
    // For longer content, show first few meaningful lines + count
    const preview = lines.slice(0, 4).join('\n');
    return `${preview}\n... and ${lines.length - 4} more lines`;
  };

  if (!workspaceId) {
    return (
      <div className="flex items-center justify-center h-full text-muted">
        Select a workspace to view direction.
      </div>
    );
  }

  return (
    <div role="main" aria-label="Direction stack panel - configure direction layers" className="flex flex-col md:flex-row h-full gap-px bg-border overflow-auto md:overflow-hidden">
      {/* Column 1: Layer editor or Skills list */}
      <div className="flex-1 flex flex-col bg-bg min-w-0 min-h-[50vh] md:min-h-0">
        {/* Header: Sub-tab toggle (Layers/Skills) + View mode + action buttons */}
        <div className="flex items-center border-b border-border min-w-0 overflow-x-auto">
          {/* ULT-008: Layers / Skills sub-tab toggle */}
          <div className="flex items-center px-3 py-1.5 gap-1">
            <div className="flex bg-border/50 rounded p-0.5">
              <button
                onClick={() => setStackView('layers')}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 ${
                  stackView === 'layers' ? 'bg-bg text-text shadow-sm' : 'text-muted hover:text-text'
                }`}
              >
                Layers
              </button>
              <button
                onClick={() => setStackView('skills')}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 ${
                  stackView === 'skills' ? 'bg-bg text-text shadow-sm' : 'text-muted hover:text-text'
                }`}
              >
                Skills
              </button>
            </div>
          </div>

          {/* Simple/Advanced toggle — only visible in Layers view */}
          {stackView === 'layers' && (
            <div className="flex items-center gap-1">
              <div className="flex bg-border/50 rounded p-0.5">
                <button
                  onClick={() => handleToggleViewMode('simple')}
                  aria-pressed={isSimple}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 ${
                    isSimple ? 'bg-bg text-text shadow-sm' : 'text-muted hover:text-text'
                  }`}
                >
                  Simple
                </button>
                <button
                  onClick={() => handleToggleViewMode('advanced')}
                  aria-pressed={!isSimple}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 ${
                    !isSimple ? 'bg-bg text-text shadow-sm' : 'text-muted hover:text-text'
                  }`}
                >
                  Advanced
                </button>
              </div>
            </div>
          )}

          {/* Advanced mode: L1/L2/L3 tabs — only in Layers view */}
          {stackView === 'layers' && !isSimple && (
            <div role="tablist" className="flex flex-1">
              {([1, 2, 3] as const).map((n) => (
                <button
                  key={n}
                  role="tab"
                  aria-selected={activeTab === n}
                  onClick={() => setActiveTab(n)}
                  className={`flex-1 px-3 py-2 text-xs font-medium transition-colors relative flex items-center justify-center gap-1 focus:outline-none focus:ring-2 focus:ring-accent/50 ${
                    activeTab === n
                      ? 'text-text border-b-2 border-accent'
                      : 'text-muted hover:text-text'
                  }`}
                >
                  {LAYER_LABELS[n]}
                  <HelpTooltip helpKey={`direction-stack-l${n}`} size={11} />
                  {layers[n].isDirty && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-warning ml-1.5 opacity-60" />
                  )}
                  {layers[n].isSaving && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent ml-1.5 animate-pulse" />
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Spacer */}
          {(stackView === 'skills' || isSimple) && <div className="flex-1" />}

          {/* Health indicator — always visible */}
          <DirectionHealthIndicator l1={l1} l2={l2} l3={l3} />

          {/* Action buttons — only in Layers view */}
          {stackView === 'layers' && (
            <div className="flex items-center gap-0.5 ml-1 shrink-0 pr-2">
              <button
                onClick={handleScanRepo}
                disabled={isScanning}
                className="px-2 py-1.5 text-[11px] font-medium text-accent hover:text-[var(--accent-hover)] transition-colors whitespace-nowrap disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent/50 rounded"
                title="Scan repository to detect direction"
              >
                {isScanning ? 'Scanning...' : 'Scan'}
              </button>
              <span className="text-border text-[10px]">|</span>
              <button
                onClick={() => setShowAISetup(true)}
                className="px-2 py-1.5 text-[11px] font-medium text-accent hover:text-[var(--accent-hover)] transition-colors whitespace-nowrap"
                title="Setup direction with AI wizard"
              >
                AI Setup &#10022;
              </button>
              <span className="text-border text-[10px]">|</span>
              <button
                onClick={() => setShowBootstrap(true)}
                className="px-2 py-1.5 text-[11px] text-muted hover:text-text transition-colors whitespace-nowrap"
                title="Bootstrap context files"
              >
                Bootstrap
              </button>
            </div>
          )}
        </div>

        {/* ULT-008: Skills sub-tab content */}
        {stackView === 'skills' ? (
          <SkillsList workspaceId={workspaceId} />
        ) : (
          <>
            {/* First-run empty state */}
            {showFirstRunBanner && !scanResult && (
              <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
                <div className="flex flex-col items-center max-w-[400px]">
                  <div className="w-14 h-14 rounded-2xl bg-accent/10 flex items-center justify-center mb-4">
                    <Compass size={28} className="text-accent" />
                  </div>
                  <h3 className="text-base font-semibold text-[var(--text)] mb-1.5">No direction configured</h3>
                  <p className="text-sm text-muted leading-relaxed mb-4">
                    Click Scan Repo to auto-generate direction from your codebase, or set it up with an AI wizard.
                  </p>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleScanRepo}
                      disabled={isScanning}
                      className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-50"
                    >
                      {isScanning ? 'Scanning...' : 'Scan Repo'}
                    </button>
                    <button
                      onClick={() => setShowAISetup(true)}
                      className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg border border-border text-text hover:bg-surface-200 transition-colors"
                    >
                      AI Setup
                    </button>
                  </div>
                  <button
                    onClick={handleDismissBanner}
                    className="mt-4 text-xs text-muted hover:text-text transition-colors"
                  >
                    I&#39;ll configure manually
                  </button>
                </div>
              </div>
            )}

            {/* Scan error */}
            {scanError && (
              <div className="flex items-center justify-between px-3 py-2 bg-red-500/10 border-b border-red-500/30">
                <span className="text-xs text-red-400">{scanError}</span>
                <button onClick={() => setScanError(null)} className="text-xs text-muted hover:text-text">&#10005;</button>
              </div>
            )}

            {/* Scan result preview banner */}
            {scanResult && (
              <div className="border-b border-accent/30 bg-accent/5">
                <div className="flex items-center justify-between px-3 py-2">
                  <div className="text-xs text-text">
                    <span className="font-medium">Repo scanned</span>
                    <span className="text-muted ml-2">
                      {scanResult.filesScanned.join(', ')} | {scanResult.dirCount} dirs | confidence: {scanResult.confidence}
                    </span>
                    {!scanResult.l3Valid && scanResult.l3Errors.length > 0 && (
                      <span className="text-warning ml-2">Project layer has validation issues</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={handleAcceptScan}
                      className="px-2.5 py-1 text-xs font-medium bg-accent hover:bg-[var(--accent-hover)] text-white rounded transition-colors"
                    >
                      Apply Drafts
                    </button>
                    <button
                      onClick={() => setScanResult(null)}
                      className="text-xs text-muted hover:text-text transition-colors"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
                {/* Inline preview of the draft for the active tab */}
                <div className="px-3 pb-2">
                  <pre className="text-xs font-mono text-muted max-h-24 overflow-auto bg-bg rounded p-2">
                    {activeTab === 1 ? scanResult.l1Draft : activeTab === 2 ? scanResult.l2Draft : scanResult.l3Draft}
                  </pre>
                </div>
              </div>
            )}

            {/* Content area: Simple or Advanced */}
            {isSimple ? (
              /* Simple view: stacked prose sections for all 3 layers */
              <div className="flex-1 overflow-auto">
                {([1, 2, 3] as const).map((n) => {
                  const info = SIMPLE_LABELS[n];
                  const layer = layers[n];
                  const isEditing = editingLayer === n;
                  const summary = getLayerSummary(layer.content);

                  return (
                    <div key={n} className="border-b border-border">
                      {/* Section header */}
                      <div className="flex items-center justify-between px-4 py-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <h3 className="text-sm font-medium text-text">{info.title}</h3>
                            {layer.isDirty && (
                              <span className="inline-block w-1.5 h-1.5 rounded-full bg-warning opacity-60" />
                            )}
                            {layer.isSaving && (
                              <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                            )}
                          </div>
                          <p className="text-xs text-muted mt-0.5">{info.description}</p>
                        </div>
                        <button
                          onClick={() => setEditingLayer(isEditing ? null : n)}
                          className={`px-3 py-1.5 text-xs font-medium rounded transition-colors shrink-0 ml-3 ${
                            isEditing
                              ? 'bg-accent text-white hover:bg-[var(--accent-hover)]'
                              : 'text-accent hover:bg-accent/10'
                          }`}
                        >
                          {isEditing ? 'Done' : 'Edit'}
                        </button>
                      </div>

                      {/* Content: summary or editor */}
                      {isEditing ? (
                        <div className="px-4 pb-3">
                          <textarea
                            value={layer.content}
                            onChange={(e) => layer.setContent(e.target.value)}
                            className="w-full p-3 text-sm bg-bg text-text border border-border rounded outline-none resize-none focus:border-accent/50 transition-colors"
                            placeholder={info.placeholder}
                            rows={8}
                            autoFocus
                          />
                        </div>
                      ) : (
                        <div className="px-4 pb-3">
                          {summary ? (
                            <p className="text-sm text-text whitespace-pre-wrap leading-relaxed">{summary}</p>
                          ) : (
                            <p className="text-sm text-muted italic">
                              Not configured yet. Click Edit to add {info.title.toLowerCase()}.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {/* Cascade rule */}
                <div className="px-4 py-2 text-[11px] text-muted/70">
                  Project beats Conventions beats Standards
                </div>
              </div>
            ) : (
              /* Advanced view: YAML editor for active tab */
              <textarea
                value={active.content}
                onChange={(e) => active.setContent(e.target.value)}
                className="flex-1 w-full p-3 font-mono text-sm bg-bg text-text border-none outline-none resize-none"
                placeholder={`Enter ${LAYER_LABELS[activeTab]} content...`}
                spellCheck={false}
              />
            )}
          </>
        )}
      </div>

      {/* Column 2: Synthesized preview (read-only) */}
      <div className="flex-1 flex flex-col bg-bg min-w-0 min-h-[30vh] md:min-h-0">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="text-xs font-medium text-muted inline-flex items-center gap-1">
            Synthesized Output
            <HelpTooltip helpKey="synthesized-output" size={11} />
            <span className="ml-1 text-muted opacity-60">
              {synthesized.length.toLocaleString()} chars
            </span>
          </span>
          <button
            onClick={handleCopy}
            aria-label="Copy synthesized output"
            className="px-2 py-1 text-xs text-muted hover:text-text transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 rounded"
          >
            Copy
          </button>
        </div>
        <div aria-live="polite" className="flex-1 overflow-auto p-3">
          {isSynthesizing ? (
            <div className="flex items-center gap-2 text-muted text-sm">
              <span className="sr-only">Loading...</span>
              <svg
                className="w-4 h-4 animate-spin"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              Synthesizing...
            </div>
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-sm text-text">
              {synthesized || <span className="text-muted">No output yet. Add content to layers above.</span>}
            </pre>
          )}
        </div>
      </div>

      {/* Bootstrap Context Modal */}
      {showBootstrap && workspaceId && (
        <BootstrapContextModal
          workspaceId={workspaceId}
          activeLayer={activeTab}
          onAccept={handleBootstrapAccept}
          onClose={() => setShowBootstrap(false)}
        />
      )}

      {/* AI Setup Wizard */}
      {showAISetup && workspaceId && (
        <AISetupWizard
          workspaceId={workspaceId}
          onComplete={handleAISetupComplete}
          onClose={() => setShowAISetup(false)}
          hasExistingLayers={!allEmpty}
        />
      )}
    </div>
  );
}
