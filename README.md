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

## Build for hosting

```sh
make build
```

Serve the contents of `web/` on a static host, including the generated
`fractal.wasm` file. Configure `.wasm` responses as `application/wasm`.

See [references](references/README.md) for shader and WebGPU implementation notes.
te-coverage request.

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
node scripts/compare-metrics.mjs before.json after.json
```

The comparison rejects mismatched scenarios/configurations and exits nonzero
when the new run fails its checks. Selected unfinished display jobs keep
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

## 2D zoom-out transitions

Completed wider views replace the old base after fading, even when zoom-out has
overtaken their bounds. Only overlapping regions crossfade; newly revealed edges
render opaque instead of fading from black.

## 3D Mandelbulb

Choose **3D Mandelbulb** in the top-left view tabs, or open `/3d.html`.
Drag to orbit, Shift-drag to pan, and scroll/pinch to dolly the camera.
**Pan drag** provides panning without holding a modifier; middle/right dragging
also pans. **Reset view** restores the camera, power 8, and 12 iterations.
Power and detail sliders change the fractal through Rust exports.

The 3D view uses the same Rust/WASM → uniforms → WebGPU pipeline, with a separate
camera and a distance-estimated ray marcher. Rust owns the orbit target, camera
basis, distance, and fractal parameters in `scene3d.rs`; `mandelbulb.wgsl` is embedded
in the same `fractal.wasm`. Its 112-byte uniform has seven vec4 blocks. Rust animates an orbiting point
light; secondary distance-estimated rays approximate soft cast shadows. A dim
fill light, orbit-trap coloring, and ambient occlusion expose the surface shape.
**Pause light** holds the current light position; **Resume light** continues its orbit.

3D uses fresh rays for camera motion, since a flat cached image cannot represent
newly exposed surfaces. Motion resolution adapts between 400 and 960 pixels on
the longest side with a 112-step marching budget. After release it uses 224 marching steps. Moving lighting renders at up to
1000 pixels on the longest side. Pausing the light refines at up to 1400 pixels,
then stops submitting work until something changes. Shadow rays keep the same 40-step budget during gestures and at rest to avoid
lighting changes when zooming. Light animation follows elapsed time independently
of rendering speed; hidden tabs and the pause control suspend its clock. Their finite budget approximates visibility
and can miss very thin occluders. Background tabs stop rendering.
Only one submission is in flight; inputs during a submission are coalesced into
the next camera frame. The existing 2D cache stays in the 2D view.

Rust sweeps camera movements against a conservative CPU version of the Mandelbulb
distance estimator, stopping with a small surface clearance. This also applies
to panning and short orbit arcs, preventing large input jumps through the object.
Changing the fractal shape moves the camera back if the new surface encloses it.
These are approximate fractal distance estimates, not exact mesh collisions. Distance estimation is
approximate, GPU arithmetic has finite precision, and zoom distance is bounded
from 0.02 to 80 scene units. This 3D path does not offer arbitrary-depth precision
or the 2D benchmark's performance guarantees. The model requires no asset downloads.
