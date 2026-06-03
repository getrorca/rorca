# Rorca Pi Extension Autopilot

This directory contains the durable state and plan for the extension-wide autonomous build loop.

## What it does

`scripts/pi_extension_autopilot.py` runs a multi-phase loop that:
- uses Pi as the implementer
- uses Pi again as a separate reviewer
- runs independent validators outside Pi
- keeps all durable truth on disk so the loop survives compactions
- requires consecutive green cycles before accepting a phase

## Important files

- `extension-autopilot.json` — phase manifest
- `master-goal.md` — global objective and constraints
- `goals/*.md` — phase-specific instructions
- `state.json` — latest autopilot state snapshot
- `journal.jsonl` — append-only cycle history
- `handoffs/*.json` — implementer output per phase
- `reviews/*.json` — reviewer output per phase
- `validations/*.json` — validator snapshots per phase
- `logs/` — implementer/reviewer/validator logs
- `sessions/` — rolled Pi session files
- `dashboard.md` / `dashboard.html` — latest human-readable status

## Default validator intent

The default validator stack includes:
- repo TypeScript check
- backend TypeScript check
- extension TypeScript check
- `scripts/validate_rorca_pi_extension.py` to catch raw-terminal regressions

## Run

```bash
python3 scripts/pi_extension_autopilot.py \
  --provider openai \
  --model gpt-5.4 \
  --thinking high \
  --max-cycles 120
```

## Behavior

A phase only completes when:
- implementer claims it is done
- reviewer independently approves it
- validators pass
- required files exist
- confidence thresholds are met
- the phase passes enough consecutive green cycles

That is the practical approximation here for “implemented and validated without known bugs.”
