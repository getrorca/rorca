'use client';

import { motion } from 'framer-motion';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';
import { Crown, TerminalSquare, Brain, FolderLock, GitMerge, FileTerminal } from 'lucide-react';

export default function EngineClient() {
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
                    <div className="inline-flex items-center gap-2 px-3 py-1 bg-fizz/10 text-fizz border border-fizz/20 rounded-full text-xs font-mono font-medium tracking-wide mb-6 uppercase">
                        <Crown className="w-4 h-4" /> The KingMode Discipline
                    </div>
                    <h1 className="text-4xl md:text-6xl font-medium tracking-tight mb-6">
                        The Context / Intent <span className="text-accent text-glow">Engine</span>.
                    </h1>
                    <p className="text-zinc-400 text-xl max-w-2xl leading-relaxed">
                        LLMs are stateless functions. Meaningful autonomy requires bridging &apos;The Is&apos; (Context) with &apos;The Ought&apos; (Intent). Rorca does this through an episodic ledger and hard virtual routing.
                    </p>
                </motion.div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-12">
                    {/* Floating Navigation (Left) */}
                    <div className="lg:col-span-3 hidden lg:block sticky top-32 h-fit">
                        <nav className="flex flex-col gap-4 text-sm font-medium">
                            <a href="#context-routing" className="text-zinc-400 hover:text-white transition-colors">Virtual Context Routing</a>
                            <a href="#episodic-ledger" className="text-zinc-400 hover:text-white transition-colors">The Episodic Ledger</a>
                            <a href="#soft-governance" className="text-zinc-400 hover:text-white transition-colors">Soft Governance Rules</a>
                        </nav>
                    </div>

                    {/* Main Content (Right) */}
                    <div className="lg:col-span-9 space-y-32">

                        {/* Section: Context Routing */}
                        <section id="context-routing" className="scroll-mt-32">
                            <div className="flex items-center gap-3 mb-6">
                                <GitMerge className="text-accent w-6 h-6" />
                                <h2 className="text-2xl font-medium">Virtual Context Routing</h2>
                            </div>
                            <p className="text-zinc-400 text-lg mb-8 leading-relaxed">
                                Dumping the entire repository into the context window destroys reasoning and wastes tokens. Rorca&apos;s <code className="text-zinc-300">`config.json`</code> uses exact glob matching to route the right slices of architectural context strictly to the subprocesses that need them.
                            </p>

                            <div className="bg-zinc-950 border border-white/10 rounded-2xl overflow-hidden p-6 relative group">
                                <div className="absolute inset-0 bg-gradient-to-br from-accent/5 to-transparent pointer-events-none" />
                                <div className="relative font-mono text-sm leading-relaxed">
                                    <div className="text-zinc-500 mb-2">// Routes context intelligently based on touched files</div>
                                    <div className="text-zinc-300">
                                        <span className="text-fizz">&quot;routing&quot;</span>: {'{'}
                                        <div className="pl-4">
                                            <span className="text-white">&quot;match&quot;</span>: <span className="text-blue-300">&quot;src/panels/**/*.tsx&quot;</span>,<br />
                                            <span className="text-white">&quot;inject&quot;</span>: [<span className="text-blue-300">&quot;frontend-patterns.md&quot;</span>, <span className="text-blue-300">&quot;components/AGENTS.md&quot;</span>]
                                        </div>
                                        {'}'},
                                    </div>
                                </div>
                            </div>
                        </section>

                        {/* Section: The Episodic Ledger */}
                        <section id="episodic-ledger" className="scroll-mt-32">
                            <div className="flex items-center gap-3 mb-6">
                                <Brain className="text-accent w-6 h-6" />
                                <h2 className="text-2xl font-medium">The Episodic Ledger (<code className="text-white">MEMORY.md</code>)</h2>
                            </div>
                            <p className="text-zinc-400 text-lg mb-8 leading-relaxed">
                                Agent determinism degrades over time. Rorca&apos;s episodic memory is a timestamped, structured ledger—not sprawling prose. At the end of every task, the engine synthesizes patterns, fixed gotchas, and architectural decisions, appending them atomically. The orchestrator never forgets.
                            </p>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="p-5 bg-zinc-900 border border-accent/20 rounded-xl relative overflow-hidden">
                                    <div className="absolute top-0 right-0 p-3 opacity-20"><TerminalSquare /></div>
                                    <div className="text-xs font-mono text-accent mb-2">Category: Architecture</div>
                                    <p className="text-sm text-zinc-300">xterm.js implementation requires @xterm scope. Do not use legacy xterm package.</p>
                                    <div className="mt-3 text-[10px] text-zinc-600 font-mono">2026-02-23T14:22:01Z</div>
                                </div>
                                <div className="p-5 bg-zinc-900 border border-fizz/20 rounded-xl relative overflow-hidden">
                                    <div className="absolute top-0 right-0 p-3 opacity-20"><TerminalSquare /></div>
                                    <div className="text-xs font-mono text-fizz mb-2">Category: Gotcha</div>
                                    <p className="text-sm text-zinc-300">pg Pool is async — always await DB calls. Use $1, $2 placeholders.</p>
                                    <div className="mt-3 text-[10px] text-zinc-600 font-mono">2026-02-21T09:14:33Z</div>
                                </div>
                            </div>
                        </section>

                        {/* Section: Soft Governance */}
                        <section id="soft-governance" className="scroll-mt-32">
                            <div className="flex items-center gap-3 mb-6">
                                <FolderLock className="text-accent w-6 h-6" />
                                <h2 className="text-2xl font-medium">Soft Governance via (<code className="text-white">AGENTS.md</code>)</h2>
                            </div>
                            <p className="text-zinc-400 text-lg mb-8 leading-relaxed">
                                Not all directories are equal. By placing localized <code className="text-zinc-300">`AGENTS.md`</code> files throughout the monolith, you impose soft behavioral constraints at the directory level. The implementation subprocess consumes the local file governing its target path before making a single edit.
                            </p>

                            <div className="flex flex-col sm:flex-row gap-6 items-center bg-zinc-900/50 p-6 rounded-2xl border border-white/5">
                                <FileTerminal className="w-12 h-12 text-zinc-700 flex-shrink-0" />
                                <div>
                                    <h3 className="text-white font-medium mb-1">backend/src/db/migrations/AGENTS.md</h3>
                                    <p className="text-sm text-zinc-400 mb-0">&quot;Migrations are strictly append-only. SQLite in this repo lacks ADD COLUMN IF NOT EXISTS; use the index.ts pragma pattern for schema evolution instead of generating new migration layers.&quot;</p>
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
