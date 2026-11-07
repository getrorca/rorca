# Wave 3 Redaction Boundary Review Receipt

| Field | Receipt |
|---|---|
| Review date | 2026-08-05 |
| Integration branch | `wave3-integration-20260805` |
| Exact reviewed base commit SHA | `269efa10517f2c18ff3610a1c980f0637b7d5188` |
| Exact swept round-1 packet tree SHA | `6f3872ad7c412ae6fc6b6f46a0e132b0b4ed0f4d` |
| Round-1 packet commit SHA | `e6f8e3d094f3b70f315e13f0b416d7e640eed22a` |
| Round-1 packet tree SHA | `47f0387c1dc0871b64259b61e96f9c83d7ccfc14` |
| Exact swept round-2 packet tree SHA | `6d048c8034995db6a876f1e096c2cc952dbbff55` |
| Round-2 packet commit SHA | `a3739ac1c5a4bf77654bb12430d9ed18b46e7e62` |
| Round-2 packet tree SHA | `6d048c8034995db6a876f1e096c2cc952dbbff55` |
| Final packet commit SHA | `14886502e04e9b8024d3568c970a5c7c1a6159a0` |
| Final packet tree SHA | `efd3de61cdd61187135962cfd1912c59781702aa` |
| Wave 2 prerequisite SHA | `1420fb4c819aad692894da9449bc4958ed74dd49` |
| Review scope | Wave 3B PTY committed-range capture, neutral stream contracts/ingress, persistence/replay, API, generated schemas, and Run View |
| Authority result | No authority widening; activity remains `projectionOnly: true` / `authorityEffect: none` |
| Findings | None |

The round-2 packet tree `6d048c8034995db6a876f1e096c2cc952dbbff55` contains all reviewed code, focused tests, browser journey, generated artifacts, and criterion evidence. The final packet tree `efd3de61cdd61187135962cfd1912c59781702aa` (commit `14886502e04e9b8024d3568c970a5c7c1a6159a0`) differs from the swept tree by exactly the two receipt documents — `git diff --stat 6d048c8034995db6a876f1e096c2cc952dbbff55..14886502e04e9b8024d3568c970a5c7c1a6159a0` lists only `docs/wave3-redaction-review-receipt.md` and `docs/wave3-complete-gate-receipt.md`. Subsequent ledger-only commits reconcile documentation counts (36/36 focused gate) and record review verdicts; no code changed after the sweep.

## Exact sweep commands and results

Static boundary sweep, run from the repository root against the staged remediation working tree:

```sh
node -e "const fs=require('node:fs');const files=['backend/src/lib/execution-engine.ts','backend/src/lib/pty-manager.ts','backend/src/lib/run-pty-store.ts','backend/src/lib/run-activity-projector.ts','backend/src/lib/run-activity-store.ts','backend/src/lib/governed-contracts/run-stream.ts','backend/src/routes/run-activity.ts','src/components/RunActivityView.tsx','packages/rorca-public-contract/schemas/governed-execution/run-stream-envelope.schema.json','packages/rorca-public-contract/schemas/governed-execution/runtime-telemetry-batch.schema.json'];const forbidden=/(rawPrompt|rawTranscript|rawContext|environmentSnapshot|credentialValue|humanAttestation|signatureValue|ordinaryProjectionContainsRaw\\s*[:=]\\s*true|rawPayloadIncluded\\s*[:=]\\s*true)/;const hits=files.flatMap(file=>fs.readFileSync(file,'utf8').split('\\n').flatMap((line,index)=>forbidden.test(line)?[\`${file}:${index+1}\`]:[]));if(hits.length)throw new Error(\`redaction boundary violations: ${hits.join(',')}\`);console.log(\`PASS redaction static sweep: ${files.length} files, 0 forbidden raw/attestation/true-raw projection paths\`);"
```

Result:

```text
PASS redaction static sweep: 10 files, 0 forbidden raw/attestation/true-raw projection paths
```

Round-2 sweep (`a3739ac1c5a4bf77654bb12430d9ed18b46e7e62` / `6d048c8034995db6a876f1e096c2cc952dbbff55`): the exact command above was rerun against the current working tree; result `PASS redaction static sweep: 10 files, 0 forbidden raw/attestation/true-raw projection paths`.

Database/contract/API boundary gate, run through the invocation-owner wrapper with the isolated PG16.14 Docker fallback:

```sh
RORCA_TEST_DATABASE_MODE=docker npm test -- --config jest.config.ts --runInBand --runTestsByPath src/lib/__tests__/run-activity-contracts.test.ts src/lib/__tests__/run-activity-routes.test.ts src/lib/__tests__/run-activity-store.integration.test.ts
```

Result: `3/3` suites and `36/36` tests passed (includes the `/live?tail=true` SSE regression). The store integration includes the full `rorca.run_activity_%` table marker sweep, RLS isolation, restricted pre-persistence redaction, archive-manifest raw-byte exclusion, replay, retention, transaction interruption, generation rollover, and fake-runtime admission checks.

Frontend component and browser commands:

```sh
npx vitest run src/components/__tests__/RunActivityView.test.tsx
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5212 npx playwright test tests/run-activity-journey.spec.ts --project=chromium
```

Results: RunActivityView Vitest `1/1` file, `2/2` tests passed; local headless Chromium journey `1/1` passed in `3.4s`. Backend and frontend TypeScript checks also exited `0`.

## Boundary ledger

| Boundary | Reviewed evidence | Result |
|---|---|---|
| PTY committed-range callback | `pty-manager` and `run-pty-store` preserve exact generation/sequence order, hash only committed contiguous ranges, and call the projector with generation, sequence range, byte count, range hash, and timestamp. | PASS — no PTY bytes enter the callback contract. |
| Execution-engine binding | `execution-engine` loads the exact governed completion context, fails closed when that scope is incomplete, and installs `createPtyRangeProjectionCallback` only for a governed PTY run. | PASS — the callback grants no validation, completion, merge, deploy, or production authority. |
| PTY projection | `run-activity-projector` emits `pty_output_referenced` with `rawBytesIncluded: false`, restricted transcript metadata, and a one-way range hash. | PASS — raw output remains solely in the existing restricted PTY archive. |
| Runtime telemetry admission | `run-stream.ts` whitelists runtime-owned, non-authoritative compaction/settled/retry/candidate-observed/activity kinds. It rejects `story_closeout_observed`, `status_plane_observed`, and all other host-owned kinds from fake-federated telemetry. | PASS — a runtime cannot forge accepted closeout or any of the seven operational planes. |
| Transport semantics | Each transport kind has a matching literal payload state (`opened`, `closed`, `throttled`, or `terminated`). | PASS — semantically mismatched transport state rejects at contract validation. |
| Persistence and replay | `run-activity-store` redacts before material hashing/persistence, uses exact workspace/generation/lease/fence/source bindings, stores sanitized envelopes, and returns a bounded signed replay or durable tail. | PASS — ordinary persistence/replay contains no restricted raw value and cannot cross workspace/generation. |
| Archive and retention | Tombstones and archive manifests retain only integrity hashes, range metadata, and opaque restricted references with `raw_payload_included=false`; pruning excludes canonical evidence/lifecycle rows. | PASS |
| API and SSE | `run-activity` routes require exact membership or the bounded internal runtime credential, expose sanitized pages/state/SSE, disconnect slow clients, and carry explicit non-authority labels. | PASS — errors and cursor resets do not reveal foreign workspace identity or restricted values. |
| Run View UI | `RunActivityView` renders only sanitized envelope metadata, current projection state, and plane provenance/freshness. It never resolves restricted references. Its activity list reads the newest durable 100-event tail. | PASS — noisy PTY and runtime assertions cannot imply completion. |
| Generated contracts | The generated run-stream envelope and runtime-telemetry batch schemas expose bounded references and non-authority fields without raw prompt/transcript/context/environment/credential/attestation properties. | PASS |

The governed-contract manifest/source closure was deterministically regenerated from the reviewed remediated source: drift check PASS across 38 files, all 27 schema file contents unchanged, and public-contract tests `4/4` PASS.

## W3B-008 / W3B-009 browser evidence

`tests/run-activity-journey.spec.ts` drives the real local Run View against a Vite dev server in headless Chromium. It verifies:

- existing noisy PTY output remains available beside the structured lane;
- explicit observability-only and host-closeout authority wording;
- current runtime generation, lease, context, retry, candidate, cancellation, and canonical closeout state;
- independent status planes with source class, source identity, source hash, `observedAt`, and `validUntil`;
- a healthy runtime cannot mask stale queue/outbox state;
- live, disconnect/reconnect, durable-tail refresh replay, gap, cancellation, empty, error, and canonical accepted-completion states.
Result: `1/1 PASS`. Only the canonical accepted closeout fixture renders `story_accepted`; runtime telemetry is unable to submit that event kind.

## Conclusion

No redaction-boundary finding remains open for the final packet commit `14886502e04e9b8024d3568c970a5c7c1a6159a0` (tree `efd3de61cdd61187135962cfd1912c59781702aa`), whose code bytes equal the swept round-2 tree `6d048c8034995db6a876f1e096c2cc952dbbff55` minus the two receipt documents. Restricted material is rejected, redacted before hashing/persistence, or represented only by a bounded opaque integrity reference. PTY/runtime observations cannot settle a story or run and cannot authorize lifecycle, evidence, approval, merge, deployment, or production outcomes.
