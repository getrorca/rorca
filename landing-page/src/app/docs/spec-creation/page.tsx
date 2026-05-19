import type { Metadata } from 'next';
import Link from 'next/link';
import { buildMetadata, SITE_URL } from '@/lib/metadata';

export const metadata: Metadata = buildMetadata({
  title: 'Spec creation',
  description: 'The canonical create-spec contract, compatibility aliases, reliability caveats, and the skill-first flow across clients.',
  path: '/docs/spec-creation',
  ogImage: `${SITE_URL}/og/home.png`,
});

export default function DocsSpecCreationPage() {
  return (
    <div className="max-w-4xl">
      <div className="mb-10">
        <p className="text-xs uppercase tracking-[0.24em] text-zinc-500 mb-4">Spec creation</p>
        <h1 className="text-4xl md:text-5xl font-medium tracking-tight mb-4">Explicit spec persistence is the reliable path.</h1>
        <p className="text-zinc-400 text-lg leading-relaxed max-w-3xl">
          The guaranteed cross-client flow is explicit: retrieve context if needed, draft locally or in-skill, then persist through <code className="text-zinc-300">rorca_create_spec</code> or <code className="text-zinc-300">POST /api/specs/persist</code>. For Rorca-owned surfaces that cannot spawn a local drafter directly, the dashboard uses the shared skill-first forge workflow behind <code className="text-zinc-300">POST /api/specs/forge</code> and <code className="text-zinc-300">POST /api/specs/forge/batch</code>.
        </p>
      </div>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Canonical contract</h2>
        <div className="grid gap-4 md:grid-cols-3 text-sm">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Preferred</div>
            <div className="text-white font-medium mb-2">Explicit draft persistence</div>
            <p className="text-zinc-400 leading-relaxed">Use <code className="text-zinc-300">rorca_create_spec</code> or <code className="text-zinc-300">POST /api/specs/persist</code> when the caller already authored the draft.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Dashboard path</div>
            <div className="text-white font-medium mb-2">Shared skill-first forge</div>
            <p className="text-zinc-400 leading-relaxed">The browser UI and BatchForge use <code className="text-zinc-300">POST /api/specs/forge</code> and <code className="text-zinc-300">POST /api/specs/forge/batch</code>, which draft through the shared skill-first workflow and then persist canonically.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Fallback</div>
            <div className="text-white font-medium mb-2">Legacy backend drafting</div>
            <p className="text-zinc-400 leading-relaxed"><code className="text-zinc-300">rorca_persist_spec</code> remains a compatibility alias for persistence, and <code className="text-zinc-300">rorca_generate_spec</code> / <code className="text-zinc-300">POST /api/specs/generate</code> remain available only when server-side drafting is intentional.</p>
          </div>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="text-2xl font-medium mb-4">Reliability rule</h2>
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-5 text-zinc-200 leading-relaxed">
          Natural-language intent routing can be helpful, but it is not the guaranteed path. If you want reliable cross-client behavior, use an explicit command or tool that forces create-spec persistence.
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Short flow</h2>
        <ol className="space-y-3 text-zinc-300 leading-relaxed list-decimal list-inside">
          <li>Retrieve context if the caller wants more project grounding.</li>
          <li>Draft the spec locally or inside a skill.</li>
          <li>If the caller already has the draft, persist via <code className="text-zinc-300">rorca_create_spec</code> / <code className="text-zinc-300">POST /api/specs/persist</code>.</li>
          <li>If the caller is the dashboard, use the shared skill-first forge path via <code className="text-zinc-300">/api/specs/forge</code> or <code className="text-zinc-300">/api/specs/forge/batch</code>.</li>
          <li>Optionally run enrich, match-skills, and memory synthesis after save.</li>
          <li>Review, approve, and execute the spec through the selected provider CLI.</li>
        </ol>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Important implementation detail</h2>
        <p className="text-zinc-300 leading-relaxed mb-3">
          Persisted explicit drafts now seed generation-log data immediately. That means the UI Context tab is non-null right after persistence instead of waiting for a later server-generated enrich path. The same benefit now applies to dashboard-owned forge flows because they persist through the shared skill-first path rather than a separate legacy browser path.
        </p>
        <p className="text-zinc-400 leading-relaxed">
          Enrich can still append richer context later, but the persisted draft is already a first-class spec the moment it lands.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-2xl font-medium mb-4">Client examples</h2>
        <ul className="space-y-3 text-zinc-300 leading-relaxed">
          <li><strong className="text-white">Dashboard / BatchForge:</strong> use the built-in forge UI. It routes through the shared skill-first backend workflow and persists canonically.</li>
          <li><strong className="text-white">Pi:</strong> use <code className="text-zinc-300">/rorca-create-spec</code>, which dispatches the forge skill and persists explicitly.</li>
          <li><strong className="text-white">Claude Code / other MCP clients:</strong> draft locally or in-skill, then call <code className="text-zinc-300">rorca_create_spec</code>.</li>
          <li><strong className="text-white">Legacy fallback:</strong> if you explicitly want the backend to draft from a brief, use <code className="text-zinc-300">rorca_generate_spec</code>.</li>
        </ul>
      </section>

      <div className="flex flex-wrap gap-3">
        <Link href="/docs/architecture" className="px-4 py-2 rounded-lg bg-white text-zinc-950 font-medium hover:bg-zinc-200 transition-colors">Architecture</Link>
        <Link href="/docs/memory-retrieval" className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors">Memory & retrieval</Link>
      </div>
    </div>
  );
}
