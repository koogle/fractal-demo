# Rust rendering-policy migration

Validated on 2026-10-02 using the existing continuous random-navigation benchmark:
24 zoom/pan gestures up to 2,000,000×, including the exact detail preset, then
zoom-out recovery. Same 1600×900 canvas, DPR 2, 384 iterations, and seed 20261001.

| Version | Checks passed | Frame gap p95 | Queue completion p95 | Peak textures |
| --- | --- | --- | --- | --- |
| Published JavaScript baseline | 12/12 | 20.3 ms | 19.9 ms | 962.2 MiB |
| Rust selection/cache/budgets | 12/12 | 23.7 ms | 23.4 ms | 962.2 MiB |
| Rust scheduling/reprojection too | 12/12 | 20.3 ms | 20.0 ms | 962.2 MiB |

No browser errors were reported. These single runs establish recovery and show
similar final timing, not a statistically demonstrated speedup or proof of zero
visual flicker. Queue measurements are wall time, and sharpness is a 45-point
estimate. Shader arithmetic is unchanged by this migration.

`node scripts/check-render-plan.mjs` also compares the actual compiled WASM with
the original JavaScript policy from git: 6,000 seeded multi-frame cases for
selection, priority, scheduling, eviction, and reprojection, plus 96,000 coverage
comparisons passed. This catches behavioral changes that timing benchmarks do not.

```sh
make build
node scripts/check-render-plan.mjs
node scripts/compare-metrics.mjs benchmarks/rust-migration/before.json benchmarks/rust-migration/scheduler.json
```
