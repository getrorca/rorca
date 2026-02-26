'use client';

import { motion } from 'framer-motion';
import { FileCode, Play, DatabaseZap } from 'lucide-react';

const steps = [
    {
        id: "01",
        title: "The Direction Stack",
        description: "Every spec is compiled into a YAML Direction Stack. This structured intent ensures the engine knows exactly where it's going, allowing you to manually intervene and steer the course at any time.",
        icon: FileCode,
    },
    {
        id: "02",
        title: "Native Subprocesses",
        description: "Rorca spawns isolated, native subprocesses for Claude Code, OpenCode, or Codex CLI to execute your tasks. You aren't locked into one provider—use the best CLI for the specific job.",
        icon: Play,
    },
    {
        id: "03",
        title: "Episodic Memory",
        description: "After a native CLI finishes a task, Rorca extracts the diffs and updates its Episodic Memory. When the next task spawns, the new subprocess inherits the exact context it needs to continue without hallucinating.",
        icon: DatabaseZap,
    },
];

export function HowItWorks() {
    return (
        <section className="py-32 px-6 sm:px-12 mx-auto max-w-7xl relative">
            <div className="text-center mb-24 relative z-10">
                <h2 className="text-4xl md:text-5xl font-medium tracking-tight text-white mb-6">Built for scale. Designed for control.</h2>
                <p className="text-zinc-400 text-xl max-w-3xl mx-auto leading-relaxed">
                    How Rorca orchestrates autonomous intelligence without losing the plot.
                </p>
            </div>

            <div className="relative z-10">
                {/* Connection Line Background */}
                <div className="hidden lg:block absolute top-[45px] left-[10%] right-[10%] h-[1px] bg-white/5 -z-10" />

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-16 lg:gap-8">
                    {steps.map((step, index) => (
                        <motion.div
                            key={step.id}
                            initial={{ opacity: 0, y: 30 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            transition={{ duration: 0.6, delay: index * 0.2 }}
                            className="relative flex flex-col items-center text-center group"
                        >
                            {/* Step Number Badge */}
                            <div className="w-24 h-24 mb-8 rounded-2xl bg-surface border border-border flex items-center justify-center relative shadow-[0_0_30px_rgba(0,0,0,0.5)] group-hover:border-zinc-500 transition-colors duration-500">
                                <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 rounded-2xl" />
                                <step.icon className="w-8 h-8 text-zinc-300 group-hover:text-white transition-colors duration-500 relative z-10" strokeWidth={1.5} />

                                {/* Glow effect under the icon */}
                                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-12 h-12 bg-accent/20 blur-xl rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                            </div>

                            {/* Connecting Nodes (Desktop only) */}
                            <div className="hidden lg:block absolute top-[45px] left-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-zinc-800 border-2 border-zinc-950 -z-0 group-hover:bg-accent transition-colors duration-500" />

                            {/* Content */}
                            <div className="flex flex-col items-center">
                                <span className="text-accent font-bold tracking-widest text-sm mb-4">{step.id}</span>
                                <h3 className="text-2xl font-medium text-zinc-100 mb-4 tracking-tight">{step.title}</h3>
                                <p className="text-zinc-400 leading-relaxed text-base max-w-sm">
                                    {step.description}
                                </p>
                            </div>
                        </motion.div>
                    ))}
                </div>
            </div>

            {/* Background radial gradient to separate section */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[400px] bg-accent/5 blur-[150px] pointer-events-none -z-10 rounded-[100%]" />
        </section>
    );
}
