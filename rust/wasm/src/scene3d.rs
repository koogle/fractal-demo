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
const CAMERA_CLEARANCE: f64 = 0.006;
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
            let probe = (traveled + 0.0001).min(total);
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
        let span = c.distance * 0.9;
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
        next.distance = (c.distance * factor).clamp(0.02, 80.0);
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
