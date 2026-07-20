# Qualification procedure v1

1. Provision the isolated database/role boundary described by the parent qualification README when durable database scenarios are required.
2. Run `npm run test:wave-qualification`; the first attempt is authoritative.
3. The stress launcher runs report generation as a separate blocking child without passing captured stdout/stderr.
4. Review `qualification.json`, `qualification.md`, and `receipt.json` under the owned `.rorca/qualification/<digest>/` directory.
5. Require passing scenario verdicts for every versioned `QUALIFICATION_SCENARIOS` ID, successful semantic closeout, passing budgets, closeout telemetry, durable DB/WAL proof, Git integration proof, an independent checker verdict, a non-production canary/soak artifact, and a rollback-rehearsal artifact.
6. Configure a trusted issuer and publish through the admin receipt API. Publication recomputes current local identities; it never trusts request claims.

The recognized evidence classes are automated test output, durable database/WAL, Git integration, independent checker, canary/soak, rollback rehearsal, operator observation, skipped check, and environmental blocker. The measured classes are `durable_database_wal`, `git_integration`, `independent_checker`, `canary_soak`, and `rollback_rehearsal`. Automated output and operator observations are supporting and non-authoritative. A skipped check or environmental blocker makes the gate unavailable.

The provider-free stress command deliberately produces a signed audit receipt with `productionEnableAvailable=false` until all five measured evidence classes are attached by the complete qualification pipeline. Diagnostics never replace the failed first attempt.
