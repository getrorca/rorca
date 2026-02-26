'use client';

import { motion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';

export function Hero() {
    return (
        <section className="relative pt-32 pb-20 px-6 sm:px-12 mx-auto max-w-7xl flex flex-col items-center justify-center text-center">
            {/* Premium Pill Badge */}
            <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, ease: "easeOut" }}
                className="flex items-center gap-2 px-3 py-1 mb-8 rounded-full bg-white/5 border border-white/10 backdrop-blur-md text-sm font-medium text-zinc-300 cursor-pointer hover:bg-white/10 transition-colors"
            >
                <span className="flex h-2 w-2 rounded-full bg-accent animate-pulse"></span>
                Introducing Rorca V1 Architecture
                <ChevronRight className="w-4 h-4 text-zinc-500" />
            </motion.div>

            {/* Hero Headline */}
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, delay: 0.1, ease: "easeOut" }}
            >
                <h1 className="text-6xl sm:text-7xl md:text-8xl font-medium tracking-tight text-white leading-[1.1] max-w-5xl">
                    Ship specs. <br />
                    <span className="bg-gradient-to-r from-zinc-300 via-zinc-500 to-zinc-400 bg-clip-text text-transparent">Not tickets.</span>
                </h1>
            </motion.div>

            {/* Subtitle */}
            <motion.p
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, delay: 0.2, ease: "easeOut" }}
                className="mt-8 text-xl text-zinc-400 max-w-2xl font-normal leading-relaxed tracking-wide"
            >
                The unified orchestration engine for Claude Code, OpenCode, and Codex CLI. Rorca deploys cost-optimized, wave-parallel execution with deep episodic memory to turn plain-English into production code.
            </motion.p>

            {/* CTAs */}
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, delay: 0.3, ease: "easeOut" }}
                className="mt-10 flex flex-col sm:flex-row items-center gap-4"
            >
                <button className="px-6 py-3 bg-white text-zinc-950 rounded-lg font-medium shadow-[0_0_40px_rgba(255,255,255,0.1)] hover:shadow-[0_0_60px_rgba(255,255,255,0.2)] transition-shadow">
                    Start Building
                </button>
                <button className="px-6 py-3 bg-transparent text-white border border-white/10 rounded-lg font-medium hover:bg-white/5 transition-colors flex items-center gap-2">
                    Read the Docs
                </button>
            </motion.div>

            {/* Mockup Container Background Glow */}
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 w-[80%] h-[300px] bg-accent/20 blur-[100px] pointer-events-none -z-10 rounded-full" />
        </section>
    );
}
