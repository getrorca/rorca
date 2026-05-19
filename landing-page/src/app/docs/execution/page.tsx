import type { Metadata } from 'next';
import Link from 'next/link';
import { buildMetadata, SITE_URL } from '@/lib/metadata';

export const metadata: Metadata = buildMetadata({
  title: 'Execution',
  description: 'Rorca surfaces, provider CLIs, Pi distinctions, and phase-specific model usage across the workflow.',
  path: '/docs/execution',
  ogImage: `${SITE_URL}/og/execution.png`,
});

export default function DocsExecutionPage() {
  return (
    <div className="max-w-4xl">
      <p className="text-xs uppercase tracking-[0.24em] text-zinc-500 mb-4">Execution</p>
      <h1 className="text-4xl md:text-5xl font-medium tracking-tight mb-4">Rorca orchestrates. Provider CLIs execute.</h1>
      <p className="text-zinc-400 text-lg leading-relaxed max-w-3xl mb-10">
        The user selects the provider CLI. Rorca automates execution through that provider’s native tools while it handles the spec loop, retrieval, and story-by-story orchestration.
      </p>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Separate these concepts</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4"><h3 className="font-medium text-white mb-2">Rorca surfaces</h3><p className="text-zinc-400 leading-relaxed">Dashboard, CLI, embedded TUI, backend, worker, and MCP contract.</p></div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4"><h3 className="font-medium text-white mb-2">Provider CLIs</h3><p className="text-zinc-400 leading-relaxed">Claude Code, OpenCode, Codex CLI, and Pi CLI are runtime execution surfaces that Rorca attaches to.</p></div>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Pi distinction</h2>
        <p className="text-zinc-300 leading-relaxed mb-3">
          <strong className="text-white">Pi CLI</strong> is an execution provider. <strong className="text-white">The Pi extension</strong> is a separate operator surface with commands and skill-launching UX on top of the same backend contract.
        </p>
        <p className="text-zinc-400 leading-relaxed">
          Public copy should keep those separate instead of using “Pi” as one catch-all word.
        </p>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-10">
        <h2 className="text-2xl font-medium mb-4">Models across the workflow</h2>
        <ul className="space-y-3 text-zinc-300 leading-relaxed">
          <li><strong className="text-white">Planning / spec creation</strong> can use a model chosen for drafting and structure.</li>
          <li><strong className="text-white">Run execution</strong> uses the configured runtime model of the selected provider CLI.</li>
          <li><strong className="text-white">Memory synthesis</strong> can use a cheaper or faster model for summarization and consolidation.</li>
        </ul>
        <p className="text-zinc-400 leading-relaxed mt-4">
          That is the current truth. Per-story cascading should not be the headline story.
        </p>
      </section>

      <div className="flex flex-wrap gap-3">
        <Link href="/execution" className="px-4 py-2 rounded-lg bg-white text-zinc-950 font-medium hover:bg-zinc-200 transition-colors">Public execution page</Link>
        <Link href="/docs/pricing-packaging" className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors">Pricing & packaging</Link>
      </div>
    </div>
  );
}
