# LFC-028 Lifecycle visual review

Date: 2026-07-15

## Authoritative layout sources

Compared against both required UI sources:

- `docs/diagrams/rorca-ssdlc-lifecycle-board-wireframe.excalidraw`
- `docs/diagrams/rorca-ssdlc-lifecycle-board-wireframe.png`

The runtime sequence diagram was not used as a layout source. Runtime contracts remain authoritative where fixture wording differs from the wireframe.

## Review matrix

The stable capture contract is `src/fixtures/lifecycleVisualRegression.ts`. It defines every required state in light theme with reduced motion at 1440×900, 1024×768, and 390×844, plus desktop dark-theme parity for default, blocked drawer, retry preview, empty, loading, recoverable error, and stale states. It also adds the permission-restricted state required by the operational-state acceptance criterion. CI or a human capture session must use each fixture's `screenshot` path verbatim so baseline names remain deterministic.

| Area | Source intent | Implementation comparison | Result |
| --- | --- | --- | --- |
| Header/context | Compact Lifecycle identity and visible workspace | 72 px header, truncation with full title, high-contrast workspace context | Match |
| KPIs/controls | One restrained summary band above filters | Six compact cards, tabular counts, wrapping controls, subtle refresh status | Match |
| Matrix | Pinned identity/header, quiet rules, all phases, selected blocked 2/4 cell | Sticky phase row and spec column, 11 phases in horizontal scroll, visible status text/icons, gate fractions, strong selected ring | Match |
| Phase detail | Board retained on desktop; 420–520 px drawer | Shared 520 px SlideOver, non-modal desktop board, full-screen tablet/mobile sheet | Match |
| Detail hierarchy | State, blocker, and next safe action precede traceability | Current-state card is first; required evidence remains expanded; normalized payload and liveness classifier evidence use disclosure | Match |
| Governed actions | Exact retry/override/approval consequence before commit | Full-screen mobile modal, sticky close/actions, exact scope/policy, explicit confirmation, no inferred authority | Match |
| Feedback | Calm semantic tints and quick, restrained response | Tokenized 140–150 ms ease-out, reduced-motion override, static geometry skeleton, no Lifecycle glass/gradient/heavy shadow | Match |
| Exceptional states | Clear explanation and one next action; no fake zeroes | Empty, zero-filter, permission, adapter, stale refresh, and recoverable error states are distinct | Match |

## Viewport and zoom checks

- **1440×900:** KPIs, controls, matrix, selected cell, 520 px drawer, sticky actions, and legend retain distinct hierarchy. The matrix scroll region bounds long portfolios without moving its phase header.
- **1024×768:** controls wrap in document order; the matrix keeps its pinned spec column and horizontal phase access; Lifecycle opts into the shared full-screen tablet sheet.
- **390×844:** the pinned identity column is capped at 220 px and 56 viewport-width units, leaving a visible phase edge as a scroll cue even under text zoom; all 11 phases remain in the table; drawer and governed dialog fill `100dvh` with persistent close and permitted actions.
- **200% zoom/text scaling:** labels use wrapping or deterministic ellipsis with full accessible text. No essential Lifecycle copy is below 12 CSS px, and primary controls do not have fixed text-height clipping.
- **Dark theme:** the same semantic variables remain available with AA-oriented muted text, focus, and status colors; light remains the default review theme.

## Discrepancies found and resolved

| Severity | Discrepancy | Resolution |
| --- | --- | --- |
| P0 | Nested drawer/modal focus traps could steal Tab or process one Escape twice | Parent traps now defer to the active nested modal; modal Escape cancels only the governed action and focus restoration remains deterministic |
| P1 | Blocker and next action appeared after traceability detail | Moved both into the first drawer content card |
| P1 | Selected semantic cells could have their selection fill overridden by status CSS | Moved selected-state precedence after semantic status rules |
| P1 | Governed dialogs were not full-screen at 390 px and used heavy elevation | Added Lifecycle-specific `100dvh` sheet composition and minimal token-derived elevation |
| P1 | Some metadata rendered at 10–11 CSS px | Raised all Lifecycle essential and metadata copy to at least 12 CSS px |
| P1 | Initial theme defaulted to dark despite light-first review target | Default and pre-hydration tokens now resolve to light while preserving explicit dark mode |
| P1 | Adapter and permission failures were presented as a generic recoverable error | Added deterministic explanations and appropriate next actions without rendering KPI zeroes |
| P2 | Passed cells created a broad semantic color wall | Removed the passed fill; retained icon and visible status copy |
| P2 | Loading matrix represented only six phases and used a decorative shimmer | Skeleton now reserves the complete 11-phase geometry with static neutral blocks |

## Human visual QA handoff

Use the 36 light-theme entries in `LIFECYCLE_VISUAL_FIXTURES` and seven entries in `LIFECYCLE_DARK_VISUAL_FIXTURES` as the sign-off checklist. At browser 200% zoom, repeat default, blocked drawer, retry preview, and mobile navigation; required actions must remain visible and the page must not gain two-dimensional scrolling outside the intentionally horizontal matrix.

Reject a baseline for any item in `LIFECYCLE_VISUAL_QA_REJECTIONS`: placeholder copy, uneven spacing, clipped labels, layout shift, nested-card clutter, heavy shadows, uncontrolled gradients, low-contrast status tints, or ambiguous primary actions. Also reject ambiguous icon-only state, hidden close/action controls, or a mismatched selected cell. Any screenshot delta must be reviewed against both UI sources above rather than the runtime sequence diagram.
