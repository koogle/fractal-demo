# Rust WebAssembly library

Run `make build` from the repository root to compile for `wasm32-unknown-unknown`
and copy the binary to `web/fractal.wasm`. Rust embeds `demo.wgsl` and exposes
it through `shader_ptr` and `shader_len`; JavaScript compiles it with WebGPU.

Rust owns the camera, selected fractal, iteration count, and palette. `set_fractal`
accepts 0 (Mandelbrot), 1 (Julia), or 2 (Burning Ship), and moves the camera to that
fractal's home view. Julia uses c = -0.8 + 0.156i. `reset_view` and `explore_detail`
respect the selected fractal. `drag`, `pan`, `zoom`, and pointer-anchored `zoom_at`
operate on the same f64 camera for all algorithms.

## Render planning in Rust

`render_plan.rs` owns 2D rendering policy: predicted zoom targets, coverage checks,
completed-cache selection, base/detail transitions, job priorities, protected LRU
eviction, job creation/retirement, reprojection uniforms, and adaptive tile budgets. `web/render-plan.mjs` marshals metadata and
resolves returned IDs to browser resources. `web/src.js` continues to create and
destroy textures, submit GPU commands, and handle browser input. Diagnostics stay
in JavaScript as independent instrumentation. Rust also owns the 3D refresh and quality state machine.

The planner input is a bounded array of 128 records, each containing 16 f64s:
ID, camera x/y/scale, visible height, texture width/height, complete flag,
active-job flag, next tile, total tiles, texture bytes, last-used time,
completion time, visible width, and one reserved value. IDs start at 1; zero means no image.
JavaScript checks capacity before copying. The dimensions and timestamps keep
existing units (pixels and milliseconds); camera coordinates retain f64 precision.

The selection output contains base ID, detail ID, transition start, job count,
and ordered job IDs. Target output contains count, zoom direction, and camera
triples. Eviction output contains count followed by IDs. Results are copied before
the next planner call because they share one output buffer. Settings changes reset
the planner along with the browser cache. No WebGPU handles cross into WASM. Scheduling returns retirement IDs and requested
camera triples; predicted allocations participate in subsequent coverage decisions.
Reprojection is a separate 16-f32 output matching the GPU's 64-byte layout, including the old base bounds.

After `make build`, run `node scripts/check-render-plan.mjs` to compare the real
WASM planner against the pre-migration JavaScript retained in git at `5e71a6e`,
with the later zoom-out promotion rule explicitly applied to that reference.
It checks 6,000 seeded selection, priority, scheduling, eviction, and reprojection
cases plus 96,000 coverage comparisons. The original git commit must be available
(a shallow clone may need to fetch history). Browser benchmarks remain accessible
through `?metrics=1`; no tests directory is required.

## Runtime ownership

`runtime.rs` chooses viewport dimensions, device-limited repair capacity, cache
configuration, padded job geometry, settings invalidation, interaction timing,
and wheel/drag coordinate conversion. `planner_allocation` accounts for active
and cached textures together and returns permission plus eviction IDs. Rust
chooses whether retired jobs are discarded or retained and which submitted jobs
have completed. JS maintains the corresponding resource handles and executes
those transitions after `onSubmittedWorkDone`.

For 3D, `scene3d_plan` returns `[needed, width, height, moving]` as four f64s.
`scene3d_invalidate` records input; `scene3d_finish` feeds GPU completion time back
into resolution adaptation and returns the next delay in milliseconds: -1 sleeps,
0 schedules immediately, otherwise a timer schedules the next frame. Revisions
preserve input received while the GPU is busy. `scene3d_resume` invalidates a view
after tab visibility changes. Browser scheduling and GPU handles remain in JS.

Run `node scripts/check-runtime.mjs` after building to check 2,000 geometry,
viewport and bit-exact uniform cases, 2,000 refresh cases, allocation/lifecycle,
invalidation, navigation conversion, light animation and collision behavior.

## GPU data

`update_frame` returns a WASM pointer; `uniform_size` reports 96 bytes. The six
16-byte blocks match WGSL `Frame`:

| Offset | Block | Contents |
| --- | --- | --- |
| 0 | screen | Texture dimensions, first calculation tile, reference length |
| 16 | view | Center x/y, scale, animated palette phase |
| 32 | parameters | Iterations, color density/speed, precision mode |
| 48 | center | Q8.56 center x/y low/high words |
| 64 | cache | Padding x/y, visible cache width/height |
| 80 | fractal | Algorithm ID, Julia c real/imaginary, reserved |

JavaScript copies the snapshot to the display uniform. It retains an immutable
snapshot for each cached view. `compute_input_ptr` accepts that snapshot as raw bytes;
`compute_frame` fills its compute dimensions, tile index, reference length, timestamp,
and cache geometry in Rust. Packed Q8.56 integer words are preserved bit for bit. `cache_extent` returns 1.25;
padding is rounded up independently on each edge. The compute and repair shaders
use the same `pixel_offset` function, subtracting padding before mapping visible
pixels to world coordinates. Padding never multiplies the camera scale.

`camera_ptr` returns center x/y and scale as three f64 values. A separate 64-byte
reprojection uniform contains the current image transform, transition timing, and
visible dimensions. Camera differences are calculated before conversion to f32.
The display maps onto the center of each padded texture using its visible pixel
height. Fresh tiles replace older pixels as they become available;
fractal switches discard previous images to prevent mixing different algorithms.
Small pans reuse the original cache and its camera snapshot. Up to eight
full-resolution jobs run during navigation, each with independent camera uniforms
and reference storage. Missing tiles fall back to a completed image in the shader.
The shared repair buffer holds at most 1,023 tiles of pixels (about 32 MiB), subject to device limits; each job's
compute and repair passes finish before the next job reuses it.

## Fractal calculation

Normal views use direct f32 iteration. Mandelbrot deep views use a reference
orbit generated by `reference_ptr(aspect, extent)`; `reference_len` returns the
orbit entry count (up to 1025). An extra leading vec4 stores a complex derivative
and prefix length. Rust bounds the omitted terms of a linear approximation over
the actual padded extent, allowing the GPU to skip an initial orbit prefix.
Each orbit entry stores x/y and a glitch threshold. Uploads contain
`reference_len() + 1` blocks.

`compute_main` writes escape counts and norms into an `rg32float` texture.
Unstable Mandelbrot pixels, and deep Julia/Burning Ship pixels, enter an atomic
repair queue. `prepare_repairs` writes indirect dispatch arguments;
`repair_main` uses Q8.56 arithmetic on those pixels without CPU readback. The
Julia path initializes z from the pixel and uses the fixed Julia constant;
Burning Ship uses the absolute real/imaginary components before squaring.
The visible center tiles are scheduled before the offscreen margin. The total
batch across jobs adapts toward 8 ms during gestures and 12 ms at rest, capped
at 256/512 tiles respectively, or the smaller device limits. GPU workgroups execute
parallel pixel calculations; job batches share one bounded submission.

`set_zoom_level`, `set_iterations`, `set_color_density`, and `set_color_speed`
validate slider input. `read_settings` returns the four corresponding values.
The display shader applies the palette separately, reusing cached orbit results.
Precision remains finite, with f64 camera/reference coordinates and Q8.56 repair
arithmetic. Julia and Burning Ship do not yet have perturbation acceleration.

Exports run serially on the browser main thread. There is no generated JS glue,
shared memory, external crate dependency, or frontend build system.

## Predicted zoom views

`prepare_view(x, y, scale, width, height, aspect, extent)` prepares a frame and
reference orbit for an offscreen camera, restoring live navigation and palette
state before returning. Copy its 96-byte frame immediately. `reference_data_ptr`
reads the prepared orbit without recomputing it at the live camera;
`reference_len` reports its length. JavaScript uploads that orbit when creating a
render job, then reuses it for every batch in the job.

The JavaScript cache retains up to 48 cached views with a 1 GiB texture
budget including active jobs (repair storage is separate). During navigation it
predicts seven levels ahead with cursor anchoring. The logarithmic spacing
expands with measured zoom speed. At rest it retains six forward levels and
one reverse level. The display selects a stable base and one detail image near native pixel
density; unwritten samples preserve the base. Useful jobs keep
running through input events; stale jobs are discarded. Each active job receives
a share of the adaptive tile budget, prioritizing the current view. Completed
snapshots retain their own precision mode and camera; algorithm, iteration, and
viewport-size changes clear the bank and all in-progress jobs.

Pending GPU jobs continue via a yielding timer as soon as a submission completes;
animation frames are used when there is no work or the document is hidden. There
is still only one submission in flight. This avoids a display-refresh-sized gap
between compute batches without building a queue of stale views.

## Tile transitions

The display pipeline uses source-alpha blending. Each image has a four-byte
arrival timestamp per 64×64 tile, written by compute binding 10 and read through
fragment binding 9. Compute snapshots use `fractal.w` for the batch timestamp.
The 64-byte reprojection block reuses its second vec4 for display time, layer
appearance time, fade duration, and a reserved field. The shader fades each tile
for 140 ms from the later of its arrival and layer appearance. The bottom layer
is opaque, and coarser covering images stay until the replacement has fully
faded. This blends palette colors without interpolating fractal iteration data.

Display selection retains a base/detail pair until the detail is complete,
fully covers the viewport, and has finished fading. An 8% improvement threshold
and 1.05× magnification tolerance prevent needless switches between nearby
levels. On zoom-out, a substantially oversampled base can transition to a more
suitable level. Selected textures are protected from eviction. Cancelled jobs
with computed tiles enter the cache as incomplete fallbacks.

The fragment shader shades neighboring samples before bilinear interpolation.
It accumulates premultiplied color and coverage so missing pixels do not create
black fringes. A bounded 2×2 footprint filter handles moderate minification;
this is not a full mip pyramid or arbitrary-scale anti-aliasing. The detail
rectangle is feathered over eight display pixels. The final color is converted
to straight alpha for the display pipeline's source-alpha blend.

The fourth reprojection vec4 holds old base bounds in screen pixels. Zoom-out
uses these bounds to crossfade overlap without darkening newly exposed edges.
Completed wider views can become the base after fading even when both images
have been overtaken by continued zoom-out.
