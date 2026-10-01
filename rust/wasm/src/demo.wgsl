// Original compact Mandelbrot renderer. Reference implementation:
// https://github.com/thaapasa/webgpu-fractal/blob/main/src/renderer/shaders/mandelbrot.wgsl
struct Frame {
    screen: vec4<f32>, // width, height, first calculation tile, reference length
    view: vec4<f32>, // center x/y, scale, color phase — all controlled by Rust
    parameters: vec4<f32>, // iterations, color density, speed, precision mode
    center: vec4<u32>, // Q8.56 center x low/high, center y low/high
    cache: vec4<f32>, // padding x/y in texels, visible cache width/height
    fractal: vec4<f32>, // algorithm: 0 Mandelbrot, 1 Julia, 2 Burning Ship; Julia c real/imag
}
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var escape_output: texture_storage_2d<rg32float, write>;
@group(0) @binding(2) var escape_cache: texture_2d<f32>;
@group(0) @binding(3) var preview_cache: texture_2d<f32>;
@group(0) @binding(4) var<storage, read> reference: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> repair_pixels: array<vec2<u32>>;
struct RepairQueue {
    count: atomic<u32>,
}
@group(0) @binding(6) var<storage, read_write> repair_queue: RepairQueue;
@group(0) @binding(7) var<storage, read_write> repair_dispatch: vec4<u32>;
// Current transform: x/y shift, scale ratio, available.
// The previous block stores fade timing; its name preserves the 48-byte layout.
struct Reprojection { current: vec4<f32>, previous: vec4<f32>, visible_sizes: vec4<f32> }
@group(0) @binding(8) var<uniform> reprojection: Reprojection;
// The compute and display entry points bind the same tiny per-tile buffer.
@group(0) @binding(9) var<storage, read> tile_times: array<f32>;
@group(0) @binding(10) var<storage, read_write> tile_times_output: array<f32>;

@vertex
fn vertex_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)
    );
    return vec4<f32>(positions[index], 0.0, 1.0);
}

// BEGIN_FIXED_POINT
// Signed Q8.56 values stored as low/high u32 words. All arithmetic is integer.
fn q_neg(a: vec2<u32>) -> vec2<u32> {
    let lo = ~a.x + 1u;
    return vec2<u32>(lo, ~a.y + select(0u, 1u, lo == 0u));
}
fn q_add(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
    let lo = a.x + b.x;
    return vec2<u32>(lo, a.y + b.y + select(0u, 1u, lo < a.x));
}
fn q_sub(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> { return q_add(a, q_neg(b)); }
fn q_abs(a: vec2<u32>) -> vec2<u32> {
    return select(a, q_neg(a), (a.y & 0x80000000u) != 0u);
}
fn wide_mul(a: u32, b: u32) -> vec2<u32> {
    let a0 = a & 65535u;
    let b0 = b & 65535u;
    let a1 = a >> 16u;
    let b1 = b >> 16u;
    let p0 = a0 * b0;
    let p1 = a0 * b1;
    let p2 = a1 * b0;
    let middle = (p0 >> 16u) + (p1 & 65535u) + (p2 & 65535u);
    return vec2<u32>((p0 & 65535u) | (middle << 16u), a1 * b1 + (p1 >> 16u) + (p2 >> 16u) + (middle >> 16u));
}
fn wide_add(a: vec4<u32>, b: vec4<u32>) -> vec4<u32> {
    let x = a.x + b.x;
    let y0 = a.y + b.y;
    let y = y0 + select(0u, 1u, x < a.x);
    let z0 = a.z + b.z;
    let z = z0 + select(0u, 1u, y0 < a.y || y < y0);
    let w = a.w + b.w + select(0u, 1u, z0 < a.z || z < z0);
    return vec4<u32>(x, y, z, w);
}
fn q_mul(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
    let aa = q_abs(a);
    let bb = q_abs(b);
    let p00 = wide_mul(aa.x, bb.x);
    let p01 = wide_mul(aa.x, bb.y);
    let p10 = wide_mul(aa.y, bb.x);
    let p11 = wide_mul(aa.y, bb.y);
    var p = vec4<u32>(p00, 0u, 0u);
    p = wide_add(p, vec4<u32>(0u, p01, 0u));
    p = wide_add(p, vec4<u32>(0u, p10, 0u));
    p = wide_add(p, vec4<u32>(0u, 0u, p11));
    let result = vec2<u32>((p.y >> 24u) | (p.z << 8u), (p.z >> 24u) | (p.w << 8u));
    return select(result, q_neg(result), ((a.y ^ b.y) & 0x80000000u) != 0u);
}
fn q_from_float(value: f32) -> vec2<u32> {
    let bits = bitcast<u32>(abs(value));
    let exponent = i32((bits >> 23u) & 255u);
    if (exponent == 0) { return vec2<u32>(0u); }
    let mantissa = (bits & 0x7fffffu) | 0x800000u;
    // value = mantissa * 2^(exponent - 127 - 23); multiply by 2^56.
    let shift = exponent - 94;
    var result = vec2<u32>(0u);
    if (shift >= 32 && shift < 64) {
        result.y = mantissa << u32(shift - 32);
    } else if (shift > 0 && shift < 32) {
        result = vec2<u32>(mantissa << u32(shift), mantissa >> u32(32 - shift));
    } else if (shift == 0) {
        result.x = mantissa;
    } else if (shift < 0 && shift > -32) {
        result.x = mantissa >> u32(-shift);
    }
    return select(result, q_neg(result), value < 0.0);
}
fn q_to_float(value: vec2<u32>) -> f32 {
    let a = q_abs(value);
    let magnitude = f32(a.y) * (1.0 / 16777216.0) + f32(a.x) * (1.0 / 72057594037927936.0);
    return select(magnitude, -magnitude, (value.y & 0x80000000u) != 0u);
}
// END_FIXED_POINT

fn precise_orbit(offset: vec2<f32>, limit: u32) -> vec2<f32> {
    var cx = q_add(frame.center.xy, q_from_float(offset.x));
    var cy = q_add(frame.center.zw, q_from_float(offset.y));
    var x = vec2<u32>(0u);
    var y = vec2<u32>(0u);
    if (frame.fractal.x == 1.0) {
        x = cx; y = cy;
        cx = q_from_float(frame.fractal.y);
        cy = q_from_float(frame.fractal.z);
    }
    for (var i = 0u; i <= 1024u; i++) {
        let xx = q_mul(x, x);
        let yy = q_mul(y, y);
        let norm = q_add(xx, yy);
        // Escape at |z| >= 2, keeping all fixed-point intermediates in range.
        if (norm.y >= 0x04000000u) { return vec2<f32>(f32(i), q_to_float(norm)); }
        if (i >= limit) { break; }
        var xy = q_mul(x, y);
        if (frame.fractal.x == 2.0) { xy = q_mul(q_abs(x), q_abs(y)); }
        x = q_add(q_sub(xx, yy), cx);
        y = q_add(q_add(xy, xy), cy);
    }
    return vec2<f32>(-1.0, 0.0);
}

fn orbit(point: vec2<f32>, limit: u32) -> vec2<f32> {
    var c = point;
    let cx = c.x - 0.25;
    let q = cx * cx + c.y * c.y;
    if (frame.fractal.x == 0.0 && (q * (q + cx) <= 0.25 * c.y * c.y || (c.x + 1.0) * (c.x + 1.0) + c.y * c.y <= 0.0625)) {
        return vec2<f32>(-1.0, 0.0);
    }
    var z = vec2<f32>(0.0);
    if (frame.fractal.x == 1.0) { z = point; c = frame.fractal.yz; }
    for (var i = 0u; i <= 1024u; i++) {
        let norm = dot(z, z);
        if (norm >= 4.0) { return vec2<f32>(f32(i), norm); }
        if (i >= limit) { break; }
        if (frame.fractal.x == 2.0) { z = abs(z); }
        z = vec2<f32>(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    }
    return vec2<f32>(-1.0, 0.0);
}

// z = Z + delta, where Rust computes Z once in f64. All pixels execute
// delta' = 2 Z delta + delta² + dc in parallel with native GPU float math.
fn perturbed_orbit(offset: vec2<f32>, limit: u32) -> vec2<f32> {
    let acceleration = reference[0];
    var delta = vec2<f32>(
        acceleration.x * offset.x - acceleration.y * offset.y,
        acceleration.x * offset.y + acceleration.y * offset.x
    );
    let skipped = u32(acceleration.z);
    var ref_index = skipped;
    let ref_length = u32(abs(frame.screen.w));
    if (ref_length < 2u) { return vec2<f32>(-2.0, 0.0); }
    for (var i = skipped; i <= 1024u; i++) {
        let entry = reference[ref_index + 1u];
        let z = entry.xy + delta;
        let norm = dot(z, z);
        // NaNs also fail this comparison. Send unstable pixels to a separate
        // integer dispatch so their slow path cannot stall fast GPU lanes.
        if (!(norm >= entry.z) || !(norm < 1.0e20)) {
            return vec2<f32>(-2.0, 0.0);
        }
        if (norm >= 4.0) { return vec2<f32>(f32(i), norm); }
        if (i >= limit) { return vec2<f32>(-1.0, 0.0); }
        // Rebase when the difference dominates or the center orbit ends.
        // Iteration i still counts the pixel orbit, independently of ref_index.
        var base = entry.xy;
        if (norm < dot(delta, delta) || ref_index + 1u >= ref_length) {
            delta = z;
            ref_index = 0u;
            base = vec2<f32>(0.0);
        }
        delta = vec2<f32>(
            2.0 * (base.x * delta.x - base.y * delta.y) + delta.x * delta.x - delta.y * delta.y,
            2.0 * (base.x * delta.y + base.y * delta.x) + 2.0 * delta.x * delta.y
        ) + offset;
        ref_index++;
    }
    return vec2<f32>(-1.0, 0.0);
}

// Calculate tiles intersecting the visible center first, then fill the margin.
// All ordering and extended-area coordinate mapping happen on the GPU.
fn cache_tile(index: u32) -> vec2<u32> {
    let grid = (vec2<u32>(frame.screen.xy) + 63u) / 64u;
    let margin = frame.cache.xy;
    let first = vec2<u32>(floor(margin / 64.0));
    let end = min(grid, vec2<u32>(ceil((frame.screen.xy - margin) / 64.0)));
    let inner = end - first;
    let visible_count = inner.x * inner.y;
    if (index < visible_count) {
        return first + vec2<u32>(index % inner.x, index / inner.x);
    }
    var rest = index - visible_count;
    let top_count = first.y * grid.x;
    if (rest < top_count) { return vec2<u32>(rest % grid.x, rest / grid.x); }
    rest -= top_count;
    let side_width = first.x + grid.x - end.x;
    let side_count = inner.y * side_width;
    if (rest < side_count) {
        let column = rest % side_width;
        let x = select(end.x + column - first.x, column, column < first.x);
        return vec2<u32>(x, first.y + rest / side_width);
    }
    rest -= side_count;
    return vec2<u32>(rest % grid.x, end.y + rest / grid.x);
}

// One mapping for calculation and repair: padding is outside the visible
// pixel rectangle and never changes the viewport's world-space scale.
fn pixel_offset(pixel: vec2<u32>) -> vec2<f32> {
    let position = vec2<f32>(pixel) + 0.5 - frame.cache.xy;
    let uv = (2.0 * position - frame.cache.zw) / frame.cache.w;
    return vec2<f32>(uv.x, -uv.y) * frame.view.z;
}

// Each dispatch calculates a short batch of 64 × 64 tiles. Palette changes
// only sample the cached result; they never repeat the Mandelbrot iterations.
@compute @workgroup_size(8, 8, 1)
fn compute_main(@builtin(global_invocation_id) id: vec3<u32>) {
    let tile = u32(frame.screen.z) + id.z;
    let pixel = cache_tile(tile) * 64u + id.xy;
    if (any(pixel >= vec2<u32>(frame.screen.xy))) { return; }
    if (all(id.xy == vec2<u32>(0u))) {
        let coordinate = cache_tile(tile);
        let columns = (u32(frame.screen.x) + 63u) / 64u;
        tile_times_output[coordinate.y * columns + coordinate.x] = frame.fractal.w;
    }
    let offset = pixel_offset(pixel);
    let c = frame.view.xy + offset;
    if (frame.view.z > 1.0e10 || any(abs(c) > vec2<f32>(1.0e10))) {
        textureStore(escape_output, vec2<i32>(pixel), vec4<f32>(-1.0, 0.0, 0.0, 0.0));
        return;
    }
    let limit = u32(frame.parameters.x);
    var result: vec2<f32>;
    if (frame.parameters.w > 0.5) {
        result = vec2<f32>(-2.0, 0.0);
        if (frame.fractal.x == 0.0) { result = perturbed_orbit(offset, limit); }
    } else {
        result = orbit(c, limit);
    }
    if (result.x == -2.0) {
        if (frame.screen.w < 0.0) { return; } // Display the reprojected image during gestures.
        let index = atomicAdd(&repair_queue.count, 1u);
        repair_pixels[index] = pixel;
        return;
    }
    textureStore(escape_output, vec2<i32>(pixel), vec4<f32>(result, 0.0, 0.0));
}

// Generate an indirect dispatch on the GPU: no readback or main-thread wait.
@compute @workgroup_size(1)
fn prepare_repairs() {
    repair_dispatch = vec4<u32>((atomicLoad(&repair_queue.count) + 63u) / 64u, 1u, 1u, 0u);
}

@compute @workgroup_size(64)
fn repair_main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= atomicLoad(&repair_queue.count)) { return; }
    let pixel = repair_pixels[id.x];
    let result = precise_orbit(pixel_offset(pixel), u32(frame.parameters.x));
    textureStore(escape_output, vec2<i32>(pixel), vec4<f32>(result, 0.0, 0.0));
}

// Filter shaded colors, never raw escape counts: interior and escaped samples
// have different meanings. Missing pixels carry zero coverage, not black RGB.
fn shaded_sample(position: vec2<i32>) -> vec4<f32> {
    let size = textureDimensions(escape_cache);
    if (any(position < vec2<i32>(0)) || any(position >= vec2<i32>(size))) { return vec4<f32>(0.0); }
    let result = textureLoad(escape_cache, position, 0).xy;
    if (all(result == vec2<f32>(0.0))) { return vec4<f32>(0.0); }
    var opacity = 1.0;
    if (reprojection.previous.z > 0.0) {
        let tile = vec2<u32>(position) / 64u;
        let arrived = tile_times[tile.y * ((size.x + 63u) / 64u) + tile.x];
        opacity = smoothstep(0.0, reprojection.previous.z,
            reprojection.previous.x - max(arrived, reprojection.previous.y));
    }
    var color = vec3<f32>(0.015, 0.022, 0.04);
    if (result.x >= 0.0 && result.y > 0.0) {
        let smooth_count = result.x + 1.0 - log2(0.5 * log2(result.y));
        let t = frame.parameters.y * smooth_count + frame.view.w;
        let palette = 0.5 + 0.5 * cos(6.2831853 * (vec3<f32>(t) + vec3<f32>(0.0, 0.16, 0.32)));
        let brightness = 0.18 + 0.82 * (1.0 - exp(-0.08 * max(smooth_count, 0.0)));
        color = pow(palette * brightness, vec3<f32>(0.8));
    }
    return vec4<f32>(color * opacity, opacity);
}

fn filtered_color(position: vec2<f32>) -> vec4<f32> {
    // Texture coordinates name texel edges; their centers lie at n + 0.5.
    let centered = position - 0.5;
    let base = vec2<i32>(floor(centered));
    let weight = fract(centered);
    return mix(mix(shaded_sample(base), shaded_sample(base + vec2<i32>(1, 0)), weight.x),
        mix(shaded_sample(base + vec2<i32>(0, 1)), shaded_sample(base + vec2<i32>(1, 1)), weight.x), weight.y);
}

@fragment
fn fragment_main(@builtin(position) pixel: vec4<f32>) -> @location(0) vec4<f32> {
    if (reprojection.current.w < 0.5) { discard; }
    let uv = (2.0 * pixel.xy - frame.screen.xy) / frame.screen.y;
    let size = vec2<f32>(textureDimensions(escape_cache));
    let cache_uv = uv * reprojection.current.z + reprojection.current.xy;
    let position = (cache_uv * reprojection.visible_sizes.y + size) * 0.5;
    let footprint = reprojection.current.z * reprojection.visible_sizes.y / frame.screen.y;
    var color = filtered_color(position);
    if (footprint > 1.0) {
        // Bounded 2x2 footprint sampling handles the moderately minified
        // neighboring levels selected by the display scheduler.
        let spread = min(footprint, 4.0) * 0.25;
        let minified = 0.25 * (filtered_color(position + vec2<f32>(-spread, -spread)) +
            filtered_color(position + vec2<f32>(spread, -spread)) +
            filtered_color(position + vec2<f32>(-spread, spread)) +
            filtered_color(position + vec2<f32>(spread, spread)));
        // A hard filter switch made fine edges pop as the same cached image
        // crossed the threshold during a zoom. Blend kernels continuously.
        color = mix(color, minified, smoothstep(1.0, 2.0, footprint));
    }
    if (color.a <= 0.00001) { discard; }
    var edge = 1.0;
    if (reprojection.previous.z > 0.0) {
        let distance = min(position, size - position);
        edge = smoothstep(0.0, max(1.0, footprint) * 8.0, min(distance.x, distance.y));
    }
    return vec4<f32>(color.rgb / color.a, color.a * edge);
}
