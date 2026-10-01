# Random-navigation optimization rounds — 2026-10-01

All three rounds ran in the local WebGPU browser, with seed 20261001,
384 iterations, paused colors, 1600×900 render targets, a cold cache, and
random zoom anchors and pans. Bursts contain 16/20/24 gestures, 80 ms apart;
every fourth gesture reaches the round's maximum zoom. Each burst revisits the
Mandelbrot detail neighborhood. Before/after files retain their actual metadata.

| Round | Maximum zoom | Change | Recorded result |
| --- | ---: | --- | --- |
| 1 | 20,000× | Batch time targets 12/24 → 8/12 ms moving/idle | Queue p95 26.2 → 25.2 ms; job p95 81 → 76 ms. Small difference, potentially timing noise. |
| 2 | 200,000× | Prefer visible replacement work; release a panned detail when a finished covering replacement exists | Job p95 99.6 → 80.8 ms; retired tiles 2,269 → 620. Frame gap p95 worsened 26.1 → 28.1 ms. |
| 3 | 2,000,000× | Cap submissions at 256/512 tiles moving/idle; limit batch growth to 25% | Frame gap p95 23.9 → 10.8 ms; queue p95 23.4 → 10.4 ms. Throughput fell 11.7%; job p95 rose 75.1 → 84.2 ms. |

All checks passed in each before/after run: sharp coverage after stopping,
zoom-out recovery, no orphaned detail, at most two display layers, and the
1 GiB texture budget. The retained implementation combines these three changes.
The panning bug also has a unit regression test that failed before its fix.

## Additional validation and rejected experiment

`1-final.json` and `2-final.json` recheck the combined changes with a fixed
1600×900 viewport (DPR 1). Original before/after pairs used DPR 2; do not treat
these final checks as directly comparable timings. `*-large-viewport.json`
records additional passing runs at 1600×1151 after the window size changed.

`3-continuous-before.json` is the retained implementation: 24 gestures interpolated
over 320 ms each, with simultaneous panning, reversals, and a final exact-detail
preset check at 2,000,000×. All 12 checks passed. Random checkpoint recovery was
209–417 ms; the exact deep detail recovered in 233 ms. Frame gap p95 was 21.1 ms.

`3-continuous-after.json` tried four predictions during movement instead of eight.
Although frame gap p95 improved to 14 ms, discarded tile work increased from
37,018 to 49,196 and several sharpness checkpoints took longer. **This experiment
was reverted.** The eight-view prediction queue remains. The earlier
`3-continuous-initial.json` lacks the final exact-detail check and is exploratory.

## Reproduce

Run `make serve`, open `/?metrics=1&stress=1` (or 2/3), then click **Run zoom
benchmark**. Add `&motion=1` for continuous gestures. Keep the tab active.
Export the full JSON from the panel. Stored reports here contain summary/checks;
the browser export additionally includes frame samples.

```sh
node scripts/compare-metrics.mjs benchmarks/rounds/3-before.json benchmarks/rounds/3-after.json
```

These are single local runs, not confidence intervals or universal speedups.
The trajectories are seeded, but browser scheduling and GPU contention vary.
The harness calls Rust camera exports directly; it does not measure OS input
latency and deliberately does not supply cursor hints to the prefetch scheduler.
Queue completion and frame gaps are wall-clock measurements, not GPU timestamps
or presented-frame timings. Sharp coverage is a conservative 45-point estimate,
including fades; it is not visual correctness. Its frame-count fraction changes
when submission frequency changes. Extreme gestures still temporarily magnify
old pixels; these results establish recovery, not a guarantee of seamlessness.
