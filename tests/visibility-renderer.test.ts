import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tabletop } from '../client/Tabletop.tsx';
import { canTokenSeePoint, canTokenSeeToken, tokenBodyRadius, tokenVisibilityPoints, visibilityPolygon } from '../shared/geometry.ts';
import { makeScene, projectSnapshot, seedCampaign } from '../server/engine.ts';
import type { Member, Point, Scene, Token, Wall } from '../shared/model.ts';

const player: Member = { id: 'player', name: 'Player', role: 'player', color: '#ffffff' };
function fixture() {
  const scene = makeScene('Visibility regression');
  scene.width = 10000; scene.height = 10000; scene.visionEnabled = true;
  const observer: Token = { id: 'observer', name: 'Observer', x: 1000, y: 1000, width: 1, height: 1,
    rotation: 0, color: '#ffffff', levelId: 'ground', owners: [player.id], hidden: false,
    actorId: null, linked: false, hp: null, maxHp: null, vision: 5000, visionEnabled: true, conditions: [] };
  const target: Token = { ...observer, id: 'target', name: 'Target', owners: [],
    x: 6018.388099973075, y: 1123.1945130621673 };
  scene.tokens = [observer, target];
  return { scene, observer, target };
}
function markup(scene: Scene) {
  return renderToStaticMarkup(createElement(Tabletop, { scene, actors: [], self: player, selection: null,
    setSelection: () => {}, command: async () => { throw new Error('SSR cannot send commands'); }, onCreateToken: () => {}, online: false }));
}
function mask(html: string) {
  const result = html.match(/<mask id="vision-mask"[^>]*>(.*?)<\/mask>/s);
  assert.ok(result, 'the player renderer must include its fog mask');
  return result[1];
}
function clip(html: string, id: string): Point[] {
  const result = html.match(new RegExp(`<clipPath id="${id}"><polygon points="([^"]*)"`));
  assert.ok(result, `missing clip path ${id}`);
  return result[1].split(' ').map(pair => { const [x, y] = pair.split(',').map(Number); return { x, y }; });
}
function contains(polygon: Point[], p: Point): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function distanceToPolygon(polygon: Point[], p: Point): number {
  return Math.min(...polygon.map((a, i) => {
    const b = polygon[(i + 1) % polygon.length], dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
  }));
}

test('zero intrinsic range cannot disclose a dark target whose footprint sample coincides with the observer', () => {
  const { scene, observer, target } = fixture();
  Object.assign(observer, { x: 100, y: 100, vision: 0 });
  Object.assign(target, { x: 120, y: 100 });
  assert.ok(tokenVisibilityPoints(target, scene.grid.size).some(p => p.x === observer.x && p.y === observer.y));
  assert.equal(canTokenSeePoint(scene, observer, observer), false);
  assert.equal(canTokenSeeToken(scene, observer, target), false);
  const campaign = seedCampaign('Darkness regression', 'GM');
  campaign.members.push(player); campaign.scenes = [scene]; campaign.activeSceneId = scene.id;
  assert.deepEqual(projectSnapshot(campaign, player, '').campaign.scenes[0].tokens.map(t => t.id), ['observer']);
  assert.doesNotMatch(mask(markup(scene)), /<circle/, 'zero range and no lights leave the mask closed');
  scene.globalLightEnabled = true;
  assert.equal(canTokenSeeToken(scene, observer, target), true, 'external global illumination remains valid');
  scene.globalLightEnabled = false; observer.visionUnlimited = true;
  assert.equal(canTokenSeeToken(scene, observer, target), true, 'explicit unlimited sight remains valid');
});

test('the intrinsic range mask renders the exact circle at the former inscribed-polygon blind spot', () => {
  const { scene, observer, target } = fixture();
  const previousRangePolygon = visibilityPolygon(observer, observer.vision, [], 'ground');
  assert.ok(distanceToPolygon(previousRangePolygon, target) > tokenBodyRadius(target, scene.grid.size), 'the entire target body was outside the old range mask');
  assert.equal(canTokenSeePoint(scene, observer, target), false, 'target center is outside intrinsic range');
  assert.equal(canTokenSeeToken(scene, observer, target), true);
  const html = markup(scene);
  assert.match(mask(html), /<g clip-path="url\(#sight-observer\)"><circle cx="1000" cy="1000" r="5000"/);
  const los = clip(html, 'sight-observer');
  const witness = tokenVisibilityPoints(target, scene.grid.size).find(p => canTokenSeePoint(scene, observer, p));
  assert.ok(witness && contains(los, witness), 'the disclosed body sample is inside the actual LOS clip');
  assert.ok(Math.hypot(witness.x - observer.x, witness.y - observer.y) < observer.vision, 'the SVG circle opens the disclosed sample');
  assert.ok([{ x: 0, y: 0 }, { x: scene.width, y: 0 }, { x: 0, y: scene.height }, { x: scene.width, y: scene.height }].every(p => contains(los, p)), 'the LOS polygon circumference must not trim the scene');
});

test('external illumination uses an exact dim circle with shared light LOS and each observer LOS', () => {
  const { scene, observer, target } = fixture();
  observer.x = 500; observer.y = 3000; observer.vision = 0;
  scene.lights = [{ id: 'lamp', name: 'Lamp', x: 1000, y: 1000, bright: 0, dim: 5000, color: '#ffffff', enabled: true, levelId: 'ground' }];
  const second = { ...observer, id: 'second', y: 3500 }; scene.tokens.push(second);
  assert.equal(canTokenSeePoint(scene, observer, target), false);
  assert.equal(canTokenSeeToken(scene, observer, target), true);
  const html = markup(scene), fog = mask(html);
  for (const id of ['observer', 'second']) {
    assert.match(fog, new RegExp(`<g clip-path="url\\(#sight-${id}\\)"><circle cx="1000" cy="1000" r="5000" clip-path="url\\(#light-clip-lamp\\)"`));
  }
  assert.equal((html.match(/<clipPath id="light-clip-lamp">/g) ?? []).length, 1, 'all observers and the light overlay share one light LOS definition');
  const witness = tokenVisibilityPoints(target, scene.grid.size).find(p => canTokenSeePoint(scene, observer, p));
  assert.ok(witness && contains(clip(html, 'light-clip-lamp'), witness) && contains(clip(html, 'sight-observer'), witness));
});

test('exact illumination circles remain clipped by both independent wall channels', () => {
  const { scene, observer, target } = fixture();
  Object.assign(observer, { x: 100, y: 300, vision: 0 });
  Object.assign(target, { x: 500, y: 300 });
  scene.lights = [{ id: 'lamp', name: 'Lamp', x: 500, y: 100, bright: 0, dim: 1000, color: '#ffffff', enabled: true, levelId: 'ground' }];
  const barrier: Wall = { id: 'barrier', a: { x: 300, y: 0 }, b: { x: 300, y: 600 },
    levelId: 'ground', kind: 'wall', state: 'closed', movement: true, sight: true, light: false, sound: true };
  scene.walls = [barrier];
  let html = markup(scene);
  assert.ok(!contains(clip(html, 'sight-observer'), target));
  assert.ok(contains(clip(html, 'light-clip-lamp'), target));
  assert.equal(canTokenSeeToken(scene, observer, target), false);
  Object.assign(barrier, { a: { x: 400, y: 200 }, b: { x: 600, y: 200 }, sight: false, light: true });
  html = markup(scene);
  assert.ok(contains(clip(html, 'sight-observer'), target));
  assert.ok(!contains(clip(html, 'light-clip-lamp'), target));
  assert.equal(canTokenSeeToken(scene, observer, target), false);
  assert.match(mask(html), /<g clip-path="url\(#sight-observer\)"><circle[^>]+clip-path="url\(#light-clip-lamp\)"/);
});
