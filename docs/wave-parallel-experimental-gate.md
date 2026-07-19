# Wave-parallel experimental safety gate

Wave-parallel pipeline execution is **not production-ready**. Rorca defaults all ordinary Run Now, queued, and retry requests to sequential execution (`orchestrationMode=sequential`, `parallelism=1`). Production refuses any request or queued job whose effective parallelism is greater than one.

## Temporary non-production experiment

An operator may test explicit wave-parallel requests only in an isolated non-production environment:

```dotenv
NODE_ENV=development
RORCA_EXPERIMENTAL_WAVE_PARALLEL=true
```

The opt-in is exact and intentionally verbose. Setting it does not make parallel execution the default; a caller must also explicitly request `orchestrationMode=wave-parallel`, `parallelism>1`, or set workspace `execution.waveParallelism=true`.

Do not set this variable in a deployed production environment. When `NODE_ENV=production`, Rorca ignores the opt-in and returns `WAVE_PARALLEL_POLICY_DENIED` for explicit parallel requests. Workers independently revalidate persisted run rows and queue payloads before spawning the execution engine, so retries and direct jobs cannot bypass the policy.

## Operator response

When a request is denied:

1. Remove the parallel request or set `orchestrationMode=sequential` and `parallelism=1`.
2. Recreate stale queued runs through the pipeline trigger API; do not edit queue payloads or run rows.
3. Use the experiment only for disposable non-production validation. Do not describe or rely on it as a supported production capability.

Persisted `trigger_options`, the run row, and the worker payload must agree on the effective mode and parallelism. Rorca refuses inconsistent metadata rather than silently executing a different mode.
