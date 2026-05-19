'use client';

import { motion } from 'framer-motion';
import { ChevronRight, Github, Download, FileText } from 'lucide-react';
import Link from 'next/link';
import { trackCtaClick } from '@/lib/analytics';

const trustPills = [
  'Explicit spec persistence',
  'Skills + MCP ready',
  'Rorca CLI + embedded TUI',
  'Claude Code · OpenCode · Codex · Pi',
];

export function Hero() {
  return (
    <section className="relative pt-28 pb-20 px-6 sm:px-12 mx-auto max-w-7xl flex flex-col items-center justify-center text-center">
      <motion.div
        initial={{ opacity: 0, y: -16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: 'easeOut' }}
        className="inline-flex items-center gap-2 px-3 py-1 mb-8 rounded-full bg-white/5 border border-white/10 text-sm font-medium text-zinc-300"
      >
        <span className="flex h-2 w-2 rounded-full bg-accent animate-pulse" />
        Local-first · skill-first · MCP-native
        <ChevronRight className="w-4 h-4 text-zinc-500" />
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 0.05, ease: 'easeOut' }}
      >
        <h1 className="text-5xl sm:text-6xl md:text-7xl font-medium tracking-tight text-white leading-[1.05] max-w-5xl">
          Ship specs.
          <br />
          <span className="bg-gradient-to-r from-zinc-200 via-zinc-400 to-zinc-500 bg-clip-text text-transparent">
            Not prompts.
          </span>
        </h1>
      </motion.div>

      <motion.p
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 0.12, ease: 'easeOut' }}
        className="mt-8 text-lg sm:text-xl text-zinc-400 max-w-3xl font-normal leading-relaxed"
      >
        Rorca turns a brief into a reviewable spec, persists explicitly drafted specs,
        and runs story-by-story with backend-native retrieval, telemetry, and feedback.
        It ships with its own CLI and embedded TUI for local operator workflows, and it automates execution through the CLI provider the user selected — Claude Code, OpenCode, Codex, or Pi — using that provider’s native tools.
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 0.2, ease: 'easeOut' }}
        className="mt-10 flex flex-col sm:flex-row items-center gap-3"
      >
        <Link
          href="/download"
          onClick={() => trackCtaClick('install_rorca', '/')}
          className="px-6 py-3 bg-white text-zinc-950 rounded-lg font-medium shadow-[0_0_40px_rgba(255,255,255,0.1)] hover:shadow-[0_0_60px_rgba(255,255,255,0.18)] transition-shadow inline-flex items-center gap-2"
        >
          <Download className="w-4 h-4" />
          Install Rorca
        </Link>
        <Link
          href="/docs"
          onClick={() => trackCtaClick('read_docs', '/')}
          className="px-6 py-3 bg-transparent text-white border border-white/10 rounded-lg font-medium hover:bg-white/5 transition-colors inline-flex items-center gap-2"
        >
          <FileText className="w-4 h-4" />
          Read the Docs
        </Link>
        <a
          href="https://github.com/getrorca/rorca"
          target="_blank"
          rel="noreferrer"
          onClick={() => trackCtaClick('view_source', '/')}
          className="px-6 py-3 bg-transparent text-zinc-300 border border-white/5 rounded-lg font-medium hover:bg-white/5 hover:text-white transition-colors inline-flex items-center gap-2"
        >
          <Github className="w-4 h-4" />
          View Source
        </a>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 0.28, ease: 'easeOut' }}
        className="mt-8 flex flex-wrap items-center justify-center gap-2"
      >
        {trustPills.map((pill) => (
          <span
            key={pill}
            className="inline-flex items-center rounded-full border border-white/8 bg-white/4 px-3 py-1 text-xs font-medium text-zinc-400"
          >
            {pill}
          </span>
        ))}
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.34, ease: 'easeOut' }}
        className="mt-5 flex flex-wrap items-center justify-center gap-2 text-xs text-zinc-400"
      >
        <span className="inline-flex items-center rounded-full border border-white/8 bg-black/20 px-3 py-1">Claude Code · Codex CLI = subscription-backed</span>
        <span className="inline-flex items-center rounded-full border border-white/8 bg-black/20 px-3 py-1">OpenCode = BYOA / API-key-backed</span>
        <span className="inline-flex items-center rounded-full border border-white/8 bg-black/20 px-3 py-1">Pi CLI = provider-authenticated</span>
      </motion.div>

      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 w-[78%] h-[300px] bg-accent/18 blur-[110px] pointer-events-none -z-10 rounded-full" />
    </section>
  );
}
