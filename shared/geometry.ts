import type { Point, Scene, Token, Wall, WallDirection, WallSenseMode } from './model.js';

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

/** Mode only; door state and level membership are applied separately. Movement remains boolean. */
export function effectiveWallSenseMode(wall: Wall, channel: WallChannel): WallSenseMode {
  const mode = channel === 'movement' ? undefined : wall.senseModes?.[channel];
  if (mode === undefined) return wall[channel] ? 'normal' : 'none';
  // Malformed persisted overrides fail closed. Commands and imports accept only these three modes.
  return mode === 'none' || mode === 'limited' ? mode : 'normal';
}

/** Legacy or malformed persisted directions retain a two-sided barrier. */
export function effectiveWallDirection(wall: Pick<Wall, 'direction'>): WallDirection {
  return wall.direction === 'left' || wall.direction === 'right' ? wall.direction : 'both';
}

/** Whether a wall can contribute a crossing; one limited crossing alone does not block. */
export function wallBlocks(wall: Wall, levelId: string, channel: WallChannel): boolean {
  return inLevel(wall, levelId) && effectiveWallSenseMode(wall, channel) !== 'none'
    && !(wall.kind !== 'wall' && wall.state === 'open');
}

/** Point-source eligibility before intersection/LIMITED counting.
 * In screen coordinates (y down), cross(B-A, source-A)<0 is the left side,
 * and >0 is the right side. An origin on the infinite supporting line does
 * not contribute a point-query barrier, including BOTH. Coordinates retain
 * their fractional precision; this does not reproduce native integer rounding.
 */
export function wallBlocksFrom(wall: Wall, origin: Point, levelId: string, channel: WallChannel): boolean {
  if (!wallBlocks(wall, levelId, channel)) return false;
  const side = cross(sub(wall.b, wall.a), sub(origin, wall.a));
  if (!Number.isFinite(side)) return true;
  if (side === 0) return false;
  const direction = effectiveWallDirection(wall);
  return direction === 'both' || (direction === 'left' ? side < 0 : side > 0);
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

/** First blocking ray parameter, shared by point visibility and sampled polygons.
 * A normal crossing blocks immediately; the first distinct limited crossing passes and the second blocks.
 * BRAMA counts coincident hits (within EPS scene pixels) once, including joined endpoints and duplicate segments.
 * This tie policy is our own contract, not a claim of equivalence to another engine's coincident-hit behavior.
 */
export function firstBlockingWallHit(
  origin: Point, target: Point, walls: Wall[], levelId: string, channel: WallChannel = 'sight',
): number | null {
  if (!finitePoint(origin) || !finitePoint(target)) return 0;
  const length = Math.hypot(target.x - origin.x, target.y - origin.y);
  if (length <= EPS) return null;
  let nearestNormal: number | null = null;
  const limited: number[] = [];
  for (const wall of walls) {
    if (!wallBlocksFrom(wall, origin, levelId, channel)) continue;
    const t = segmentHit(origin, target, wall.a, wall.b);
    if (t === null || t <= EPS) continue;
    if (effectiveWallSenseMode(wall, channel) === 'limited') limited.push(t);
    else nearestNormal = nearestNormal === null ? t : Math.min(nearestNormal, t);
  }
  limited.sort((a, b) => a - b);
  const first = limited[0];
  for (let i = 1; i < limited.length; i++) {
    if ((limited[i] - first) * length > EPS) return nearestNormal === null ? limited[i] : Math.min(nearestNormal, limited[i]);
  }
  return nearestNormal;
}

export function hasLineOfSight(
  origin: Point, target: Point, walls: Wall[], levelId: string, channel: WallChannel = 'sight',
): boolean {
  return firstBlockingWallHit(origin, target, walls, levelId, channel) === null;
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
    || (observer.vision > 0 && Math.hypot(target.x - observer.x, target.y - observer.y) <= observer.vision)
    || isPointIlluminated(scene, target, levelId);
}

/** The rendered token body is a disk inside its occupied cells; labels and selection bounds are not its body. */
export function tokenBodyRadius(token: Pick<Token, 'width' | 'height'>, gridSize: number): number {
  if (!Number.isFinite(gridSize) || gridSize <= 0 || !Number.isFinite(token.width) || token.width <= 0
      || !Number.isFinite(token.height) || token.height <= 0) return 0;
  const radius = Math.min(token.width, token.height) * gridSize * .42;
  return Number.isFinite(radius) ? radius : 0;
}

/** Samples inside the visible body, excluding labels, stroke and empty selection-rectangle corners.
 * Half-cell spacing adapts to token size, capped at four rings of 64 points plus the center.
 * This bounded approximation can miss an aperture between samples; it is not exact disk/visibility intersection.
 */
export function tokenVisibilityPoints(token: Pick<Token, 'x' | 'y' | 'width' | 'height'>, gridSize: number): Point[] {
  const radius = tokenBodyRadius(token, gridSize);
  if (!finitePoint(token) || radius <= 0) return [];
  const points: Point[] = [{ x: token.x, y: token.y }];
  const insideRadius = radius - Math.min(1, radius * .05);
  const spacing = gridSize / 2;
  const rings = Math.min(4, Math.max(1, Math.ceil(insideRadius / spacing)));
  // Check the outer body first: partial cover is commonly resolved there.
  for (let ring = rings; ring > 0; ring--) {
    const r = insideRadius * ring / rings;
    const count = Math.min(64, Math.max(8, Math.ceil(TAU * r / spacing / 8) * 8));
    for (let i = 0; i < count; i++) {
      const angle = i * TAU / count;
      points.push({ x: token.x + Math.cos(angle) * r, y: token.y + Math.sin(angle) * r });
    }
  }
  return points;
}

/** Geometric visibility only. Projection separately enforces hidden flags and ownership privileges. */
export function canTokenSeeToken(scene: Scene, observer: Token, target: Token): boolean {
  if (observer.visionEnabled === false || observer.levelId !== target.levelId || !finitePoint(observer)
      || !finitePoint(target) || tokenBodyRadius(target, scene.grid.size) <= 0) return false;
  // Most unobstructed targets need one ray and no footprint allocation.
  if (canTokenSeePoint(scene, observer, target, target.levelId)) return true;
  return tokenVisibilityPoints(target, scene.grid.size).some(point => canTokenSeePoint(scene, observer, point, target.levelId));
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
  // Movement uses the starting token center for the one-way side gate, then
  // tests the entire swept footprint. A BOTH wall remains SAT-active even
  // when that center is on its line; point-query exclusion must not weaken
  // the legacy finite-body collision contract.
  return scene.walls.some(wall => wallBlocks(wall, token.levelId, 'movement')
    && (effectiveWallDirection(wall) === 'both' || wallBlocksFrom(wall, token, token.levelId, 'movement'))
    && sweptRectangleHitsWall(token, to, halfW, halfH, wall));
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const edge = sub(b, a), denominator = dot(edge, edge);
  const t = denominator > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), edge) / denominator)) : 0;
  return Math.hypot(p.x - a.x - edge.x * t, p.y - a.y - edge.y * t);
}

/** Second-hit envelopes can have inward corners at intersecting LIMITED walls.
 * Endpoint rays alone join across those corners and reveal a wedge behind both
 * barriers. Bound the pair search; dense cases use conservative normal-wall
 * rendering instead of silently omitting corners. Point visibility is unchanged.
 */
function limitedIntersectionBounds(origin: Point, radius: number, walls: Wall[], channel: WallChannel): Point[] | null {
  const limited = walls.filter(wall => effectiveWallSenseMode(wall, channel) === 'limited').map(wall => ({
    wall, minX: Math.min(wall.a.x, wall.b.x), maxX: Math.max(wall.a.x, wall.b.x),
    minY: Math.min(wall.a.y, wall.b.y), maxY: Math.max(wall.a.y, wall.b.y),
  })).sort((a, b) => a.minX - b.minX);
  const active: typeof limited = [], intersections: Point[] = [];
  let comparisons = 0;
  for (const current of limited) {
    for (let i = active.length - 1; i >= 0; i--) {
      if (++comparisons > 32_768) return null;
      const previous = active[i];
      if (previous.maxX < current.minX - EPS) { active.splice(i, 1); continue; }
      if (previous.maxY < current.minY - EPS || current.maxY < previous.minY - EPS) continue;
      const r = sub(current.wall.b, current.wall.a), s = sub(previous.wall.b, previous.wall.a);
      const denominator = cross(r, s);
      // Collinear overlaps do not exchange the radial order of two barriers.
      if (Math.abs(denominator) <= EPS) continue;
      const offset = sub(previous.wall.a, current.wall.a);
      const t = cross(offset, s) / denominator, u = cross(offset, r) / denominator;
      if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) continue;
      const point = { x: current.wall.a.x + r.x * Math.max(0, Math.min(1, t)), y: current.wall.a.y + r.y * Math.max(0, Math.min(1, t)) };
      const distance = Math.hypot(point.x - origin.x, point.y - origin.y);
      if (distance <= EPS || distance > radius + EPS) continue;
      intersections.push(point);
      if (intersections.length > 2_048) return null;
    }
    active.push(current);
  }
  return intersections;
}

/** Circular visibility approximation; endpoint rays resolve wall corners. */
export function visibilityPolygon(origin: Point, radius: number, walls: Wall[], levelId: string, channel: WallChannel = 'sight'): Point[] {
  if (!finitePoint(origin) || !Number.isFinite(radius) || radius <= 0) return [];
  let relevant = walls.filter(wall => wallBlocksFrom(wall, origin, levelId, channel)
    && distanceToSegment(origin, wall.a, wall.b) <= radius + EPS);
  const intersections = limitedIntersectionBounds(origin, radius, relevant, channel);
  if (intersections === null) relevant = relevant.map(wall => effectiveWallSenseMode(wall, channel) === 'limited'
    ? { ...wall, senseModes: { ...wall.senseModes, [channel]: 'normal' } } : wall);
  const angles: number[] = Array.from({ length: 128 }, (_, i) => i * TAU / 128);
  // Preserve already-normalized values exactly: adding/subtracting TAU again
  // can round an intersection's key and lose its conservative distance bound.
  const normalizeAngle = (angle: number) => { const value = angle % TAU; return value < 0 ? value + TAU : value; };
  const bounds = new Map<number, number>();
  for (const point of intersections ?? []) {
    const angle = normalizeAngle(Math.atan2(point.y - origin.y, point.x - origin.x));
    const distance = Math.hypot(point.x - origin.x, point.y - origin.y);
    // A zero-width coincident ray may pass in point queries. Rendering it as a
    // long polygon vertex would open a finite wedge, so clip it conservatively.
    bounds.set(angle, Math.min(bounds.get(angle) ?? radius, distance));
    angles.push(angle);
  }
  for (const wall of relevant) {
    for (const point of [wall.a, wall.b]) {
      const angle = Math.atan2(point.y - origin.y, point.x - origin.x);
      angles.push(angle - 1e-6, angle, angle + 1e-6);
    }
  }
  const sorted = angles.map(normalizeAngle).sort((a, b) => a - b);
  const polygon: Point[] = [];
  let lastAngle = -Infinity;
  for (const angle of sorted) {
    if (angle === lastAngle || (angle - lastAngle < 1e-10 && !bounds.has(angle))) continue;
    lastAngle = angle;
    const rayRadius = Math.min(radius, bounds.get(angle) ?? radius);
    const end = { x: origin.x + Math.cos(angle) * rayRadius, y: origin.y + Math.sin(angle) * rayRadius };
    const nearest = firstBlockingWallHit(origin, end, relevant, levelId, channel) ?? 1;
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
