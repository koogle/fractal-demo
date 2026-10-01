# Fractal Demo

A compact Rust/WebAssembly and WebGPU shader demo for exploring Mandelbrot,
Julia, and Burning Ship fractals. Plain JavaScript loads the compiled Rust
library; no JavaScript bundler or model downloads are required.

## Run locally

Requirements: Rust/Cargo, Make, and Python 3.

```sh
rustup target add wasm32-unknown-unknown
make serve
```

Open http://127.0.0.1:5173/. This compiles the Rust library and serves the `web/`
folder directly. Use a browser with WebGPU enabled. The browser loads the WASM
file with plain JavaScript. HTML, CSS, and JavaScript need no bundler.

Select a fractal from the dropdown. Each has its own home and detail view.
Julia uses the fixed constant c = -0.8 + 0.156i; Burning Ship applies absolute
values to both orbit components before squaring.

Drag the canvas to pan. Two-finger trackpad scrolling, pinching, and mouse-wheel
scrolling zoom around the pointer. The buttons also call Rust exports to pan,
zoom, explore a detail preset, pause the
palette animation, or reset. Sliders adjust logarithmic zoom, iteration detail,
color bands, and color animation speed; Rust validates their ranges. Rust owns this state, embeds the WGSL shader, and
writes a 96-byte uniform block each frame. JavaScript copies those bytes to a
WebGPU buffer. A compute shader calculates the fractal in small tiles and caches
escape counts in a GPU texture. The fullscreen fragment shader only colors that
texture, so palette animation does not repeat the expensive orbit calculations.
The shader renders a cache with an extra 12.5% beyond each viewport edge,
rounded up to whole texels. Visible dimensions and padding are stored separately,
so adding the margin never changes the camera scale or visible center. Visible tiles are calculated
first, then the offscreen margin. Dragging pans across this texture in the
display shader without recalculation or a lower-resolution preview while the
viewport remains covered. Ending a contained drag keeps the same cache.
The renderer continuously schedules up to eight full-resolution views, including
while a gesture is active: the current camera and seven positions along the
zoom direction, spaced further ahead as zoom speed increases, anchored at the trackpad cursor. At rest it prepares a deeper ladder in the last direction and a reverse level. Each job has its own Rust camera snapshot, uniforms,
and reference orbit. Useful work survives subsequent wheel events.

The display keeps at most two images: a stable base and a nearby detail level.
Detail is selected near the current pixel density rather than always choosing the
finest prediction. It fades in over 140 ms, with per-tile arrival times, while
missing samples preserve the base. A fully covering completed detail becomes the
base after the fade finishes. The pair is protected from cache eviction.

The shader bilinearly filters shaded colors (not escape counts), with bounded
2×2 footprint sampling for moderately minified images. The two filtering
kernels blend continuously as their footprint grows, avoiding a hard switch during zoom. Detail rectangle edges
are feathered over eight display pixels. Each image retains its own camera
mapping. New detail is requested beyond 1.05× magnification, with an 8% density
improvement threshold to avoid repeatedly switching between nearly equal views.
There are no tiny gesture-only preview renders.

Up to 48 cached images are retained within a 1 GiB texture budget that
also includes active render targets. Shared repair storage adds up to 32 MiB. Algorithm,
iteration, and viewport changes clear the jobs and images; palette edits reuse them.
GPU workgroups calculate tiles in parallel. Up to eight jobs receive batches in
each submission. A visible replacement gets priority, with up to 85% of the batch
when no completed sharp view covers the viewport. The total
batch adapts toward 8 ms during gestures and 12 ms at rest, with batches capped at
256 tiles during gestures and 512 at rest (or the smaller device limit), with only one submission in flight. Pending work
continues immediately after completion, yielding to input between submissions
rather than waiting for the next display refresh.
This keeps stale work from building an input-blocking queue. Actual simultaneous
execution across jobs is GPU-dependent. Fast jumps into uncached regions can still
outrun rendering and temporarily use older pixels.

The zoom controls have no preset bounds, and the slider expands as you explore.
Rust keeps the camera in 64-bit floating point. Precision mode starts when a
conservative f32 coordinate rounding estimate exceeds 1/16 of a pixel, using
viewport height and camera position instead of a fixed zoom threshold. For deep Mandelbrot zooms, Rust computes a
shared reference orbit once per center/iteration change. GPU workgroups calculate
pixel differences from that orbit in parallel using native floating point
perturbation arithmetic. Numerically unstable pixels are compacted into a repair
queue and recalculated using Q8.56 integers in a separate GPU dispatch. The GPU
creates the repair dispatch arguments itself, without CPU readback. Reference
rebasing lets pixels continue when the center orbit escapes. Rust also computes a linear series prefix and bounds its omitted quadratic
terms over the viewport, skipping early iterations only while the bound stays
small and every point remains below the escape threshold. Batch sizing retains
its tuning across gestures; final rendering targets short GPU submissions and
caps the total at 1,023 tiles (or the device limit) and reduces it when expensive repairs increase submission time.
Julia and Burning Ship use direct floating point iteration at normal zooms and
the Q8.56 path at deep zooms; their deep views can be slower than Mandelbrot.
Iterations remain bounded to keep rendering responsive. Precision is still
finite: arbitrary-precision camera/reference arithmetic and rescaled deltas are
needed for indefinitely deep exploration. This optimization does not remove
those limits, and views with many repair pixels can still be expensive.

After editing Rust or WGSL, run `make build` and refresh the browser. Refresh after editing
HTML, CSS, or JavaScript as well.

## Build for hosting

```sh
make build
```

Serve the contents of `web/` on a static host, including the generated
`fractal.wasm` file. Configure `.wasm` responses as `application/wasm`.

See [references](references/README.md) for shader and WebGPU implementation notes.

The browser requests a high-performance GPU adapter. Only the selected pair is
drawn, so retaining more cached views does not add full-screen display passes.
Cancelled predictions stop computing but keep finished tiles as possible
fallbacks; incomplete images never satisfy a complete-coverage request.

## Renderer metrics and regression benchmark

Open `http://127.0.0.1:5173/?metrics=1` for the internal diagnostics panel.
Normal viewing does not collect per-frame metrics. **Run zoom benchmark** starts
with a cold cache at Mandelbrot detail, runs a smooth 1×–5,000× zoom, jumps to
14,900×, rapidly reverses direction, and checks zoom-out recovery. It resets
settings to 384 iterations and pauses colors. Each settled-view check has an
8-second deadline and requires three distinct sharp renderer samples.

Metrics include submission completion wall time, renderer frame gaps, encoding
wall time, completed job latency, tiles/second, cache hits, texture memory,
retired work, layer count, orphaned detail selection, and estimated sharp
coverage. Coverage samples 45 viewport points against ready tiles and pixel
scale; it catches magnified stale views but is **not a visual correctness or
perceptual flicker score**. Queue wall time is not hardware GPU timing, and
renderer frame gaps are not measured display presentation times.

Export JSON to retain the configuration, checks, summary, and up to 12,000 recent
samples. The report states whether older samples were dropped. Compare runs at
the same viewport and settings:

```sh
make test
node scripts/compare-metrics.mjs before.json after.json
```

The comparison rejects mismatched scenarios/configurations and exits nonzero
when the new run fails its checks. Tests cover cancelled detail, stale views
following large jumps, promotion/fade rules, diagnostic tile ordering, sharpness
estimation, and bounded metrics retention. Selected unfinished display jobs keep
rendering; retired partial images cannot become a new detail target.

Randomized stress variants use the same seed (`20261001`) for repeatability:

- `?metrics=1&stress=1`: 16 zoom/pan jumps, up to 20,000×.
- `?metrics=1&stress=2`: 20 jumps, up to 200,000×.
- `?metrics=1&stress=3`: 24 jumps, up to 2,000,000×.
- Add `&motion=1` to interpolate each gesture over 320 ms, with a final maximum-zoom detail-preset check.

Every four gestures revisit the detail preset, then explore randomized cursor
anchors and pans. Burst gestures are 80 ms apart. Checkpoints allow four seconds
to recover full estimated sharp coverage. These drive the same Rust zoom/pan
exports as the controls; they do not measure operating-system trackpad delivery.
See `benchmarks/rounds/README.md` for the three optimization rounds and tradeoffs.
