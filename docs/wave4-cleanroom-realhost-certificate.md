# Wave 4 Real-Host Clean-Room Reconstruction Certificate (W4-014)

| Field | Receipt |
|---|---|
| Date | 2026-08-06T05:16:51.608Z |
| Exact reconstructed source SHA | `a3efe85b701ba35030c399fc4ba0e684c4638298` (HARD-PINNED reviewed Wave 4 code head; no override accepted) |
| Migration manifest | 282 files, hash `sha256:430ba55b55c244488ecb9ad804fba642ec74fb4ccb21fc626d2aa3d23e0cc404` |
| Ledger commits verified | `305df00144c15a498a69857e279edcbf4ea14233`, `bdcc1ce28efcf1cdd714781b04a6e70ca1271e5b` (cat-file -t) |
| Git object backup hash (declared input) | `sha256:fcbfcaa059e64af15c34a3e384e8391ae5a0d00df6649f399427c5714a5f1f8e` (git rev-list --objects --all) |
| PostgreSQL logical backup hash | bound per lane inside the verify_backup_ledger observation (pg_dump | sha256) |
| Contract manifest hash | `sha256:26534fb1551fb6fc5e2b7ebd5b568f2698cc2189cf9f059ba8dcdd42d4ac7d32` |
| Spec hash | `sha256:6c67ac5993d7de4a95ed82b7ab0d2a7c68fb98ae5bc17bc7d3f3ef65938e20cd` |
| Policy / configuration hashes | `sha256:6c67ac5993d7de4a95ed82b7ab0d2a7c68fb98ae5bc17bc7d3f3ef65938e20cd` / `sha256:6b3731331564d2034356e5adb10abd7b5b1fb6e7647e64647a9d54ea7492ff78` |
| Toolchain (recorded inputs) | node v22.19.0; Docker version 29.3.0, build 5927d80c76; git version 2.50.1 (Apple Git-155); postgres image rorca-postgres:pg16-age; symlinked external node_modules (MUTABLE tool input; content hash sha256:8689497d03d22d2ec0816d04240f6c26b390f3977f978f68dd2b4040cd55466e); root lock `sha256:bbc9fd591358af4739190ce62169482e26f2c2f248abeacdeafab406b6deaa6e`; backend lock `sha256:37b41a9ffef116e2b8e92ff18f6ac639c3f312f4376c04f7d0394b8a330804cf` |
| Execution environment | sanitized allowlisted child env (PATH/HOME/LANG/TZ only + explicit command vars); migrations run as a distinct constrained migration role |
| Environment class | real_isolated_host (per-lane fresh bare clone + worktree + PG16 container) |
| Lane-specific pilot code paths | exercised by the W4-009 conformance suites (real HTTP/TLS/DB); this certificate verifies the shared reconstruction inputs and fresh-host properties |

## Certificates

```json
[
  {
    "schemaVersion": "rorca.clean-room-certificate.v1",
    "lane": "managed",
    "namespaceId": "rorca-cleanroom-managed-6962abbab37969a7",
    "environmentClass": "real_isolated_host",
    "sourceSha": "a3efe85b701ba35030c399fc4ba0e684c4638298",
    "certificateHash": "sha256:67fd6dfc7533f162a074dab8eb6941b2af9f380e2565c44b0bb684a86c3ed206",
    "unresolvedBlockers": [],
    "statusPlanes": {
      "source_config_drift": "healthy",
      "dependency_health": "degraded",
      "runtime_health": "healthy",
      "queue_outbox_freshness": "healthy",
      "lease_retry_recovery": "healthy",
      "observability_freshness": "healthy",
      "provider_operations_readiness": "healthy"
    }
  },
  {
    "schemaVersion": "rorca.clean-room-certificate.v1",
    "lane": "fake_federated",
    "namespaceId": "rorca-cleanroom-fake_federated-69d992c049a5181d",
    "environmentClass": "real_isolated_host",
    "sourceSha": "a3efe85b701ba35030c399fc4ba0e684c4638298",
    "certificateHash": "sha256:ddf1586de985694db82b79e31081de38bdbec3963e712895d721e8e61b5c36b5",
    "unresolvedBlockers": [],
    "statusPlanes": {
      "source_config_drift": "healthy",
      "dependency_health": "degraded",
      "runtime_health": "healthy",
      "queue_outbox_freshness": "healthy",
      "lease_retry_recovery": "healthy",
      "observability_freshness": "healthy",
      "provider_operations_readiness": "healthy"
    }
  }
]
```

## Executed steps (per lane)

- [managed] verify_source_sha: verified (executed verifier host:rorca-cleanroom:managed; observed sha256:f6a7876ec60c1ae9bb771a4dd9b9625e5c5e367659dbf4117fbcd7538f32e58e)
- [managed] apply_migrations: verified (executed verifier host:rorca-cleanroom:managed; observed sha256:64e4361f9ffc479561612afd8dd5349c6a30b1fc471a2aa69e106065fe629401)
- [managed] verify_backup_ledger: verified (executed verifier host:rorca-cleanroom:managed; observed sha256:f82759281071d2223d5f1ef7ac89954fd7bcfda3ac7fed1568088c7a684dbc69)
- [managed] verify_public_contract_generation: verified (executed verifier host:rorca-cleanroom:managed; observed sha256:6a2961767df8cd9a0c1f9d0a7287ecabb7cfca30306bf3186db47574bdb0b058)
- [managed] reconcile_inventory: verified (executed verifier host:rorca-cleanroom:managed; observed sha256:940b1965261966285c6913ab700b7729497b6523ea7b55e090c8fb65c4fc5b4b)
- [managed] recover_queue_outbox: verified (executed verifier host:rorca-cleanroom:managed; observed sha256:d6d68322d448a633d25fc2efbb55e62b0925a9aafc3e5d0cb7b33a66fbe2a1ea)
- [managed] scan_lease_fence_retry: verified (executed verifier host:rorca-cleanroom:managed; observed sha256:5f3b88555c9126435ebb11a1dbb2c913a86245aba1830a4c667f2f6f90b6454d)
- [managed] verify_artifacts: verified (executed verifier host:rorca-cleanroom:managed; observed sha256:f76a5e56b17f69fac5b12de6dfb6d71d481bf729273e62f75b3b5b8709998bd7)
- [managed] verify_context_continuation: verified (executed verifier host:rorca-cleanroom:managed; observed sha256:76eb3899547dfb9bfbbede137e6a586d00a1b980506fbd6ac6ca0263bf93e5d6)
- [managed] observe_seven_status_planes: verified (executed verifier host:rorca-cleanroom:managed; observed sha256:c382db2ffac75f984b6656154e927ab67075e75839eb6aaea796ed2acbae3e67)
- [managed] verify_optional_dependency_degradation: verified (executed verifier host:rorca-cleanroom:managed; observed sha256:5ce0b4ac769ddf48fdf66e4ef6a21f5766a2fdb0276c186f07f7eeb470cb3382)
- [managed] cleanup: verified (executed verifier host:rorca-cleanroom:managed; observed sha256:9186513030cc6ca58d49df198278a6071de6dab2252e259ee7a1355cf7b852ee)
- [fake_federated] verify_source_sha: verified (executed verifier host:rorca-cleanroom:fake_federated; observed sha256:f6a7876ec60c1ae9bb771a4dd9b9625e5c5e367659dbf4117fbcd7538f32e58e)
- [fake_federated] apply_migrations: verified (executed verifier host:rorca-cleanroom:fake_federated; observed sha256:64e4361f9ffc479561612afd8dd5349c6a30b1fc471a2aa69e106065fe629401)
- [fake_federated] verify_backup_ledger: verified (executed verifier host:rorca-cleanroom:fake_federated; observed sha256:2e388b598b0f54ceb9f1a5a9b454a994d8e0d5744508b1f34476cae55cabddb4)
- [fake_federated] verify_public_contract_generation: verified (executed verifier host:rorca-cleanroom:fake_federated; observed sha256:6a2961767df8cd9a0c1f9d0a7287ecabb7cfca30306bf3186db47574bdb0b058)
- [fake_federated] reconcile_inventory: verified (executed verifier host:rorca-cleanroom:fake_federated; observed sha256:940b1965261966285c6913ab700b7729497b6523ea7b55e090c8fb65c4fc5b4b)
- [fake_federated] recover_queue_outbox: verified (executed verifier host:rorca-cleanroom:fake_federated; observed sha256:d6d68322d448a633d25fc2efbb55e62b0925a9aafc3e5d0cb7b33a66fbe2a1ea)
- [fake_federated] scan_lease_fence_retry: verified (executed verifier host:rorca-cleanroom:fake_federated; observed sha256:5f3b88555c9126435ebb11a1dbb2c913a86245aba1830a4c667f2f6f90b6454d)
- [fake_federated] verify_artifacts: verified (executed verifier host:rorca-cleanroom:fake_federated; observed sha256:f76a5e56b17f69fac5b12de6dfb6d71d481bf729273e62f75b3b5b8709998bd7)
- [fake_federated] verify_context_continuation: verified (executed verifier host:rorca-cleanroom:fake_federated; observed sha256:76eb3899547dfb9bfbbede137e6a586d00a1b980506fbd6ac6ca0263bf93e5d6)
- [fake_federated] observe_seven_status_planes: verified (executed verifier host:rorca-cleanroom:fake_federated; observed sha256:c382db2ffac75f984b6656154e927ab67075e75839eb6aaea796ed2acbae3e67)
- [fake_federated] verify_optional_dependency_degradation: verified (executed verifier host:rorca-cleanroom:fake_federated; observed sha256:5ce0b4ac769ddf48fdf66e4ef6a21f5766a2fdb0276c186f07f7eeb470cb3382)
- [fake_federated] cleanup: verified (executed verifier host:rorca-cleanroom:fake_federated; observed sha256:85a493e4f14922461e5750a4aa84d8b37abd13e9bf068b96b565032b61fea062)

## Cleanup

Each lane's cleanup step removed its namespace-owned worktree, bare clone, and PostgreSQL container and proved absence (run-scoped labels; no host-wide sweeps). No invocation-owned resource remains.
