# Lifecycle matrix performance profile

`tests/lifecycle-matrix-performance.spec.ts` is the repeatable acceptance profile for the lifecycle board.

## CI profile

- Playwright project: `chromium` from `playwright.config.ts` (`Desktop Chrome`)
- Dataset: deterministic 50 specs × 11 canonical phases from `src/fixtures/lifecycleMatrix.ts`
- Pagination request: `limit=50`; the mocked server response contains all 50 stable spec IDs
- Run mode: one worker, no retries
- Command (with the normal frontend dev server available on port 5210):

  ```bash
  npx playwright test tests/lifecycle-matrix-performance.spec.ts --project=chromium
  ```

## Budgets

1. **Interactive matrix:** after the lifecycle portfolio response is available, the selected seeded cell, all 50 rows, and all 550 phase controls are interactive within **1,000 ms**.
2. **Existing-cell feedback:** opening `Billing anomaly alerts → Validation` inserts a visible phase drawer within **100 ms**. The test performs one excluded warm-up, then measures 20 open/close runs and requires the slowest run to meet the budget.

The selection fixture is blocked with **2/4 gates passed**, matching the lifecycle wireframe. The drawer opens from URL-backed selection immediately; phase evidence may continue loading inside it.

## Virtualization decision

The matrix intentionally uses an ordinary semantic table. This preserves native table relationships, sticky headers, predictable keyboard movement, and browser search. Add row virtualization only if this Chromium profile fails repeatably after ordinary React/render optimization. A one-off slow developer run is not sufficient evidence to trade away semantics.
