import type { Point, Scene } from '../../shared/model';
import type { SourceRegion } from '../tabletop-geometry';

export interface AnalyticDisk { x: number; y: number; radius: number }
/** A term is an intersection; the complete list is a union. Disks stay analytic. */
export interface VisibilityTerm {
  polygons: (readonly Readonly<Point>[])[];
  disks: AnalyticDisk[];
}
export interface ObserverRegion {
  id: string; x: number; y: number; radius: number; lightPerceptionRadius: number;
  full: boolean | undefined; region: SourceRegion;
}
export interface LightRegion { id: string; region: SourceRegion }

export function sourceTerms(region: SourceRegion): VisibilityTerm[] {
  if (region.closed === null) return [{ polygons: [region.open], disks: [] }];
  const terms: VisibilityTerm[] = [{ polygons: [region.closed], disks: [] }];
  if (region.attenuationRadius !== null && region.attenuationRadius > 0) {
    terms.push({ polygons: [region.open], disks: [{ x: region.x, y: region.y, radius: region.attenuationRadius }] });
  }
  return terms;
}

/** The same light gradient is written once per covered sample, even where its
 * terms overlap. An isolated overwrite target avoids both doubled alpha and
 * nested inverse stencil masks escaping their outer positive mask. */
export function lightPaintPlan(region: SourceRegion) {
  const terms = sourceTerms(region);
  return { terms, isolated: terms.length > 1, overwrite: terms.length > 1 };
}

function withDisk(term: VisibilityTerm, x: number, y: number, radius: number): VisibilityTerm {
  return Number.isFinite(radius) ? { ...term, disks: [...term.disks, { x, y, radius }] } : term;
}

/** Same unions/intersections as the existing visibility composition; no source is inferred. */
export function observerTerms(scene: Pick<Scene, 'globalLightEnabled' | 'lights'>,
  vision: readonly ObserverRegion[], lightVisibility: readonly LightRegion[]): VisibilityTerm[] {
  const terms: VisibilityTerm[] = [];
  const lights = new Map(lightVisibility.map(light => [light.id, light.region]));
  for (const observer of vision) {
    const sight = sourceTerms(observer.region);
    if (observer.full) { terms.push(...sight); continue; }
    if (observer.radius > 0) terms.push(...sight.map(term => withDisk(term, observer.x, observer.y, observer.radius)));
    if (!(observer.lightPerceptionRadius > 0)) continue;
    if (scene.globalLightEnabled) {
      terms.push(...sight.map(term => withDisk(term, observer.x, observer.y, observer.lightPerceptionRadius)));
      continue;
    }
    for (const light of scene.lights) {
      const region = lights.get(light.id);
      if (!region || !light.enabled || !(light.dim > 0)) continue;
      for (const a of sight) for (const b of sourceTerms(region)) {
        let term: VisibilityTerm = { polygons: [...a.polygons, ...b.polygons], disks: [...a.disks, ...b.disks] };
        term = withDisk(term, light.x, light.y, light.dim);
        terms.push(withDisk(term, observer.x, observer.y, observer.lightPerceptionRadius));
      }
    }
  }
  return terms;
}

/** Tight world-coordinate bounds, including every intersection operand. */
export function termBounds(term: VisibilityTerm, width: number, height: number) {
  let left = 0, top = 0, right = width, bottom = height;
  for (const points of term.polygons) {
    if (points.length < 3) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const point of points) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
      x0 = Math.min(x0, point.x); y0 = Math.min(y0, point.y); x1 = Math.max(x1, point.x); y1 = Math.max(y1, point.y);
    }
    left = Math.max(left, x0); top = Math.max(top, y0); right = Math.min(right, x1); bottom = Math.min(bottom, y1);
  }
  for (const disk of term.disks) {
    if (!(disk.radius > 0) || !Number.isFinite(disk.x) || !Number.isFinite(disk.y)) return null;
    left = Math.max(left, disk.x - disk.radius); top = Math.max(top, disk.y - disk.radius);
    right = Math.min(right, disk.x + disk.radius); bottom = Math.min(bottom, disk.y + disk.radius);
  }
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}
