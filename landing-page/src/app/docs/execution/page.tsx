import type { Metadata } from 'next';
import Link from 'next/link';
import { buildMetadata, SITE_URL } from '@/lib/metadata';

export const metadata: Metadata = buildMetadata({
  title: 'Execution',
  description: 'Execution CLI selection, orchestration modes, run semantics, and surface differences across the dashboard, CLI, TUI, and Pi extension.',
  path: '/docs/execution',
  ogImage: `${SITE_URL}/og/execution.png`,
});

const engineExamples = [
  {
    name: 'Claude Code CLI',
    auth: 'Subscription-backed',
    cmd: 'rorca run zz-my-spec --agent claude',
    notes: 'Best when you want Claude Code as the runtime executor under Rorca orchestration.',
  },
  {
    name: 'Codex CLI',
    auth: 'Subscription-backed',
    cmd: 'rorca run zz-my-spec --agent codex --model gpt-5.4',
    notes: 'Best when you want ChatGPT Plus/Pro-backed CLI execution with explicit model override.',
  },
  {
    name: 'OpenCode',
    auth: 'BYOA / API-key-backed',
    cmd: 'rorca run zz-my-spec --agent opencode --model openai/gpt-4.1',
    notes: 'Best when you want OpenCode’s provider/model bridge as the runtime executor.',
  },
  {
    name: 'Pi CLI',
    auth: 'Provider-authenticated',
    cmd: 'rorca run zz-my-spec --agent pi --model openai-codex/gpt-5.4',
    notes: 'Best when you want Pi CLI execution from the standalone Rorca CLI.',
  },
] as const;

const surfaceMatrix = [
  ['Dashboard', 'Visual agent selector for Claude / OpenCode / Codex in the browser run flow.'],
  ['CLI', 'Explicit --agent and --model overrides through rorca run.'],
  ['TUI', 'Active-agent/model switching inside the embedded terminal UI.'],
  ['Pi extension', 'Pi-native slash commands; run surface chooses Pi execution and Pi model only.'],
] as const;

const orchestrationRows = [
  ['Sequential', 'One story at a time.', 'Best for debugging, risky refactors, flaky repos, or easier-to-reason-about logs.'],
  ['Wave-parallel', 'Run dependency-safe stories concurrently in waves.', 'Best for throughput when the spec graph has real independent branches.'],
] as const;

export default function DocsExecutionPage() {
  return (
    <div className="max-w-5xl">
      <div className="mb-10">
        <p className="text-xs uppercase tracking-[0.24em] text-zinc-500 mb-4">Execution</p>
        <h1 className="text-4xl md:text-5xl font-medium tracking-tight mb-4">Rorca orchestrates. Provider CLIs execute.</h1>
        <p className="text-zinc-400 text-lg leading-relaxed max-w-4xl">
          Execution is the place where users most often blur together product surface, execution engine, and runtime model. Keep them separate: Rorca is the control plane, the user-facing surface is how you trigger and monitor work, and the provider CLI is the actual runtime executor.
        </p>
      </div>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Separate these concepts</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4"><h3 className="font-medium text-white mb-2">Rorca surfaces</h3><p className="text-zinc-400 leading-relaxed">Dashboard, CLI, embedded TUI, Pi extension, and MCP.</p></div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4"><h3 className="font-medium text-white mb-2">Execution CLI engines</h3><p className="text-zinc-400 leading-relaxed">Claude Code, OpenCode, Codex CLI, and Pi CLI are the runtimes that execute stories.</p></div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4"><h3 className="font-medium text-white mb-2">Models</h3><p className="text-zinc-400 leading-relaxed">The runtime model belongs to the selected execution CLI and can differ from forge or memory models.</p></div>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Execution engine examples</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {engineExamples.map((engine) => (
            <div key={engine.name} className="rounded-xl border border-white/10 bg-black/20 p-4">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="text-white font-medium">{engine.name}</div>
                <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">{engine.auth}</div>
              </div>
              <p className="text-sm text-zinc-400 leading-relaxed mb-3">{engine.notes}</p>
              <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{engine.cmd}</code></pre>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Surface capability differences</h2>
        <div className="space-y-3">
          {surfaceMatrix.map(([surface, description]) => (
            <div key={surface} className="rounded-xl border border-white/10 bg-black/20 p-4">
              <div className="text-white font-medium mb-1">{surface}</div>
              <p className="text-zinc-400 leading-relaxed">{description}</p>
            </div>
          ))}
        </div>
        <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-zinc-200 leading-relaxed">
          Important current truth: the <strong className="text-white">Pi extension</strong> is a Pi-native operator surface, but it is not the cross-engine chooser. If you want to pick Claude / Codex / OpenCode explicitly, use the standalone CLI, TUI, dashboard, or backend trigger API.
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Sequential vs wave-parallel</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {orchestrationRows.map(([mode, summary, guidance]) => (
            <div key={mode} className="rounded-xl border border-white/10 bg-black/20 p-4">
              <div className="text-white font-medium mb-2">{mode}</div>
              <p className="text-zinc-300 leading-relaxed mb-2">{summary}</p>
              <p className="text-sm text-zinc-400 leading-relaxed">{guidance}</p>
            </div>
          ))}
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Standalone CLI</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{`rorca run zz-my-spec --sequential
rorca run zz-my-spec --story US-001 --sequential`}</code></pre>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Pi extension</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{`/rorca-run zz-my-spec --workspace rorca --sequential
/rorca-retry 20260316000319 US-001 --sequential`}</code></pre>
          </div>
        </div>
        <ul className="mt-4 space-y-2 text-zinc-300 leading-relaxed">
          <li>Single-story runs are already effectively sequential, but passing a sequential override still makes the operator’s intent explicit.</li>
          <li>Wave-parallel is still the default throughput story when the dependency graph and config allow it.</li>
          <li>When debugging first-story failures, no-code-change exits, or worktree confusion, prefer sequential runs first.</li>
        </ul>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-10">
        <h2 className="text-2xl font-medium mb-4">Which guide to read next?</h2>
        <div className="grid gap-4 lg:grid-cols-3">
          <Link href="/docs/cli" className="rounded-xl border border-white/10 bg-black/20 p-4 hover:border-zinc-700 transition-colors">
            <div className="text-white font-medium mb-2">CLI guide</div>
            <p className="text-zinc-400 leading-relaxed">All important flags, engine examples, forge/run flows, and attach/status patterns.</p>
          </Link>
          <Link href="/docs/tui" className="rounded-xl border border-white/10 bg-black/20 p-4 hover:border-zinc-700 transition-colors">
            <div className="text-white font-medium mb-2">TUI guide</div>
            <p className="text-zinc-400 leading-relaxed">Board mode, live substreams, model picker, recall, and story editing in the embedded terminal UI.</p>
          </Link>
          <Link href="/docs/pi-extension" className="rounded-xl border border-white/10 bg-black/20 p-4 hover:border-zinc-700 transition-colors">
            <div className="text-white font-medium mb-2">Pi extension guide</div>
            <p className="text-zinc-400 leading-relaxed">Install, slash commands, sequential retry, watch/status flows, and execution caveats.</p>
          </Link>
        </div>
      </section>

      <div className="flex flex-wrap gap-3">
        <Link href="/execution" className="px-4 py-2 rounded-lg bg-white text-zinc-950 font-medium hover:bg-zinc-200 transition-colors">Public execution page</Link>
        <Link href="/docs/tools" className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors">Tools index</Link>
      </div>
    </div>
  );
}
