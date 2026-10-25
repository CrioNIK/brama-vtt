/** Packed finite-segment kernel. Eligibility (level, door, side, threshold) stays in geometry.ts. */
export const RAYCAST_EPS = 1e-8;
export interface RaycastKernel {
  readonly name: 'wasm';
  cast(originX: number, originY: number, walls: Float64Array, rays: Float64Array): Float64Array;
}
export interface RaycastBackendStatus {
  backend: 'typescript' | 'wasm'; wasmBatches: number; wasmRays: number;
  fallbackBatches: number; fallbackRays: number; error: string | null;
}
let kernel: RaycastKernel | null = null;
const status: RaycastBackendStatus = { backend: 'typescript', wasmBatches: 0, wasmRays: 0, fallbackBatches: 0, fallbackRays: 0, error: null };
export function getRaycastBackendStatus(): Readonly<RaycastBackendStatus> { return { ...status }; }
/** Explicit installation; the server never loads a browser kernel implicitly. */
export function installRaycastKernel(value: RaycastKernel | null, error: string | null = null): void {
  kernel = value; status.backend = value?.name ?? 'typescript'; status.error = error;
}
export function resetRaycastBackendCounters(): void {
  status.wasmBatches = status.wasmRays = status.fallbackBatches = status.fallbackRays = 0;
}

function segmentParameter(ox: number, oy: number, tx: number, ty: number, walls: Float64Array, offset: number): number | null {
  const rx = tx - ox, ry = ty - oy, sx = walls[offset + 2] - walls[offset], sy = walls[offset + 3] - walls[offset + 1];
  const ax = walls[offset] - ox, ay = walls[offset + 1] - oy, rr = rx * rx + ry * ry;
  if (rr <= RAYCAST_EPS * RAYCAST_EPS) return null;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) <= RAYCAST_EPS) {
    if (Math.abs(ax * ry - ay * rx) > RAYCAST_EPS) return null;
    let lo = (ax * rx + ay * ry) / rr, hi = ((walls[offset + 2] - ox) * rx + (walls[offset + 3] - oy) * ry) / rr;
    if (lo > hi) [lo, hi] = [hi, lo];
    if (hi < -RAYCAST_EPS || lo > 1 + RAYCAST_EPS) return null;
    return Math.max(0, lo) <= RAYCAST_EPS && hi > RAYCAST_EPS ? Math.min(hi, RAYCAST_EPS * 2) : Math.max(0, lo);
  }
  const t = (ax * sy - ay * sx) / denominator, u = (ax * ry - ay * rx) / denominator;
  return t < -RAYCAST_EPS || t > 1 + RAYCAST_EPS || u < -RAYCAST_EPS || u > 1 + RAYCAST_EPS
    ? null : Math.max(0, Math.min(1, t));
}

/** Independent TypeScript reference; -1 is no hit, t in [0,1] is a blocking crossing.
 * walls: [ax,ay,bx,by,mode] (0 normal, 1 limited). rays: [targetX,targetY,length].
 * Ray lengths are supplied from Math.hypot, preserving the scene-pixel EPS tie rule.
 */
export function castRayBatchReference(ox: number, oy: number, walls: Float64Array, rays: Float64Array): Float64Array {
  const result = new Float64Array(rays.length / 3), limited: number[] = [];
  for (let ray = 0; ray < result.length; ray++) {
    const offset = ray * 3, length = rays[offset + 2];
    if (length <= RAYCAST_EPS) { result[ray] = -1; continue; }
    let normal = Infinity;
    limited.length = 0;
    for (let wall = 0; wall < walls.length; wall += 5) {
      const t = segmentParameter(ox, oy, rays[offset], rays[offset + 1], walls, wall);
      if (t === null || t <= RAYCAST_EPS) continue;
      if (walls[wall + 4] === 1) limited.push(t); else normal = Math.min(normal, t);
    }
    limited.sort((a, b) => a - b);
    for (let i = 1; i < limited.length; i++) {
      if ((limited[i] - limited[0]) * length > RAYCAST_EPS) { normal = Math.min(normal, limited[i]); break; }
    }
    result[ray] = normal === Infinity ? -1 : normal;
  }
  return result;
}

export function validateRayBatch(ox: number, oy: number, walls: Float64Array, rays: Float64Array): void {
  if (!Number.isFinite(ox) || !Number.isFinite(oy) || walls.length % 5 || rays.length % 3
      || walls.length / 5 > 100_000 || rays.length / 3 > 1_000_000) throw new RangeError('Invalid ray batch dimensions');
  for (let i = 0; i < walls.length; i++) {
    if (!Number.isFinite(walls[i]) || (i % 5 === 4 && walls[i] !== 0 && walls[i] !== 1)) throw new RangeError('Invalid packed wall');
  }
  for (let i = 0; i < rays.length; i++) {
    if (!Number.isFinite(rays[i]) || (i % 3 === 2 && rays[i] < 0)) throw new RangeError('Invalid packed ray');
  }
}

/** One backend call per source batch, with observable fallback on a failed kernel. */
export function castRayBatch(ox: number, oy: number, walls: Float64Array, rays: Float64Array): Float64Array {
  validateRayBatch(ox, oy, walls, rays);
  if (kernel) {
    try {
      const values = kernel.cast(ox, oy, walls, rays);
      if (values.length !== rays.length / 3 || values.some(value => !Number.isFinite(value) || (value !== -1 && (value < 0 || value > 1)))) {
        throw new Error('Invalid ray kernel result');
      }
      status.wasmBatches++; status.wasmRays += values.length;
      return values;
    } catch (error) {
      installRaycastKernel(null, error instanceof Error ? error.message : String(error));
    }
  }
  status.fallbackBatches++; status.fallbackRays += rays.length / 3;
  return castRayBatchReference(ox, oy, walls, rays);
}
