'use client';

import { motion } from 'framer-motion';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';
import { GitMerge, Sparkles, BrainCircuit } from 'lucide-react';

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
                    <h1 className="text-4xl md:text-6xl font-medium tracking-tight mb-6">
                        The Context <span className="text-accent">Memory</span>.
                    </h1>
                    <p className="text-zinc-400 text-xl max-w-2xl leading-relaxed">
                        LLMs are stateless. Meaningful autonomy requires bridging what the codebase is with what needs to be built. Rorca does this through virtual context routing, LLM-matched skills, and a tiered memory retrieval cascade.
                    </p>
                </motion.div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-12">
                    {/* Floating Navigation (Left) */}
                    <div className="lg:col-span-3 hidden lg:block sticky top-32 h-fit">
                        <nav className="flex flex-col gap-4 text-sm font-medium">
                            <a href="#memory-cascade" className="text-zinc-400 hover:text-white transition-colors">Memory Retrieval Cascade</a>
                            <a href="#context-routing" className="text-zinc-400 hover:text-white transition-colors">Virtual Context Routing</a>
                            <a href="#skills" className="text-zinc-400 hover:text-white transition-colors">Skills Injection</a>
                        </nav>
                    </div>

                    {/* Main Content (Right) */}
                    <div className="lg:col-span-9 space-y-32">

                        {/* Section: Memory Retrieval Cascade */}
                        <section id="memory-cascade" className="scroll-mt-32">
                            <div className="flex items-center gap-3 mb-6">
                                <BrainCircuit className="text-accent w-6 h-6" />
                                <h2 className="text-2xl font-medium">Memory Retrieval Cascade</h2>
                            </div>
                            <p className="text-zinc-400 text-lg mb-8 leading-relaxed">
                                Memory is retrieved in three tiers before each story executes. The ledger is built from two sources: post-run synthesis (decisions and patterns extracted after each pipeline run) and git history hydration (LLM map-reduce over commit history on workspace registration, parsed into individual entries). Both sources deduplicate against existing entries before writing.
                            </p>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-8">
                                <div className="flex items-start gap-3 p-4 bg-zinc-900/50 border border-white/5 rounded-xl">
                                    <div className="w-2 h-2 rounded-full bg-accent mt-1.5 flex-shrink-0" />
                                    <div>
                                        <p className="text-sm font-medium text-zinc-200 mb-1">Post-run synthesis</p>
                                        <p className="text-xs text-zinc-500">After every pipeline run, the engine extracts architectural decisions, bug patterns, conventions, and gotchas from story execution output. Written with <code className="font-mono">source: auto_synthesis</code>.</p>
                                    </div>
                                </div>
                                <div className="flex items-start gap-3 p-4 bg-zinc-900/50 border border-white/5 rounded-xl">
                                    <div className="w-2 h-2 rounded-full bg-fizz mt-1.5 flex-shrink-0" />
                                    <div>
                                        <p className="text-sm font-medium text-zinc-200 mb-1">Git history hydration</p>
                                        <p className="text-xs text-zinc-500">On workspace registration and periodically thereafter, git commit history is analyzed via LLM map-reduce. Output is parsed into individual memory entries. Written with <code className="font-mono">source: git_hydration</code>.</p>
                                    </div>
                                </div>
                            </div>
                            <div className="space-y-3 mb-8">
                                {[
                                    { tier: 'CAG', label: 'Cache', latency: '0ms', desc: 'In-memory hydrated context snapshot. Checked first, zero DB round-trip.' },
                                    { tier: 'RAG', label: 'pgvector', latency: '< 5ms', desc: 'Cosine similarity search over embedded memory entries. Semantically matches story title and acceptance criteria.' },
                                    { tier: 'Graph', label: 'Apache AGE', latency: '< 20ms', desc: 'Relationship traversal. Finds memories connected to specs, stories, or files referenced in the story description.' },
                                ].map((t, i) => (
                                    <div key={t.tier} className="flex items-start gap-4 p-4 bg-zinc-900/50 border border-white/5 rounded-xl">
                                        <div className="flex flex-col items-center flex-shrink-0">
                                            <div className="w-8 h-8 rounded bg-zinc-800 border border-white/10 flex items-center justify-center text-xs font-mono text-accent">{t.tier}</div>
                                            {i < 2 && <div className="w-[1px] h-3 bg-white/10 mt-1" />}
                                        </div>
                                        <div className="flex-1">
                                            <div className="flex items-center gap-3 mb-1">
                                                <span className="text-sm font-medium text-zinc-200">{t.label}</span>
                                                <span className="text-xs font-mono text-zinc-600">{t.latency}</span>
                                            </div>
                                            <p className="text-sm text-zinc-500">{t.desc}</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="p-5 bg-zinc-900 border border-accent/20 rounded-xl">
                                    <div className="text-xs font-mono text-accent mb-2">Category: Architecture</div>
                                    <p className="text-sm text-zinc-300">Use timestamp prefix (YYYYMMDDHHMMSS) for all new migrations — sequential numbers collide on parallel worktree branches.</p>
                                    <div className="mt-3 text-[10px] text-zinc-600 font-mono">2026-03-13T21:14:00Z · source: auto_synthesis</div>
                                </div>
                                <div className="p-5 bg-zinc-900 border border-fizz/20 rounded-xl">
                                    <div className="text-xs font-mono text-fizz mb-2">Category: Convention</div>
                                    <p className="text-sm text-zinc-300">All Express routes use AppError subclasses (ValidationError, NotFoundError) — raw Error throws are not serialized by the error handler.</p>
                                    <div className="mt-3 text-[10px] text-zinc-600 font-mono">2026-03-10T09:32:00Z · source: git_hydration</div>
                                </div>
                            </div>
                        </section>

                        {/* Section: Context Routing */}
                        <section id="context-routing" className="scroll-mt-32">
                            <div className="flex items-center gap-3 mb-6">
                                <GitMerge className="text-accent w-6 h-6" />
                                <h2 className="text-2xl font-medium">Virtual Context Routing</h2>
                            </div>
                            <p className="text-zinc-400 text-lg mb-8 leading-relaxed">
                                Dumping the entire repository into the context window destroys reasoning and wastes tokens. Rorca&apos;s <code className="text-zinc-300 font-mono text-sm">.rorca/config.json</code> uses micromatch glob patterns to route the right architectural context to each story — scoped by the files it&apos;s expected to touch. Token budget enforced at 8K. Globals always included.
                            </p>
                            <div className="bg-zinc-950 border border-white/10 rounded-2xl overflow-hidden p-6 relative">
                                <div className="absolute inset-0 bg-gradient-to-br from-accent/5 to-transparent pointer-events-none" />
                                <div className="relative font-mono text-sm leading-relaxed">
                                    <div className="text-zinc-600 mb-3 text-xs">{'// .rorca/config.json — routing table'}</div>
                                    <div className="text-zinc-300 space-y-2">
                                        <div>
                                            {'{'} <span className="text-fizz">&quot;match&quot;</span>: <span className="text-blue-300">&quot;src/**/*.tsx&quot;</span>,{' '}
                                            <span className="text-fizz">&quot;inject&quot;</span>: [<span className="text-blue-300">&quot;react-review.md&quot;</span>] {'}'}
                                        </div>
                                        <div>
                                            {'{'} <span className="text-fizz">&quot;match&quot;</span>: <span className="text-blue-300">&quot;backend/src/db/**&quot;</span>,{' '}
                                            <span className="text-fizz">&quot;inject&quot;</span>: [<span className="text-blue-300">&quot;database-optimization.md&quot;</span>] {'}'}
                                        </div>
                                        <div>
                                            {'{'} <span className="text-fizz">&quot;match&quot;</span>: <span className="text-blue-300">&quot;backend/src/routes/**&quot;</span>,{' '}
                                            <span className="text-fizz">&quot;inject&quot;</span>: [<span className="text-blue-300">&quot;security-scan.md&quot;</span>] {'}'}
                                        </div>
                                        <div className="text-zinc-600">
                                            {'{'} <span className="text-zinc-500">&quot;match&quot;</span>: <span className="text-zinc-500">&quot;**&quot;</span>,{' '}
                                            <span className="text-zinc-500">&quot;priority&quot;</span>: <span className="text-zinc-500">101</span>,{' '}
                                            <span className="text-zinc-500">&quot;inject&quot;</span>: [<span className="text-zinc-500">&quot;logging-fundamentals.md&quot;</span>] {'}'} <span className="text-zinc-700">{'// global, always injected'}</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </section>

                        {/* Section: Skills Injection */}
                        <section id="skills" className="scroll-mt-32">
                            <div className="flex items-center gap-3 mb-6">
                                <Sparkles className="text-accent w-6 h-6" />
                                <h2 className="text-2xl font-medium">Skills Injection</h2>
                            </div>
                            <p className="text-zinc-400 text-lg mb-8 leading-relaxed">
                                Before each story executes, the SkillRegistry asks an LLM to match installed skills against the story&apos;s title and acceptance criteria. Matched skills are injected as context — both as Claude native skill files and via <code className="text-zinc-300 font-mono text-sm">buildPrompt()</code>. Install from the Marketplace or drop any Markdown file into <code className="text-zinc-300 font-mono text-sm">.rorca/skills/</code>.
                            </p>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
                                {[
                                    { name: 'react-review', match: 'stories touching src/' },
                                    { name: 'database-optimization', match: 'stories touching db/' },
                                    { name: 'security-scan', match: 'auth, payment, secrets stories' },
                                    { name: 'accessibility-audit', match: 'UI component stories' },
                                    { name: 'exhaustive-specification', match: 'spec generation pass' },
                                    { name: 'logging-fundamentals', match: 'all stories (global)' },
                                ].map((s) => (
                                    <div key={s.name} className="p-4 bg-zinc-900/50 border border-white/5 rounded-xl">
                                        <p className="text-sm font-mono text-zinc-200 mb-1">{s.name}</p>
                                        <p className="text-xs text-zinc-600">{s.match}</p>
                                    </div>
                                ))}
                            </div>
                            <div className="flex items-center gap-3 p-4 bg-zinc-900/30 border border-white/5 rounded-xl">
                                <div className="w-2 h-2 rounded-full bg-accent flex-shrink-0" />
                                <p className="text-sm text-zinc-400">Skills are LLM-matched per story at runtime — no manual tagging. Relevance score 1–10; skills below threshold are excluded to stay within token budget.</p>
                            </div>
                        </section>

                    </div>
                </div>
            </div>
            <Footer />
        </main>
    );
}
