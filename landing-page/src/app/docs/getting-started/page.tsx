import type { Metadata } from 'next';
import Link from 'next/link';
import { buildMetadata, SITE_URL } from '@/lib/metadata';

export const metadata: Metadata = buildMetadata({
  title: 'Getting started',
  description: 'Zero to first successful Rorca run: install, add a workspace, configure providers and models, install skills, create a spec, choose stories, and execute safely.',
  path: '/docs/getting-started',
  ogImage: `${SITE_URL}/og/home.png`,
});

const installCommands = [
  'npm install',
  'npm run dev',
] as const;

const prerequisites = [
  'A real local git repository you want Rorca to work against.',
  'Node.js 20+ and npm.',
  'One execution path you can actually use: Claude Code CLI, Codex CLI, OpenCode, or Pi.',
  'Enough patience to connect one provider first instead of configuring everything at once.',
] as const;

const starterOutcome = [
  'the dashboard opens locally',
  'your repo is registered as a workspace',
  'at least one provider/model path is connected',
  'a few useful skills are installed',
  'one spec is drafted and approved',
  'one story or one small spec run completes successfully',
] as const;

const providersTabs = [
  ['Connections', 'Set up execution connections such as Claude CLI, OpenCode CLI, Codex CLI, Pi, Anthropic API, OpenRouter, or OpenAI-compatible endpoints.'],
  ['Workflow Router', 'Control which provider/model should be preferred for different workflow steps.'],
  ['Model Browser', 'Browse the available models and pick the ones you actually want to use.'],
  ['Embeddings', 'Choose the semantic engine used for memory, search, and graph-backed retrieval.'],
  ['Routing', 'Tune model/provider routing behavior when you want more control later.'],
  ['Reasoning', 'Configure reasoning defaults for reasoning-capable models.'],
  ['Display', 'Set display defaults such as the default model shown in UI pickers.'],
] as const;

const providerPaths = [
  ['Claude Code', 'Best if you already use Claude Code locally and want subscription-backed execution.'],
  ['Codex CLI', 'Best if you already use the Codex CLI and want ChatGPT-backed execution.'],
  ['OpenCode', 'Best if you want API-key/BYOA-style provider flexibility.'],
  ['Pi', 'Best if Pi is already part of your workflow and you want Pi-managed provider auth.'],
] as const;

const skillsWays = [
  ['Marketplace → skills.sh', 'Search public skills from the skills.sh registry and install them into your workspace.'],
  ['Marketplace → GitHub', 'Install skill files from a GitHub repo when you already know the source.'],
  ['Marketplace → Custom', 'Paste your own SKILL.md-style content directly into Rorca.'],
  ['Filesystem', 'Drop your own markdown skill files into .rorca/skills/ if you prefer managing them in the repo.'],
] as const;

const briefExample = `Build a docs-only improvement pass for our onboarding flow.

Goals:
- make the first-run path clearer for new users
- explain providers and models in plain English
- explain how skills are installed and matched automatically
- let reviewers exclude stories they do not want yet

Constraints:
- docs only, no product behavior changes
- keep terminology aligned with the dashboard UI`;

const safeFirstRun = [
  'Pick one approved spec.',
  'If it has many stories, exclude the ones you do not want yet.',
  'Run one story first or force sequential mode for the first execution.',
  'Watch the run instead of immediately queueing more work.',
  'If something fails, retry the failed story narrowly instead of rerunning everything.',
] as const;

export default function DocsGettingStartedPage() {
  return (
    <div className="max-w-5xl">
      <div className="mb-10">
        <p className="text-xs uppercase tracking-[0.24em] text-zinc-500 mb-4">Getting started</p>
        <h1 className="text-4xl md:text-5xl font-medium tracking-tight mb-4">Zero to first successful Rorca run.</h1>
        <p className="text-zinc-400 text-lg leading-relaxed max-w-4xl">
          If you are brand new, do not start with MCP details, slash commands, or engine theory. Start in the dashboard. Your day-one goal is simple: connect a repo, connect one provider, add a few skills, create a spec, trim the story list, and run something small successfully.
        </p>
      </div>

      <section className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-3">What success looks like in your first session</h2>
        <ul className="space-y-2 text-zinc-200 leading-relaxed list-disc list-inside">
          {starterOutcome.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Before you start</h2>
        <div className="space-y-4 text-zinc-300 leading-relaxed">
          <p><strong className="text-white">Rorca is a local orchestration layer.</strong> The website explains the product, but your local dashboard, backend, worker/queue path, CLI, and execution engines are the actual runtime.</p>
          <p><strong className="text-white">You do not need every surface on day one.</strong> You can learn the CLI, embedded TUI, Pi extension, and MCP tooling later.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 mt-4">
          {prerequisites.map((item) => (
            <div key={item} className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-zinc-400 leading-relaxed">{item}</div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">1) Start the local app</h2>
        <p className="text-zinc-400 leading-relaxed mb-4">
          For most new users, these are the only two commands needed to get the dashboard up locally:
        </p>
        <div className="rounded-xl border border-white/10 bg-black/30 p-4 font-mono text-sm text-zinc-200 overflow-x-auto">
          {installCommands.map((command) => (
            <div key={command} className="py-1">$ {command}</div>
          ))}
        </div>
        <div className="grid gap-4 md:grid-cols-2 mt-4 text-sm">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-zinc-300 leading-relaxed">
            <div className="text-white font-medium mb-2">What you should see</div>
            <ul className="space-y-1 text-zinc-400">
              <li>Dashboard on <code className="text-zinc-300">localhost:5210</code></li>
              <li>Backend API on <code className="text-zinc-300">localhost:3030</code></li>
              <li>A working local control plane you can operate from the browser</li>
            </ul>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-zinc-300 leading-relaxed">
            <div className="text-white font-medium mb-2">If this is already failing</div>
            <p className="text-zinc-400">Do not keep guessing. Jump to <Link href="/docs/troubleshooting" className="text-white hover:text-zinc-200">troubleshooting</Link> or use the CLI health path later with <code className="text-zinc-300">rorca doctor</code>.</p>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">2) Add your repository as a workspace</h2>
        <div className="space-y-3 text-zinc-300 leading-relaxed">
          <p>A <strong className="text-white">workspace</strong> is Rorca’s unit of execution context. It is where specs, memory, skills, direction, routing, and run history attach.</p>
          <p>Point the workspace at a real local git repository. Once registered, Rorca can read the repo, build context around it, attach skills and memory, and execute stories against it.</p>
          <p><strong className="text-white">Beginner rule:</strong> start with one repo and get one clean run before you add more workspaces.</p>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">3) Connect one provider and one model before trying to run anything</h2>
        <p className="text-zinc-400 leading-relaxed mb-4">
          In the dashboard sidebar, open <strong className="text-white">Execution → Providers &amp; Models</strong>. This is the most important beginner settings page because it defines which execution paths and models are actually available in your local environment.
        </p>
        <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/10 p-4 text-sm text-zinc-200 leading-relaxed mb-4">
          The right beginner move is <strong className="text-white">not</strong> to connect everything. Pick one path you already trust, confirm that models are visible, and get one run working first.
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4 mb-4">
          {providerPaths.map(([title, desc]) => (
            <div key={title} className="rounded-xl border border-white/10 bg-black/20 p-4">
              <div className="text-white font-medium mb-2">{title}</div>
              <p className="text-sm text-zinc-400 leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {providersTabs.map(([title, desc]) => (
            <div key={title} className="rounded-xl border border-white/10 bg-black/20 p-4">
              <div className="text-white font-medium mb-2">{title}</div>
              <p className="text-sm text-zinc-400 leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
        <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-zinc-300 leading-relaxed">
          <strong className="text-white">Minimum success condition:</strong> one execution engine is connected, at least one usable model appears in the browser/pickers, and you understand which path you will use for the first run.
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">4) Install a few skills in the UI</h2>
        <p className="text-zinc-400 leading-relaxed mb-4">
          Skills are reusable instructions and conventions that help Rorca execute stories more intelligently. For new users, the easiest place to manage them is the <strong className="text-white">Marketplace</strong>.
        </p>
        <div className="grid gap-3 md:grid-cols-2 mb-4">
          {skillsWays.map(([title, desc]) => (
            <div key={title} className="rounded-xl border border-white/10 bg-black/20 p-4">
              <div className="text-white font-medium mb-2">{title}</div>
              <p className="text-sm text-zinc-400 leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
        <div className="space-y-3 text-zinc-300 leading-relaxed">
          <p><strong className="text-white">How skill use actually works:</strong> you install skills into the workspace first. Then Rorca suggests and matches relevant skills per story at execution time instead of dumping every skill into every prompt.</p>
          <p><strong className="text-white">What to install first:</strong> a few high-signal skills that match your stack or conventions. Think React, Tailwind, Postgres, testing, docs, security, or team-specific conventions.</p>
          <p><strong className="text-white">If you want deterministic attachment later:</strong> use <strong className="text-white">Context Routing</strong> rules by directory or tag. But you do not need that to get started.</p>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">5) Create your first spec from a plain-English brief</h2>
        <div className="space-y-3 text-zinc-300 leading-relaxed mb-4">
          <p>Once the workspace and provider path are ready, use the dashboard forge flow and describe the work in normal language.</p>
          <p>Rorca’s preferred product-wide path is <strong className="text-white">explicit draft + persist</strong>: you write the brief, the forge flow drafts stories, and you review the result before execution.</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-black/30 p-4">
          <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Example brief</div>
          <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{briefExample}</code></pre>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">6) Review the stories and trim the run before approval</h2>
        <div className="space-y-3 text-zinc-300 leading-relaxed">
          <p><strong className="text-white">Do not blindly run every generated story.</strong> This is one of the most important beginner habits in Rorca.</p>
          <p>During review, check each story’s title, description, acceptance criteria, dependencies, and suggested skills. If a story should wait, mark it excluded/deferred for now.</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-300">
            <li>exclude stories you do not want yet</li>
            <li>bulk include or bulk exclude selections</li>
            <li>approve only after the story list looks sane</li>
            <li>prefer one story first if you are still proving the setup path</li>
          </ul>
        </div>
        <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-zinc-200 leading-relaxed">
          If the generated spec has 20+ stories, your first run should usually be a smaller slice, not the full blast radius.
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">7) Use the safest first-run recipe</h2>
        <p className="text-zinc-400 leading-relaxed mb-4">
          For the first execution, optimize for confidence, not maximum throughput.
        </p>
        <ol className="space-y-3 list-decimal list-inside text-zinc-300 leading-relaxed">
          {safeFirstRun.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-white font-medium mb-2">Sequential</div>
            <p className="text-sm text-zinc-400 leading-relaxed">Best first-run choice when you want fewer concurrency variables, clearer logs, and easier debugging.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-white font-medium mb-2">Wave-parallel</div>
            <p className="text-sm text-zinc-400 leading-relaxed">Best later, once you trust the setup and the stories are genuinely independent.</p>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">8) Watch the run, then retry narrowly</h2>
        <div className="space-y-3 text-zinc-300 leading-relaxed">
          <p>Use the run view and story list to see what passed, what failed, and which skills were active.</p>
          <p>If something fails, do not rerun everything blindly. Retry the failed story or failed subset first. Small safe retries are one of the core Rorca operating habits.</p>
          <p>Once you get one clean small run, then it makes sense to widen scope, try wave-parallel execution, or move into the CLI, TUI, Pi extension, or MCP surfaces.</p>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-10">
        <h2 className="text-2xl font-medium mb-4">If you get stuck</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-white font-medium mb-2">Provider confusion</div>
            <p className="text-sm text-zinc-400 leading-relaxed">Go back to Providers &amp; Models and confirm you connected one real execution path and can actually see usable models.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-white font-medium mb-2">Too much scope</div>
            <p className="text-sm text-zinc-400 leading-relaxed">Exclude more stories and run one story sequentially first.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-white font-medium mb-2">Local health issues</div>
            <p className="text-sm text-zinc-400 leading-relaxed">Use the CLI health path with <code className="text-zinc-300">rorca doctor</code> or read <Link href="/docs/troubleshooting" className="text-white hover:text-zinc-200">troubleshooting</Link>.</p>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-10">
        <h2 className="text-2xl font-medium mb-4">What to learn next</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-white font-medium mb-2">CLI</div>
            <p className="text-sm text-zinc-400 leading-relaxed">Learn this next if you want repeatable commands, flags, doctor checks, and explicit engine control.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-white font-medium mb-2">TUI</div>
            <p className="text-sm text-zinc-400 leading-relaxed">Learn this next if you want a terminal-native board, watch mode, and live substreams.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-white font-medium mb-2">Pi extension</div>
            <p className="text-sm text-zinc-400 leading-relaxed">Learn this next if you already live inside Pi and want Pi-native slash commands for create-spec, run, watch, and retry.</p>
          </div>
        </div>
      </section>

      <div className="flex flex-wrap gap-3">
        <Link href="/docs/spec-creation" className="px-4 py-2 rounded-lg bg-white text-zinc-950 font-medium hover:bg-zinc-200 transition-colors">Spec creation guide</Link>
        <Link href="/docs/execution" className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors">Execution guide</Link>
        <Link href="/docs/tools" className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors">Tools index</Link>
        <Link href="/docs/troubleshooting" className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors">Troubleshooting</Link>
      </div>
    </div>
  );
}
