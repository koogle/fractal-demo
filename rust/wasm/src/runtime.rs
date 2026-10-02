//! Numeric rendering configuration and uniform packing. No browser handles.
use std::cell::RefCell;
static mut VALUES: [f64; 12] = [0.0; 12];
static mut COMPUTE: [u32; 24] = [0; 24];
fn output(values: &[f64]) -> *const f64 {
    unsafe {
        core::ptr::copy_nonoverlapping(
            values.as_ptr(),
            core::ptr::addr_of_mut!(VALUES).cast(),
            values.len(),
        );
    }
    core::ptr::addr_of!(VALUES).cast()
}
#[unsafe(no_mangle)]
pub extern "C" fn render_config(storage: f64, buffer: f64, workgroups: f64) -> *const f64 {
    let batch = 1023.0_f64
        .min((storage / 32768.0).floor())
        .min((buffer / 32768.0).floor())
        .min((workgroups / 64.0).floor())
        .max(1.0);
    output(&[
        1073741824.0,
        8.0,
        48.0,
        batch,
        batch * 32768.0,
        batch.min(128.0),
        140.0,
    ])
}
#[unsafe(no_mangle)]
pub extern "C" fn render_size(width: f64, height: f64, dpr: f64, limit: f64) -> *const f64 {
    let scale = dpr.min(1.5).min(1600.0 / width.max(height).max(1.0));
    output(&[
        (width * scale).round().max(1.0).min(limit),
        (height * scale).round().max(1.0).min(limit),
    ])
}
#[unsafe(no_mangle)]
pub extern "C" fn job_geometry(width: f64, height: f64, extent: f64) -> *const f64 {
    let px = (width * (extent - 1.0) / 2.0).ceil();
    let py = (height * (extent - 1.0) / 2.0).ceil();
    let w = width + 2.0 * px;
    let h = height + 2.0 * py;
    let tiles = (w / 64.0).ceil() * (h / 64.0).ceil();
    output(&[w, h, px, py, w * h * 8.0, tiles, tiles * 4.0])
}
// Copy bytes, not float values: center coordinates contain exact packed integers.
#[unsafe(no_mangle)]
pub extern "C" fn compute_input_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(COMPUTE).cast()
}
#[unsafe(no_mangle)]
pub extern "C" fn compute_frame(
    width: f32,
    height: f32,
    next: f32,
    reference: f32,
    px: f32,
    py: f32,
    visible_width: f32,
    visible_height: f32,
    seconds: f32,
) -> *const u32 {
    unsafe {
        let f = &mut *core::ptr::addr_of_mut!(COMPUTE);
        for (i, v) in [width, height, next, reference].into_iter().enumerate() {
            f[i] = v.to_bits();
        }
        for (i, v) in [px, py, visible_width, visible_height]
            .into_iter()
            .enumerate()
        {
            f[16 + i] = v.to_bits();
        }
        f[23] = seconds.to_bits();
    }
    core::ptr::addr_of!(COMPUTE).cast()
}
thread_local! { static SETTINGS: RefCell<Option<[u32;4]>> = const { RefCell::new(None) }; }
#[unsafe(no_mangle)]
pub extern "C" fn render_invalidate() {
    SETTINGS.with(|s| *s.borrow_mut() = None);
}
#[unsafe(no_mangle)]
pub extern "C" fn render_settings_changed(width: u32, height: u32) -> u32 {
    let frame = unsafe { &*core::ptr::addr_of!(super::FRAME) };
    let key = [
        width,
        height,
        frame.parameters[0].to_bits(),
        frame.fractal[0].to_bits(),
    ];
    SETTINGS.with(|s| {
        let mut s = s.borrow_mut();
        let changed = *s != Some(key);
        *s = Some(key);
        changed as u32
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn render_moving(now: f64, last_input: f64, dragging: u32) -> u32 {
    (dragging != 0 || now < last_input + 180.0) as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn navigation_wheel(
    delta: f64,
    mode: u32,
    pinch: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> *const f64 {
    let unit = match mode {
        1 => 16.0,
        2 => height,
        _ => 1.0,
    };
    let factor = (delta * unit * if pinch != 0 { 0.01 } else { 0.002 })
        .clamp(-0.5, 0.5)
        .exp();
    let ax = (2.0 * x - width) / height.max(1.0);
    let ay = (height - 2.0 * y) / height.max(1.0);
    super::zoom_at(factor, ax, ay);
    output(&[if factor < 1.0 { 0.7 } else { 1.0 / 0.7 }, ax, ay])
}
#[unsafe(no_mangle)]
pub extern "C" fn navigation_drag(dx: f64, dy: f64, height: f64) {
    if height > 0.0 {
        super::drag(-2.0 * dx / height, 2.0 * dy / height);
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn render_continue(jobs: u32, hidden: u32) -> u32 {
    (jobs > 0 && hidden == 0) as u32
}
