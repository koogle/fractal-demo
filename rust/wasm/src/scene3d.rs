//! Independent 3D camera and shader ABI; the 2D camera never changes here.
use std::cell::RefCell;
const SHADER: &str = include_str!("mandelbulb.wgsl");
#[derive(Clone, Copy)]
struct Camera {
    target: [f64; 3],
    yaw: f64,
    pitch: f64,
    distance: f64,
    power: f32,
    iterations: f32,
}
const HOME: Camera = Camera {
    target: [0.0; 3],
    yaw: 0.55,
    pitch: 0.25,
    distance: 3.4,
    power: 8.0,
    iterations: 12.0,
};
thread_local! { static CAMERA: RefCell<Camera> = const { RefCell::new(HOME) }; }
struct Light {
    phase: f32,
    previous: Option<f32>,
    enabled: bool,
}
thread_local! { static LIGHT: RefCell<Light> = const { RefCell::new(Light { phase: -0.65, previous: None, enabled: true }) }; }
static mut FRAME: [[f32; 4]; 7] = [[0.0; 4]; 7];
#[unsafe(no_mangle)]
pub extern "C" fn scene3d_light(enabled: u32) {
    LIGHT.with(|l| {
        let mut l = l.borrow_mut();
        l.enabled = enabled != 0;
        l.previous = None;
    });
}
fn basis(c: &Camera) -> ([f64; 3], [f64; 3], [f64; 3]) {
    let (sy, cy) = c.yaw.sin_cos();
    let (sp, cp) = c.pitch.sin_cos();
    (
        [cy, 0.0, -sy],
        [-sy * sp, cp, -cy * sp],
        [-sy * cp, -sp, -cy * cp],
    )
}
// Conservative CPU counterpart of the shader DE for camera collision only.
// Sweep the whole movement, not just the endpoint, so large wheel events cannot tunnel.
// Keep a small precision guard above the f32 ray marcher’s hit threshold.
const CAMERA_CLEARANCE: f64 = 0.00002;
fn eye(c: &Camera) -> [f64; 3] {
    let (_, _, forward) = basis(c);
    std::array::from_fn(|i| c.target[i] - forward[i] * c.distance)
}
fn length(p: [f64; 3]) -> f64 {
    p.iter().map(|v| v * v).sum::<f64>().sqrt()
}
fn clearance(p: [f64; 3], c: &Camera) -> f64 {
    let outside = length(p) - 2.0;
    if outside > 0.0 {
        return outside;
    }
    let mut z = p;
    let mut derivative = 1.0;
    let mut radius = 0.0;
    let power = f64::from(c.power);
    for _ in 0..c.iterations as usize {
        radius = length(z);
        if radius > 4.0 {
            break;
        }
        if radius < 1e-12 {
            return 0.0;
        }
        let theta = (z[1] / radius).clamp(-1.0, 1.0).acos() * power;
        let phi = z[2].atan2(z[0]) * power;
        let raised = radius.powf(power - 1.0);
        derivative = raised * power * derivative + 1.0;
        z = [
            radius * raised * theta.sin() * phi.cos() + p[0],
            radius * raised * theta.cos() + p[1],
            radius * raised * theta.sin() * phi.sin() + p[2],
        ];
    }
    let distance = 0.5 * radius.max(1e-12).ln() * radius / derivative;
    if distance.is_finite() {
        distance.max(0.0)
    } else {
        0.0
    }
}
fn navigation_span(c: &Camera) -> f64 {
    (clearance(eye(c), c) - CAMERA_CLEARANCE)
        .max(CAMERA_CLEARANCE * 0.25)
        .min(c.distance)
}
fn sweep(from: [f64; 3], to: [f64; 3], c: &Camera) -> f64 {
    let delta = std::array::from_fn(|i| to[i] - from[i]);
    let total = length(delta);
    if total < 1e-12 {
        return 1.0;
    }
    let mut traveled = 0.0;
    for _ in 0..192 {
        let p = std::array::from_fn(|i| from[i] + delta[i] * traveled / total);
        let safe = (clearance(p, c) - CAMERA_CLEARANCE) * 0.2;
        if safe <= 1e-7 {
            // At the stopping boundary, allow a tiny step only if it increases
            // clearance. Otherwise zooming back out could get stuck too.
            let probe = (traveled + CAMERA_CLEARANCE * 0.25).min(total);
            let q = std::array::from_fn(|i| from[i] + delta[i] * probe / total);
            if clearance(q, c) > clearance(p, c) + 1e-9 {
                traveled = probe;
                if traveled >= total {
                    return 1.0;
                }
                continue;
            }
            break;
        }
        if traveled + safe >= total {
            return 1.0;
        }
        traveled += safe;
    }
    traveled / total
}
fn move_camera(c: &mut Camera, next: Camera) {
    // Subdivide orbits into short arcs as well as sweeping pan/dolly segments.
    let start = *c;
    let count = ((next.yaw - start.yaw)
        .abs()
        .max((next.pitch - start.pitch).abs())
        / 0.04)
        .ceil()
        .clamp(1.0, 160.0) as usize;
    for step in 1..=count {
        let t = step as f64 / count as f64;
        let mut candidate = next;
        candidate.yaw = start.yaw + (next.yaw - start.yaw) * t;
        candidate.pitch = start.pitch + (next.pitch - start.pitch) * t;
        candidate.distance = start.distance + (next.distance - start.distance) * t;
        candidate.target =
            std::array::from_fn(|i| start.target[i] + (next.target[i] - start.target[i]) * t);
        let fraction = sweep(eye(c), eye(&candidate), c);
        if fraction < 1.0 {
            // Dolly/pan are linear in eye space. Keep orbit at the last safe arc.
            if candidate.yaw == c.yaw && candidate.pitch == c.pitch {
                c.distance += (candidate.distance - c.distance) * fraction;
                for i in 0..3 {
                    c.target[i] += (candidate.target[i] - c.target[i]) * fraction;
                }
            }
            break;
        }
        *c = candidate;
    }
    c.yaw = c.yaw.rem_euclid(std::f64::consts::TAU);
}
#[unsafe(no_mangle)]
pub extern "C" fn scene3d_reset() {
    CAMERA.with(|c| *c.borrow_mut() = HOME);
}
#[unsafe(no_mangle)]
pub extern "C" fn scene3d_orbit(dx: f64, dy: f64) {
    if !dx.is_finite() || !dy.is_finite() {
        return;
    }
    CAMERA.with(|c| {
        let mut c = c.borrow_mut();
        let mut next = *c;
        next.yaw -= dx.clamp(-1.0, 1.0) * 3.0;
        next.pitch = (c.pitch + dy * 3.0).clamp(-1.5, 1.5);
        move_camera(&mut c, next);
    });
}
#[unsafe(no_mangle)]
pub extern "C" fn scene3d_pan(dx: f64, dy: f64) {
    if !dx.is_finite() || !dy.is_finite() {
        return;
    }
    CAMERA.with(|c| {
        let mut c = c.borrow_mut();
        let (right, up, _) = basis(&c);
        let span = navigation_span(&c) * 0.9;
        let mut next = *c;
        for i in 0..3 {
            next.target[i] =
                (c.target[i] - right[i] * dx * span + up[i] * dy * span).clamp(-100.0, 100.0);
        }
        move_camera(&mut c, next);
    });
}
#[unsafe(no_mangle)]
pub extern "C" fn scene3d_zoom(factor: f64) {
    if !factor.is_finite() || factor <= 0.0 {
        return;
    }
    CAMERA.with(|c| {
        let mut c = c.borrow_mut();
        let mut next = *c;
        // Approach by a fraction of free space, rather than repeatedly slamming
        // a center-relative dolly step into the collision barrier. Backing out
        // retains the original speed so leaving a close-up is easy.
        let delta = if factor < 1.0 {
            navigation_span(&c) * (factor.max(0.1) - 1.0)
        } else {
            c.distance * (factor - 1.0)
        };
        next.distance = (c.distance + delta).clamp(CAMERA_CLEARANCE, 80.0);
        move_camera(&mut c, next);
    });
}
#[unsafe(no_mangle)]
pub extern "C" fn scene3d_parameters(power: f32, iterations: f32) {
    if !power.is_finite() || !iterations.is_finite() {
        return;
    }
    CAMERA.with(|c| {
        let mut c = c.borrow_mut();
        c.power = power.clamp(2.0, 12.0);
        c.iterations = iterations.clamp(6.0, 24.0).round();
        if clearance(eye(&c), &c) < CAMERA_CLEARANCE {
            c.distance = (length(c.target) + 3.0).min(80.0);
        }
    });
}
#[unsafe(no_mangle)]
pub extern "C" fn scene3d_frame(width: f32, height: f32, moving: u32, seconds: f32) -> *const f32 {
    CAMERA.with(|c| {
        let c = c.borrow();
        let (right, up, forward) = basis(&c);
        let mut values = [[0.0; 4]; 7];
        values[6] = LIGHT.with(|l| {
            let mut l = l.borrow_mut();
            if seconds.is_finite() {
                if l.enabled {
                    l.phase += (seconds - l.previous.unwrap_or(seconds)).max(0.0) * 0.22;
                }
                l.previous = Some(seconds);
                l.phase = l.phase.rem_euclid(std::f32::consts::TAU);
            }
            [3.5 * l.phase.sin(), 2.8, 3.5 * l.phase.cos(), 40.0]
        });
        for i in 0..3 {
            values[0][i] = (c.target[i] - forward[i] * c.distance) as f32;
            values[1][i] = right[i] as f32;
            values[2][i] = up[i] as f32;
            values[3][i] = forward[i] as f32;
        }
        values[4] = [width, height, 0.45, c.distance as f32];
        values[5] = [
            c.power,
            c.iterations,
            if moving != 0 { 112.0 } else { 224.0 },
            if moving != 0 { 1.3 } else { 0.65 },
        ];
        unsafe {
            FRAME = values;
        }
    });
    core::ptr::addr_of!(FRAME).cast::<f32>()
}
#[unsafe(no_mangle)]
pub extern "C" fn scene3d_shader_ptr() -> *const u8 {
    SHADER.as_ptr()
}
#[unsafe(no_mangle)]
pub extern "C" fn scene3d_shader_len() -> usize {
    SHADER.len()
}

// One submitted frame at a time. Browser callbacks supply clocks and viewport
// measurements; all quality, invalidation and refresh decisions live here.
struct Refresh {
    revision: u64,
    rendered: Option<u64>,
    submitted: u64,
    last_input: f64,
    full: bool,
    moving: bool,
    resolution: f64,
}
thread_local! { static REFRESH: RefCell<Refresh> = const { RefCell::new(Refresh {
    revision: 0, rendered: None, submitted: 0, last_input: f64::NEG_INFINITY,
    full: false, moving: false, resolution: 720.0,
}) }; }
static mut RENDER_PLAN: [f64; 4] = [0.0; 4];
#[unsafe(no_mangle)]
pub extern "C" fn scene3d_invalidate(now: f64) {
    REFRESH.with(|r| {
        let mut r = r.borrow_mut();
        r.revision += 1;
        r.last_input = now;
    });
}
#[unsafe(no_mangle)]
pub extern "C" fn scene3d_resume() {
    REFRESH.with(|r| {
        let mut r = r.borrow_mut();
        r.full = false;
        r.rendered = None;
    });
}
#[unsafe(no_mangle)]
pub extern "C" fn scene3d_plan(
    now: f64,
    dragging: u32,
    width: f64,
    height: f64,
    dpr: f64,
    max_dimension: f64,
) -> *const f64 {
    let light = LIGHT.with(|l| l.borrow().enabled);
    REFRESH.with(|r| {
        let mut r = r.borrow_mut();
        let moving = dragging != 0 || now - r.last_input < 160.0;
        let needed = light || r.rendered != Some(r.revision) || (!r.full && !moving);
        let limit = if moving {
            r.resolution
        } else if light {
            1000.0
        } else {
            1400.0
        };
        let scale = dpr.min(limit / width.max(height).max(1.0));
        if needed {
            r.submitted = r.revision;
            r.moving = moving;
        }
        unsafe {
            RENDER_PLAN = [
                needed as u32 as f64,
                (width * scale).round().clamp(1.0, max_dimension),
                (height * scale).round().clamp(1.0, max_dimension),
                moving as u32 as f64,
            ];
        }
    });
    core::ptr::addr_of!(RENDER_PLAN).cast()
}
#[unsafe(no_mangle)]
pub extern "C" fn scene3d_finish(elapsed: f64) -> i32 {
    let light = LIGHT.with(|l| l.borrow().enabled);
    REFRESH.with(|r| {
        let mut r = r.borrow_mut();
        if r.moving {
            r.resolution = (r.resolution * (20.0 / elapsed.max(1.0)).sqrt().clamp(0.8, 1.1))
                .clamp(400.0, 960.0);
        }
        r.rendered = Some(r.submitted);
        r.full = !r.moving;
        if r.rendered != Some(r.revision) {
            0
        } else if light {
            16
        } else if !r.full {
            180
        } else {
            -1
        }
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn scene3d_wheel(dx: f64, dy: f64, mode: u32, shift: u32, pinch: u32, height: f64) {
    if height <= 0.0 {
        return;
    }
    let unit = match mode {
        1 => 16.0,
        2 => height,
        _ => 1.0,
    };
    if shift != 0 && pinch == 0 {
        scene3d_pan(if dx != 0.0 { dx } else { dy } * unit / height, 0.0);
    } else {
        scene3d_zoom(
            (dy * unit * if pinch != 0 { 0.008 } else { 0.002 })
                .clamp(-0.3, 0.3)
                .exp(),
        );
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn scene3d_drag(dx: f64, dy: f64, height: f64, pan: u32) {
    if height <= 0.0 {
        return;
    }
    if pan != 0 {
        scene3d_pan(dx / height, dy / height);
    } else {
        scene3d_orbit(dx / height, dy / height);
    }
}
