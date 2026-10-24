import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, projectSnapshot, seedCampaign } from '../server/engine.ts';
import { canTokenSeePoint, canTokenSeeToken, tokenBodyRadius, tokenVisibilityPoints, visibilityPolygon } from '../shared/geometry.ts';
import type { Point, Token, Wall } from '../shared/model.ts';

function fixture() {
  const scene = makeScene('Footprint visibility');
  scene.visionEnabled = true;
  const observer: Token = { id: 'observer', name: 'Observer', x: 100, y: 300, width: 1, height: 1, rotation: 0,
    color: '#ffffff', levelId: 'ground', owners: ['player'], hidden: false, actorId: null, linked: false,
    hp: null, maxHp: null, vision: 1000, visionEnabled: true, conditions: [] };
  const target: Token = { ...observer, id: 'target', name: 'Target', x: 500, width: 4, height: 4, owners: [] };
  const wall = (from: number, to: number, patch: Partial<Wall> = {}): Wall => ({ id: `wall-${from}-${to}`,
    a: { x: 300, y: from }, b: { x: 300, y: to }, levelId: 'ground', kind: 'wall', state: 'closed',
    movement: true, sight: true, light: true, sound: true, ...patch });
  scene.tokens = [observer, target];
  return { scene, observer, target, wall };
}

// Independent point-in-polygon check for the SVG mask geometry used by the current renderer.
function polygonContains(polygon: Point[], point: Point): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y)
        && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

test('a large token with an occluded center is visible through its exposed body, matching the fog polygon', () => {
  const { scene, observer, target, wall } = fixture();
  scene.walls = [wall(280, 320)];
  assert.equal(canTokenSeePoint(scene, observer, target), false, 'the previous center-only rule hides this target');
  assert.equal(canTokenSeeToken(scene, observer, target), true);
  const fogOpening = visibilityPolygon(observer, observer.vision, scene.walls, observer.levelId);
  const visibleSamples = tokenVisibilityPoints(target, scene.grid.size).filter(p => canTokenSeePoint(scene, observer, p));
  assert.ok(visibleSamples.length > 0);
  assert.ok(visibleSamples.every(p => polygonContains(fogOpening, p)), 'revealed body samples also lie in the rendered opening');
  scene.walls = [wall(0, 600)];
  assert.equal(canTokenSeeToken(scene, observer, target), false, 'the entire footprint is now occluded');
  const closed = visibilityPolygon(observer, observer.vision, scene.walls, observer.levelId);
  assert.ok(tokenVisibilityPoints(target, scene.grid.size).every(p => !polygonContains(closed, p)));
});

test('empty selection-rectangle corners cannot disclose an otherwise occluded circular body', () => {
  const { scene, observer, target, wall } = fixture();
  scene.walls = [wall(255, 600)];
  const selectionCorner = { x: target.x - target.width * scene.grid.size / 2, y: target.y - target.height * scene.grid.size / 2 };
  assert.equal(canTokenSeePoint(scene, observer, selectionCorner), true, 'an empty corner of the occupied rectangle is exposed');
  assert.equal(canTokenSeeToken(scene, observer, target), false);
  assert.equal(tokenBodyRadius({ width: 8, height: 2 }, 50), 42, 'non-square footprints use the circular body, not the long dimension');
});

test('large-token adaptive samples detect a narrow opening between eight compass points', () => {
  const { scene, observer, target, wall } = fixture();
  scene.walls = [wall(0, 308), wall(312, 600)];
  const r = tokenBodyRadius(target, scene.grid.size) - 1;
  const compass = Array.from({ length: 8 }, (_, i) => ({ x: target.x + Math.cos(i * Math.PI / 4) * r, y: target.y + Math.sin(i * Math.PI / 4) * r }));
  assert.equal(canTokenSeePoint(scene, observer, target), false);
  assert.ok(compass.every(p => !canTokenSeePoint(scene, observer, p)), 'center plus eight points would miss this opening');
  assert.equal(canTokenSeeToken(scene, observer, target), true);
});

test('interior rings can reveal a body portion missed by center and boundary samples', () => {
  const { scene, observer, target, wall } = fixture();
  scene.walls = [wall(0, 306.8), wall(307.4, 600)];
  const samples = tokenVisibilityPoints(target, scene.grid.size), boundaryRadius = tokenBodyRadius(target, scene.grid.size) - 1;
  const boundary = samples.filter(p => Math.hypot(p.x - target.x, p.y - target.y) > boundaryRadius - 1e-6);
  assert.ok(boundary.length > 8);
  assert.equal(canTokenSeePoint(scene, observer, target), false);
  assert.ok(boundary.every(p => !canTokenSeePoint(scene, observer, p)));
  assert.equal(canTokenSeeToken(scene, observer, target), true);
});

test('footprint sampling is bounded, stays inside the body, and rejects invalid geometry', () => {
  const { scene, observer, target } = fixture();
  const small = tokenVisibilityPoints({ ...target, width: 1, height: 1 }, scene.grid.size);
  const large = tokenVisibilityPoints({ ...target, width: 20, height: 20 }, scene.grid.size);
  assert.ok(large.length > small.length && large.length <= 257);
  for (const size of [.25, 1, 4, 20, 10000]) {
    const body = { ...target, width: size, height: size };
    const points = tokenVisibilityPoints(body, scene.grid.size), radius = tokenBodyRadius(body, scene.grid.size);
    assert.ok(points.length <= 257);
    assert.deepEqual(points[0], { x: target.x, y: target.y });
    assert.ok(points.every(p => Math.hypot(p.x - target.x, p.y - target.y) < radius));
  }
  for (const patch of [{ width: 0 }, { height: -1 }, { width: Infinity }, { height: NaN }, { x: NaN }, { y: Infinity }]) {
    assert.deepEqual(tokenVisibilityPoints({ ...target, ...patch }, scene.grid.size), []);
    assert.equal(canTokenSeeToken(scene, observer, { ...target, ...patch }), false);
  }
  for (const size of [0, -1, NaN, Infinity]) assert.deepEqual(tokenVisibilityPoints(target, size), []);
});

test('sight channels, explicit wall membership and door states apply to every footprint point', () => {
  const { scene, observer, target, wall } = fixture();
  for (const kind of ['door', 'secret'] as const) for (const state of ['closed', 'locked', 'open'] as const) {
    scene.walls = [wall(0, 600, { kind, state })];
    assert.equal(canTokenSeeToken(scene, observer, target), state === 'open', `${kind}/${state}`);
  }
  scene.walls = [wall(0, 600, { sight: false })];
  assert.equal(canTokenSeeToken(scene, observer, target), true);
  scene.walls[0].sight = true; scene.walls[0].levelIds = ['upper'];
  assert.equal(canTokenSeeToken(scene, observer, target), true);
  scene.walls[0].levelIds.push('ground');
  assert.equal(canTokenSeeToken(scene, observer, target), false);
});

test('partial intrinsic range or external light must illuminate an unoccluded sample on the correct level', () => {
  const { scene, observer, target, wall } = fixture();
  observer.vision = 350;
  assert.equal(canTokenSeePoint(scene, observer, target), false);
  assert.equal(canTokenSeeToken(scene, observer, target), true, 'near side of the body is within range');
  observer.vision = 0;
  assert.equal(canTokenSeeToken(scene, observer, target), false);
  scene.lights = [{ id: 'lamp', name: 'Lamp', x: 700, y: 300, bright: 0, dim: 130, color: '#ffffff', enabled: true, levelId: 'ground' }];
  assert.equal(canTokenSeePoint(scene, observer, target), false, 'target center remains unlit');
  assert.equal(canTokenSeeToken(scene, observer, target), true, 'far side is lit and within observer LOS');
  scene.walls = [wall(0, 600, { a: { x: 590, y: 0 }, b: { x: 590, y: 600 }, sight: false })];
  assert.equal(canTokenSeeToken(scene, observer, target), false, 'a light-only barrier blocks illumination');
  scene.walls = [wall(0, 600, { light: false })];
  assert.equal(canTokenSeeToken(scene, observer, target), false, 'illumination alone cannot bypass a sight barrier');
  scene.walls = []; scene.globalLightEnabled = true;
  observer.visionEnabled = false;
  assert.equal(canTokenSeeToken(scene, observer, target), false);
  observer.visionEnabled = true; target.levelId = 'upper';
  assert.equal(canTokenSeeToken(scene, observer, target), false);
});

function projectionFixture() {
  const f = fixture(), campaign = seedCampaign('Footprint projection', 'GM');
  const player = { id: 'player', name: 'Player', role: 'player' as const, color: '#ffffff' };
  campaign.members.push(player);
  const actor = campaign.actors[0];
  actor.id = 'target-actor'; actor.name = 'Visible target actor'; actor.owners = [];
  actor.gmNotes = 'PRIVATE_GM_NOTES'; actor.notes = 'PRIVATE_ACTOR_NOTES';
  actor.source = { sourceActorRef: 'PRIVATE_ACTOR_SOURCE', resolution: 'resolved', systemId: null, systemVersion: null };
  f.target.actorId = actor.id;
  f.target.source = { sourceTokenId: 'PRIVATE_TOKEN_SOURCE', sourceActorRef: 'PRIVATE_ACTOR_SOURCE', actorResolution: 'resolved',
    rotationConvention: 'foundry-zero-south', elevation: 0, sightMetadata: {} };
  campaign.actors = [actor]; campaign.scenes = [f.scene]; campaign.activeSceneId = f.scene.id;
  campaign.combat.combatants = [{ id: 'target-combatant', sceneId: f.scene.id, tokenId: f.target.id, name: f.target.name, initiative: 10, kind: 'token' }];
  const view = () => projectSnapshot(campaign, player, 'PRIVATE_INVITE').campaign;
  return { ...f, campaign, player, actor, view };
}

test('server disclosure includes a partially visible target and redacts its private actor/token data', () => {
  const f = projectionFixture();
  f.scene.walls = [f.wall(280, 320)];
  const before = structuredClone(f.campaign), view = f.view();
  assert.deepEqual(view.scenes[0].tokens.map(t => t.id), ['observer', 'target']);
  assert.equal(view.actors[0].sheetAccess, 'summary');
  assert.deepEqual(view.combat.combatants.map(c => c.tokenId), ['target']);
  assert.ok(!JSON.stringify(view).includes('PRIVATE_'));
  assert.deepEqual(f.campaign, before, 'projection must not mutate authoritative data');
  f.scene.walls = [f.wall(0, 600)];
  const blocked = f.view();
  assert.deepEqual(blocked.scenes[0].tokens.map(t => t.id), ['observer']);
  assert.deepEqual(blocked.actors, []);
  assert.deepEqual(blocked.combat.combatants, []);
  assert.ok(!JSON.stringify(blocked).includes('Visible target actor'));
});

test('projection never grants vision from hidden, foreign-owned, disabled or other-level observers', () => {
  for (const patch of [{ hidden: true }, { owners: ['other'] }, { visionEnabled: false }, { levelId: 'upper' }]) {
    const f = projectionFixture();
    f.scene.walls = [f.wall(280, 320)]; Object.assign(f.observer, patch);
    assert.ok(!f.view().scenes[0].tokens.some(t => t.id === 'target'), JSON.stringify(patch));
  }
  const f = projectionFixture();
  f.scene.walls = [f.wall(255, 600)];
  assert.ok(!f.view().scenes[0].tokens.some(t => t.id === 'target'), 'empty rectangle corners cannot grant server disclosure');
});

test('owned tokens keep disclosure privileges while explicit hiding, GM visibility and fog-disabled policy stay intact', () => {
  const f = projectionFixture();
  f.scene.walls = [f.wall(0, 600)]; f.observer.visionEnabled = false;
  f.target.owners = [f.player.id];
  assert.ok(f.view().scenes[0].tokens.some(t => t.id === 'target'), 'owned token remains available behind walls');
  f.target.hidden = true;
  assert.ok(!f.view().scenes[0].tokens.some(t => t.id === 'target'), 'explicit hiding still overrides ownership');
  assert.ok(projectSnapshot(f.campaign, f.campaign.members[0], '').campaign.scenes[0].tokens.some(t => t.id === 'target'), 'GM can still see hidden tokens');
  f.target.hidden = false; f.target.owners = []; f.scene.visionEnabled = false;
  assert.ok(f.view().scenes[0].tokens.some(t => t.id === 'target'), 'fog-disabled scene preserves existing disclosure policy');
  f.target.hidden = true;
  assert.ok(!f.view().scenes[0].tokens.some(t => t.id === 'target'), 'fog-disabled scene does not reveal hidden tokens');
});
