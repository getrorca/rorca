import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { buildMetadata, SITE_URL } from '@/lib/metadata';

export const metadata: Metadata = buildMetadata({
  title: 'Architecture',
  description: 'Direction Stack, spec lifecycle, skill-first MCP control plane, and backend ownership boundaries.',
  path: '/docs/architecture',
  ogImage: `${SITE_URL}/og/architecture.png`,
});

export default function DocsArchitecturePage() {
  return (
    <div className="max-w-4xl">
      <p className="text-xs uppercase tracking-[0.24em] text-zinc-500 mb-4">Architecture</p>
      <h1 className="text-4xl md:text-5xl font-medium tracking-tight mb-4">Rorca is a control plane, not just a wrapper.</h1>
      <p className="text-zinc-400 text-lg leading-relaxed max-w-3xl mb-10">
        The core story is not “three execution engines.” It is a spec-first orchestration model with explicit persistence, a Direction Stack, backend-native retrieval, and story-by-story execution through the provider CLI the operator selected.
      </p>

      <figure className="mb-10 overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/70 p-2 shadow-2xl shadow-black/30">
        <Image
          src="/diagrams/rorca-linear-flow-clean-icons-aqua.png"
          alt="Linear diagram showing Rorca surfaces creating canonical specs, executing queued stories, and feeding run evidence back into memory and graph retrieval."
          width={2400}
          height={1350}
          priority
          sizes="(min-width: 1024px) 896px, 100vw"
          className="h-auto w-full rounded-xl"
        />
        <figcaption className="px-3 pb-2 pt-3 text-sm text-zinc-500">
          The same loop powers the dashboard, CLI/TUI, MCP tools, Pi extension, and provider-backed execution runtimes.
        </figcaption>
      </figure>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">The four moving parts</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4"><h3 className="font-medium text-white mb-2">Direction Stack</h3><p className="text-zinc-400 leading-relaxed">Persistent engineering context layered from broad rules down to spec and story intent.</p></div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4"><h3 className="font-medium text-white mb-2">Spec lifecycle</h3><p className="text-zinc-400 leading-relaxed">Brief or draft → persisted pending spec → review and approval → execution → feedback and memory updates.</p></div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4"><h3 className="font-medium text-white mb-2">Skill-first MCP</h3><p className="text-zinc-400 leading-relaxed">Skills can draft, judge, or operate. MCP is the cross-client contract that persists or mutates the spec state.</p></div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4"><h3 className="font-medium text-white mb-2">Backend-native retrieval</h3><p className="text-zinc-400 leading-relaxed">Memory, search, graph context, reranking, telemetry, and feedback live in the backend rather than in one client wrapper.</p></div>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="text-2xl font-medium mb-4">Skill-first create-spec flow</h2>
        <div className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 font-mono text-sm text-zinc-300 overflow-x-auto">
          local draft / in-skill draft → rorca_create_spec → POST /api/specs/persist → review → approve → execute
        </div>
        <p className="text-zinc-400 leading-relaxed mt-4">
          For Rorca-owned surfaces like the dashboard and BatchForge, the browser now uses the shared skill-first forge workflow behind <code className="text-zinc-300">/api/specs/forge</code> and <code className="text-zinc-300">/api/specs/forge/batch</code>. Those routes still end in the same canonical persistence semantics rather than a separate UI-only forge brain.
        </p>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-10">
        <h2 className="text-2xl font-medium mb-4">Ownership boundaries</h2>
        <ul className="space-y-3 text-zinc-300 leading-relaxed">
          <li><strong className="text-white">Skills</strong> plan, critique, or draft. They are not the primitive graph or storage layer.</li>
          <li><strong className="text-white">MCP</strong> is the cross-client control surface for explicit mutations and retrieval calls.</li>
          <li><strong className="text-white">The backend</strong> owns spec persistence, retrieval, graph context, telemetry, feedback, and the shared forge workflow used by the dashboard when a local drafter is not directly available.</li>
          <li><strong className="text-white">Provider CLIs</strong> remain the runtime tools Rorca attaches to during execution.</li>
        </ul>
      </section>

      <div className="flex flex-wrap gap-3">
        <Link href="/architecture" className="px-4 py-2 rounded-lg bg-white text-zinc-950 font-medium hover:bg-zinc-200 transition-colors">Public architecture page</Link>
        <Link href="/docs/execution" className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors">Execution docs</Link>
        <Link href="/docs/memory-retrieval" className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors">Memory docs</Link>
      </div>
    </div>
  );
}
