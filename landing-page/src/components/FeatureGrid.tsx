'use client';

import { motion } from 'framer-motion';
import { Layers, BrainCircuit, GitPullRequest, Database } from 'lucide-react';

const FEATURES = [
  {
    icon: Layers,
    title: 'Explicit spec persistence',
    description:
      'A caller or skill drafts the spec, Rorca validates it, and the canonical pending record is saved immediately so the Context tab is never empty.',
  },
  {
    icon: BrainCircuit,
    title: 'Retrieval that learns',
    description:
      'Cached context, memory search, graph traversal, and telemetry work together. The system records what was retrieved and whether it helped.',
  },
  {
    icon: GitPullRequest,
    title: 'Story-by-story execution',
    description:
      'Claude Code, OpenCode, Codex, and Pi all plug into the same Rorca loop. You choose the underlying CLI provider, Rorca attaches to that provider, and it executes approved work one story at a time with that CLI’s native tools.',
  },
  {
    icon: Database,
    title: 'Skills/MCP control plane',
    description:
      'Skills, MCP tools, the dashboard, and the Pi extension all point at the same backend contract. One control plane, many client surfaces.',
  },
];

export function FeatureGrid() {
  return (
    <section className="py-24 px-6 sm:px-12 mx-auto max-w-7xl">
      <div className="mb-14 max-w-3xl">
        <p className="text-sm uppercase tracking-[0.24em] text-zinc-500 mb-4">Why Rorca feels different</p>
        <h2 className="text-3xl sm:text-4xl font-medium tracking-tight text-white mb-4">
          Built around spec truth, retrieval truth, and execution truth.
        </h2>
        <p className="text-zinc-400 text-lg leading-relaxed">
          The site should explain what the product actually does: persist explicit drafts, ground them in backend-native context, and carry the result through execution without losing the thread.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {FEATURES.map((feature, index) => (
          <motion.article
            key={feature.title}
            initial={{ opacity: 0, y: 18 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.45, delay: index * 0.06 }}
            className="group relative bg-surface border border-border rounded-2xl p-7 overflow-hidden transition-colors hover:border-zinc-700"
          >
            <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
            <div className="relative z-10">
              <div className="h-10 w-10 rounded-lg bg-zinc-800/50 border border-white/5 flex items-center justify-center mb-5">
                <feature.icon className="w-5 h-5 text-zinc-300" strokeWidth={1.5} />
              </div>
              <h3 className="text-xl font-medium text-white mb-3 tracking-tight">{feature.title}</h3>
              <p className="text-zinc-400 leading-relaxed text-sm sm:text-base">{feature.description}</p>
            </div>
          </motion.article>
        ))}
      </div>
    </section>
  );
}
