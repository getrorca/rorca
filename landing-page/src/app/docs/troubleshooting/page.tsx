import type { Metadata } from 'next';
import Link from 'next/link';
import { buildMetadata, SITE_URL } from '@/lib/metadata';

export const metadata: Metadata = buildMetadata({
  title: 'Troubleshooting & glossary',
  description: 'Common confusion points around local setup, explicit spec creation, provider selection, and key Rorca terms.',
  path: '/docs/troubleshooting',
  ogImage: `${SITE_URL}/og/home.png`,
});

const glossary = [
  ['Direction Stack', 'Layered project guidance that persists conventions and intent across runs.'],
  ['CAG', 'Cached or carried-forward context that Rorca can reuse before heavier retrieval.'],
  ['RAG', 'Retrieval-augmented context assembled from stored memory or search results.'],
  ['Graph context', 'Relationship-aware context drawn from linked specs, files, and memories.'],
  ['MCP', 'The cross-client tool contract Rorca exposes for explicit control and retrieval actions.'],
  ['Enrich', 'A post-save step that adds more context or structure to a persisted spec.'],
  ['Match-skills', 'A post-save step that suggests or attaches relevant skills for the spec or stories.'],
];

export default function DocsTroubleshootingPage() {
  return (
    <div className="max-w-4xl">
      <p className="text-xs uppercase tracking-[0.24em] text-zinc-500 mb-4">Troubleshooting & glossary</p>
      <h1 className="text-4xl md:text-5xl font-medium tracking-tight mb-4">Answer the real confusion points directly.</h1>
      <p className="text-zinc-400 text-lg leading-relaxed max-w-3xl mb-10">
        Most support friction comes from a few repeated misunderstandings: what runs locally, how explicit spec creation differs from legacy backend generation, how the dashboard forge path works today, and how Rorca surfaces differ from provider CLIs.
      </p>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Quick answers</h2>
        <div className="space-y-4 text-zinc-300 leading-relaxed">
          <p><strong className="text-white">Landing page vs product:</strong> the website is the public Next app; the product is the local dashboard/backend/worker stack plus CLI and TUI.</p>
          <p><strong className="text-white">Explicit create-spec vs dashboard forge:</strong> explicit persistence is the reliable external contract for caller-authored drafts. The dashboard now uses a shared skill-first forge workflow that drafts and then persists canonically through the same backend semantics.</p>
          <p><strong className="text-white">Pi CLI vs Pi extension:</strong> Pi CLI is a runtime provider; the Pi extension is a separate operator surface.</p>
          <p><strong className="text-white">Pi extension commands missing after install:</strong> run <code className="text-zinc-300">rorca pi install</code>, then <code className="text-zinc-300">/reload</code> if Pi was already open. If commands still do not appear, restart Pi.</p>
          <p><strong className="text-white">Why explicit is more reliable:</strong> named tools and commands remove ambiguity that freeform prompts can never fully eliminate. That is why MCP/CLI callers should still prefer <code className="text-zinc-300">rorca_create_spec</code> even though the browser UI now uses the shared skill-first forge path.</p>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-10">
        <h2 className="text-2xl font-medium mb-4">Glossary</h2>
        <div className="space-y-3">
          {glossary.map(([term, definition]) => (
            <div key={term} className="rounded-xl border border-white/10 bg-black/20 p-4">
              <div className="text-white font-medium mb-1">{term}</div>
              <div className="text-zinc-400 leading-relaxed">{definition}</div>
            </div>
          ))}
        </div>
      </section>

      <div className="flex flex-wrap gap-3">
        <Link href="/troubleshooting" className="px-4 py-2 rounded-lg bg-white text-zinc-950 font-medium hover:bg-zinc-200 transition-colors">Public troubleshooting page</Link>
        <Link href="/docs/getting-started" className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors">Getting started</Link>
      </div>
    </div>
  );
}
