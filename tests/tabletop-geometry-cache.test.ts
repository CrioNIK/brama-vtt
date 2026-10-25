import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SvgTabletop as Tabletop } from '../client/Tabletop.tsx';
import { TabletopGeometryCache, type SourceGeometryRequest, type SourceRegion } from '../client/tabletop-geometry.ts';
import { prepareWallSource, sceneSourceRadius, tokenExternalRadius, wallSourcePolygons } from '../shared/geometry.ts';
import type { Member, Scene, Token, Wall } from '../shared/model.ts';

const player: Member = { id: 'player', name: 'Player', role: 'player', color: '#ffffff' };
function fixture(): Scene {
  const observer: Token = { id: 'observer', name: 'Observer', x: 200, y: 400, width: 1, height: 1,
    rotation: 0, color: '#ffffff', levelId: 'ground', owners: [player.id], hidden: false, actorId: null,
    linked: false, hp: 10, maxHp: 20, vision: 500, visionRangeOrigin: 'token-edge', conditions: [] };
  return { id: 'scene', name: 'Cache fixture', width: 2000, height: 1200, background: '#20303c',
    grid: { type: 'square', size: 100, distance: 5, units: 'ft' }, activeLevelId: 'ground',
    levels: [{ id: 'ground', name: 'Ground', bottom: 0, top: 10 }, { id: 'upper', name: 'Upper', bottom: 10, top: 20 }],
    visionEnabled: true, tokens: [observer, { ...observer, id: 'observer-b', x: 350, y: 700 }],
    walls: [{ id: 'wall', a: { x: 600, y: 100 }, b: { x: 600, y: 1000 }, levelId: 'ground', kind: 'wall',
      state: 'closed', movement: true, sight: true, light: true, sound: true }],
    lights: [
      { id: 'lamp-a', name: 'Lamp A', x: 300, y: 300, levelId: 'ground', bright: 100, dim: 700, color: '#ffffff', enabled: true },
      { id: 'lamp-b', name: 'Lamp B', x: 1000, y: 700, levelId: 'ground', bright: 200, dim: 600, color: '#ffeedd', enabled: true },
    ] };
}
function sight(scene: Scene, index = 0): SourceGeometryRequest {
  const origin = scene.tokens[index];
  return { origin, radius: sceneSourceRadius(scene), channel: 'sight', externalRadius: tokenExternalRadius(origin, scene.grid.size),
    rayRadius: 2 * (Math.hypot(scene.width, scene.height) + Math.hypot(origin.x, origin.y)) };
}
function lamp(scene: Scene, index = 0): SourceGeometryRequest {
  const origin = scene.lights[index];
  return { origin, radius: Math.min(origin.dim, sceneSourceRadius(scene)), channel: 'light',
    rayRadius: 2 * (Math.hypot(scene.width, scene.height) + Math.hypot(origin.x, origin.y)) };
}
function fresh(scene: Scene, request = sight(scene)): SourceRegion {
  const source = prepareWallSource(request.origin, request.radius, scene.walls, scene.activeLevelId, request.channel, request.externalRadius ?? 0);
  return { ...wallSourcePolygons(source, request.rayRadius), x: request.origin.x, y: request.origin.y, attenuationRadius: source.attenuationRadius };
}
function all(cache: TabletopGeometryCache, scene: Scene) {
  const frame = cache.forScene(scene, player);
  return [frame.region(sight(scene)), frame.region(sight(scene, 1)), frame.region(lamp(scene)), frame.region(lamp(scene, 1))];
}
function threshold(scene: Scene) {
  Object.assign(scene.walls[0], { senseModes: { sight: 'proximity', light: 'proximity' },
    senseThresholds: { sight: 500, light: 500 }, thresholdAttenuation: true });
}
function markup(scene: Scene, member = player) {
  return renderToStaticMarkup(createElement(Tabletop, { scene, actors: [], self: member, selection: null,
    setSelection: () => {}, command: async () => { throw new Error('SSR cannot send commands'); }, onCreateToken: () => {}, online: false }));
}

test('equivalent snapshots and cosmetic token/light updates reuse real source geometry', () => {
  const scene = fixture(), cache = new TabletopGeometryCache(), before = all(cache, scene);
  const clone = JSON.parse(JSON.stringify(scene)) as Scene;
  clone.tokens[0].name = 'Renamed'; clone.tokens[0].hp = 3; clone.tokens[0].color = '#123456';
  clone.lights[0].name = 'New label'; clone.lights[0].color = '#abcdef'; clone.lights[0].bright = 150;
  clone.name = 'Cosmetic scene name';
  const after = all(cache, clone);
  after.forEach((region, i) => assert.equal(region, before[i]));
  assert.deepEqual(after[0], fresh(clone));
  assert.deepEqual(after[2], fresh(clone, lamp(clone)));
});

test('one render batch serializes walls once for all sources and a new frame rechecks content', () => {
  const scene = fixture(), cache = new TabletopGeometryCache(), frame = cache.forScene(scene, player);
  assert.equal(cache.getDiagnostics().wallKeyBuilds, 0, 'a frame with no used sources does no wall-key work');
  const first = frame.region(sight(scene));
  frame.region(sight(scene, 1)); frame.region(lamp(scene)); frame.region(lamp(scene, 1));
  assert.equal(frame.region(sight(scene)), first);
  assert.equal(cache.getDiagnostics().wallKeyBuilds, 1, 'all unchanged sources share one serialized descriptor');
  assert.equal(cache.forScene(scene, player).region(sight(scene)), first);
  assert.equal(cache.getDiagnostics().wallKeyBuilds, 2, 'a later frame never trusts a prior mutable array identity');
});

test('the frame descriptor guard detects nested value, key and enumerability changes without stale masks', () => {
  const scene = fixture(), cache = new TabletopGeometryCache(); threshold(scene);
  scene.walls[0].thresholdAttenuation = false;
  const values = scene.walls[0].senseThresholds!;
  Object.defineProperty(values, 'unknown', { value: 10, enumerable: false, configurable: true });
  const frame = cache.forScene(scene, player), open = frame.region(sight(scene));
  Object.defineProperty(values, 'unknown', { enumerable: true });
  const closed = frame.region(sight(scene));
  assert.notDeepEqual(closed, open); assert.deepEqual(closed, fresh(scene));
  assert.equal(cache.getDiagnostics().wallKeyBuilds, 2);
  delete (values as Record<string, unknown>).unknown;
  const reopened = frame.region(sight(scene));
  assert.deepEqual(reopened, fresh(scene)); assert.notDeepEqual(reopened, closed);
  scene.walls[0].a.x += 100;
  assert.deepEqual(frame.region(sight(scene)), fresh(scene));
  assert.equal(cache.getDiagnostics().wallKeyBuilds, 4);
  frame.region(lamp(scene));
  assert.equal(cache.getDiagnostics().wallKeyBuilds, 4, 'a second source reuses the rebuilt descriptor');
});

test('retained batches detect ordered array edits and newly introduced accessors without executing them', () => {
  const scene = fixture(), cache = new TabletopGeometryCache();
  scene.walls.push({ ...scene.walls[0], id: 'second', a: { x: 800, y: 50 }, b: { x: 800, y: 950 } });
  const frame = cache.forScene(scene, player), original = frame.region(sight(scene));
  scene.walls.reverse();
  const reordered = frame.region(sight(scene));
  assert.notEqual(reordered, original); assert.deepEqual(reordered, fresh(scene));
  let accessorCalls = 0;
  Object.defineProperty(scene.walls[0], 'unused', { get() { accessorCalls++; throw new Error('Accessor must not run'); } });
  const unsafe = frame.region(sight(scene));
  assert.deepEqual(unsafe, fresh(scene)); assert.notEqual(frame.region(sight(scene)), unsafe);
  assert.equal(accessorCalls, 0);
  assert.equal(cache.getDiagnostics().wallKeyBuilds, 3, 'an unsafe batch remains uncacheable without repeated serialization');
});

test('observer and light moves invalidate only their own unchanged-wall source regions', () => {
  const scene = fixture(), cache = new TabletopGeometryCache(), original = all(cache, scene);
  scene.tokens[0].x += 100;
  const observerMoved = all(cache, scene);
  assert.notEqual(observerMoved[0], original[0]);
  for (const i of [1, 2, 3]) assert.equal(observerMoved[i], original[i]);
  assert.deepEqual(observerMoved[0], fresh(scene));
  scene.lights[1].x += 100;
  const lampMoved = all(cache, scene);
  for (const i of [0, 1, 2]) assert.equal(lampMoved[i], observerMoved[i]);
  assert.notEqual(lampMoved[3], observerMoved[3]);
  assert.deepEqual(lampMoved[3], fresh(scene, lamp(scene, 1)));
});

test('range paint changes reuse LOS while token size, range origin and grid change threshold geometry', () => {
  const scene = fixture(), cache = new TabletopGeometryCache(); threshold(scene);
  const original = cache.forScene(scene, player).region(sight(scene));
  scene.tokens[0].vision = 20; scene.tokens[0].visionUnlimited = true;
  scene.tokens[0].lightPerception = { enabled: false, range: 0 }; scene.globalLightEnabled = true;
  assert.equal(cache.forScene(scene, player).region(sight(scene)), original);
  scene.tokens[0].width = 2; scene.tokens[0].height = 2;
  const resized = cache.forScene(scene, player).region(sight(scene));
  assert.notEqual(resized, original); assert.deepEqual(resized, fresh(scene));
  assert.notEqual(resized.attenuationRadius, original.attenuationRadius);
  scene.grid.size = 120;
  const gridded = cache.forScene(scene, player).region(sight(scene));
  assert.notEqual(gridded, resized); assert.deepEqual(gridded, fresh(scene));
  scene.tokens[0].visionRangeOrigin = 'center';
  const centered = cache.forScene(scene, player).region(sight(scene));
  assert.notEqual(centered, gridded); assert.deepEqual(centered, fresh(scene));
});

test('wall geometry, door state, direction and mode changes invalidate warm regions', () => {
  const changes: ((wall: Wall) => void)[] = [
    wall => { wall.a.x += 100; }, wall => { wall.b.y -= 200; },
    wall => { wall.kind = 'door'; wall.state = 'open'; }, wall => { wall.direction = 'left'; },
    wall => { wall.levelIds = []; }, wall => { wall.levelId = 'upper'; },
    wall => { wall.sight = false; }, wall => { wall.senseModes = { sight: 'none' }; },
    wall => { wall.senseModes = { sight: 'limited' }; },
    wall => { wall.senseModes = { sight: 'proximity' }; wall.senseThresholds = { sight: 500 }; },
  ];
  for (const change of changes) {
    const scene = fixture(), cache = new TabletopGeometryCache();
    const before = cache.forScene(scene, player).region(sight(scene));
    change(scene.walls[0]);
    const after = cache.forScene(scene, player).region(sight(scene));
    assert.notEqual(after, before); assert.deepEqual(after, fresh(scene));
    assert.notDeepEqual(after, before, 'fixture must exercise an actual shape change');
  }
});

test('ordered endpoints and explicit level membership retain their exact geometry semantics', () => {
  const scene = fixture(), cache = new TabletopGeometryCache(); scene.walls[0].direction = 'left';
  let previous = cache.forScene(scene, player).region(sight(scene));
  [scene.walls[0].a, scene.walls[0].b] = [scene.walls[0].b, scene.walls[0].a];
  let current = cache.forScene(scene, player).region(sight(scene));
  assert.notDeepEqual(current, previous); assert.deepEqual(current, fresh(scene));
  previous = current;
  for (const levelIds of [[], ['ground'], ['upper'], undefined]) {
    scene.walls[0].levelIds = levelIds;
    current = cache.forScene(scene, player).region(sight(scene));
    assert.notEqual(current, previous); assert.deepEqual(current, fresh(scene)); previous = current;
  }
});

test('threshold value, attenuation and unknown nested keys cannot reuse stale bypasses', () => {
  const scene = fixture(), cache = new TabletopGeometryCache(); threshold(scene);
  const initial = cache.forScene(scene, player).region(sight(scene));
  scene.walls[0].senseThresholds!.sight = 600;
  let current = cache.forScene(scene, player).region(sight(scene));
  assert.notEqual(current.attenuationRadius, initial.attenuationRadius); assert.deepEqual(current, fresh(scene));
  for (const patch of [
    { senseThresholds: { sight: 500, light: 500, unsupported: undefined } },
    { senseThresholds: { sight: null } }, { senseThresholds: { sight: NaN } },
    { senseThresholds: { sight: Infinity } }, { senseThresholds: { sight: undefined } },
    { senseThresholds: { sight: 500 }, thresholdAttenuation: 'true' },
    { senseThresholds: { sight: 500 }, thresholdAttenuation: false },
  ]) {
    Object.assign(scene.walls[0], patch);
    const next = cache.forScene(scene, player).region(sight(scene));
    assert.notEqual(next, current); assert.deepEqual(next, fresh(scene)); current = next;
  }
});

test('descriptor-only enumerable changes invalidate malformed threshold validation', () => {
  const scene = fixture(), cache = new TabletopGeometryCache(); threshold(scene);
  scene.walls[0].thresholdAttenuation = false;
  const values = scene.walls[0].senseThresholds!;
  Object.defineProperty(values, 'unknown', { value: 10, enumerable: false, configurable: true });
  const before = cache.forScene(scene, player).region(sight(scene));
  Object.defineProperty(values, 'unknown', { enumerable: true });
  const after = cache.forScene(scene, player).region(sight(scene));
  assert.notEqual(after, before); assert.notDeepEqual(after, before); assert.deepEqual(after, fresh(scene));
});

test('malformed object-valued levels cannot collapse strict membership identity into a value key', () => {
  const scene = fixture(), cache = new TabletopGeometryCache(), wallLevel = {};
  scene.walls[0].levelId = wallLevel as unknown as string;
  scene.activeLevelId = {} as string;
  const before = cache.forScene(scene, player).region(sight(scene));
  scene.activeLevelId = wallLevel as unknown as string;
  const after = cache.forScene(scene, player).region(sight(scene));
  assert.notEqual(after, before); assert.notDeepEqual(after, before); assert.deepEqual(after, fresh(scene));
  assert.notEqual(cache.forScene(scene, player).region(sight(scene)), after, 'malformed contexts are never retained');
});

test('non-finite and signed numeric requests stay distinct while malformed values stay fresh', () => {
  const scene = fixture(), cache = new TabletopGeometryCache(), frame = cache.forScene(scene, player);
  const seen: SourceRegion[] = [];
  for (const radius of [NaN, Infinity, -Infinity, null, undefined, 0, -0]) {
    const request = { ...sight(scene), radius: radius as number };
    const region = frame.region(request);
    assert.ok(!seen.includes(region)); assert.deepEqual(region, fresh(scene, request)); seen.push(region);
  }
  const request = sight(scene), initial = frame.region(request);
  const differentRay = frame.region({ ...request, rayRadius: request.rayRadius / 2 });
  assert.notEqual(initial, differentRay); assert.deepEqual(differentRay, fresh(scene, { ...request, rayRadius: request.rayRadius / 2 }));
  const light = frame.region({ ...request, channel: 'light' });
  assert.notEqual(light, initial); assert.deepEqual(light, fresh(scene, { ...request, channel: 'light' }));
});

test('malformed source scalars and accessor-backed requests are not retained', () => {
  const scene = fixture(), cache = new TabletopGeometryCache(), frame = cache.forScene(scene, player);
  const variants = [
    { ...sight(scene), origin: { x: {}, y: 400 } }, { ...sight(scene), radius: {} },
    { ...sight(scene), rayRadius: '1000' }, { ...sight(scene), externalRadius: null },
    { ...sight(scene), channel: 'unsupported' },
  ] as unknown as SourceGeometryRequest[];
  for (const request of variants) {
    const first = frame.region(request);
    assert.notEqual(frame.region(request), first); assert.deepEqual(first, fresh(scene, request));
  }
  const request = sight(scene);
  Object.defineProperty(request, 'radius', { get: () => sceneSourceRadius(scene), enumerable: true });
  const first = frame.region(request);
  assert.notEqual(frame.region(request), first); assert.deepEqual(first, fresh(scene, request));
  const origin = { y: 400 };
  Object.defineProperty(origin, 'x', { get: () => 200, enumerable: true });
  const originGetter = { ...sight(scene), origin } as SourceGeometryRequest;
  const second = frame.region(originGetter);
  assert.notEqual(frame.region(originGetter), second); assert.deepEqual(second, fresh(scene, originGetter));
});

test('source radius and direction-excluded attenuation contributors remain part of cached geometry', () => {
  const scene = fixture(), cache = new TabletopGeometryCache(); threshold(scene);
  const first = cache.forScene(scene, player).region(sight(scene));
  const contributor: Wall = { ...scene.walls[0], id: 'contributor', direction: 'left', thresholdAttenuation: false,
    a: { x: 500, y: 100 }, b: { x: 500, y: 1000 } };
  scene.walls.push(contributor);
  const contributed = cache.forScene(scene, player).region(sight(scene));
  assert.notEqual(contributed.attenuationRadius, first.attenuationRadius);
  assert.equal(contributed.attenuationRadius, sceneSourceRadius(scene));
  assert.deepEqual(contributed, fresh(scene));
  const request = { ...sight(scene), radius: 1000 };
  const reduced = cache.forScene(scene, player).region(request);
  assert.equal(reduced.attenuationRadius, 1000); assert.deepEqual(reduced, fresh(scene, request));
  const light = cache.forScene(scene, player).region(lamp(scene));
  scene.lights[0].dim += 200;
  const brighterReach = cache.forScene(scene, player).region(lamp(scene));
  assert.notEqual(light, brighterReach); assert.deepEqual(brighterReach, fresh(scene, lamp(scene)));
});

test('accessors, cyclic data and exotic records bypass caching without invoking JSON conversion', () => {
  const scene = fixture(), cache = new TabletopGeometryCache();
  const record = scene.walls[0] as Wall & Record<string, unknown>;
  Object.defineProperty(record, 'unrelated', { get: () => { throw new Error('Cache must not invoke an accessor'); }, configurable: true });
  let first = cache.forScene(scene, player).region(sight(scene));
  assert.notEqual(cache.forScene(scene, player).region(sight(scene)), first); assert.deepEqual(first, fresh(scene));
  delete record.unrelated; record.cycle = record;
  first = cache.forScene(scene, player).region(sight(scene));
  assert.notEqual(cache.forScene(scene, player).region(sight(scene)), first); assert.deepEqual(first, fresh(scene));
  delete record.cycle; record.toJSON = () => { throw new Error('No toJSON call'); };
  first = cache.forScene(scene, player).region(sight(scene));
  assert.notEqual(cache.forScene(scene, player).region(sight(scene)), first); assert.deepEqual(first, fresh(scene));
});

test('in-place input changes and attempted output mutation cannot poison immutable entries', () => {
  const scene = fixture(), cache = new TabletopGeometryCache(), frame = cache.forScene(scene, player), request = sight(scene);
  const original = frame.region(request), saved = structuredClone(original);
  assert.throws(() => { (original.open as { x: number; y: number }[])[0].x = 99999; }, TypeError);
  assert.throws(() => { (original.open as { x: number; y: number }[]).push({ x: 0, y: 0 }); }, TypeError);
  assert.throws(() => { (original as { attenuationRadius: number | null }).attenuationRadius = 99999; }, TypeError);
  scene.walls[0].a.x += 100;
  const changed = frame.region(request);
  assert.notEqual(changed, original); assert.deepEqual(changed, fresh(scene, request)); assert.deepEqual(original, saved);
  request.origin.x += 80;
  const moved = frame.region(request);
  assert.notEqual(moved, changed); assert.deepEqual(moved, fresh(scene, request));
});

test('scene, member, role and level changes clear prior entries and stale accessors cannot repopulate them', () => {
  for (const field of ['scene', 'member', 'role', 'level'] as const) {
    const scene = fixture(), cache = new TabletopGeometryCache(), frame = cache.forScene(scene, player);
    const original = frame.region(sight(scene));
    const nextScene = structuredClone(scene), nextPlayer = { ...player };
    if (field === 'scene') nextScene.id = 'second-scene';
    if (field === 'member') nextPlayer.id = 'second-member';
    if (field === 'role') nextPlayer.role = 'gm';
    if (field === 'level') nextScene.activeLevelId = 'upper';
    const current = cache.forScene(nextScene, nextPlayer).region(sight(nextScene));
    assert.notEqual(current, original); assert.deepEqual(current, fresh(nextScene));
    assert.notEqual(frame.region(sight(scene)), original, 'old accessor cannot hit an evicted foreign-context entry');
    assert.equal(cache.forScene(nextScene, nextPlayer).region(sight(nextScene)), current, 'old accessor does not contaminate current context');
    assert.notEqual(cache.forScene(scene, player).region(sight(scene)), original, 'returning to context starts fresh');
  }
});

test('entry capacity uses LRU and separate instances never share cached regions', () => {
  const scene = fixture(), cache = new TabletopGeometryCache({ entries: 2 }), frame = cache.forScene(scene, player);
  const a = sight(scene), b = sight(scene, 1), c = lamp(scene);
  const a1 = frame.region(a), b1 = frame.region(b);
  assert.equal(frame.region(a), a1);
  frame.region(c);
  assert.equal(frame.region(a), a1, 'recently used entry survives');
  assert.notEqual(frame.region(b), b1, 'least recently used entry was evicted');
  assert.notEqual(new TabletopGeometryCache().forScene(scene, player).region(a), a1);
});

test('point and key budgets skip oversized entries and cap cumulative retained polygons', () => {
  const scene = fixture(); scene.walls = [];
  const request = sight(scene);
  for (const limits of [{ points: 127 }, { keyCharacters: 64 }]) {
    const frame = new TabletopGeometryCache(limits).forScene(scene, player), first = frame.region(request);
    assert.deepEqual(first, fresh(scene)); assert.notEqual(frame.region(request), first);
  }
  const frame = new TabletopGeometryCache({ points: 255 }).forScene(scene, player), first = frame.region(request);
  assert.equal(first.open.length, 128);
  frame.region(sight(scene, 1));
  assert.notEqual(frame.region(request), first, 'two 128-point entries exceed the total budget');
  const padded = fixture();
  Object.assign(padded.walls[0], { unrelatedPadding: 'x'.repeat(1000) });
  const keyBounded = new TabletopGeometryCache({ keyCharacters: 2000 }).forScene(padded, player);
  const paddedRequest = sight(padded), retained = keyBounded.region(paddedRequest);
  assert.equal(keyBounded.region(paddedRequest), retained, 'one long key fits and is cached');
  keyBounded.region(sight(padded, 1));
  assert.notEqual(keyBounded.region(paddedRequest), retained, 'combined key storage evicts even below entry and point limits');
  for (const entries of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => new TabletopGeometryCache({ entries }));
});

test('LIMITED intersections, coincident barriers and conservative dense masks remain fresh-equivalent', () => {
  const scene = fixture(), cache = new TabletopGeometryCache();
  const limited = (id: string, x: number): Wall => ({ ...scene.walls[0], id,
    a: { x, y: 0 }, b: { x, y: 1000 }, senseModes: { sight: 'limited', light: 'limited' } });
  const variants = [
    [limited('first', 600)], [limited('first', 600), limited('second', 900)],
    [limited('first', 600), { ...limited('second', 600), a: { x: 400, y: 50 }, b: { x: 1000, y: 950 } }],
    Array.from({ length: 257 }, (_, i) => limited(`duplicate-${i}`, 600)),
  ];
  for (const walls of variants) {
    scene.walls = walls;
    const original = structuredClone(walls), cached = cache.forScene(scene, player).region(sight(scene));
    assert.deepEqual(cached, fresh(scene)); assert.deepEqual(walls, original);
    assert.equal(cache.forScene(structuredClone(scene), player).region(sight(scene)), cached);
    if (walls.length > 1) {
      scene.walls = [...walls].reverse();
      const reversed = cache.forScene(scene, player).region(sight(scene));
      assert.notEqual(reversed, cached); assert.deepEqual(reversed, fresh(scene));
    }
  }
});

test('GM and vision-disabled views omit unused sight regions but retain enabled light paint and GM handles', () => {
  const scene = fixture();
  scene.lights.push({ ...scene.lights[0], id: 'disabled', enabled: false }, { ...scene.lights[0], id: 'zero', dim: 0 });
  const gm = markup(scene, { ...player, role: 'gm' });
  assert.doesNotMatch(gm, /<clipPath id="sight-/);
  assert.match(gm, /<clipPath id="light-clip-lamp-a">/);
  assert.match(gm, /fill="url\(#light-lamp-a\)" clip-path="url\(#light-clip-lamp-a\)"/);
  assert.doesNotMatch(gm, /<clipPath id="light-clip-(disabled|zero)"/);
  assert.doesNotMatch(gm, /clip-path="url\(#light-clip-(disabled|zero)\)"/);
  assert.equal((gm.match(/r="10" fill="#ffffff"/g) ?? []).length, 3, 'enabled, disabled and zero-radius light handles still render for GM');
  scene.visionEnabled = false;
  const playerWithoutFog = markup(scene);
  assert.doesNotMatch(playerWithoutFog, /<clipPath id="sight-/);
  assert.match(playerWithoutFog, /fill="url\(#light-lamp-a\)" clip-path="url\(#light-clip-lamp-a\)"/);
  scene.visionEnabled = true;
  assert.match(markup(scene), /<clipPath id="sight-observer">/);
});

test('fresh observer membership and perception settings recompose masks independently of LOS reuse', () => {
  const scene = fixture(); scene.tokens = [scene.tokens[0]];
  const cache = new TabletopGeometryCache(), region = cache.forScene(scene, player).region(sight(scene));
  scene.tokens[0].owners = [];
  assert.doesNotMatch(markup(scene), /<clipPath id="sight-observer">/);
  scene.tokens[0].owners = [player.id]; scene.tokens[0].visionEnabled = false;
  assert.doesNotMatch(markup(scene), /<clipPath id="sight-observer">/);
  scene.tokens[0].visionEnabled = true; scene.tokens[0].vision = 0;
  scene.tokens[0].lightPerception = { enabled: false, range: null };
  assert.match(markup(scene), /<mask id="vision-mask"[^>]*><rect[^>]*><\/rect><g fill="black"><g clip-path="url\(#sight-observer\)"><\/g>/);
  scene.globalLightEnabled = true; scene.tokens[0].lightPerception = { enabled: true, range: 150 };
  assert.match(markup(scene), /<clipPath id="light-perception-observer"><circle cx="200" cy="400" r="200"/);
  assert.equal(cache.forScene(scene, player).region(sight(scene)), region);
});
