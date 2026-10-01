mod render_plan;
mod scene3d;
// Rust owns the WGSL source, camera state, and animated palette.
const SHADER: &str = include_str!("demo.wgsl");
const CACHE_EXTENT: f64 = 1.25; // 12.5% of the viewport beyond each edge.
#[repr(C)]
struct Frame {
    screen: [f32; 4],
    view: [f32; 4],
    parameters: [f32; 4],
    center: [u32; 4],
    cache: [f32; 4],
    fractal: [f32; 4],
}
static mut FRAME: Frame = Frame {
    screen: [0.0; 4],
    view: [0.0; 4],
    parameters: [0.0; 4],
    center: [0; 4],
    cache: [0.0; 4],
    fractal: [0.0, -0.8, 0.156, 0.0],
};
static mut SETTINGS: [f32; 4] = [0.0; 4];

// One double-precision center orbit is shared by all GPU pixels. The GPU
// iterates small differences from it rather than repeating software integers.
// Header: complex derivative, number of iterations safe to skip, reserved.
static mut REFERENCE: [[f32; 4]; 1026] = [[0.0; 4]; 1026];
static mut REFERENCE_DOUBLE: [[f64; 2]; 1025] = [[0.0; 2]; 1025];
static mut CAMERA: [f64; 3] = [0.0; 3];
static mut REFERENCE_LENGTH: u32 = 0;
static mut REFERENCE_KEY: (u64, u64, u32) = (0, 0, 0);

#[unsafe(no_mangle)]
pub extern "C" fn reference_ptr(aspect: f64, extent: f64) -> *const f32 {
    with_state(|s| unsafe {
        let key = (s.x.to_bits(), s.y.to_bits(), s.iterations);
        if key != REFERENCE_KEY {
            let reference = &mut *core::ptr::addr_of_mut!(REFERENCE);
            let double = &mut *core::ptr::addr_of_mut!(REFERENCE_DOUBLE);
            let (mut x, mut y) = (0.0_f64, 0.0_f64);
            REFERENCE_LENGTH = 0;
            for i in 0..=s.iterations as usize {
                let norm = x * x + y * y;
                // Precompute the perturbation glitch threshold as well.
                reference[i + 1] = [x as f32, y as f32, (norm * 1.0e-6) as f32, 0.0];
                double[i] = [x, y];
                REFERENCE_LENGTH += 1;
                if norm >= 4.0 {
                    break;
                }
                (x, y) = (x * x - y * y + s.x, 2.0 * x * y + s.y);
            }
            REFERENCE_KEY = key;
        }
        let reference = &mut *core::ptr::addr_of_mut!(REFERENCE);
        reference[0] = [0.0; 4];
        if !aspect.is_finite() || aspect <= 0.0 || !extent.is_finite() || extent < 1.0 {
            return;
        }
        let radius = s.scale * extent * (aspect * aspect + 1.0).sqrt() * 1.01;
        let double = &*core::ptr::addr_of!(REFERENCE_DOUBLE);
        let (mut dx, mut dy, mut bound, mut error) = (0.0_f64, 0.0_f64, 0.0_f64, 0.0_f64);
        // Bound the omitted quadratic term over the entire viewport. Only skip
        // a prefix that cannot escape or encounter cancellation, and whose
        // accumulated approximation error stays below 1e-7 of its delta range.
        for i in 1..REFERENCE_LENGTH as usize {
            let [x, y] = double[i - 1];
            let magnitude = (x * x + y * y).sqrt();
            let next_dx = 2.0 * (x * dx - y * dy) + 1.0;
            let next_dy = 2.0 * (x * dy + y * dx);
            error = 2.0 * magnitude * error + bound * bound;
            bound = 2.0 * magnitude * bound + bound * bound + radius;
            let delta_range = radius * (next_dx * next_dx + next_dy * next_dy).sqrt();
            let [zx, zy] = double[i];
            let z_magnitude = (zx * zx + zy * zy).sqrt();
            if !bound.is_finite()
                || !delta_range.is_finite()
                || error > delta_range * 1.0e-7
                || z_magnitude + bound >= 2.0
                || z_magnitude - bound <= z_magnitude * 0.002
                || next_dx.abs().max(next_dy.abs()) > 1.0e30
            {
                break;
            }
            (dx, dy) = (next_dx, next_dy);
            reference[0] = [dx as f32, dy as f32, i as f32, 0.0];
        }
    });
    core::ptr::addr_of!(REFERENCE).cast::<f32>()
}

#[unsafe(no_mangle)]
pub extern "C" fn reference_data_ptr() -> *const f32 {
    core::ptr::addr_of!(REFERENCE).cast::<f32>()
}

#[unsafe(no_mangle)]
pub extern "C" fn reference_len() -> u32 {
    unsafe { REFERENCE_LENGTH }
}

// Exact f64 camera snapshot for reprojection of previously rendered results.
#[unsafe(no_mangle)]
pub extern "C" fn camera_ptr() -> *const f64 {
    unsafe {
        CAMERA = with_state(|s| [s.x, s.y, s.scale]);
    }
    core::ptr::addr_of!(CAMERA).cast::<f64>()
}

#[derive(Clone, Copy)]
struct State {
    x: f64,
    y: f64,
    scale: f64,
    phase: f32,
    previous_seconds: f32,
    paused: bool,
    iterations: u32,
    density: f32,
    speed: f32,
    fractal: u32,
}

static mut STATE: State = State {
    x: -0.6,
    y: 0.0,
    scale: 1.2,
    phase: 0.0,
    previous_seconds: 0.0,
    paused: false,
    iterations: 384,
    density: 0.025,
    speed: 0.035,
    fractal: 0,
};

fn home(state: &mut State) {
    (state.x, state.y, state.scale) = match state.fractal {
        1 => (0.0, 0.0, 1.2),
        2 => (-0.4, -0.5, 1.6),
        _ => (-0.6, 0.0, 1.2),
    };
}

#[unsafe(no_mangle)]
pub extern "C" fn cache_extent() -> f64 {
    CACHE_EXTENT
}

#[unsafe(no_mangle)]
pub extern "C" fn set_fractal(value: u32) {
    if value > 2 {
        return;
    }
    with_state(|s| {
        s.fractal = value;
        home(s);
    });
}

// Exports are called serially by the browser's main thread; no shared WASM memory.
fn with_state<T>(update: impl FnOnce(&mut State) -> T) -> T {
    unsafe { update(&mut *core::ptr::addr_of_mut!(STATE)) }
}

#[unsafe(no_mangle)]
pub extern "C" fn shader_ptr() -> *const u8 {
    SHADER.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn shader_len() -> usize {
    SHADER.len()
}

#[unsafe(no_mangle)]
pub extern "C" fn uniform_size() -> usize {
    core::mem::size_of::<Frame>()
}

#[unsafe(no_mangle)]
pub extern "C" fn pan(horizontal: f64, vertical: f64) {
    drag(horizontal * 0.25, vertical * 0.25);
}

#[unsafe(no_mangle)]
pub extern "C" fn zoom(factor: f64) {
    zoom_at(factor, 0.0, 0.0);
}

// Coordinates use the shader's height-normalized view space, with positive y up.
#[unsafe(no_mangle)]
pub extern "C" fn drag(horizontal: f64, vertical: f64) {
    if !horizontal.is_finite() || !vertical.is_finite() {
        return;
    }
    with_state(|state| {
        let x = state.x + horizontal * state.scale;
        let y = state.y + vertical * state.scale;
        if x.is_finite() && y.is_finite() {
            state.x = x;
            state.y = y;
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn zoom_at(factor: f64, horizontal: f64, vertical: f64) {
    if !factor.is_finite() || factor <= 0.0 {
        return;
    }
    if !horizontal.is_finite() || !vertical.is_finite() {
        return;
    }
    with_state(|state| {
        let next_scale = state.scale * factor;
        let x = state.x + horizontal * (state.scale - next_scale);
        let y = state.y + vertical * (state.scale - next_scale);
        // Reject numeric overflow/underflow, without imposing a zoom range.
        if next_scale.is_finite() && next_scale > 0.0 && x.is_finite() && y.is_finite() {
            state.x = x;
            state.y = y;
            state.scale = next_scale;
        }
    });
}

// UI snapshot: logarithmic zoom level, iteration limit, palette density, speed.
#[unsafe(no_mangle)]
pub extern "C" fn read_settings() -> *const f32 {
    let values = with_state(|s| {
        [
            (1.2_f64.log2() - s.scale.log2()) as f32,
            s.iterations as f32,
            s.density,
            s.speed,
        ]
    });
    unsafe {
        SETTINGS = values;
    }
    core::ptr::addr_of!(SETTINGS).cast::<f32>()
}

#[unsafe(no_mangle)]
pub extern "C" fn set_zoom_level(value: f64) {
    if !value.is_finite() {
        return;
    }
    let scale = 1.2_f64 * 2.0_f64.powf(-value);
    if scale.is_finite() && scale > 0.0 {
        with_state(|s| s.scale = scale);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn set_iterations(value: f32) {
    if !value.is_finite() {
        return;
    }
    with_state(|s| s.iterations = value.clamp(64.0, 1024.0).round() as u32);
}

#[unsafe(no_mangle)]
pub extern "C" fn set_color_density(value: f32) {
    if !value.is_finite() {
        return;
    }
    with_state(|s| s.density = value.clamp(0.005, 0.08));
}

#[unsafe(no_mangle)]
pub extern "C" fn set_color_speed(value: f32) {
    if !value.is_finite() {
        return;
    }
    with_state(|s| s.speed = value.clamp(0.0, 0.15));
}

#[unsafe(no_mangle)]
pub extern "C" fn explore_detail() {
    with_state(|state| {
        (state.x, state.y, state.scale) = match state.fractal {
            1 => (0.0, 0.0, 0.35),
            2 => (-1.7443359375, -0.017451171875, 0.035),
            _ => (-0.743643887037151, 0.13182590420533, 0.003),
        };
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn toggle_pause() -> u32 {
    with_state(|state| {
        state.paused = !state.paused;
        u32::from(state.paused)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn reset_view() {
    with_state(|state| {
        home(state);
        state.phase = 0.0;
        state.paused = false;
        state.iterations = 384;
        state.density = 0.025;
        state.speed = 0.035;
    });
}

fn fixed_words(value: f64) -> [u32; 2] {
    // Signed Q8.56: enough integer range for escaped Mandelbrot iterates.
    let bits = ((value * 72_057_594_037_927_936.0).round() as i64) as u64;
    [bits as u32, (bits >> 32) as u32]
}

// Matches WGSL Frame: six vec4 blocks, total 96 bytes.
#[unsafe(no_mangle)]
pub extern "C" fn update_frame(width: f32, height: f32, seconds: f32) -> *const f32 {
    let values = with_state(|state| {
        let delta = (seconds - state.previous_seconds).clamp(0.0, 0.1);
        state.previous_seconds = seconds;
        if !state.paused {
            state.phase = (state.phase + delta * state.speed) % 1.0;
        }
        // Switch before rounding the absolute f32 coordinate becomes visible.
        // A fixed zoom threshold allowed different resolutions and centers to
        // lose different amounts of subpixel detail before perturbation began.
        let pixel_span = 2.0 * state.scale / f64::from(height.max(1.0));
        let coordinate_error = f64::from(f32::EPSILON)
            * (state.x.abs().max(state.y.abs()) + state.scale).max(1.0);
        let precise = pixel_span < coordinate_error * 16.0
            && state.x.abs() < 4.0
            && state.y.abs() < 4.0;
        let x = if precise {
            fixed_words(state.x)
        } else {
            [0; 2]
        };
        let y = if precise {
            fixed_words(state.y)
        } else {
            [0; 2]
        };
        Frame {
            screen: [width, height, 0.0, 0.0],
            view: [
                state.x as f32,
                state.y as f32,
                state.scale as f32,
                state.phase,
            ],
            parameters: [
                state.iterations as f32,
                state.density,
                state.speed,
                f32::from(precise),
            ],
            center: [x[0], x[1], y[0], y[1]],
            cache: [0.0, 0.0, width, height],
            fractal: [state.fractal as f32, -0.8, 0.156, 0.0],
        }
    });
    unsafe {
        FRAME = values;
    }
    core::ptr::addr_of!(FRAME).cast::<f32>()
}

// Snapshot a speculative view without moving the user's camera or palette.
// Calls are synchronous and serialized; no state borrow spans another export.
#[unsafe(no_mangle)]
pub extern "C" fn prepare_view(
    x: f64,
    y: f64,
    scale: f64,
    width: f32,
    height: f32,
    aspect: f64,
    extent: f64,
) -> *const f32 {
    let saved = with_state(|s| *s);
    if !x.is_finite() || !y.is_finite() || !scale.is_finite() || scale <= 0.0 {
        return core::ptr::null();
    }
    with_state(|s| {
        s.x = x;
        s.y = y;
        s.scale = scale;
    });
    let pointer = update_frame(width, height, saved.previous_seconds);
    reference_ptr(aspect, extent);
    with_state(|s| *s = saved);
    pointer
}
