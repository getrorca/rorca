'use client';

import { motion } from 'framer-motion';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';
import { Layers, GitPullRequest, Radio, Terminal } from 'lucide-react';

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
                        A spec-driven pipeline backed by PostgreSQL 16, a 5-layer context cascade, Apache AGE knowledge graph, and real-time WAL event telemetry.
                    </p>
                </motion.div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-12">
                    {/* Floating Navigation (Left) */}
                    <div className="lg:col-span-3 hidden lg:block sticky top-32 h-fit">
                        <nav className="flex flex-col gap-4 text-sm font-medium">
                            <a href="#direction-stack" className="text-zinc-400 hover:text-white transition-colors">Direction Stack</a>
                            <a href="#github-integration" className="text-zinc-400 hover:text-white transition-colors">GitHub Integration</a>
                            <a href="#observability" className="text-zinc-400 hover:text-white transition-colors">Real-time Observability</a>
                            <a href="#mcp" className="text-zinc-400 hover:text-white transition-colors">MCP Interface</a>
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

                        {/* Section: MCP Interface */}
                        <section id="mcp" className="scroll-mt-32">
                            <div className="flex items-center gap-3 mb-6">
                                <Terminal className="text-accent w-6 h-6" />
                                <h2 className="text-2xl font-medium">MCP Interface</h2>
                            </div>
                            <p className="text-zinc-400 text-lg mb-8 leading-relaxed">
                                Rorca exposes a Model Context Protocol server alongside the Express API. Once registered, any Claude session can generate specs, approve them, trigger runs, and monitor progress — entirely through natural language. The MCP tools are designed to sit on top of Claude Code, not work against it. They extend your current session rather than replacing it.
                            </p>
                            <div className="bg-zinc-950 border border-white/10 rounded-2xl p-6 mb-8">
                                <div className="text-xs font-mono text-zinc-600 mb-3">// Register once — available in every Claude session</div>
                                <pre className="text-sm font-mono text-zinc-300 overflow-x-auto">{`claude mcp add rorca -- npx tsx /path/to/rorca/backend/src/mcp/server.ts`}</pre>
                            </div>

                            {/* Prompt cache tandem callout */}
                            <div className="flex items-start gap-4 p-5 bg-zinc-900/50 border border-accent/20 rounded-xl mb-8">
                                <div className="w-2 h-2 rounded-full bg-accent mt-1.5 flex-shrink-0" />
                                <div>
                                    <p className="text-sm font-medium text-zinc-200 mb-1">Works with your session&apos;s prompt cache</p>
                                    <p className="text-sm text-zinc-400 leading-relaxed">When you&apos;re already coding in Claude Code, your codebase, CLAUDE.md, and context are all warm in the prompt cache. Calling <code className="font-mono text-zinc-300 text-xs">rorca_generate_spec</code> from within that same session means the spec is generated with everything already loaded — no cold start, no redundant context extraction. The spec reflects exactly what you&apos;re working on right now.</p>
                                </div>
                            </div>

                            <p className="text-sm text-zinc-500 mb-6">A typical workflow — from coding session to running spec:</p>
                            <div className="space-y-3 mb-8">
                                {[
                                    { tool: 'rorca_generate_spec', prompt: '"Add a dark mode toggle to the settings panel"', result: 'Generates user stories with acceptance criteria, dependency graph, and model assignments — using your current session context.' },
                                    { tool: 'rorca_list_specs', prompt: 'Check what specs are pending', result: 'Returns pending, approved, and running specs grouped by status.' },
                                    { tool: 'rorca_approve_spec', prompt: '"Looks good, approve it"', result: 'Moves spec to the approved queue. Returns spec ID.' },
                                    { tool: 'rorca_trigger_run', prompt: '"Run it"', result: 'Spawns the pipeline. Returns run ID and queue position in ~200ms.' },
                                    { tool: 'rorca_pipeline_status', prompt: '"How\'s it going?"', result: 'Returns per-story pass/fail/skip counts, elapsed time, and last log line.' },
                                    { tool: 'rorca_get_memories', prompt: '"What did we learn?"', result: 'Returns memories synthesized from the run — Architecture, Convention, Gotcha entries.' },
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

                            {/* Slash commands */}
                            <div className="mb-6">
                                <p className="text-sm text-zinc-500 mb-4">Slash commands are also available for common operations — no MCP tool call overhead:</p>
                                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                                    {[
                                        '/generate-spec',
                                        '/approve-spec',
                                        '/run-spec',
                                        '/pipeline-status',
                                        '/list-specs',
                                        '/save-memory',
                                    ].map((cmd) => (
                                        <div key={cmd} className="px-3 py-2 bg-zinc-950 border border-white/5 rounded-lg">
                                            <span className="text-xs font-mono text-fizz">{cmd}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="flex items-start gap-3 p-4 bg-zinc-900/30 border border-white/5 rounded-xl">
                                <div className="w-2 h-2 rounded-full bg-accent mt-1.5 flex-shrink-0" />
                                <p className="text-sm text-zinc-400">24 tools total covering specs, pipeline, direction stack, workspaces, stories, and memory. Auto-generated from the same OpenAPI spec that powers the REST API — no version skew, always up to date.</p>
                            </div>
                        </section>

                    </div>
                </div>
            </div>
            <Footer />
        </main>
    );
}
