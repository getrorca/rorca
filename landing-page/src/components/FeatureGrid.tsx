'use client';

import { motion } from 'framer-motion';
import { Layers, BrainCircuit, LineChart, Network } from 'lucide-react';
import { SiAnthropic, SiOpenai } from 'react-icons/si';

export function FeatureGrid() {
    return (
        <section className="py-24 px-6 sm:px-12 mx-auto max-w-7xl">
            <div className="mb-16">
                <h2 className="text-3xl font-medium tracking-tight text-white mb-4">Orchestrate complexity.</h2>
                <p className="text-zinc-400 text-lg max-w-2xl">
                    Rorca isn't just an agent—it's an execution platform. Built to handle massive context windows and parallel processing in a cost-effective way.
                </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

                {/* Large Card: Consolidation Engine */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.5, delay: 0 }}
                    className="group relative bg-surface border border-border rounded-2xl p-8 overflow-hidden transition-colors hover:border-zinc-700 md:col-span-2 flex flex-col justify-between"
                >
                    <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />

                    <div className="mb-12">
                        <div className="h-10 w-10 rounded-lg bg-zinc-800/50 border border-white/5 flex items-center justify-center mb-6">
                            <Layers className="w-5 h-5 text-zinc-300" strokeWidth={1.5} />
                        </div>
                        <h3 className="text-2xl font-medium text-zinc-100 mb-3 tracking-tight">The Unified Orchestration Engine</h3>
                        <p className="text-zinc-400 leading-relaxed text-base max-w-md">
                            Consolidate Claude Code, OpenCode, and Codex CLI into a single, cohesive workflow. Whether you bring APIs or subscriptions, Rorca coordinates them all flawlessly.
                        </p>
                    </div>

                    {/* Visual representation of the tools */}
                    <div className="flex items-center gap-4 mt-auto">
                        <div className="flex items-center gap-2 bg-zinc-950 border border-white/10 px-4 py-2 rounded-full shadow-inner">
                            <SiAnthropic className="w-4 h-4 text-[#d97757]" />
                            <span className="text-xs font-semibold text-zinc-300">Claude Code</span>
                        </div>
                        <div className="w-8 h-[1px] bg-white/10 relative">
                            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-accent/50 animate-pulse"></div>
                        </div>
                        <div className="flex items-center gap-2 bg-zinc-950 border border-white/10 px-4 py-2 rounded-full shadow-inner">
                            {/* OpenCode actual brand mark — dark frame, split inner rect */}
                            <svg className="w-4 h-4" viewBox="0 0 14 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <rect width="14" height="18" fill="#1c1c1c" />
                                <rect x="3" y="3" width="8" height="5" fill="white" />
                                <rect x="3" y="8" width="8" height="7" fill="#b0b0b0" />
                            </svg>
                            <span className="text-xs font-semibold text-zinc-300">OpenCode</span>
                        </div>
                        <div className="w-8 h-[1px] bg-white/10 flex items-center justify-center relative">
                            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-accent/50 animate-pulse" style={{ animationDelay: '0.5s' }}></div>
                        </div>
                        <div className="flex items-center gap-2 bg-zinc-950 border border-white/10 px-4 py-2 rounded-full shadow-inner">
                            <SiOpenai className="w-4 h-4 text-white" />
                            <span className="text-xs font-semibold text-zinc-300">Codex CLI</span>
                        </div>
                    </div>
                </motion.div>

                {/* Small Card: Wave-Parallel */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.5, delay: 0.1 }}
                    className="group relative bg-surface border border-border rounded-2xl p-8 overflow-hidden transition-colors hover:border-zinc-700 md:col-span-1"
                >
                    <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
                    <div className="h-10 w-10 rounded-lg bg-zinc-800/50 border border-white/5 flex items-center justify-center mb-6">
                        <Network className="w-5 h-5 text-zinc-300" strokeWidth={1.5} />
                    </div>
                    <h3 className="text-xl font-medium text-zinc-100 mb-2 tracking-tight">Wave-Parallel Execution</h3>
                    <p className="text-zinc-400 leading-relaxed text-sm">
                        Agents iterate on all tasks within a spec concurrently across isolated worktrees until absolute completion. Extreme velocity, zero state collision.
                    </p>
                </motion.div>

                {/* Small Card: Cost Optimization */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.5, delay: 0.2 }}
                    className="group relative bg-surface border border-border rounded-2xl p-8 overflow-hidden transition-colors hover:border-zinc-700 md:col-span-1"
                >
                    <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
                    <div className="h-10 w-10 rounded-lg bg-zinc-800/50 border border-white/5 flex items-center justify-center mb-6">
                        <LineChart className="w-5 h-5 text-zinc-300" strokeWidth={1.5} />
                    </div>
                    <h3 className="text-xl font-medium text-zinc-100 mb-2 tracking-tight">Cost-Optimized Routing</h3>
                    <p className="text-zinc-400 leading-relaxed text-sm">
                        Smart delegation. Rorca routes repository reading and globbing to cheaper models, reserving flagship intelligence strictly for high-order logic and coding.
                    </p>
                </motion.div>

                {/* Large Card: Directional Intent & Memory */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.5, delay: 0.3 }}
                    className="group relative bg-surface border border-border rounded-2xl p-8 overflow-hidden transition-colors hover:border-zinc-700 md:col-span-2"
                >
                    <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
                    <div className="h-10 w-10 rounded-lg bg-zinc-800/50 border border-white/5 flex items-center justify-center mb-6">
                        <BrainCircuit className="w-5 h-5 text-zinc-300" strokeWidth={1.5} />
                    </div>
                    <h3 className="text-2xl font-medium text-zinc-100 mb-3 tracking-tight">Directional Intent & Episodic Memory</h3>
                    <p className="text-zinc-400 leading-relaxed text-base max-w-lg mb-6">
                        You are always in control. Context engineering structures intent, while manual user intervention checkpoints guarantee precision. Persistent episodic memory ensures the orchestrator never loses context—even in massive mono-repos.
                    </p>

                    {/* Visual abstract timeline */}
                    <div className="flex items-center w-full h-12 rounded-lg bg-zinc-950/50 border border-white/5 px-4 overflow-hidden relative">
                        <div className="w-2 h-2 rounded-full bg-zinc-500 z-10"></div>
                        <div className="flex-grow h-[1px] bg-white/10 z-0"></div>
                        <div className="w-3 h-3 rounded-full bg-accent z-10 shadow-[0_0_10px_rgba(139,92,246,0.8)]"></div>
                        <div className="flex-grow h-[1px] bg-white/10 z-0"></div>
                        <div className="w-2 h-2 rounded-full bg-zinc-500 z-10"></div>

                        {/* Sweeping scanline effect */}
                        <div className="absolute top-0 bottom-0 w-24 bg-gradient-to-r from-transparent via-accent/20 to-transparent -translate-x-full animate-[text-shimmer_3s_infinite]" />
                    </div>
                </motion.div>

            </div>
        </section>
    );
}
