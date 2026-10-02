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

## Remaining runtime migration (2026-10-02)

Rust now handles viewport/allocation math, settings invalidation, compute uniform
packing, input coordinate conversion, job completion/retention decisions, and 3D
refresh/resolution adaptation. The browser still owns GPU objects, event capture,
DOM presentation and diagnostics.

The merged HEAD had a duplicate `mod scene3d` declaration; this pass removes it.
For the same-session baseline, HEAD was exported to a temporary directory and
only that duplicate declaration was removed so it could compile. The historical
policy checker was also updated to include the intentional wider-base zoom-out
promotion rule. No shader arithmetic changed in this pass.

| Version | Checks | Frame gap p95 | Queue p95 | Zoom-out recovery | Peak textures |
| --- | --- | --- | --- | --- | --- |
| Same-session HEAD baseline | 12/12 | 56.5 ms | 56.1 ms | 512 ms | 962.2 MiB |
| Rust runtime, final build | 12/12 | 58.7 ms | 57.7 ms | 333 ms | 962.2 MiB |

Reports: `runtime-baseline.json` and `runtime.json`. Both used the continuous
round-3 path, 24 random zoom/pan gestures to 2,000,000×, 1600×900, DPR 2 and 384
iterations. Both recorded zero orphaned detail frames and at most two layers.
Timing varies substantially from earlier runs; these single runs verify recovery,
not a statistically established performance improvement. Final-build recovery
at the exact maximum-zoom detail preset was 637 ms (baseline 1,022 ms).

Commands used:

```sh
make build
node --check web/src.js
node --check web/scene3d.js
node scripts/check-render-plan.mjs
node scripts/check-runtime.mjs
```

The planner checker passed 6,000 policy and 96,000 coverage comparisons. The new
runtime checker passed 2,000 geometry/viewport/bit-exact uniform cases and 2,000
3D refresh cases, plus allocation, completion, invalidation, navigation, light
and collision checks against the compiled WASM.

Browser smoke checks also covered Julia and Burning Ship detail views and
refinement, plus 3D orbit drag, pan drag, wheel zoom, closer/back buttons, power
changes, reset and light pause/resume. Paused 3D refined to 1400×788; moving light
returned to 1000×563. No WebGPU or browser warning/error logs were reported.
These checks are not exhaustive across browsers, GPUs or arbitrary zoom depths.
