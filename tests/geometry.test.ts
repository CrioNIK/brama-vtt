import test from 'node:test';
import assert from 'node:assert/strict';
import { blocksMovement, hasLineOfSight, inLevel, snapPoint, visibilityPolygon } from '../shared/geometry.js';
import type { Scene, Token, Wall } from '../shared/model.js';

function wall(overrides: Partial<Wall> = {}): Wall {
  return { id: 'wall', a: { x: 300, y: 300 }, b: { x: 300, y: 700 }, levelId: 'ground',
    kind: 'wall', state: 'closed', movement: true, sight: true, light: true, sound: true, ...overrides };
}
function scene(walls: Wall[]): Scene {
  return { id: 'scene', name: 'Test', width: 1000, height: 1000, grid: { type: 'square', size: 50, distance: 5, units: 'ft' },
    levels: [{ id: 'ground', name: 'Ground', bottom: 0, top: 20 }], activeLevelId: 'ground', background: '#000000', visionEnabled: true,
    tokens: [], walls, lights: [] };
}
function token(overrides: Partial<Token> = {}): Token {
  return { id: 'token', name: 'Token', x: 100, y: 400, width: 1, height: 1, rotation: 0, color: '#ffffff', levelId: 'ground',
    owners: [], hidden: false, actorId: null, linked: false, hp: 10, maxHp: 10, vision: 500, conditions: [], ...overrides };
}

test('swept footprint blocks large jumps through thin walls', () => {
  assert.equal(blocksMovement(scene([wall()]), token(), { x: 900, y: 400 }), true);
  assert.equal(blocksMovement(scene([wall()]), token(), { x: 250, y: 400 }), false);
});

test('finite endpoints and corner contact use token footprint, not only center ray', () => {
  assert.equal(blocksMovement(scene([wall()]), token({ y: 270 }), { x: 500, y: 270 }), false);
  assert.equal(blocksMovement(scene([wall()]), token({ y: 280 }), { x: 500, y: 280 }), true);
  assert.equal(blocksMovement(scene([wall()]), token({ x: 200, y: 200 }), { x: 275, y: 275 }), true);
});

test('touching tokens can move away or slide but cannot penetrate', () => {
  const state = scene([wall()]), touching = token({ x: 275, y: 400 });
  assert.equal(blocksMovement(state, touching, { x: 100, y: 400 }), false);
  assert.equal(blocksMovement(state, touching, { x: 275, y: 500 }), false);
  assert.equal(blocksMovement(state, touching, { x: 276, y: 400 }), true);
});

test('footprint bounds account for two-cell dimensions', () => {
  const big = token({ width: 2, height: 2 });
  assert.equal(blocksMovement(scene([]), big, { x: 49, y: 300 }), true);
  assert.equal(blocksMovement(scene([]), big, { x: 50, y: 300 }), false);
  assert.equal(blocksMovement(scene([]), big, { x: 960, y: 300 }), true);
});

test('ordinary/secret doors block when closed or locked and pass when open', () => {
  for (const kind of ['door', 'secret'] as const) {
    for (const state of ['closed', 'locked', 'open'] as const) {
      assert.equal(blocksMovement(scene([wall({ kind, state })]), token(), { x: 600, y: 400 }), state !== 'open');
      assert.equal(hasLineOfSight({ x: 100, y: 400 }, { x: 600, y: 400 }, [wall({ kind, state })], 'ground'), state === 'open');
    }
  }
  assert.equal(blocksMovement(scene([wall({ kind: 'wall', state: 'open' })]), token(), { x: 600, y: 400 }), true);
});

test('membership filters use moving token level and shared entities retain one identity', () => {
  assert.equal(blocksMovement(scene([wall({ levelId: 'upper' })]), token(), { x: 600, y: 400 }), false);
  const shared = wall({ levelId: 'upper', levelIds: ['upper', 'ground'] });
  assert.equal(blocksMovement(scene([shared]), token(), { x: 600, y: 400 }), true);
  assert.equal(inLevel(shared, 'upper'), true);
  assert.equal(inLevel({ levelId: 'ground', levelIds: [] }, 'ground'), false);
  assert.equal(inLevel({ levelId: 'ground' }, 'ground'), true);
});

test('LOS blocks endpoint intersections and permits clear routes past finite walls', () => {
  assert.equal(hasLineOfSight({ x: 100, y: 400 }, { x: 600, y: 400 }, [wall()], 'ground'), false);
  assert.equal(hasLineOfSight({ x: 100, y: 299 }, { x: 600, y: 299 }, [wall()], 'ground'), true);
  assert.equal(hasLineOfSight({ x: 100, y: 300 }, { x: 600, y: 300 }, [wall()], 'ground'), false);
});

test('LOS handles collinear overlap and looking away from an origin touch', () => {
  const horizontal = wall({ a: { x: 300, y: 300 }, b: { x: 500, y: 300 } });
  assert.equal(hasLineOfSight({ x: 200, y: 300 }, { x: 600, y: 300 }, [horizontal], 'ground'), false);
  assert.equal(hasLineOfSight({ x: 300, y: 300 }, { x: 100, y: 300 }, [horizontal], 'ground'), true);
  assert.equal(hasLineOfSight({ x: 300, y: 300 }, { x: 300, y: 300 }, [horizontal], 'ground'), true);
});

test('LOS channels respect independent wall restrictions', () => {
  const glass = wall({ sight: false, light: false, movement: true });
  assert.equal(hasLineOfSight({ x: 100, y: 400 }, { x: 600, y: 400 }, [glass], 'ground'), true);
  assert.equal(hasLineOfSight({ x: 100, y: 400 }, { x: 600, y: 400 }, [glass], 'ground', 'movement'), false);
});

test('visibility polygon stays inside radius and clips to closed walls', () => {
  const barrier = wall({ a: { x: 50, y: -100 }, b: { x: 50, y: 100 } });
  const polygon = visibilityPolygon({ x: 0, y: 0 }, 100, [barrier], 'ground');
  assert.ok(polygon.length >= 128);
  assert.ok(polygon.every(p => Math.hypot(p.x, p.y) <= 100 + 1e-6));
  assert.ok(polygon.every(p => p.x <= 50 + 1e-6));
  const open = visibilityPolygon({ x: 0, y: 0 }, 100, [{ ...barrier, kind: 'door', state: 'open' }], 'ground');
  assert.ok(Math.max(...open.map(p => p.x)) > 99);
});

test('light polygon respects the light channel independently of sight and door state', () => {
  const barrier = wall({ a: { x: 50, y: -100 }, b: { x: 50, y: 100 }, sight: false, light: true });
  const origin = { x: 0, y: 0 };
  const vision = visibilityPolygon(origin, 100, [barrier], 'ground');
  assert.ok(Math.max(...vision.map(p => p.x)) > 99, 'transparent sight wall does not clip vision');
  const light = visibilityPolygon(origin, 100, [barrier], 'ground', 'light');
  assert.ok(light.every(p => p.x <= 50 + 1e-6), 'light-blocking wall clips light');
  const nonblocking = visibilityPolygon(origin, 100, [{ ...barrier, light: false }], 'ground', 'light');
  assert.ok(Math.max(...nonblocking.map(p => p.x)) > 99);
  const open = visibilityPolygon(origin, 100, [{ ...barrier, kind: 'door', state: 'open' }], 'ground', 'light');
  assert.ok(Math.max(...open.map(p => p.x)) > 99, 'open door passes light');
  const closed = visibilityPolygon(origin, 100, [{ ...barrier, kind: 'door', state: 'closed' }], 'ground', 'light');
  assert.ok(closed.every(p => p.x <= 50 + 1e-6), 'closed door clips light');
});

test('invalid coordinates are conservative and snap clamps geometric intersections', () => {
  assert.equal(blocksMovement(scene([]), token(), { x: NaN, y: 0 }), true);
  assert.equal(hasLineOfSight({ x: 0, y: 0 }, { x: Infinity, y: 0 }, [], 'ground'), false);
  assert.deepEqual(visibilityPolygon({ x: 0, y: 0 }, 0, [], 'ground'), []);
  assert.deepEqual(snapPoint({ x: 98, y: 130 }, 50, { width: 100, height: 100 }), { x: 100, y: 100 });
  assert.throws(() => snapPoint({ x: 0, y: 0 }, 0));
});
