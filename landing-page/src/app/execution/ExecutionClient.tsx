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
                        Three engines. <br />
                        <span className="text-zinc-500">Zero lock-in.</span>
                    </h1>
                    <p className="text-zinc-400 text-xl max-w-2xl leading-relaxed">
                        Three first-class execution engines. Model cascading by story complexity. Wave-parallel worktrees. The same tool set regardless of provider — edit, bash, read, write, glob, grep.
                    </p>
                </motion.div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-12">
                    {/* Floating Navigation (Left) */}
                    <div className="lg:col-span-3 hidden lg:block sticky top-32 h-fit">
                        <nav className="flex flex-col gap-4 text-sm font-medium">
                            <a href="#engines" className="text-zinc-400 hover:text-white transition-colors">Three Execution Engines</a>
                            <a href="#cascading" className="text-zinc-400 hover:text-white transition-colors">Model Cascading & FinOps</a>
                            <a href="#wave-parallel" className="text-zinc-400 hover:text-white transition-colors">Wave-Parallel Execution</a>
                        </nav>
                    </div>

                    {/* Main Content (Right) */}
                    <div className="lg:col-span-9 space-y-32">

                        {/* Section: Three Execution Engines */}
                        <section id="engines" className="scroll-mt-32">
                            <div className="flex items-center gap-3 mb-6">
                                <Cpu className="text-fizz w-6 h-6" />
                                <h2 className="text-2xl font-medium">Three Execution Engines</h2>
                            </div>
                            <p className="text-zinc-400 text-lg mb-8 leading-relaxed">
                                Every story runs as a fresh isolated subprocess with the full tool set. No context limits. The engine is the same; the model behind it is your choice. Bring your Claude subscription, an API key, or your ChatGPT plan.
                            </p>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
                                        <li>Model cascading (Haiku → Opus)</li>
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
                                        <li>Same tool set, no cascading</li>
                                        <li>OpenAI model tier (subscription)</li>
                                    </ul>
                                </div>
                            </div>
                        </section>

                        {/* Section: Model Cascading & FinOps */}
                        <section id="cascading" className="scroll-mt-32">
                            <div className="flex items-center gap-3 mb-6">
                                <Zap className="text-fizz w-6 h-6" />
                                <h2 className="text-2xl font-medium">Model Cascading & FinOps</h2>
                            </div>
                            <p className="text-zinc-400 text-lg mb-8 leading-relaxed">
                                When running OpenCode, Rorca scores every story by complexity before the subprocess spawns. Simple CRUD goes to Haiku. Failures escalate up the tier automatically on non-zero exit. On average, cascading saves 40–60% vs an all-Opus baseline. The FinOps dashboard tracks realized savings per run and trend over time.
                            </p>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div className="bg-zinc-900 border border-fizz/30 rounded-xl p-6 relative overflow-hidden">
                                    <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-fizz to-transparent opacity-50" />
                                    <h3 className="text-base font-medium text-white mb-2">Tier 1 — Haiku</h3>
                                    <p className="text-sm text-zinc-400 mb-4">Simple CRUD, UI copy, config tweaks, low dependsOn depth.</p>
                                    <div className="text-xs font-mono text-zinc-500 bg-black/40 px-3 py-2 rounded">Non-zero exit → Sonnet</div>
                                </div>
                                <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6">
                                    <h3 className="text-base font-medium text-white mb-2">Tier 2 — Sonnet</h3>
                                    <p className="text-sm text-zinc-400 mb-4">Standard features, business logic, moderate file count.</p>
                                    <div className="text-xs font-mono text-zinc-500 bg-black/40 px-3 py-2 rounded">Non-zero exit → Opus</div>
                                </div>
                                <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                                    <h3 className="text-base font-medium text-white mb-2">Tier 3 — Opus</h3>
                                    <p className="text-sm text-zinc-400 mb-4">Architecture, security, payments, high dependency depth.</p>
                                    <div className="text-xs font-mono text-zinc-500 bg-black/40 px-3 py-2 rounded border border-red-500/20 text-red-400">Non-zero exit → story_failed</div>
                                </div>
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
