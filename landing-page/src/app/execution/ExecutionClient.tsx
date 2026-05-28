'use client';

import { motion } from 'framer-motion';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';
import { Zap, Split, Cpu, Network } from 'lucide-react';
import { SiAnthropic, SiOpenai } from 'react-icons/si';

export default function ComputeClient() {
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
                        CLI-native execution.
                        <br />
                        <span className="text-zinc-500">Zero lock-in.</span>
                    </h1>
                    <p className="text-zinc-400 text-xl max-w-2xl leading-relaxed">
                        Rorca attaches to the CLI provider the user selected. Claude Code, OpenCode, Codex, and Pi can all drive the same spec loop, and Rorca automates execution through that provider&apos;s native tools while it handles orchestration, retrieval, and story-by-story control.
                    </p>
                </motion.div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-12">
                    {/* Floating Navigation (Left) */}
                    <div className="lg:col-span-3 hidden lg:block sticky top-32 h-fit">
                        <nav className="flex flex-col gap-4 text-sm font-medium">
                            <a href="#engines" className="text-zinc-400 hover:text-white transition-colors">CLI-native execution</a>
                            <a href="#cascading" className="text-zinc-400 hover:text-white transition-colors">Models across the workflow</a>
                            <a href="#wave-parallel" className="text-zinc-400 hover:text-white transition-colors">Wave-Parallel Execution</a>
                        </nav>
                    </div>

                    {/* Main Content (Right) */}
                    <div className="lg:col-span-9 space-y-32">

                        {/* Section: CLI-native execution */}
                        <section id="engines" className="scroll-mt-32">
                            <div className="flex items-center gap-3 mb-6">
                                <Cpu className="text-fizz w-6 h-6" />
                                <h2 className="text-2xl font-medium">CLI-native Execution</h2>
                            </div>
                            <p className="text-zinc-400 text-lg mb-8 leading-relaxed">
                                Every story runs through the CLI provider the user selected. Rorca doesn’t replace Claude Code, OpenCode, Codex, or Pi — it attaches to them, then loops through the spec using that provider’s own tools, prompts, approvals, and subprocess model while Rorca manages orchestration and feedback.
                            </p>
                            <div className="mb-8 rounded-2xl border border-white/10 bg-zinc-950/60 p-6">
                                <h3 className="text-lg font-medium text-white mb-3">What “attach to the CLI” means</h3>
                                <p className="text-zinc-300 leading-relaxed mb-3">
                                    Rorca is the long-lived control plane, not the thing doing the coding inside one permanent provider shell. For each story attempt, Rorca prepares story context and repo state, then spawns an isolated subprocess through the selected provider CLI.
                                </p>
                                <p className="text-zinc-400 leading-relaxed">
                                    That subprocess performs the work, streams output, returns an exit result, and exits. Rorca keeps retries, dependencies, and run evidence consistent across those subprocesses.
                                </p>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {/* Claude */}
                                <div className="p-6 bg-zinc-900 border border-white/10 rounded-xl flex flex-col">
                                    <div className="flex items-center gap-2 mb-3">
                                        <SiAnthropic className="w-4 h-4 text-[#d97757]" />
                                        <span className="font-medium text-white text-sm">Claude Code</span>
                                    </div>
                                    <div className="text-xs font-mono text-zinc-600 mb-4">claude --print</div>
                                    <ul className="text-sm text-zinc-400 space-y-2 flex-1">
                                        <li>Claude Pro / Max subscription</li>
                                        <li>Prompt caching on tool round-trips</li>
                                        <li>Persistent bash shell state</li>
                                        <li>CLAUDE.md auto-injected</li>
                                        <li>Hierarchical subagents (Task tool)</li>
                                    </ul>
                                </div>

                                {/* OpenCode */}
                                <div className="p-6 bg-zinc-900 border border-fizz/30 rounded-xl flex flex-col relative overflow-hidden">
                                    <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-fizz to-transparent opacity-50" />
                                    <div className="flex items-center gap-2 mb-3">
                                        <div className="w-4 h-4 rounded bg-zinc-700 flex items-center justify-center flex-shrink-0">
                                            <span className="text-[7px] font-bold text-white">OC</span>
                                        </div>
                                        <span className="font-medium text-white text-sm">OpenCode</span>
                                    </div>
                                    <div className="text-xs font-mono text-zinc-600 mb-4">opencode run</div>
                                    <ul className="text-sm text-zinc-400 space-y-2 flex-1">
                                        <li>API key · 75+ models</li>
                                        <li>Broad provider / model catalog</li>
                                        <li>Warm server via --attach</li>
                                        <li>Structured JSON events</li>
                                        <li>GitHub Copilot subscription</li>
                                    </ul>
                                </div>

                                {/* Codex */}
                                <div className="p-6 bg-zinc-900 border border-white/10 rounded-xl flex flex-col">
                                    <div className="flex items-center gap-2 mb-3">
                                        <SiOpenai className="w-4 h-4 text-white" />
                                        <span className="font-medium text-white text-sm">Codex CLI</span>
                                    </div>
                                    <div className="text-xs font-mono text-zinc-600 mb-4">codex --approval-mode auto-edit</div>
                                    <ul className="text-sm text-zinc-400 space-y-2 flex-1">
                                        <li>ChatGPT Plus / Pro subscription</li>
                                        <li>Flat-rate, no per-token billing</li>
                                        <li>Direction stack via AGENTS.md</li>
                                        <li>Subscription-shaped execution path</li>
                                        <li>OpenAI model tier (subscription)</li>
                                    </ul>
                                </div>

                                {/* Pi */}
                                <div className="p-6 bg-zinc-900 border border-white/10 rounded-xl flex flex-col">
                                    <div className="flex items-center gap-2 mb-3">
                                        <div className="w-4 h-4 rounded bg-fizz/80 flex items-center justify-center text-[8px] font-bold text-black">P</div>
                                        <span className="font-medium text-white text-sm">Pi CLI</span>
                                    </div>
                                    <div className="text-xs font-mono text-zinc-600 mb-4">pi</div>
                                    <ul className="text-sm text-zinc-400 space-y-2 flex-1">
                                        <li>Provider-authenticated local models</li>
                                        <li>Pi-native execution path inside the Rorca loop</li>
                                        <li>Model discovery via the local Pi CLI</li>
                                        <li>Rorca manages orchestration around the Pi session</li>
                                        <li>Separate from the Pi extension command layer</li>
                                    </ul>
                                </div>
                            </div>
                        </section>

                        {/* Section: Models across the workflow */}
                        <section id="cascading" className="scroll-mt-32">
                            <div className="flex items-center gap-3 mb-4">
                                <Zap className="text-fizz w-6 h-6" />
                                <h2 className="text-2xl font-medium">Models Across the Workflow</h2>
                            </div>
                            <p className="text-zinc-400 text-lg mb-8 leading-relaxed max-w-4xl">
                                Rorca no longer markets per-story model routing as the main idea. The more important truth is that different parts of the workflow can use different models for different jobs: one model for spec creation, one model for execution, and a cheaper or faster model for memory synthesis and consolidation when that makes sense.
                            </p>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
                                <div className="bg-zinc-900 border border-white/10 rounded-xl p-6">
                                    <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-3">Create</div>
                                    <h3 className="text-base font-medium text-white mb-2">Spec creation</h3>
                                    <p className="text-sm text-zinc-400 mb-5">Spec generation, enrich, and skill-matching flows can resolve a model appropriate for drafting and planning work.</p>
                                    <div className="text-xs font-mono text-zinc-500 bg-black/40 px-3 py-2 rounded">planning / drafting focus</div>
                                </div>
                                <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6">
                                    <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-3">Execute</div>
                                    <h3 className="text-base font-medium text-white mb-2">Run execution</h3>
                                    <p className="text-sm text-zinc-400 mb-5">Approved stories run through the selected CLI provider and its configured execution model. That model stays consistent for the active execution run unless the operator changes it.</p>
                                    <div className="text-xs font-mono text-zinc-500 bg-black/40 px-3 py-2 rounded">provider-selected runtime model</div>
                                </div>
                                <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                                    <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-3">Learn</div>
                                    <h3 className="text-base font-medium text-white mb-2">Memory synthesis</h3>
                                    <p className="text-sm text-zinc-400 mb-5">Memory extraction and consolidation can use a cheaper or faster synthesis model because the job is summarization, not primary execution.</p>
                                    <div className="text-xs font-mono text-zinc-500 bg-black/40 px-3 py-2 rounded">cheap / fast synthesis path</div>
                                </div>
                            </div>
                            <div className="flex items-start gap-3 p-4 bg-zinc-900/30 border border-white/5 rounded-xl">
                                <div className="w-2 h-2 rounded-full bg-fizz mt-1.5 flex-shrink-0" />
                                <p className="text-sm text-zinc-400">The important distinction is phase-specific model choice, not automatic per-story provider-specific routing. Rorca keeps the spec loop stable while different parts of the workflow can optimize for planning, execution, or consolidation.</p>
                            </div>
                        </section>

                        {/* Section: Wave-Parallel Execution */}
                        <section id="wave-parallel" className="scroll-mt-32">
                            <div className="flex items-center gap-3 mb-6">
                                <Split className="text-fizz w-6 h-6" />
                                <h2 className="text-2xl font-medium">Wave-Parallel Execution</h2>
                            </div>
                            <p className="text-zinc-400 text-lg mb-8 leading-relaxed">
                                Rorca compiles your spec&apos;s <code className="text-zinc-300 font-mono text-sm">dependsOn</code> DAG into topological wave groups. Each wave runs its stories concurrently across isolated git worktrees. Auto-merge fires between waves before the next starts. A 40-minute sequential spec becomes ~12 minutes.
                            </p>
                            <div className="bg-zinc-950 border border-white/5 rounded-2xl p-8">
                                <div className="flex flex-col gap-5">
                                    {/* Wave 0 */}
                                    <div className="flex items-center gap-4">
                                        <div className="w-20 text-xs font-mono text-zinc-500 uppercase tracking-widest flex-shrink-0">Wave 0</div>
                                        <div className="flex gap-2 flex-1">
                                            <div className="h-8 flex-1 bg-white/10 rounded border border-white/5 flex items-center justify-center text-xs text-white">US-001</div>
                                            <div className="h-8 flex-1 bg-white/10 rounded border border-white/5 flex items-center justify-center text-xs text-white">US-002</div>
                                            <div className="h-8 flex-1 bg-white/10 rounded border border-white/5 flex items-center justify-center text-xs text-white">US-003</div>
                                        </div>
                                    </div>
                                    {/* Merge */}
                                    <div className="flex items-center gap-4">
                                        <div className="w-20 flex-shrink-0" />
                                        <div className="flex-1 flex justify-center items-center gap-2">
                                            <Network className="w-4 h-4 text-zinc-600" />
                                            <span className="text-xs font-mono text-zinc-600">auto-merge</span>
                                        </div>
                                    </div>
                                    {/* Wave 1 */}
                                    <div className="flex items-center gap-4">
                                        <div className="w-20 text-xs font-mono text-zinc-500 uppercase tracking-widest flex-shrink-0">Wave 1</div>
                                        <div className="flex gap-2 flex-1 justify-center">
                                            <div className="h-8 w-1/3 bg-fizz/20 text-fizz rounded border border-fizz/30 flex items-center justify-center text-xs">US-004</div>
                                            <div className="h-8 w-1/3 bg-fizz/20 text-fizz rounded border border-fizz/30 flex items-center justify-center text-xs">US-005</div>
                                        </div>
                                    </div>
                                    {/* Merge */}
                                    <div className="flex items-center gap-4">
                                        <div className="w-20 flex-shrink-0" />
                                        <div className="flex-1 flex justify-center items-center gap-2">
                                            <Network className="w-4 h-4 text-zinc-600" />
                                            <span className="text-xs font-mono text-zinc-600">auto-merge</span>
                                        </div>
                                    </div>
                                    {/* Wave 2 */}
                                    <div className="flex items-center gap-4">
                                        <div className="w-20 text-xs font-mono text-zinc-500 uppercase tracking-widest flex-shrink-0">Wave 2</div>
                                        <div className="flex gap-2 flex-1 justify-center">
                                            <div className="h-8 w-1/4 bg-accent/20 text-accent rounded border border-accent/30 flex items-center justify-center text-xs">US-006</div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </section>

                    </div>
                </div>
            </div>
            <Footer />
        </main>
    );
}
