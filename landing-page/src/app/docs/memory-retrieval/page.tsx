import type { Metadata } from 'next';
import Link from 'next/link';
import { buildMetadata, SITE_URL } from '@/lib/metadata';

export const metadata: Metadata = buildMetadata({
  title: 'Memory & retrieval',
  description: 'How cached context, retrieval, graph context, reranking, telemetry, and feedback work together in Rorca today.',
  path: '/docs/memory-retrieval',
  ogImage: `${SITE_URL}/og/memory.png`,
});

export default function DocsMemoryRetrievalPage() {
  return (
    <div className="max-w-4xl">
      <p className="text-xs uppercase tracking-[0.24em] text-zinc-500 mb-4">Memory & retrieval</p>
      <h1 className="text-4xl md:text-5xl font-medium tracking-tight mb-4">Retrieval is backend-native and client-agnostic.</h1>
      <p className="text-zinc-400 text-lg leading-relaxed max-w-3xl mb-10">
        Rorca’s context path does not belong to Pi, Claude Code, or any single wrapper. The backend decides how cached context, search, graph context, reranking, telemetry, and feedback combine before context reaches a live prompt.
      </p>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Short version</h2>
        <ol className="space-y-3 list-decimal list-inside text-zinc-300 leading-relaxed">
          <li>Start with cached context and the Direction Stack.</li>
          <li>Search for memories only when needed.</li>
          <li>Add graph context when relationship evidence improves the answer.</li>
          <li>Rerank and diversify the final context bundle.</li>
          <li>Record telemetry and feed outcomes back into future retrieval quality.</li>
        </ol>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Long version</h2>
        <div className="rounded-xl border border-white/10 bg-black/20 p-4 font-mono text-sm text-zinc-300 overflow-x-auto mb-4">
          cached context → conditional search → graph context → reranking / diversity → prompt injection → telemetry → outcome feedback
        </div>
        <p className="text-zinc-300 leading-relaxed mb-3">
          The graph matters more than it used to because file-path evidence and memory/spec/file linkage were hardened. That said, ranking weights and decay policies are still heuristic and should continue to be tuned against better eval fixtures.
        </p>
        <p className="text-zinc-400 leading-relaxed">
          That is why the honest claim is “state-of-the-art shaped architecture,” not “state-of-the-art measured performance already proven everywhere.”
        </p>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-10">
        <h2 className="text-2xl font-medium mb-4">Operator visibility</h2>
        <p className="text-zinc-300 leading-relaxed mb-3">
          Retrieval telemetry and feedback are exposed through an operator route:
        </p>
        <div className="rounded-xl border border-white/10 bg-black/20 p-4 font-mono text-sm text-zinc-300">GET /api/graph/retrieval-telemetry</div>
        <p className="text-zinc-400 leading-relaxed mt-4">
          The current visibility surface is backend/operator-focused. A richer dashboard layer can be built on top of it, but the data path already exists.
        </p>
      </section>

      <div className="flex flex-wrap gap-3">
        <Link href="/memory" className="px-4 py-2 rounded-lg bg-white text-zinc-950 font-medium hover:bg-zinc-200 transition-colors">Public memory page</Link>
        <Link href="/docs/spec-creation" className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors">Spec creation docs</Link>
      </div>
    </div>
  );
}
