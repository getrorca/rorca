'use client';

import { motion } from 'framer-motion';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';
import { ShieldAlert, Split, Cpu, Network, Zap, PlayCircle } from 'lucide-react';

export default function ComputePage() {
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
                        Compute is a commodity. <br />
                        <span className="text-zinc-500">Execution is an art.</span>
                    </h1>
                    <p className="text-zinc-400 text-xl max-w-2xl leading-relaxed">
                        Rorca decouples the pipeline from the provider. By treating LLMs as raw, interchangeable compute, Rorca achieves 3.3x speedups and 60% cast reduction.
                    </p>
                </motion.div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-12">
                    {/* Floating Navigation (Left) */}
                    <div className="lg:col-span-3 hidden lg:block sticky top-32 h-fit">
                        <nav className="flex flex-col gap-4 text-sm font-medium">
                            <a href="#arbitrage" className="text-zinc-400 hover:text-white transition-colors">The Arbitrage Engine</a>
                            <a href="#wave-parallel" className="text-zinc-400 hover:text-white transition-colors">Wave-Parallel Processing</a>
                            <a href="#multi-engine" className="text-zinc-400 hover:text-white transition-colors">Agnostic Subprocesses</a>
                        </nav>
                    </div>

                    {/* Main Content (Right) */}
                    <div className="lg:col-span-9 space-y-32">

                        {/* Section: Arbitrage Engine */}
                        <section id="arbitrage" className="scroll-mt-32">
                            <div className="flex items-center gap-3 mb-6">
                                <Zap className="text-fizz w-6 h-6" />
                                <h2 className="text-2xl font-medium">The Arbitrage Engine</h2>
                            </div>
                            <p className="text-zinc-400 text-lg mb-8 leading-relaxed">
                                Not every story requires Opus. Rorca's Story Complexity Scorer evaluates file count and `dependsOn` depth, routing boilerplate to Haiku and escalating to Opus only when tests fail. API arbitrage right at the metal.
                            </p>

                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                {/* Haiku */}
                                <div className="bg-zinc-900 border border-fizz/30 rounded-xl p-6 relative overflow-hidden group">
                                    <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-fizz to-transparent opacity-50" />
                                    <h3 className="text-lg font-medium text-white mb-2">Tier 1: Haiku</h3>
                                    <p className="text-sm text-zinc-400 mb-4">Simple CRUD, UI copy, config tweaks.</p>
                                    <div className="text-xs font-mono text-zinc-500 bg-black/40 px-3 py-2 rounded">Fail: Escalate →</div>
                                </div>

                                {/* Sonnet */}
                                <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 opacity-80">
                                    <h3 className="text-lg font-medium text-white mb-2">Tier 2: Sonnet</h3>
                                    <p className="text-sm text-zinc-400 mb-4">Standard features, business logic.</p>
                                    <div className="text-xs font-mono text-zinc-500 bg-black/40 px-3 py-2 rounded">Fail: Escalate →</div>
                                </div>

                                {/* Opus */}
                                <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6 opacity-60">
                                    <h3 className="text-lg font-medium text-white mb-2">Tier 3: Opus</h3>
                                    <p className="text-sm text-zinc-400 mb-4">Architecture, security, complex state.</p>
                                    <div className="text-xs font-mono text-zinc-500 bg-black/40 px-3 py-2 rounded border border-red-500/20 text-red-400">Fail: Human INTL</div>
                                </div>
                            </div>
                        </section>

                        {/* Section: Wave-Parallel Processing */}
                        <section id="wave-parallel" className="scroll-mt-32">
                            <div className="flex items-center gap-3 mb-6">
                                <Split className="text-fizz w-6 h-6" />
                                <h2 className="text-2xl font-medium">Wave-Parallel Processing</h2>
                            </div>
                            <p className="text-zinc-400 text-lg mb-8 leading-relaxed">
                                Throw out sequential queues. Rorca topologically sorts your `dependsOn` DAG into waves. Wave 0 stories execute concurrently in isolated Git worktrees, auto-merging before Wave 1 begins. 3x the output in the same wall-clock time.
                            </p>

                            <div className="bg-zinc-950 border border-white/5 rounded-2xl p-8 relative">
                                <div className="absolute inset-0 bg-[url('/grid.svg')] opacity-[0.03] pointer-events-none mix-blend-screen" />
                                <div className="flex flex-col gap-6 relative z-10">
                                    {/* Wave 0 */}
                                    <div className="flex items-center gap-4">
                                        <div className="w-20 text-xs font-mono text-zinc-500 uppercase tracking-widest">Wave 0</div>
                                        <div className="flex gap-2 flex-1">
                                            <div className="h-8 flex-1 bg-white/10 rounded border border-white/5 flex items-center justify-center text-xs text-white">US-001</div>
                                            <div className="h-8 flex-1 bg-white/10 rounded border border-white/5 flex items-center justify-center text-xs text-white">US-002</div>
                                            <div className="h-8 flex-1 bg-white/10 rounded border border-white/5 flex items-center justify-center text-xs text-white">US-003</div>
                                        </div>
                                    </div>

                                    {/* Merge Node */}
                                    <div className="flex items-center gap-4">
                                        <div className="w-20" />
                                        <div className="flex-1 flex justify-center">
                                            <Network className="w-5 h-5 text-zinc-600" />
                                        </div>
                                    </div>

                                    {/* Wave 1 */}
                                    <div className="flex items-center gap-4">
                                        <div className="w-20 text-xs font-mono text-zinc-500 uppercase tracking-widest">Wave 1</div>
                                        <div className="flex gap-2 flex-1 justify-center">
                                            <div className="h-8 w-1/3 bg-fizz/20 text-fizz rounded border border-fizz/30 flex items-center justify-center text-xs">US-004</div>
                                            <div className="h-8 w-1/3 bg-fizz/20 text-fizz rounded border border-fizz/30 flex items-center justify-center text-xs">US-005</div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </section>

                        {/* Section: Agnostic Engine */}
                        <section id="multi-engine" className="scroll-mt-32">
                            <div className="flex items-center gap-3 mb-6">
                                <Cpu className="text-fizz w-6 h-6" />
                                <h2 className="text-2xl font-medium">Agnostic Subprocesses</h2>
                            </div>
                            <p className="text-zinc-400 text-lg mb-8 leading-relaxed">
                                No vendor lock-in. Toggle between the native `claude` CLI for aggressive prompt-caching, or use `opencode` to route stories via API keys to 75+ OpenRouter models. The bash tools, memory ledger, and Git isolation remain identical.
                            </p>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <div className="p-6 bg-zinc-900 border border-white/5 rounded-xl">
                                    <div className="flex items-center justify-between mb-4">
                                        <span className="font-medium text-white">claude --print</span>
                                        <ShieldAlert className="w-4 h-4 text-zinc-500" />
                                    </div>
                                    <ul className="text-sm text-zinc-400 space-y-2">
                                        <li>• Native Prompt Caching</li>
                                        <li>• Persistent Bash State</li>
                                        <li>• Minimal Latency Round-Trips</li>
                                    </ul>
                                </div>
                                <div className="p-6 bg-zinc-900 border border-white/5 rounded-xl">
                                    <div className="flex items-center justify-between mb-4">
                                        <span className="font-medium text-white">opencode run</span>
                                        <PlayCircle className="w-4 h-4 text-zinc-500" />
                                    </div>
                                    <ul className="text-sm text-zinc-400 space-y-2">
                                        <li>• 75+ Models (OpenRouter)</li>
                                        <li>• Zero Cold-Start (`--attach`)</li>
                                        <li>• Structured JSON Output</li>
                                    </ul>
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
