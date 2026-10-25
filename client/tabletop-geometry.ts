import type { Member, Point, Scene } from '../shared/model';
import { prepareWallSource, wallSourcePolygons, type WallChannel } from '../shared/geometry';

export interface SourceRegion {
  readonly x: number;
  readonly y: number;
  readonly open: readonly Readonly<Point>[];
  readonly closed: readonly Readonly<Point>[] | null;
  readonly attenuationRadius: number | null;
}
export interface SourceGeometryRequest {
  origin: Point; radius: number; rayRadius: number; channel: WallChannel; externalRadius?: number;
}
export const TABLETOP_GEOMETRY_CACHE_LIMITS = Object.freeze({ entries: 128, points: 100_000, keyCharacters: 1_000_000 });
type Limits = typeof TABLETOP_GEOMETRY_CACHE_LIMITS;
interface ObjectSnapshot {
  object: object;
  prototype: object | null;
  properties: { name: string; value: unknown; enumerable: boolean }[];
}

/** A retained frame may be used after an in-place edit. Check descriptors without
 * rebuilding the large serialized wall key or invoking accessors. */
function snapshotsUnchanged(snapshots: readonly ObjectSnapshot[]): boolean {
  for (const snapshot of snapshots) {
    const { object, prototype, properties } = snapshot;
    if (Object.getPrototypeOf(object) !== prototype || Object.getOwnPropertySymbols(object).length
        || Object.getOwnPropertyNames(object).length !== properties.length) return false;
    for (const property of properties) {
      const descriptor = Object.getOwnPropertyDescriptor(object, property.name);
      if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== property.enumerable
          || !Object.is(descriptor.value, property.value)) return false;
    }
  }
  return true;
}

/** Exact typed encoding, without JSON's NaN/null, missing/undefined or -0/0 collisions.
 * Exotic/accessor/cyclic data is deliberately uncacheable; geometry keeps its own validation.
 */
function semanticKey(value: unknown, limit: number, snapshots?: ObjectSnapshot[]): string | null {
  const parts: string[] = [], ancestors = new Set<object>();
  const captured = snapshots ? new Set<object>() : null;
  let length = 0;
  const append = (part: string) => { length += part.length; if (length > limit) return false; parts.push(part); return true; };
  function encode(item: unknown, depth: number): boolean {
    if (depth > 64) return false;
    if (item === null) return append('n;');
    if (item === undefined) return append('u;');
    if (typeof item === 'string') return append(`s${item.length}:${item}`);
    if (typeof item === 'number') return append(`d${Object.is(item, -0) ? '-0' : String(item)};`);
    if (typeof item === 'boolean') return append(item ? 'b1;' : 'b0;');
    if (typeof item !== 'object' || ancestors.has(item) || Object.getOwnPropertySymbols(item).length) return false;
    const prototype = Object.getPrototypeOf(item);
    if (Array.isArray(item) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
    if (snapshots && !captured!.has(item)) {
      const properties: ObjectSnapshot['properties'] = [];
      for (const name of Object.getOwnPropertyNames(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, name)!;
        if (!('value' in descriptor)) return false;
        properties.push({ name, value: descriptor.value, enumerable: !!descriptor.enumerable });
      }
      snapshots.push({ object: item, prototype, properties }); captured!.add(item);
    }
    ancestors.add(item);
    let valid = true;
    if (Array.isArray(item)) {
      const names = Object.getOwnPropertyNames(item);
      if (names.some(name => name !== 'length' && (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= item.length))) valid = false;
      valid = valid && append(`a${item.length}[`);
      for (let i = 0; valid && i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        valid = descriptor ? 'value' in descriptor && encode(descriptor.value, depth + 1) : append('h;');
      }
      valid = valid && append(']');
    } else {
      const names = Object.getOwnPropertyNames(item).sort();
      valid = append(`${prototype === null ? 'z' : 'o'}${names.length}{`);
      for (const name of names) {
        if (!valid) break;
        const descriptor = Object.getOwnPropertyDescriptor(item, name)!;
        // Object.keys participates in threshold validation; changing only an unknown
        // property's enumerability can change whether a wall fails closed.
        valid = 'value' in descriptor && encode(name, depth + 1) && append(descriptor.enumerable ? 'e1;' : 'e0;')
          && encode(descriptor.value, depth + 1);
      }
      valid = valid && append('}');
    }
    ancestors.delete(item);
    return valid;
  }
  return encode(value, 0) ? parts.join('') : null;
}

function immutableRegion(request: SourceGeometryRequest, scene: Scene): SourceRegion {
  const source = prepareWallSource(request.origin, request.radius, scene.walls, scene.activeLevelId, request.channel, request.externalRadius ?? 0);
  const polygons = wallSourcePolygons(source, request.rayRadius);
  const freezePoints = (points: Point[]) => Object.freeze(points.map(point => Object.freeze(point)));
  return Object.freeze({ x: request.origin.x, y: request.origin.y,
    open: freezePoints(polygons.open), closed: polygons.closed === null ? null : freezePoints(polygons.closed),
    attenuationRadius: source.attenuationRadius });
}

function cacheableRequest(request: SourceGeometryRequest): boolean {
  // Read descriptors first: accessor-backed source fields can change between key
  // creation and geometry evaluation, and object-valued coordinates are not immutable scalars.
  const value = (object: object, key: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  };
  const origin = value(request, 'origin');
  if (!origin || typeof origin !== 'object' || typeof value(origin, 'x') !== 'number'
      || typeof value(origin, 'y') !== 'number' || typeof value(request, 'radius') !== 'number'
      || typeof value(request, 'rayRadius') !== 'number') return false;
  const channel = value(request, 'channel');
  if (!['sight', 'light', 'sound', 'movement'].includes(channel)) return false;
  const external = Object.getOwnPropertyDescriptor(request, 'externalRadius');
  return external ? 'value' in external && (external.value === undefined || typeof external.value === 'number')
    : !('externalRadius' in request);
}

/** Per-Tabletop bounded LRU of immutable geometry only, never authorization or token closures. */
export class TabletopGeometryCache {
  private context: string | null = null;
  private entries = new Map<string, { region: SourceRegion; points: number }>();
  private points = 0;
  private keyCharacters = 0;
  private wallKeyBuilds = 0;
  private readonly limits: { entries: number; points: number; keyCharacters: number };

  constructor(limits: Partial<{ [K in keyof Limits]: number }> = {}) {
    const bounded = (key: keyof Limits) => {
      const value = limits[key] ?? TABLETOP_GEOMETRY_CACHE_LIMITS[key];
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid geometry cache bound');
      return Math.min(value, TABLETOP_GEOMETRY_CACHE_LIMITS[key]);
    };
    this.limits = { entries: bounded('entries'), points: bounded('points'), keyCharacters: bounded('keyCharacters') };
  }

  /** Work counter for controlled renderer checks; not a timing measurement. */
  getDiagnostics(): Readonly<{ wallKeyBuilds: number }> { return { wallKeyBuilds: this.wallKeyBuilds }; }

  forScene(scene: Scene, member: Pick<Member, 'id' | 'role'>) {
    // Level matching uses strict equality. A malformed object-valued level must
    // not be reduced to a value key that loses its identity relationship to walls.
    const context = typeof scene.id === 'string' && typeof scene.activeLevelId === 'string'
      && typeof member.id === 'string' && (member.role === 'gm' || member.role === 'player')
      ? semanticKey([scene.id, member.id, member.role, scene.activeLevelId], this.limits.keyCharacters) : null;
    if (context === null || context !== this.context) {
      this.entries.clear(); this.points = 0; this.keyCharacters = 0; this.context = context;
    }
    // Each forScene call is a fresh render/batch boundary: never trust wall-array
    // identity across snapshots. Build lazily so unused GM/disabled masks do no work.
    let wallSnapshot: { root: unknown; key: string | null; objects: ObjectSnapshot[] } | null = null;
    const wallsKeyAtLookup = () => {
      const walls = scene.walls;
      if (wallSnapshot?.root === walls && (wallSnapshot.key === null || snapshotsUnchanged(wallSnapshot.objects))) return wallSnapshot.key;
      const objects: ObjectSnapshot[] = [];
      const key = semanticKey(walls, this.limits.keyCharacters, objects);
      this.wallKeyBuilds++;
      wallSnapshot = { root: walls, key, objects: key === null ? [] : objects };
      return key;
    };
    return {
      region: (request: SourceGeometryRequest): SourceRegion => {
        // Content is checked at lookup, including in-place changes. No mutable input
        // references or source closures are retained in cache entries.
        const wallsKey = wallsKeyAtLookup();
        const sourceKey = cacheableRequest(request) ? semanticKey([request.origin.x, request.origin.y, request.radius, request.rayRadius,
          request.externalRadius ?? 0, scene.activeLevelId, request.channel], this.limits.keyCharacters) : null;
        // A frame accessor must not reuse entries after another scene/member context took over.
        const key = context !== null && this.context === context && typeof scene.activeLevelId === 'string'
          && ['sight', 'light', 'sound', 'movement'].includes(request.channel) && wallsKey !== null && sourceKey !== null
          ? `${wallsKey.length}:${wallsKey}${sourceKey}` : null;
        if (key !== null) {
          const cached = this.entries.get(key);
          if (cached) { this.entries.delete(key); this.entries.set(key, cached); return cached.region; }
        }
        const region = immutableRegion(request, scene);
        const points = region.open.length + (region.closed?.length ?? 0);
        if (key === null || key.length > this.limits.keyCharacters || points > this.limits.points) return region;
        while (this.entries.size >= this.limits.entries || this.points + points > this.limits.points
            || this.keyCharacters + key.length > this.limits.keyCharacters) {
          const oldest = this.entries.entries().next().value;
          if (!oldest) break;
          this.entries.delete(oldest[0]); this.points -= oldest[1].points; this.keyCharacters -= oldest[0].length;
        }
        this.entries.set(key, { region, points }); this.points += points; this.keyCharacters += key.length;
        return region;
      },
    };
  }
}
