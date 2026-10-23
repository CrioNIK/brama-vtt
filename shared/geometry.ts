import type { Point, Scene, Token, Wall } from './model.js';

export type WallChannel = 'movement' | 'sight' | 'light' | 'sound';
const EPS = 1e-8;
const TAU = Math.PI * 2;
const finitePoint = (p: Point): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);
const cross = (a: Point, b: Point): number => a.x * b.y - a.y * b.x;
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;

/** Explicit membership takes precedence; empty means no inferred membership. */
export function inLevel(entity: { levelId: string; levelIds?: string[] }, levelId: string): boolean {
  return entity.levelIds === undefined ? entity.levelId === levelId : entity.levelIds.includes(levelId);
}

export function wallBlocks(wall: Wall, levelId: string, channel: WallChannel): boolean {
  return inLevel(wall, levelId) && wall[channel]
    && !(wall.kind !== 'wall' && wall.state === 'open');
}

/** Nearest intersection parameter on [p,q], including collinear overlap. */
function segmentHit(p: Point, q: Point, a: Point, b: Point): number | null {
  const r = sub(q, p), s = sub(b, a), ap = sub(a, p);
  const rr = dot(r, r);
  if (rr <= EPS * EPS) return null;
  const denominator = cross(r, s);
  if (Math.abs(denominator) <= EPS) {
    if (Math.abs(cross(ap, r)) > EPS) return null;
    let lo = dot(ap, r) / rr, hi = dot(sub(b, p), r) / rr;
    if (lo > hi) [lo, hi] = [hi, lo];
    if (hi < -EPS || lo > 1 + EPS) return null;
    // An overlap continuing beyond the origin blocks; an isolated touch at
    // the origin does not prevent looking away from a wall.
    return Math.max(0, lo) <= EPS && hi > EPS ? Math.min(hi, EPS * 2) : Math.max(0, lo);
  }
  const t = cross(ap, s) / denominator, u = cross(ap, r) / denominator;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return Math.max(0, Math.min(1, t));
}

export function hasLineOfSight(
  origin: Point, target: Point, walls: Wall[], levelId: string, channel: WallChannel = 'sight',
): boolean {
  if (!finitePoint(origin) || !finitePoint(target)) return false;
  if (Math.hypot(target.x - origin.x, target.y - origin.y) <= EPS) return true;
  return !walls.some(wall => {
    if (!wallBlocks(wall, levelId, channel)) return false;
    const t = segmentHit(origin, target, wall.a, wall.b);
    return t !== null && t > EPS;
  });
}

/** Basic illumination at a point; no shader intensity, darkness curves or perceptual thresholds. */
export function isPointIlluminated(scene: Scene, target: Point, levelId: string): boolean {
  if (!finitePoint(target)) return false;
  if (scene.globalLightEnabled === true) return true;
  return scene.lights.some(light => light.enabled && inLevel(light, levelId)
    && light.dim > 0 && Math.hypot(target.x - light.x, target.y - light.y) <= light.dim
    && hasLineOfSight(light, target, scene.walls, levelId, 'light'));
}

/** A basic-sight observer sees through sight LOS inside intrinsic vision, or at illuminated targets.
 * An intrinsic range of zero is enabled sight relying on external light, not disabled vision.
 */
export function canTokenSeePoint(scene: Scene, observer: Token, target: Point, levelId = observer.levelId): boolean {
  if (observer.visionEnabled === false || observer.levelId !== levelId || !finitePoint(observer) || !finitePoint(target)) return false;
  if (!hasLineOfSight(observer, target, scene.walls, levelId, 'sight')) return false;
  return observer.visionUnlimited === true
    || Math.hypot(target.x - observer.x, target.y - observer.y) <= observer.vision
    || isPointIlluminated(scene, target, levelId);
}

/** Continuous SAT: moving axis-aligned rectangle against a finite segment. */
function sweptRectangleHitsWall(from: Point, to: Point, halfW: number, halfH: number, wall: Wall): boolean {
  const edge = sub(wall.b, wall.a), length = Math.hypot(edge.x, edge.y);
  if (length <= EPS) return false;
  const axes: Point[] = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -edge.y / length, y: edge.x / length }];
  const velocity = sub(to, from);
  let enter = -Infinity, exit = Infinity;
  for (const axis of axes) {
    const radius = Math.abs(axis.x) * halfW + Math.abs(axis.y) * halfH;
    const first = dot(wall.a, axis), second = dot(wall.b, axis);
    const low = Math.min(first, second) - radius, high = Math.max(first, second) + radius;
    const start = dot(from, axis), speed = dot(velocity, axis);
    if (Math.abs(speed) <= EPS) {
      if (start < low - EPS || start > high + EPS) return false;
      // Sliding exactly along a supporting boundary does not penetrate it.
      if (Math.abs(start - low) <= EPS || Math.abs(start - high) <= EPS) return false;
      continue;
    }
    let t0 = (low - start) / speed, t1 = (high - start) / speed;
    if (t0 > t1) [t0, t1] = [t1, t0];
    enter = Math.max(enter, t0);
    exit = Math.min(exit, t1);
    if (enter > exit + EPS) return false;
  }
  // Contact at t=0 while moving away is permitted; corner/end contact during
  // the move is conservative and blocks. No fixed-step sampling or tunneling.
  return exit > EPS && enter <= 1 + EPS && exit >= Math.max(0, enter) - EPS;
}

/** Token x/y are its CENTER; width/height are grid cells. Rotation is visual. */
export function blocksMovement(scene: Scene, token: Token, to: Point): boolean {
  if (!finitePoint(token) || !finitePoint(to) || !Number.isFinite(scene.grid.size)
      || scene.grid.size <= 0 || !Number.isFinite(token.width) || !Number.isFinite(token.height)
      || token.width <= 0 || token.height <= 0 || !Number.isFinite(scene.width) || !Number.isFinite(scene.height)) return true;
  const halfW = token.width * scene.grid.size / 2, halfH = token.height * scene.grid.size / 2;
  if (to.x - halfW < -EPS || to.y - halfH < -EPS
      || to.x + halfW > scene.width + EPS || to.y + halfH > scene.height + EPS) return true;
  if (Math.hypot(to.x - token.x, to.y - token.y) <= EPS) return false;
  return scene.walls.some(wall => wallBlocks(wall, token.levelId, 'movement')
    && sweptRectangleHitsWall(token, to, halfW, halfH, wall));
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const edge = sub(b, a), denominator = dot(edge, edge);
  const t = denominator > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), edge) / denominator)) : 0;
  return Math.hypot(p.x - a.x - edge.x * t, p.y - a.y - edge.y * t);
}

/** Circular visibility approximation; endpoint rays resolve wall corners. */
export function visibilityPolygon(origin: Point, radius: number, walls: Wall[], levelId: string, channel: WallChannel = 'sight'): Point[] {
  if (!finitePoint(origin) || !Number.isFinite(radius) || radius <= 0) return [];
  const relevant = walls.filter(wall => wallBlocks(wall, levelId, channel)
    && distanceToSegment(origin, wall.a, wall.b) <= radius + EPS);
  const angles: number[] = Array.from({ length: 128 }, (_, i) => i * TAU / 128);
  for (const wall of relevant) {
    for (const point of [wall.a, wall.b]) {
      const angle = Math.atan2(point.y - origin.y, point.x - origin.x);
      angles.push(angle - 1e-6, angle, angle + 1e-6);
    }
  }
  const sorted = angles.map(a => ((a % TAU) + TAU) % TAU).sort((a, b) => a - b);
  const polygon: Point[] = [];
  let lastAngle = -Infinity;
  for (const angle of sorted) {
    if (angle - lastAngle < 1e-10) continue;
    lastAngle = angle;
    const end = { x: origin.x + Math.cos(angle) * radius, y: origin.y + Math.sin(angle) * radius };
    let nearest = 1;
    for (const wall of relevant) {
      const t = segmentHit(origin, end, wall.a, wall.b);
      if (t !== null && t > EPS) nearest = Math.min(nearest, t);
    }
    polygon.push({ x: origin.x + (end.x - origin.x) * nearest, y: origin.y + (end.y - origin.y) * nearest });
  }
  return polygon;
}

/** Snap a geometric point to intersections, not to token-cell centers. */
export function snapPoint(point: Point, gridSize: number, bounds?: { width: number; height: number }): Point {
  if (!finitePoint(point) || !Number.isFinite(gridSize) || gridSize <= 0) throw new Error('Invalid snap coordinates or grid size');
  const result = { x: Math.round(point.x / gridSize) * gridSize, y: Math.round(point.y / gridSize) * gridSize };
  if (bounds) {
    if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width < 0 || bounds.height < 0) throw new Error('Invalid snap bounds');
    result.x = Math.max(0, Math.min(bounds.width, result.x));
    result.y = Math.max(0, Math.min(bounds.height, result.y));
  }
  return result;
}
