import type { Metadata } from 'next';
import Link from 'next/link';
import { buildMetadata, SITE_URL } from '@/lib/metadata';

export const metadata: Metadata = buildMetadata({
  title: 'TUI guide',
  description: 'In-depth guide to the embedded Rorca terminal UI: board, live streams, workspace switching, model picker, story editing, and watch flows.',
  path: '/docs/tui',
  ogImage: `${SITE_URL}/og/home.png`,
});

const boardKeys = [
  ['Arrow keys', 'Move the board selection across Pending, Approved, and Running/Done columns.'],
  ['r', 'Run the selected approved spec.'],
  ['a', 'Approve the selected pending spec.'],
  ['w', 'Watch the selected active run from the board.'],
  ['Enter', 'Watch the selected active run.'],
  ['Esc', 'Leave the board and return to the main forge/output view.'],
] as const;

const liveKeys = [
  ['Esc', 'Open the board while a run is active.'],
  ['b', 'Return from the live stream to the board.'],
  ['Tab', 'Cycle between combined run output and story substreams.'],
  ['0', 'Select the combined run stream.'],
  ['1-9', 'Select a specific story stream when available.'],
  ['Ctrl+C', 'Open the cancel prompt for the active run.'],
] as const;

const modelKeys = [
  ['↑ / ↓', 'Move through available Pi models.'],
  ['Enter', 'Switch the TUI to the selected Pi model.'],
  ['c', 'Switch active execution agent to Claude.'],
  ['o', 'Switch active execution agent to OpenCode.'],
  ['d', 'Switch active execution agent to Codex.'],
  ['Esc', 'Close the model picker.'],
] as const;

const storyEditorKeys = [
  ['Tab', 'Move between story editor fields.'],
  ['PgUp / PgDn', 'Move between stories while editing.'],
  ['Enter', 'Save the current edit or confirm the current field action.'],
  ['s', 'Save all dirty story edits.'],
  ['Esc', 'Discard the editor view and return.'],
] as const;

const commandPaletteActions = [
  ['run <spec-slug>', 'Trigger an approved spec from inside the TUI.'],
  ['approve <spec-slug>', 'Approve a pending spec.'],
  ['attach <runId>', 'Attach to a live run when you know the numeric id.'],
  ['models', 'Open the model picker and active-agent controls.'],
  ['board', 'Open the Kanban-style board view.'],
] as const;

function ShortcutGrid({ items }: { items: readonly (readonly [string, string])[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {items.map(([key, desc]) => (
        <div key={key} className="rounded-xl border border-white/10 bg-black/20 p-4">
          <div className="text-white font-mono text-sm mb-1">{key}</div>
          <p className="text-sm text-zinc-400 leading-relaxed">{desc}</p>
        </div>
      ))}
    </div>
  );
}

export default function DocsTuiPage() {
  return (
    <div className="max-w-5xl">
      <div className="mb-10">
        <p className="text-xs uppercase tracking-[0.24em] text-zinc-500 mb-4">TUI guide</p>
        <h1 className="text-4xl md:text-5xl font-medium tracking-tight mb-4">The TUI is the fastest local operator cockpit.</h1>
        <p className="text-zinc-400 text-lg leading-relaxed max-w-4xl">
          Use <code className="text-zinc-300">rorca tui</code> when you want board, forge, watch, live run output, model switching, recall, and story editing in one keyboard-first interface. It sits on the same backend contract as the dashboard and CLI, but keeps the whole operator loop inside the terminal.
        </p>
      </div>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Launch + mental model</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Launch</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{`rorca tui`}</code></pre>
            <p className="mt-3 text-sm text-zinc-400 leading-relaxed">The TUI resolves the current workspace from your current working directory. Start it from the repo or workspace you intend to operate on.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Core regions</div>
            <ul className="space-y-2 text-sm text-zinc-400 leading-relaxed">
              <li><strong className="text-white">Left pane:</strong> forge status, board, model picker, recall, story editor, and generated-spec review states.</li>
              <li><strong className="text-white">Right pane:</strong> live run output, raw output, semantic lines, and story substreams.</li>
              <li><strong className="text-white">Footer:</strong> context-aware key help based on the current mode.</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">What the TUI can do today</h2>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="text-white font-medium mb-2">Forge specs</div><p className="text-zinc-400 leading-relaxed">Draft a spec, review generated stories, save as pending, or approve and run immediately.</p></div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="text-white font-medium mb-2">Operate the board</div><p className="text-zinc-400 leading-relaxed">Approve pending specs, run approved specs, and watch active runs from a Kanban-style board.</p></div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="text-white font-medium mb-2">Attach to live runs</div><p className="text-zinc-400 leading-relaxed">Watch combined output, switch to story-level substreams, and keep following progress without leaving the terminal.</p></div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="text-white font-medium mb-2">Switch agent + model</div><p className="text-zinc-400 leading-relaxed">Open the model picker, browse Pi models, and switch active execution agent among Claude, OpenCode, Codex, and Pi.</p></div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="text-white font-medium mb-2">Recall memory</div><p className="text-zinc-400 leading-relaxed">Search recent memories, inspect rules and titles, and add new operator notes through the recall form.</p></div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="text-white font-medium mb-2">Edit stories</div><p className="text-zinc-400 leading-relaxed">Review story drafts, change titles and complexity, and save story edits without leaving the TUI.</p></div>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Board mode</h2>
        <p className="text-zinc-300 leading-relaxed mb-4">
          The board is the highest-leverage TUI mode when you are actively operating specs. It groups specs into Pending, Approved, and Running/Done columns, keeps the current selection, and lets you approve, run, or watch directly from the keyboard.
        </p>
        <ShortcutGrid items={boardKeys} />
        <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-4">
          <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Operator pattern</div>
          <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{`rorca tui
# open board
# arrows -> choose spec
# a -> approve pending spec
# r -> run approved spec
# w or Enter -> watch active run`}</code></pre>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Live run mode</h2>
        <p className="text-zinc-300 leading-relaxed mb-4">
          When a run is active, the TUI hydrates a foreground run state, connects WAL + raw output streams, and lets you watch the combined run or individual story streams. This is the terminal equivalent of the dashboard run view, with better keyboard ergonomics.
        </p>
        <ShortcutGrid items={liveKeys} />
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Attach to a running spec from the board</div>
            <p className="text-sm text-zinc-400 leading-relaxed">Use <code className="text-zinc-300">w</code> or <code className="text-zinc-300">Enter</code> on a running/done board item.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Attach by run id</div>
            <p className="text-sm text-zinc-400 leading-relaxed">Use the command palette action for <code className="text-zinc-300">attach &lt;runId&gt;</code> when you already know the run id.</p>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Command palette actions</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {commandPaletteActions.map(([cmd, desc]) => (
            <div key={cmd} className="rounded-xl border border-white/10 bg-black/20 p-4">
              <code className="block text-sm text-white font-mono break-words">{cmd}</code>
              <p className="mt-2 text-sm text-zinc-400 leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Model picker + agent switching</h2>
        <p className="text-zinc-300 leading-relaxed mb-4">
          The TUI exposes a model picker and active-agent switcher. It can switch the active execution agent to Claude, OpenCode, Codex, or Pi, and it can browse Pi models directly. This is one of the main reasons to use the TUI when you want a terminal-native but still visual execution surface.
        </p>
        <ShortcutGrid items={modelKeys} />
        <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-zinc-200 leading-relaxed">
          Current caveat: the TUI has strong active-agent/model controls, but docs should not overstate it as a perfect per-run parity surface with every CLI flag. The safest explicit per-run overrides today remain the standalone CLI and backend trigger API.
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Forge + generated spec review</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-white font-medium mb-2">Generated spec actions</div>
            <p className="text-zinc-400 leading-relaxed">After forge completes, the TUI can show the generated slug and stories, let you save as pending, edit stories, or approve and run immediately.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-white font-medium mb-2">Story editor</div>
            <p className="text-zinc-400 leading-relaxed">The story editor is meant for compact corrective passes: title cleanup, complexity changes, and save-all handling before you re-run or approve.</p>
          </div>
        </div>
        <div className="mt-4">
          <ShortcutGrid items={storyEditorKeys} />
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Sequential vs wave-parallel in the TUI</h2>
        <p className="text-zinc-300 leading-relaxed mb-4">
          The TUI is still using the same backend run/orchestration system as the CLI and dashboard. That means orchestration mode still comes from the dependency graph and backend rules. When you use the board or TUI run actions, think of the TUI as an operator shell over the same orchestration engine, not a separate scheduler.
        </p>
        <ul className="space-y-2 text-zinc-300 leading-relaxed">
          <li><strong className="text-white">Sequential</strong> is the safer debugging choice when you want a simpler story-by-story flow.</li>
          <li><strong className="text-white">Wave-parallel</strong> is what you want when the spec graph has independent branches and throughput matters more than minimizing concurrency variables.</li>
          <li><strong className="text-white">Watch the live substreams</strong> if you want to understand how parallel waves are behaving story by story.</li>
        </ul>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-10">
        <h2 className="text-2xl font-medium mb-4">When to choose the TUI vs other surfaces</h2>
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="text-white font-medium mb-2">Use the TUI when…</div><p className="text-zinc-400 leading-relaxed">you want board, watch, recall, story editing, and live output in one terminal-native loop.</p></div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="text-white font-medium mb-2">Use the CLI when…</div><p className="text-zinc-400 leading-relaxed">you want the clearest explicit flags, shell scripting, and copy-paste repeatability.</p></div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="text-white font-medium mb-2">Use the Pi extension when…</div><p className="text-zinc-400 leading-relaxed">you are already inside Pi and want slash-command workflows without leaving that session.</p></div>
        </div>
      </section>

      <div className="flex flex-wrap gap-3">
        <Link href="/docs/cli" className="px-4 py-2 rounded-lg bg-white text-zinc-950 font-medium hover:bg-zinc-200 transition-colors">CLI guide</Link>
        <Link href="/docs/pi-extension" className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors">Pi extension guide</Link>
        <Link href="/docs/tools" className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors">Tools index</Link>
      </div>
    </div>
  );
}
