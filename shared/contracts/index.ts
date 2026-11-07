// ─── Context Intelligence Platform — Shared Contracts ─────────────────────────
//
// Single entry point for the platform's versioned, runtime-validated contracts,
// shared across backend, frontend, and the capture CLI (design doc §6, US-002).
// Each contract is a Zod schema (runtime validator) plus its inferred TS type, so
// one import gives a consumer both `validate()` and a static type.
//
//   import { hydrationRecord, type HydrationRecord } from '../../shared/contracts';
//   const result = hydrationRecord.safeParse(payload);
//
// Every top-level contract carries a `schemaVersion` field (see ./version) so the
// wire format can evolve without silently mis-parsing on either side.
//
// Consumption per runtime:
//   • Frontend — imported directly; the root tsconfig already includes `shared/`
//     and Vite bundles it. No extra wiring.
//   • CLI / bin — imported by relative path; bundler/node resolution, no rootDir
//     constraint.
//   • Backend — these contracts are runtime-compatible (zod-only, no DOM/Node
//     APIs). Backend is a SEPARATE tsc project with `rootDir: "src"` and a flat
//     `backend/dist/` that production (`node dist/server.js`) and `cli.js` depend
//     on, so a backend file must NOT add this root `shared/` source to its own
//     program (that triggers TS6059 and reshapes `backend/dist/`). Backend
//     consuming stories (US-003/US-004 …) wire it as a resolved/built artifact —
//     e.g. a path alias to pre-built declarations plus copying the emitted JS
//     into `backend/dist` (the same pattern migrations use), or a local package.
//
// The contracts themselves are intentionally dependency-light (only `zod`) so any
// of those wiring choices works without code changes here.

export * from './version';
export * from './primitives';
export * from './trust';
export * from './graph';
export * from './hydration';
export * from './retrieval';
export * from './context-bundle';
export * from './context-events';
export * from './memory-candidates';
export * from './review';
export * from './mission';
export * from './source';
