# Remaining JavaScript migration candidates

Reviewed after integrating the 3D view and the 64-byte overlap reprojection fix.
This is a migration review, not an instruction to change behavior.

## Recommended next steps

1. **3D quality and invalidation policy** — `web/scene3d.js:26–52`.
   Rust already owns the 3D camera, collision constraints, fractal parameters,
   and light clock. JS still chooses motion/refined resolutions, adapts resolution
   from queue time, tracks revisions, and decides when a settled frame is needed.
   Move these decisions into a small Rust frame policy returning dimensions,
   quality, and whether another frame is needed. Keep timers, visibility events,
   queue promises, and the browser callback itself in JS. Validate both animated
   and paused lighting, input during an in-flight frame, and hidden-tab resume.

2. **2D job lifecycle and allocation accounting** — `web/src.js:99–165, 338–404`.
   Scheduling is Rust-owned, but JS retains next-tile cursors, completion/retirement
   state, geometry padding, byte totals, and memory-admission checks. Rust receives
   copies of these records every frame. Let Rust own persistent records, report
   GPU completion back by ID, and request resource creation/destruction explicitly.
   Include allocation failure acknowledgement: a planned texture is not yet an
   allocated texture. This is the largest architectural improvement, but also
   the highest-risk remaining move because stale IDs and premature destruction
   could break in-flight GPU work.

3. **Compute uniform preparation** — `web/src.js:340–350`.
   JS patches Rust-produced uniform bytes using numeric float-array offsets for
   dimensions, tile cursor, reference length, timestamp, and cache geometry.
   Return a complete per-batch frame from Rust instead. This makes Rust/WGSL data
   layout ownership consistent with the newly migrated reprojection block.
   Keep byte-for-byte comparisons at the WASM boundary.

4. **Gesture normalization** — `web/src.js:245–276` and `web/scene3d.js:58–64`.
   Sensitivity curves, pixel-to-camera deltas, and modifier-to-camera actions can
   become Rust functions. DOM event listeners, pointer capture, preventDefault,
   element bounds, and accessibility updates still belong in JS. This is a small
   consistency improvement rather than a likely performance win.

## Keep in JavaScript for this architecture

- WebGPU device/pipeline/buffer/texture creation and command submission.
- DOM controls, errors, accessibility, resize/visibility events, and input capture.
- Browser benchmark orchestration and JSON export.
- Independent diagnostic coverage calculations and the old JS policy oracle:
  retaining an independent reference helps catch bugs in the Rust migration.
- The metadata/ID bridge, until persistent Rust job ownership simplifies it.

Moving WebGPU handles and commands into Rust would require a separate binding or
wgpu migration. It is feasible, but substantially larger than moving policy and
should not be presented as a guaranteed speedup.

## Integration validation

Rust now emits all 16 f32 values in the 64-byte reprojection block, including the
old base's screen bounds. The shader uses those bounds to fade only overlapping
pixels, preserving the other change's newly revealed-edge behavior.

`make build` and `node scripts/check-render-plan.mjs` pass: 6,000 seeded policy
cases and 96,000 coverage comparisons. The reprojection comparisons include the
four added bound values. The existing continuous random-navigation benchmark
passes all 12 checks through 2,000,000× (`benchmarks/rust-migration/rebased.json`).
Its p95 frame gap was 23.5 ms in this run; these single-run measurements do not
establish a performance improvement. The 3D page starts successfully as well.
