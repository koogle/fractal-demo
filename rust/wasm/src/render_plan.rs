//! Rendering policy, independent of browser/WebGPU resource handles.
//! JS copies image metadata into INPUT and executes decisions from OUTPUT.
use std::cell::RefCell;
const CAPACITY: usize = 128;
const STRIDE: usize = 16;
static mut INPUT: [[f64; STRIDE]; CAPACITY] = [[0.0; STRIDE]; CAPACITY];
static mut OUTPUT: [f64; CAPACITY + 8] = [0.0; CAPACITY + 8];
#[derive(Clone)]
struct Image {
    id: u32,
    camera: [f64; 3],
    height: f64,
    texture: [f64; 2],
    complete: bool,
    active: bool,
    next: f64,
    total: f64,
    bytes: f64,
    used: f64,
    completed: f64,
}
impl Image {
    fn pitch(&self) -> f64 {
        self.camera[2] / self.height
    }
    fn fits(&self, camera: [f64; 3], width: f64, height: f64, max: f64) -> bool {
        fits(
            self.camera,
            self.height,
            self.texture,
            camera,
            width,
            height,
            max,
        )
    }
}
fn fits(
    source: [f64; 3],
    source_height: f64,
    texture: [f64; 2],
    camera: [f64; 3],
    width: f64,
    height: f64,
    max: f64,
) -> bool {
    let ratio = camera[2] / source[2];
    (camera[0] - source[0]).abs() / source[2] + width / height * ratio <= texture[0] / source_height
        && (camera[1] - source[1]).abs() / source[2] + ratio <= texture[1] / source_height
        && height / (source_height * ratio) <= max
}
#[derive(Default)]
struct Planner {
    images: Vec<Image>,
    camera: [f64; 3],
    width: f64,
    height: f64,
    now: f64,
    base: u32,
    detail: u32,
    since: f64,
    previous: Option<(f64, f64)>,
    rate: f64,
}
thread_local! { static PLAN: RefCell<Planner> = RefCell::new(Planner::default()); }
fn output(values: &[f64]) -> *const f64 {
    assert!(values.len() <= CAPACITY + 8);
    unsafe {
        core::ptr::copy_nonoverlapping(
            values.as_ptr(),
            core::ptr::addr_of_mut!(OUTPUT).cast::<f64>(),
            values.len(),
        );
    }
    core::ptr::addr_of!(OUTPUT).cast::<f64>()
}
impl Planner {
    fn image(&self, id: u32) -> Option<&Image> {
        self.images.iter().find(|i| i.id == id)
    }
    fn covers(&self, i: &Image, max: f64) -> bool {
        i.fits(self.camera, self.width, self.height, max)
    }
    fn intersects(&self, i: &Image) -> bool {
        let ratio = self.camera[2] / i.camera[2];
        (self.camera[0] - i.camera[0]).abs() / i.camera[2]
            < i.texture[0] / i.height + self.width / self.height * ratio
            && (self.camera[1] - i.camera[1]).abs() / i.camera[2] < i.texture[1] / i.height + ratio
    }
    fn score(&self, i: &Image) -> f64 {
        (i.pitch() / (self.camera[2] / self.height)).ln().abs()
            + if self.covers(i, f64::INFINITY) {
                0.0
            } else {
                1.0
            }
            + if i.complete { 0.0 } else { 0.15 }
    }
    fn cached(&self) -> (u32, u32) {
        let mut covering: Vec<_> = self
            .images
            .iter()
            .filter(|i| i.complete && self.covers(i, f64::INFINITY))
            .collect();
        covering.sort_by(|a, b| a.pitch().total_cmp(&b.pitch()));
        let ready = covering
            .iter()
            .find(|i| self.covers(i, 1.05))
            .map_or(0, |i| i.id);
        let displayed = if ready != 0 {
            ready
        } else {
            covering.first().map_or_else(
                || {
                    self.images
                        .iter()
                        .rev()
                        .find(|i| !i.active)
                        .map_or(0, |i| i.id)
                },
                |i| i.id,
            )
        };
        (ready, displayed)
    }
    fn select(&mut self, fade: f64) -> Vec<f64> {
        let mut jobs: Vec<_> = self.images.iter().filter(|i| i.active).cloned().collect();
        let priority = |i: &Image| {
            (if self.covers(i, 1.25) { 0.0 } else { 10.0 })
                + (i.camera[2] / self.camera[2]).ln().abs()
                - i.next / i.total
        };
        jobs.sort_by(|a, b| priority(a).total_cmp(&priority(b)));
        let available: Vec<_> = self
            .images
            .iter()
            .filter(|i| i.complete)
            .cloned()
            .chain(jobs.iter().cloned())
            .collect();
        let covering: Vec<_> = available
            .iter()
            .filter(|i| i.complete && self.covers(i, f64::INFINITY))
            .collect();
        if self.image(self.base).is_none() {
            self.base = covering
                .iter()
                .min_by(|a, b| self.score(a).total_cmp(&self.score(b)))
                .map_or_else(|| jobs.first().map_or(0, |i| i.id), |i| i.id);
        }
        if !available
            .iter()
            .any(|i| i.id == self.detail && self.intersects(i))
        {
            self.detail = 0;
        }
        let mut better: Vec<_> = available
            .iter()
            .filter(|i| i.id != self.base && self.intersects(i))
            .collect();
        better.sort_by(|a, b| {
            self.score(a)
                .total_cmp(&self.score(b))
                .then(a.id.cmp(&b.id))
        });
        let current = self.camera[2] / self.height;
        if let Some(d) = self.image(self.detail) {
            if d.pitch() / current > 1.5 && better.iter().any(|i| i.pitch() < d.pitch() * 0.8) {
                self.detail = 0;
            }
        }
        if let Some(d) = self.image(self.detail) {
            if d.complete
                && (self.covers(d, f64::INFINITY)
                    || self.image(self.base).is_some_and(|base| {
                        d.pitch() > base.pitch() && !self.covers(base, f64::INFINITY)
                    }))
                && self.now - self.since.max(d.completed) >= fade
            {
                self.base = self.detail;
                self.detail = 0;
            }
        }
        if let Some(d) = self.image(self.detail) {
            if self.now - self.since > fade
                && covering
                    .iter()
                    .any(|i| i.id != self.base && self.covers(i, 1.05))
                && !self.covers(d, f64::INFINITY)
            {
                self.detail = 0;
            }
        }
        if self.detail == 0 {
            if let Some(base) = self.image(self.base) {
                let next = better.iter().find(|i| {
                    i.id != self.base
                        && (i.pitch() < base.pitch() * 0.92
                            || !self.covers(base, f64::INFINITY)
                            || (base.pitch() < current * 0.65
                                && self.score(i) + 0.15 < self.score(base)))
                });
                if let Some(next) = next {
                    if !self.covers(base, 1.05) || base.pitch() < current * 0.65 {
                        self.detail = next.id;
                        self.since = self.now;
                    }
                }
            }
        }
        let urgent = if self.detail != 0 {
            self.detail
        } else {
            self.base
        };
        if let Some(index) = jobs
            .iter()
            .position(|i| i.id == urgent && self.covers(i, 1.05))
        {
            let job = jobs.remove(index);
            jobs.insert(0, job);
        }
        let mut result = vec![
            self.base as f64,
            self.detail as f64,
            self.since,
            jobs.len() as f64,
        ];
        result.extend(jobs.iter().map(|i| i.id as f64));
        result
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn planner_input_ptr() -> *mut f64 {
    core::ptr::addr_of_mut!(INPUT).cast::<f64>()
}
#[unsafe(no_mangle)]
pub extern "C" fn planner_capacity() -> u32 {
    CAPACITY as u32
}
#[unsafe(no_mangle)]
pub extern "C" fn planner_reset() {
    PLAN.with(|p| *p.borrow_mut() = Planner::default());
}
#[unsafe(no_mangle)]
pub extern "C" fn planner_load(
    count: u32,
    x: f64,
    y: f64,
    scale: f64,
    width: f64,
    height: f64,
    now: f64,
) {
    PLAN.with(|p| {
        let mut p = p.borrow_mut();
        p.camera = [x, y, scale];
        p.width = width;
        p.height = height;
        p.now = now;
        p.images.clear();
        for n in 0..(count as usize).min(CAPACITY) {
            let v = unsafe { *core::ptr::addr_of!(INPUT).cast::<[f64; STRIDE]>().add(n) };
            p.images.push(Image {
                id: v[0] as u32,
                camera: [v[1], v[2], v[3]],
                height: v[4],
                texture: [v[5], v[6]],
                complete: v[7] != 0.0,
                active: v[8] != 0.0,
                next: v[9],
                total: v[10],
                bytes: v[11],
                used: v[12],
                completed: v[13],
            });
        }
    });
}
#[unsafe(no_mangle)]
pub extern "C" fn planner_cached() -> *const f64 {
    PLAN.with(|p| {
        let (a, b) = p.borrow().cached();
        output(&[a as f64, b as f64])
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn planner_select(fade: f64) -> *const f64 {
    PLAN.with(|p| output(&p.borrow_mut().select(fade)))
}
#[unsafe(no_mangle)]
pub extern "C" fn planner_evict(
    reserved: f64,
    budget: f64,
    limit: u32,
    protected: u32,
) -> *const f64 {
    PLAN.with(|p| {
        let p = p.borrow();
        let cached: Vec<_> = p.images.iter().filter(|i| !i.active).collect();
        let mut bytes = reserved + cached.iter().map(|i| i.bytes).sum::<f64>();
        let mut count = cached.len();
        let mut candidates: Vec<_> = cached
            .into_iter()
            .filter(|i| i.id != protected && i.id != p.base && i.id != p.detail)
            .collect();
        candidates.sort_by(|a, b| a.used.total_cmp(&b.used));
        let mut result = vec![0.0];
        for image in candidates {
            if bytes <= budget && count <= limit as usize {
                break;
            }
            bytes -= image.bytes;
            count -= 1;
            result.push(image.id as f64);
        }
        result[0] = (result.len() - 1) as f64;
        output(&result)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn planner_fits(
    sx: f64,
    sy: f64,
    ss: f64,
    sh: f64,
    tw: f64,
    th: f64,
    x: f64,
    y: f64,
    s: f64,
    w: f64,
    h: f64,
    max: f64,
) -> u32 {
    fits([sx, sy, ss], sh, [tw, th], [x, y, s], w, h, max) as u32
}
#[unsafe(no_mangle)]
pub extern "C" fn planner_targets(
    x: f64,
    y: f64,
    scale: f64,
    now: f64,
    moving: u32,
    ax: f64,
    ay: f64,
    direction: f64,
    count: u32,
) -> *const f64 {
    PLAN.with(|p| {
        let mut p = p.borrow_mut();
        let mut direction = direction;
        if let Some((previous, time)) = p.previous {
            let rate = (previous / scale).ln() / ((now - time) / 1000.0).max(0.001);
            p.rate = 0.65 * p.rate + 0.35 * rate.clamp(-8.0, 8.0);
            if rate.abs() > 0.01 {
                direction = if rate > 0.0 { 0.7 } else { 1.0 / 0.7 };
            }
        }
        p.previous = Some((scale, now));
        let sign = if direction < 1.0 { 1 } else { -1 };
        let step = (-((p.rate.abs() * 0.12).clamp(0.16, 0.42))).exp();
        let count = count.min(8);
        let mut result = vec![0.0, direction];
        for index in 0..count {
            let factor = if moving != 0 {
                step.powi(index as i32 * sign)
            } else {
                0.82_f64.powi(if index == count - 1 {
                    -sign
                } else {
                    index as i32 * sign
                })
            };
            let s = scale * factor;
            let target = [x + ax * (scale - s), y + ay * (scale - s), s];
            if s > 0.0 && target.iter().all(|v| v.is_finite()) {
                result.extend(target);
            }
        }
        result[0] = ((result.len() - 2) / 3) as f64;
        output(&result)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn planner_batch_limit(batch: u32, moving: u32) -> u32 {
    batch.min(if moving != 0 { 256 } else { 512 })
}
#[unsafe(no_mangle)]
pub extern "C" fn planner_batch_share(remaining: u32, index: u32, count: u32, ready: u32) -> u32 {
    if index + 1 == count {
        return remaining;
    }
    let fraction = if ready == 0 && index == 0 { 0.85 } else { 0.55 };
    (remaining as f64 * fraction)
        .ceil()
        .min(remaining as f64 - (count - index - 1) as f64)
        .max(1.0) as u32
}
#[unsafe(no_mangle)]
pub extern "C" fn planner_tune_batch(
    tiles: u32,
    elapsed: f64,
    moving: u32,
    max_jobs: u32,
    max_tiles: u32,
) -> u32 {
    let target = if moving != 0 { 8.0 } else { 12.0 };
    ((tiles as f64 * (target / elapsed.max(1.0)).min(1.25)).floor() as u32)
        .min(max_tiles)
        .max(max_jobs)
}
