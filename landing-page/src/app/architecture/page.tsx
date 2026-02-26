'use client';

import { motion } from 'framer-motion';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';
import { Layers, Database, Cpu, Terminal, Zap, Code, ShieldCheck } from 'lucide-react';

export default function ArchitecturePage() {
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
                        The Physics of <span className="text-accent">Autonomous Coding</span>.
                    </h1>
                    <p className="text-zinc-400 text-xl max-w-2xl leading-relaxed">
                        Rorca isn't a wrapper. It's a multi-layered orchestration engine designed to maintain intent across thousands of lines of code.
                    </p>
                </motion.div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-12">
                    {/* Floating Navigation (Left) */}
                    <div className="lg:col-span-3 hidden lg:block sticky top-32 h-fit">
                        <nav className="flex flex-col gap-4 text-sm font-medium">
                            <a href="#l2-profiles" className="text-zinc-400 hover:text-white transition-colors">L2 Domain Profiles</a>
                            <a href="#spec-templates" className="text-zinc-400 hover:text-white transition-colors">Spec Templates</a>
                            <a href="#sse-telemetry" className="text-zinc-400 hover:text-white transition-colors">Push-Based Telemetry</a>
                        </nav>
                    </div>

                    {/* Main Content (Right) */}
                    <div className="lg:col-span-9 space-y-32">

                        {/* Section: L2 Domain Profiles */}
                        <section id="l2-profiles" className="scroll-mt-32">
                            <div className="flex items-center gap-3 mb-6">
                                <Layers className="text-accent w-6 h-6" />
                                <h2 className="text-2xl font-medium">L2 Domain Profiles</h2>
                            </div>
                            <p className="text-zinc-400 text-lg mb-8 leading-relaxed">
                                Global context enforcement. Instead of re-explaining your API patterns for every task, L2 profiles inject reusable domain knowledge (TypeScript, SaaS, Auth) into every workspace automatically.
                            </p>
                            <div className="bg-zinc-900/50 border border-white/5 rounded-2xl p-6 font-mono text-sm overflow-hidden">
                                <div className="flex items-center gap-2 mb-4 text-zinc-500">
                                    <Database className="w-4 h-4" />
                                    <span>direction_layers.domain_profile_l2</span>
                                </div>
                                <pre className="text-zinc-300">
                                    {`domain: typescript-saas
rules:
  - enforce-camelCase: true
  - error-pattern: "ApiError(status, message)"
  - test-suffix: ".test.ts"
  - mock-depth: 2`}
                                </pre>
                            </div>
                        </section>

                        {/* Section: Spec Templates Library */}
                        <section id="spec-templates" className="scroll-mt-32">
                            <div className="flex items-center gap-3 mb-6">
                                <Code className="text-accent w-6 h-6" />
                                <h2 className="text-2xl font-medium">Spec Templates Library</h2>
                            </div>
                            <p className="text-zinc-400 text-lg mb-8 leading-relaxed">
                                Curated feature patterns. Pull from a library of 12+ pre-structured briefs—from OAuth to Stripe Billing—with dynamic `{"{{PLACEHOLDER}}"}` substitution.
                            </p>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {['OAuth Login', 'REST CRUD API', 'Stripe Billing', 'Admin Dashboard'].map((t) => (
                                    <div key={t} className="p-4 bg-zinc-900 border border-white/10 rounded-xl flex items-center justify-between">
                                        <span className="font-medium">{t}</span>
                                        <Zap className="w-4 h-4 text-accent" />
                                    </div>
                                ))}
                            </div>
                        </section>

                        {/* Section: SSE Real-Time Telemetry */}
                        <section id="sse-telemetry" className="scroll-mt-32">
                            <div className="flex items-center gap-3 mb-6">
                                <Terminal className="text-accent w-6 h-6" />
                                <h2 className="text-2xl font-medium">Push-Based Telemetry</h2>
                            </div>
                            <p className="text-zinc-400 text-lg mb-8 leading-relaxed">
                                No polling, just performance. The native run-loop emits Server-Sent Events (SSE) directly to the dashboard, providing millisecond-accurate updates as coding worktrees execute.
                            </p>
                            <div className="bg-zinc-950 rounded-xl p-4 border border-white/5 shadow-2xl">
                                <div className="flex items-center gap-2 mb-2">
                                    <div className="w-2 h-2 rounded-full bg-red-500" />
                                    <div className="w-2 h-2 rounded-full bg-yellow-500" />
                                    <div className="w-2 h-2 rounded-full bg-green-500" />
                                </div>
                                <div className="font-mono text-xs text-zinc-500 space-y-1">
                                    <p>[12:04:22] <span className="text-green-400">POST /api/pipeline/webhook/run-start</span></p>
                                    <p>[12:04:23] [Story: Auth] Native subprocess spawned (PID: 2831)</p>
                                    <p>[12:04:25] [Story: Auth] Diff extracted. Updating Episodic Memory...</p>
                                    <p className="animate-pulse">[12:04:26] <span className="text-accent">Streaming SSE update to Dashboard...</span></p>
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
