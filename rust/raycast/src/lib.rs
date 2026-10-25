//! Batched finite-segment ray queries for BRAMA. Source/channel eligibility is
//! resolved by TypeScript before packing. f64 arithmetic, no SIMD or fast-math.
use std::cell::RefCell;

const EPS: f64 = 1e-8;
const MAX_WALLS: usize = 100_000;
const MAX_RAYS: usize = 1_000_000;

#[derive(Default)]
struct Buffers {
    walls: Vec<f64>, // ax, ay, bx, by, mode (0 normal, 1 limited)
    rays: Vec<f64>,  // target x, target y, length computed by JS Math.hypot
    output: Vec<f64>,
    limited: Vec<f64>,
}
thread_local! { static BUFFERS: RefCell<Buffers> = RefCell::new(Buffers::default()); }

#[unsafe(no_mangle)]
pub extern "C" fn abi_version() -> u32 { 1 }

/// Reserve one batch. Inputs are written through the exported pointers after
/// this call. No allocation may occur between obtaining pointers and execution.
#[unsafe(no_mangle)]
pub extern "C" fn prepare(walls: u32, rays: u32) -> u32 {
    let (walls, rays) = (walls as usize, rays as usize);
    if walls > MAX_WALLS || rays > MAX_RAYS { return 1; }
    BUFFERS.with(|storage| {
        let mut buffers = storage.borrow_mut();
        buffers.walls.resize(walls * 5, 0.0);
        buffers.rays.resize(rays * 3, 0.0);
        buffers.output.resize(rays, -1.0);
        buffers.limited.clear();
        if buffers.limited.capacity() < walls { buffers.limited.reserve(walls); }
    });
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn walls_ptr() -> *mut f64 { BUFFERS.with(|b| b.borrow_mut().walls.as_mut_ptr()) }
#[unsafe(no_mangle)]
pub extern "C" fn rays_ptr() -> *mut f64 { BUFFERS.with(|b| b.borrow_mut().rays.as_mut_ptr()) }
#[unsafe(no_mangle)]
pub extern "C" fn output_ptr() -> *const f64 { BUFFERS.with(|b| b.borrow().output.as_ptr()) }

fn cross(ax: f64, ay: f64, bx: f64, by: f64) -> f64 { ax * by - ay * bx }

fn intersection(ox: f64, oy: f64, tx: f64, ty: f64, wall: &[f64]) -> Option<f64> {
    let (rx, ry) = (tx - ox, ty - oy);
    let (sx, sy) = (wall[2] - wall[0], wall[3] - wall[1]);
    let (ax, ay) = (wall[0] - ox, wall[1] - oy);
    let rr = rx * rx + ry * ry;
    if rr <= EPS * EPS { return None; }
    let denominator = cross(rx, ry, sx, sy);
    if denominator.abs() <= EPS {
        if cross(ax, ay, rx, ry).abs() > EPS { return None; }
        let mut lo = (ax * rx + ay * ry) / rr;
        let mut hi = ((wall[2] - ox) * rx + (wall[3] - oy) * ry) / rr;
        if lo > hi { std::mem::swap(&mut lo, &mut hi); }
        if hi < -EPS || lo > 1.0 + EPS { return None; }
        return Some(if lo.max(0.0) <= EPS && hi > EPS { hi.min(EPS * 2.0) } else { lo.max(0.0) });
    }
    let t = cross(ax, ay, sx, sy) / denominator;
    let u = cross(ax, ay, rx, ry) / denominator;
    if t < -EPS || t > 1.0 + EPS || u < -EPS || u > 1.0 + EPS { return None; }
    Some(t.clamp(0.0, 1.0))
}

fn batch(ox: f64, oy: f64, buffers: &mut Buffers) {
    for (index, ray) in buffers.rays.chunks_exact(3).enumerate() {
        let mut normal = f64::INFINITY;
        buffers.limited.clear();
        if ray[2] <= EPS { buffers.output[index] = -1.0; continue; }
        for wall in buffers.walls.chunks_exact(5) {
            if let Some(t) = intersection(ox, oy, ray[0], ray[1], wall) {
                if t <= EPS { continue; }
                if wall[4] == 1.0 { buffers.limited.push(t); }
                else { normal = normal.min(t); }
            }
        }
        buffers.limited.sort_unstable_by(f64::total_cmp);
        if let Some(first) = buffers.limited.first() {
            for t in buffers.limited.iter().skip(1) {
                if (t - first) * ray[2] > EPS { normal = normal.min(*t); break; }
            }
        }
        buffers.output[index] = if normal.is_infinite() { -1.0 } else { normal };
    }
}

/// No caller pointers are dereferenced. The prepared arrays remain owned by
/// this module. The bridge validates finite inputs and canonical wall modes.
#[unsafe(no_mangle)]
pub extern "C" fn cast(ox: f64, oy: f64) -> u32 {
    BUFFERS.with(|storage| batch(ox, oy, &mut storage.borrow_mut()));
    0
}

#[cfg(any(test, feature = "contract-tests"))]
mod tests {
    use super::*;
    fn query(walls: &[f64]) -> f64 {
        let mut b = Buffers { walls: walls.to_vec(), rays: vec![300.0, 0.0, 300.0], output: vec![0.0], limited: vec![] };
        batch(0.0, 0.0, &mut b); b.output[0]
    }
    pub fn contracts() {
        assert_eq!(query(&[100.0,-50.0,100.0,50.0,1.0]), -1.0);
        assert_eq!(query(&[100.0,-50.0,100.0,50.0,1.0,200.0,-50.0,200.0,50.0,1.0]), 2.0/3.0);
        assert_eq!(query(&[100.0,-50.0,100.0,50.0,1.0,100.0,-50.0,100.0,50.0,1.0]), -1.0);
        assert_eq!(query(&[100.0,-50.0,100.0,50.0,1.0,150.0,-50.0,150.0,50.0,0.0]), 0.5);
        assert_eq!(query(&[100.0,-50.0,100.0,50.0,1.0,100.0+1e-9,-50.0,100.0+1e-9,50.0,1.0]), -1.0);
        assert!(query(&[100.0,-50.0,100.0,50.0,1.0,100.0+1e-7,-50.0,100.0+1e-7,50.0,1.0]) > 0.0);
        assert_eq!(query(&[300.0,-50.0,300.0,50.0,0.0]), 1.0);
        assert_eq!(query(&[100.0,1.0,200.0,1.0,0.0]), -1.0);
        assert_eq!(query(&[100.0,0.0,200.0,0.0,0.0]), 1.0/3.0);
        assert_eq!(query(&[0.0,-50.0,0.0,50.0,0.0]), -1.0);
    }
    #[test]
    fn limited_crossings_and_normal_order() { contracts(); }
}

/// Optional test artifact only; the distributed production module omits this export.
#[cfg(feature = "contract-tests")]
#[unsafe(no_mangle)]
pub extern "C" fn run_contract_tests() -> u32 { tests::contracts(); 10 }
