# Pi Supervisor

This directory holds the external state for `scripts/pi_supervisor.py`.

Why this exists:
- Pi sessions can compact.
- Long autonomous tasks need durable state outside the conversation.
- The supervisor rehydrates each iteration from files on disk instead of relying on session memory.

## Files

- `goals/*.md` — durable goal documents
- `state.json` — latest supervisor state snapshot
- `handoff.json` — machine-readable handoff written by Pi each iteration
- `last_validation.json` — latest external validator results
- `journal.jsonl` — append-only iteration journal
- `logs/` — Pi outputs + validator logs
- `sessions/` — Pi session files, rolled over periodically

## Usage

From the repo root:

```bash
python3 scripts/pi_supervisor.py
```

With custom validators:

```bash
python3 scripts/pi_supervisor.py \
  --validator "npx tsc --noEmit" \
  --validator "cd backend && npx tsc --noEmit" \
  --validator "cd ~/.pi/agent/extensions/rorca && npx tsc --noEmit"
```

With a specific model/provider:

```bash
python3 scripts/pi_supervisor.py --provider openai --model gpt-5.4 --thinking high
```

With stricter completion gates:

```bash
python3 scripts/pi_supervisor.py \
  --require-file "~/.pi/agent/extensions/rorca/index.ts" \
  --require-file "src/**/Run*.tsx" \
  --minimum-confidence 0.90 \
  --require-clean-git-on-success
```

With git checkpoints and regression rollback (dangerous; opt-in):

```bash
python3 scripts/pi_supervisor.py \
  --git-checkpoints \
  --auto-rollback-on-regression \
  --git-clean-on-rollback
```

## Dashboards

The supervisor also writes:
- `dashboard.md`
- `dashboard.html`

These summarize the latest iteration, validator outcomes, handoff state,
required-file gaps, git state, and any rollback performed.

## Done criteria

The supervisor only exits successfully when:
1. Pi writes `handoff.json` with `done: true`
2. all configured external validators pass
3. `handoff.json.known_bugs` is an empty array
4. all `--require-file` patterns resolve
5. optional strict gates pass (`--minimum-confidence`, `--require-clean-git-on-success`)

That still does **not** prove the absence of unknown bugs. It proves the task has met the declared supervised criteria.
