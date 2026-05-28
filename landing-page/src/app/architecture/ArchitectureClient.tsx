'use client';

import Image from 'next/image';
import { motion } from 'framer-motion';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';
import { Layers, GitPullRequest, Radio, Terminal, ArrowRight } from 'lucide-react';

export default function ArchitectureClient() {
    return (
        <main className="min-h-screen bg-abyss text-white selection:bg-fizz selection:text-abyss flex flex-col">
            <Nav />
            <div className="pt-32 pb-20 px-6 sm:px-12 mx-auto max-w-7xl w-full">
                {/* Header */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mb-20 text-center lg:text-left"
                >
                    <h1 className="text-4xl md:text-6xl font-medium tracking-tight mb-6">
                        How Rorca is <span className="text-accent">built</span>.
                    </h1>
                    <p className="text-zinc-400 text-xl max-w-2xl leading-relaxed">
                        A spec-driven pipeline backed by PostgreSQL 16, a 5-layer context cascade, Apache AGE knowledge graph, skill-first MCP tools, and real-time WAL event telemetry.
                    </p>
                </motion.div>

                <motion.figure
                    initial={{ opacity: 0, y: 24 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.55, delay: 0.08 }}
                    className="mb-24 overflow-hidden rounded-[2rem] border border-white/10 bg-zinc-950/70 p-2 shadow-2xl shadow-black/40"
                >
                    <Image
                        src="/diagrams/rorca-linear-flow-clean-icons-aqua.png"
                        alt="Linear diagram showing how Rorca turns operator surfaces into canonical specs, queued story execution, Git commits, and memory plus knowledge graph feedback."
                        width={2400}
                        height={1350}
                        priority
                        sizes="(min-width: 1280px) 1280px, 100vw"
                        className="h-auto w-full rounded-[1.5rem]"
                    />
                    <figcaption className="px-4 pb-3 pt-4 text-sm text-zinc-500">
                        The full loop: surfaces create spec truth, workers execute story truth, and memory/graph feedback improves the next run.
                    </figcaption>
                </motion.figure>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-12">
                    {/* Floating Navigation (Left) */}
                    <div className="lg:col-span-3 hidden lg:block sticky top-32 h-fit">
                        <nav className="flex flex-col gap-4 text-sm font-medium">
                            <a href="#direction-stack" className="text-zinc-400 hover:text-white transition-colors">Direction Stack</a>
                            <a href="#github-integration" className="text-zinc-400 hover:text-white transition-colors">GitHub Integration</a>
                            <a href="#observability" className="text-zinc-400 hover:text-white transition-colors">Real-time Observability</a>
                            <a href="#mcp" className="text-zinc-400 hover:text-white transition-colors">Skill-first MCP</a>
                        </nav>
                    </div>

                    {/* Main Content (Right) */}
                    <div className="lg:col-span-9 space-y-32">

                        {/* Section: Direction Stack */}
                        <section id="direction-stack" className="scroll-mt-32">
                            <div className="flex items-center gap-3 mb-6">
                                <Layers className="text-accent w-6 h-6" />
                                <h2 className="text-2xl font-medium">5-Layer Direction Stack</h2>
                            </div>
                            <p className="text-zinc-400 text-lg mb-8 leading-relaxed">
                                Every story runs with a fully synthesized context string assembled from five layers. Lower layers override higher ones — like CSS specificity, but for architectural intent. L4 and L5 are injected per-run; L1–L3 are persistent across workspaces.
                            </p>
                            <div className="space-y-3">
                                {[
                                    { layer: 'L1', label: 'Global', scope: 'All workspaces', example: 'Engineering principles — preferred libraries, avoid patterns, test conventions', color: 'text-zinc-400' },
                                    { layer: 'L2', label: 'Domain', scope: 'e.g. "saas"', example: 'Auth patterns, API conventions, error formats for the domain type', color: 'text-zinc-400' },
                                    { layer: 'L3', label: 'Project', scope: 'One workspace', example: 'Stack, migration pattern, key constraints, monorepo structure', color: 'text-zinc-300' },
                                    { layer: 'L4', label: 'Spec', scope: 'One spec run', example: 'What this feature is, why it matters, how it fits the product', color: 'text-white' },
                                    { layer: 'L5', label: 'Story', scope: 'One story', example: 'Edge cases, reviewer notes, implementation hints, acceptance criteria', color: 'text-accent' },
                                ].map((l, i) => (
                                    <div key={l.layer} className="flex items-start gap-4 p-4 bg-zinc-900/50 border border-white/5 rounded-xl">
                                        <div className="flex flex-col items-center flex-shrink-0">
                                            <div className="w-8 h-8 rounded bg-zinc-800 border border-white/10 flex items-center justify-center text-xs font-mono text-zinc-400">{l.layer}</div>
                                            {i < 4 && <div className="w-[1px] h-3 bg-white/10 mt-1" />}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 mb-1">
                                                <span className={`text-sm font-medium ${l.color}`}>{l.label}</span>
                                                <span className="text-xs text-zinc-600">·</span>
                                                <span className="text-xs text-zinc-500">{l.scope}</span>
                                            </div>
                                            <p className="text-sm text-zinc-500">{l.example}</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </section>

                        {/* Section: GitHub Integration */}
                        <section id="github-integration" className="scroll-mt-32">
                            <div className="flex items-center gap-3 mb-6">
                                <GitPullRequest className="text-accent w-6 h-6" />
                                <h2 className="text-2xl font-medium">GitHub Integration</h2>
                            </div>
                            <p className="text-zinc-400 text-lg mb-8 leading-relaxed">
                                Connect your GitHub repository via OAuth and a GitHub App. Import issues directly as specs. Every pipeline run opens a draft PR at the start, posts per-story commit status checks as stories pass, and converts the PR to ready-for-review on completion — with full run metadata in the description.
                            </p>
                            <div className="space-y-3">
                                {[
                                    { step: '01', label: 'Import GitHub Issue', detail: 'Issue title becomes the spec title. Body and labels extracted as story context and annotations.' },
                                    { step: '02', label: 'Draft PR opened at run start', detail: 'Branch feat/<slug>-<timestamp> created. Draft PR linked to the spec run before the first story executes.' },
                                    { step: '03', label: 'Per-story commit status checks', detail: 'Each story_passed WAL event posts a ✓ check run to the PR. story_failed posts ✗ with the error detail.' },
                                    { step: '04', label: 'Auto-convert to ready-for-review', detail: 'On run_finished, PR converts from draft, story pass/fail counts and model usage appended to the description.' },
                                ].map((s) => (
                                    <div key={s.step} className="flex items-start gap-4 p-4 bg-zinc-900/50 border border-white/5 rounded-xl">
                                        <span className="text-xs font-mono text-zinc-600 mt-0.5 flex-shrink-0 w-6">{s.step}</span>
                                        <div>
                                            <p className="text-sm font-medium text-zinc-200 mb-1">{s.label}</p>
                                            <p className="text-sm text-zinc-500">{s.detail}</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </section>

                        {/* Section: Real-time Observability */}
                        <section id="observability" className="scroll-mt-32">
                            <div className="flex items-center gap-3 mb-6">
                                <Radio className="text-accent w-6 h-6" />
                                <h2 className="text-2xl font-medium">Real-time Observability</h2>
                            </div>
                            <p className="text-zinc-400 text-lg mb-8 leading-relaxed">
                                Execution events flow from <code className="text-zinc-300 font-mono text-sm">execution-engine.ts</code> → WAL event log → <code className="text-zinc-300 font-mono text-sm">sse-hub.ts</code> → every connected dashboard. Terminal output is written to <code className="text-zinc-300 font-mono text-sm">run_output_chunks</code> in 4KB chunks — DB-backed streaming that survives backend restarts and supports late-join replay from sequence 0.
                            </p>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-8">
                                {[
                                    { event: 'story_started', color: 'text-blue-400', desc: 'Subprocess spawned, story clock starts' },
                                    { event: 'story_passed', color: 'text-green-400', desc: 'Exit 0, git commit written, check posted' },
                                    { event: 'story_failed', color: 'text-red-400', desc: 'Max retries hit or timeout — reason attached' },
                                ].map((e) => (
                                    <div key={e.event} className="p-4 bg-zinc-900/50 border border-white/5 rounded-xl">
                                        <p className={`text-xs font-mono mb-2 ${e.color}`}>{e.event}</p>
                                        <p className="text-xs text-zinc-500">{e.desc}</p>
                                    </div>
                                ))}
                            </div>
                            <div className="bg-zinc-950 rounded-xl p-5 border border-white/5 shadow-2xl">
                                <div className="flex items-center gap-2 mb-4">
                                    <div className="w-2 h-2 rounded-full bg-red-500/60" />
                                    <div className="w-2 h-2 rounded-full bg-yellow-500/60" />
                                    <div className="w-2 h-2 rounded-full bg-green-500/60" />
                                    <span className="ml-2 text-xs font-mono text-zinc-600">WAL events → sse-hub → dashboard</span>
                                </div>
                                <div className="font-mono text-xs text-zinc-500 space-y-1.5">
                                    <p><span className="text-zinc-600">[12:04:22]</span> <span className="text-blue-400">story_started</span> <span className="text-zinc-400">US-003 &quot;Add Stripe webhook handler&quot;</span></p>
                                    <p><span className="text-zinc-600">[12:04:45]</span> <span className="text-green-400">story_passed</span> <span className="text-zinc-400">US-003 · commit a3f9c1d · 23s</span></p>
                                    <p><span className="text-zinc-600">[12:04:46]</span> <span className="text-blue-400">story_started</span> <span className="text-zinc-400">US-004 &quot;Billing webhook idempotency&quot;</span></p>
                                    <p className="animate-pulse"><span className="text-zinc-600">[12:05:01]</span> <span className="text-accent">SSE broadcast</span> <span className="text-zinc-400">→ 2 connected clients</span></p>
                                </div>
                            </div>
                        </section>

                        {/* Section: Skill-first MCP */}
                        <section id="mcp" className="scroll-mt-32">
                            <div className="flex items-center gap-3 mb-6">
                                <Terminal className="text-accent w-6 h-6" />
                                <h2 className="text-2xl font-medium">Skill-first MCP Control Plane</h2>
                            </div>
                            <p className="text-zinc-400 text-lg mb-8 leading-relaxed">
                                Rorca exposes a Model Context Protocol server alongside the Express API, but the important thing is the contract: the reliable path is to draft locally or in-skill, then persist explicitly through <code className="text-zinc-300 font-mono text-sm">rorca_create_spec</code> → <code className="text-zinc-300 font-mono text-sm">POST /api/specs/persist</code>. That keeps the caller in control and makes the spec creation path portable across Claude Code, Pi, OpenCode, Codex, and custom MCP clients.
                            </p>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
                                <div className="bg-zinc-950 border border-white/10 rounded-2xl p-6">
                                    <div className="text-xs font-mono text-zinc-600 mb-3">{'// Canonical create-spec path'}</div>
                                    <div className="space-y-2 text-sm font-mono text-zinc-300">
                                        <div><span className="text-fizz">1.</span> skill / caller drafts the spec</div>
                                        <div><span className="text-fizz">2.</span> Rorca validates + normalizes it</div>
                                        <div><span className="text-fizz">3.</span> persist via <code>rorca_create_spec</code></div>
                                        <div><span className="text-fizz">4.</span> enrich / match-skills / synthesize memory</div>
                                    </div>
                                </div>
                                <div className="bg-zinc-950 border border-white/10 rounded-2xl p-6">
                                    <div className="text-xs font-mono text-zinc-600 mb-3">{'// Skill role'}</div>
                                    <div className="space-y-3 text-sm text-zinc-400 leading-relaxed">
                                        <p>Skills are planners, judges, and operators — they help draft, critique, and choose context.</p>
                                        <p>They are not the low-level storage or retrieval layer. The backend still owns retrieval, ranking, and telemetry.</p>
                                    </div>
                                </div>
                            </div>

                            <div className="flex items-start gap-4 p-5 bg-zinc-900/50 border border-accent/20 rounded-xl mb-8">
                                <div className="w-2 h-2 rounded-full bg-accent mt-1.5 flex-shrink-0" />
                                <div>
                                    <p className="text-sm font-medium text-zinc-200 mb-1">Works across Rorca surfaces and provider runtimes</p>
                                    <p className="text-sm text-zinc-400 leading-relaxed">
                                        Specs can be created from the dashboard, CLI/TUI, Pi extension, MCP tools, or another client that calls the Rorca API. Execution then attaches to the selected runtime — Claude Code, OpenCode, Codex, or Pi — while the backend keeps spec state, retrieval, telemetry, and memory consistent.
                                    </p>
                                </div>
                            </div>

                            <p className="text-sm text-zinc-500 mb-6">Typical flow when a developer wants to create a spec from a session:</p>
                            <div className="space-y-3 mb-8">
                                {[
                                    { tool: 'rorca_create_spec', prompt: '"Create a spec for a dark mode toggle"', result: 'Persists an explicit drafted spec. This is the canonical cross-client path.' },
                                    { tool: 'rorca_persist_spec', prompt: 'Compatibility alias', result: 'Same persisted-draft behavior for older clients and scripts.' },
                                    { tool: 'rorca_generate_spec', prompt: 'Fallback only', result: 'Backend-generated drafting when you intentionally want Rorca to write the spec.' },
                                    { tool: 'rorca_list_specs', prompt: 'Check pending work', result: 'Returns specs grouped by status.' },
                                    { tool: 'rorca_approve_spec', prompt: 'Approve the draft', result: 'Moves the spec to the approved queue.' },
                                    { tool: 'rorca_pipeline_status', prompt: 'Ask how it is going', result: 'Returns run status, elapsed time, and per-story progress.' },
                                ].map((step) => (
                                    <div key={step.tool} className="p-4 bg-zinc-900/50 border border-white/5 rounded-xl">
                                        <div className="flex flex-wrap items-center gap-3 mb-2">
                                            <span className="text-xs font-mono text-accent">{step.tool}</span>
                                            <span className="text-xs text-zinc-600 italic">{step.prompt}</span>
                                        </div>
                                        <p className="text-sm text-zinc-500">{step.result}</p>
                                    </div>
                                ))}
                            </div>

                            <div className="mb-6">
                                <p className="text-sm text-zinc-500 mb-4">Common operator entrypoints use the same backend contract:</p>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                    {[
                                        '/rorca-create-spec',
                                        '/skill:rorca-forge',
                                        '/rorca-run',
                                        '/rorca-watch',
                                    ].map((cmd) => (
                                        <div key={cmd} className="px-3 py-2 bg-zinc-950 border border-white/5 rounded-lg flex items-center justify-between gap-2">
                                            <span className="text-xs font-mono text-fizz">{cmd}</span>
                                            <ArrowRight className="w-3 h-3 text-zinc-600 shrink-0" />
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="flex items-start gap-3 p-4 bg-zinc-900/30 border border-white/5 rounded-xl">
                                <div className="w-2 h-2 rounded-full bg-accent mt-1.5 flex-shrink-0" />
                                <p className="text-sm text-zinc-400">The backend still owns retrieval, ranking, telemetry, and memory synthesis. MCP and skills are the control surface, not the storage layer.</p>
                            </div>
                        </section>

                    </div>
                </div>
            </div>
            <Footer />
        </main>
    );
}
