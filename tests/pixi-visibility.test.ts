import test from 'node:test';
import assert from 'node:assert/strict';
import type { Point, Scene } from '../shared/model';
import type { SourceRegion } from '../client/tabletop-geometry';
import { lightPaintPlan, observerTerms, sourceTerms, termBounds, type ObserverRegion, type VisibilityTerm } from '../client/renderer/visibility';

const square = (x0: number, y0: number, x1: number, y1: number): Point[] =>
  [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
function inPolygon(p: Point, polygon: readonly Readonly<Point>[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const inTerm = (p: Point, term: VisibilityTerm) => term.polygons.every(poly => inPolygon(p, poly))
  && term.disks.every(disk => distance(p, disk) <= disk.radius);
const inTerms = (p: Point, terms: VisibilityTerm[]) => terms.some(term => inTerm(p, term));
const inSource = (p: Point, region: SourceRegion) => region.closed === null ? inPolygon(p, region.open)
  : inPolygon(p, region.closed) || inPolygon(p, region.open) && distance(p, region) <= (region.attenuationRadius ?? 0);
const region = (x: number, y: number, attenuation: number | null): SourceRegion => ({ x, y,
  open: square(0, 0, 1000, 1000), closed: attenuation === null ? null : square(0, 0, 300, 1000), attenuationRadius: attenuation });

test('source composition preserves a union and fractional disk boundary', () => {
  const source = { x: 500, y: 400, open: square(400, 0, 1000, 1000), closed: square(0, 0, 600, 1000), attenuationRadius: 123.125 };
  const terms = sourceTerms(source);
  for (const point of [{ x: 100, y: 400 }, { x: 500, y: 400 }, { x: 623.125, y: 400 }, { x: 623.125001, y: 400 }, { x: 700, y: 800 }]) {
    assert.equal(inTerms(point, terms), inSource(point, source));
  }
  assert.equal(inTerms({ x: 100, y: 400 }, terms), true, 'closed LOS is not intersected with open LOS');
  assert.equal(inTerms({ x: 623.125001, y: 400 }, terms), false, 'fractional boundary is not rounded outward');
});

test('attenuated light paint uses an isolated overwrite union with positive masks only', () => {
  const source = { x: 500, y: 400, open: square(400, 0, 1000, 1000), closed: square(450, 0, 600, 1000), attenuationRadius: 300 };
  const plan = lightPaintPlan(source);
  assert.equal(plan.isolated, true); assert.equal(plan.overwrite, true);
  assert.equal(plan.terms.length, 2);
  assert.equal(plan.terms.filter(term => inTerm({ x: 500, y: 400 }, term)).length, 2, 'overlap is intentionally idempotent overwrite');
  assert.equal(inTerms({ x: 300, y: 400 }, plan.terms), false, 'being inside attenuation disk cannot bypass both polygons');
  assert.ok(plan.terms.every(term => !('excludedPolygons' in term)), 'no inverse stencil can escape an outer mask');
  const plain = lightPaintPlan({ ...source, closed: null, attenuationRadius: null });
  assert.equal(plain.isolated, false); assert.equal(plain.overwrite, false);
});

test('GPU term plan matches independent visibility composition over range, attenuation and light profiles', () => {
  let checks = 0;
  for (const attenuation of [null, 250, 500]) for (const lampAttenuation of [null, 150, 350])
    for (const intrinsic of [0, 200, Infinity]) for (const perception of [0, 250, Infinity])
      for (const global of [false, true]) for (const full of [false, true]) {
        const observer: ObserverRegion = { id: 'observer', x: 180, y: 400, radius: intrinsic,
          lightPerceptionRadius: perception, full, region: region(180, 400, attenuation) };
        const light = { id: 'lamp', name: 'Lamp', levelId: 'ground', color: '#ffffff', bright: 100, x: 450, y: 400, dim: 350, enabled: true };
        const lightRegion = region(450, 400, lampAttenuation);
        const terms = observerTerms({ globalLightEnabled: global, lights: [light] }, [observer], [{ id: light.id, region: lightRegion }]);
        for (let y = 17; y < 1000; y += 61) for (let x = 19; x < 1000; x += 47) {
          const point = { x, y }, fromObserver = distance(point, observer);
          const lit = global || distance(point, light) <= light.dim && inSource(point, lightRegion);
          const expected = inSource(point, observer.region) && (full || intrinsic > 0 && fromObserver <= intrinsic
            || perception > 0 && fromObserver <= perception && lit);
          assert.equal(inTerms(point, terms), expected); checks++;
        }
      }
  assert.equal(checks, 115668);
});

test('separate observers union their views without transferring light perception between sources', () => {
  const a: ObserverRegion = { id: 'a', x: 100, y: 400, radius: 0, lightPerceptionRadius: 150, full: false, region: region(100, 400, null) };
  const b: ObserverRegion = { ...a, id: 'b', x: 800, radius: 40, lightPerceptionRadius: 0 };
  const scene = { globalLightEnabled: true, lights: [] } satisfies Pick<Scene, 'globalLightEnabled' | 'lights'>;
  const terms = observerTerms(scene, [a, b], []);
  assert.equal(inTerms({ x: 240, y: 400 }, terms), true);
  assert.equal(inTerms({ x: 810, y: 400 }, terms), true);
  assert.equal(inTerms({ x: 900, y: 400 }, terms), false, 'second observer must not inherit first observer perception');
  assert.equal(inTerms({ x: 400, y: 400 }, terms), false);
});

test('disabled, zero-radius and missing-region lamps cannot reveal dark areas', () => {
  const observer: ObserverRegion = { id: 'o', x: 100, y: 400, radius: 0, lightPerceptionRadius: Infinity, full: false, region: region(100, 400, null) };
  const light = { id: 'lamp', name: 'Lamp', levelId: 'ground', color: '#ffffff', bright: 100, x: 450, y: 400, dim: 350, enabled: true };
  const regions = [{ id: light.id, region: region(450, 400, null) }];
  assert.deepEqual(observerTerms({ lights: [{ ...light, enabled: false }] }, [observer], regions), []);
  assert.deepEqual(observerTerms({ lights: [{ ...light, dim: 0 }] }, [observer], regions), []);
  assert.deepEqual(observerTerms({ lights: [light] }, [observer], []), []);
  assert.deepEqual(observerTerms({ lights: [light] }, [{ ...observer, lightPerceptionRadius: 0 }], regions), []);
});

test('maximum lit intersection keeps both attenuation disks, lamp reach and observer perception', () => {
  const observer: ObserverRegion = { id: 'o', x: 100, y: 400, radius: 0, lightPerceptionRadius: 450, full: false, region: region(100, 400, 300) };
  const light = { id: 'lamp', name: 'Lamp', levelId: 'ground', color: '#ffffff', bright: 100, x: 450, y: 400, dim: 350, enabled: true };
  const terms = observerTerms({ lights: [light] }, [observer], [{ id: light.id, region: region(450, 400, 400) }]);
  assert.equal(terms.length, 4);
  assert.equal(Math.max(...terms.map(term => term.disks.length)), 4, 'all four analytic restrictions reach the GPU plan');
  assert.equal(Math.max(...terms.map(term => term.polygons.length)), 2);
});

test('term bounds intersect scene, polygon and disk bounds and fail closed for malformed geometry', () => {
  const term: VisibilityTerm = { polygons: [square(-100, 50, 600, 800), square(100, 0, 900, 900)], disks: [{ x: 300, y: 400, radius: 150.25 }] };
  assert.deepEqual(termBounds(term, 1000, 1000), { left: 149.75, top: 249.75, right: 450.25, bottom: 550.25 });
  assert.equal(termBounds({ polygons: [[]], disks: [] }, 1000, 1000), null);
  assert.equal(termBounds({ polygons: [square(NaN, 0, 500, 500)], disks: [] }, 1000, 1000), null);
  assert.equal(termBounds({ ...term, disks: [{ x: 300, y: 400, radius: 0 }] }, 1000, 1000), null);
  assert.equal(termBounds({ ...term, disks: [{ x: 300, y: 400, radius: NaN }] }, 1000, 1000), null);
});
