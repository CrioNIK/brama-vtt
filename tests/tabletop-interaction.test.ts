import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tabletop, SvgTabletop } from '../client/Tabletop.tsx';
import { screenToWorld, worldToScreen, zoomAtScreenPoint, snapTokenCenter, keyboardTokenDestination, pickTabletopObject } from '../client/tabletop-interaction.ts';
import { tabletopRegions } from '../client/tabletop-scene.ts';
import { TabletopGeometryCache } from '../client/tabletop-geometry.ts';
import { makeScene } from '../server/engine.ts';
import { prepareWallSource, sceneSourceRadius, tokenExternalRadius, wallSourcePolygons } from '../shared/geometry.ts';
import { setLocale } from '../shared/i18n.ts';
import type { Member, Point, Token } from '../shared/model.ts';

const player: Member = { id: 'player', name: 'Player', role: 'player', color: '#ffffff' };
function fixture() {
  const scene = makeScene('Map fixture'); scene.width = 2000; scene.height = 1200; scene.grid.size = 100;
  const token: Token = { id: 'observer', name: 'Observer', x: 200, y: 400, width: 1, height: 1, rotation: 0,
    color: '#ffffff', levelId: scene.activeLevelId, owners: [player.id], hidden: false, actorId: null, linked: false,
    hp: 10, maxHp: 20, vision: 500, visionRangeOrigin: 'token-edge', conditions: [] };
  scene.tokens = [token]; scene.visionEnabled = true;
  scene.walls = [{ id: 'wall', a: { x: 600, y: 100 }, b: { x: 600, y: 1000 }, levelId: scene.activeLevelId,
    kind: 'door', state: 'closed', movement: true, sight: true, light: true, sound: true }];
  scene.lights = [{ id: 'lamp', name: 'Lamp', x: 900, y: 400, bright: 100, dim: 300, color: '#ffffff', enabled: true, levelId: scene.activeLevelId }];
  return { scene, token };
}
function near(a: Point, b: Point) { assert.ok(Math.abs(a.x - b.x) < 1e-9); assert.ok(Math.abs(a.y - b.y) < 1e-9); }

test('renderer-neutral transforms round-trip under fit, nonzero pan and portrait/landscape zoom', () => {
  const { scene } = fixture();
  for (const [width, height] of [[1080, 760], [360, 780]]) for (const zoom of [.3, 1, 4]) {
    const view = { width, height, pan: { x: 87.5, y: -43 }, zoom, scale: Math.min(width / scene.width, height / scene.height) * zoom };
    for (const at of [{ x: 0, y: 0 }, { x: scene.width, y: scene.height }, { x: 273.125, y: 319.75 }])
      near(screenToWorld(worldToScreen(at, scene, view), scene, view)!, at);
  }
});

test('wheel zoom holds the world coordinate beneath its CSS-pixel anchor, including clamp limits', () => {
  const { scene } = fixture(), view = { width: 900, height: 650, pan: { x: -47, y: 35 }, zoom: 1.3, scale: .585 }, anchor = { x: 174, y: 493 };
  const before = screenToWorld(anchor, scene, view)!;
  for (const requested of [.01, .9, 1.7, 10]) {
    const next = zoomAtScreenPoint(view, anchor, requested);
    assert.ok(next.zoom >= .3 && next.zoom <= 4);
    near(screenToWorld(anchor, scene, { ...view, ...next, scale: view.scale * next.zoom / view.zoom })!, before);
  }
  assert.equal(screenToWorld(anchor, scene, { ...view, scale: 0 }), null);
  assert.equal(screenToWorld({ x: NaN, y: 0 }, scene, view), null);
});

test('token snapping respects occupied width/height and keeps continuous coordinates without a grid', () => {
  const { scene, token } = fixture(); token.width = 2; token.height = 3;
  assert.deepEqual(snapTokenCenter({ x: 263, y: 407 }, token, scene), { x: 300, y: 450 });
  scene.grid.type = 'none';
  assert.deepEqual(snapTokenCenter({ x: 263.25, y: 407.5 }, token, scene), { x: 263.25, y: 407.5 });
  assert.deepEqual(keyboardTokenDestination('ArrowRight', token, scene.grid.size), { x: 300, y: 400 });
  assert.deepEqual(keyboardTokenDestination('ArrowUp', token, scene.grid.size), { x: 200, y: 300 });
  assert.equal(keyboardTokenDestination('Enter', token, scene.grid.size), null);
});

test('hit testing follows visual token order and exact active level, with GM-only light handles', () => {
  const { scene, token } = fixture();
  scene.tokens.push({ ...token, id: 'top' }, { ...token, id: 'other-level', levelId: 'upper' });
  assert.deepEqual(pickTabletopObject(scene, token, .5, false), { kind: 'token', id: 'top' });
  assert.equal(pickTabletopObject(scene, scene.lights[0], .5, false), null);
  assert.deepEqual(pickTabletopObject(scene, scene.lights[0], .5, true), { kind: 'light', id: 'lamp' });
  assert.deepEqual(pickTabletopObject(scene, { x: 617, y: 500 }, .5, false), { kind: 'wall', id: 'wall' });
  assert.equal(pickTabletopObject(scene, { x: 619, y: 500 }, .5, false), null);
  assert.equal(pickTabletopObject(scene, { x: 610, y: 500 }, 1, false), null, 'wall tolerance stays in CSS pixels');
  assert.equal(pickTabletopObject(scene, token, Infinity, true), null);
});

test('Pixi source adapter preserves actual committed geometry, range and per-source cache identity', () => {
  const { scene, token } = fixture(), cache = new TabletopGeometryCache();
  Object.assign(scene.walls[0], { senseModes: { sight: 'proximity' }, senseThresholds: { sight: 600 }, thresholdAttenuation: true });
  const result = tabletopRegions(scene, player, cache), source = prepareWallSource(token, sceneSourceRadius(scene), scene.walls, scene.activeLevelId, 'sight', tokenExternalRadius(token, scene.grid.size));
  assert.deepEqual(result.vision[0].region, { ...wallSourcePolygons(source, 2 * (Math.hypot(scene.width, scene.height) + Math.hypot(token.x, token.y))),
    x: token.x, y: token.y, attenuationRadius: source.attenuationRadius });
  assert.equal(result.vision[0].radius, 550);
  const visualPreview = { id: token.id, at: { x: 1000, y: 900 } };
  const frame = { ...tabletopRegions(scene, player, cache), preview: visualPreview };
  assert.equal(frame.vision[0].x, 200, 'preview coordinates are never passed to source preparation');
  assert.equal(frame.vision[0].region, result.vision[0].region);
  token.x = 300;
  assert.notEqual(tabletopRegions(scene, player, cache).vision[0].region, result.vision[0].region, 'a committed move invalidates its source');
});

test('source adapter recomposes ownership, vision and enabled light membership from each snapshot', () => {
  const { scene, token } = fixture(), cache = new TabletopGeometryCache();
  assert.equal(tabletopRegions(scene, player, cache).vision.length, 1);
  token.owners = [];
  assert.equal(tabletopRegions(scene, player, cache).vision.length, 0);
  token.owners = [player.id]; token.visionEnabled = false;
  assert.equal(tabletopRegions(scene, player, cache).vision.length, 0);
  const gm = { ...player, role: 'gm' as const };
  assert.equal(tabletopRegions(scene, gm, cache).vision.length, 0);
  assert.equal(tabletopRegions(scene, gm, cache).lightVisibility.length, 1, 'GM still paints actual lamps');
  scene.lights[0].enabled = false;
  assert.equal(tabletopRegions(scene, gm, cache).lightVisibility.length, 0);
  scene.lights[0].enabled = true; scene.lights[0].dim = 0;
  assert.equal(tabletopRegions(scene, gm, cache).lightVisibility.length, 0);
});

test('default SSR is a pending WebGL host with accessible HTML objects, never a rendered SVG map or GPU claim', () => {
  const { scene } = fixture();
  const props = { scene, actors: [], self: player, selection: null, setSelection: () => {}, command: async () => { throw new Error('SSR command'); }, onCreateToken: () => {}, online: false };
  for (const locale of ['en', 'uk', 'es', 'pl', 'cs'] as const) {
    setLocale(locale);
    const html = renderToStaticMarkup(createElement(Tabletop, props));
    assert.match(html, /data-renderer-selected="pixi"/);
    assert.match(html, /data-render-backend="pending"/);
    assert.match(html, /data-render-status="initializing"/);
    assert.match(html, /<button[^>]+data-token-id="observer"/);
    assert.doesNotMatch(html, /<svg[^>]+class="world|<mask id="vision-mask"|<canvas|data-render-backend="webgl"/);
    if (locale !== 'en') assert.doesNotMatch(html, /Starting WebGL map…/, 'non-English UI uses translated loading text');
  }
  setLocale('en');
  const reference = renderToStaticMarkup(createElement(SvgTabletop, props));
  assert.match(reference, /<svg[^>]+class="world/);
  assert.match(reference, /<mask id="vision-mask"/);
  setLocale('uk');
});
