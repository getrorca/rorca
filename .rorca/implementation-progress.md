# Implementation Progress

## Task
Remove fixed acceptance-criteria count guidance from spec-generation prompts/personas so the model can choose the right count naturally.

## Plan
1. Update prompt/persona language to remove numeric AC targets/caps.
2. Remove quick-run AC truncation if present.
3. Update tests that assert the old cap text.
4. Run targeted backend tests and typecheck.

## Status
Complete.

## What changed
- Replaced fixed AC-count prompts with open-ended guidance across spec generation paths.
- Removed quick-run truncation of acceptance criteria.
- Updated persona guidance to stop enforcing numeric AC ranges.
- Updated the quick-run test to match the new prompt.

## Validation
- `cd backend && npx jest src/routes/__tests__/pipeline.quickrun.test.ts --runInBand` ✅
- `cd backend && npx tsc --noEmit` ✅

## Notes
- No hard numeric cap remains in the generation prompts/quick-run path.
