import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeScene, projectSnapshot, seedCampaign } from '../server/engine.ts';
import { canTokenSeePoint, isPointIlluminated } from '../shared/geometry.ts';
import type { Scene, Token, Wall } from '../shared/model.ts';

function fixture() {
  const scene: Scene = makeScene('Basic sight fixture');
  const observer: Token = { id: 'observer', name: 'Observer', x: 100, y: 300, width: 1, height: 1, rotation: 0, color: '#ffffff', levelId: 'ground', owners: ['player'], hidden: false, actorId: null, linked: false, hp: null, maxHp: null, vision: 0, visionEnabled: true, conditions: [] };
  const target = { x: 500, y: 300 };
  scene.lights = [{ id: 'lamp', name: 'Lamp', x: 550, y: 300, bright: 50, dim: 100, color: '#ffffff', enabled: true, levelId: 'ground' }];
  const wall = (x: number, sight: boolean, light: boolean): Wall => ({ id: randomUUID(), a: { x, y: 0 }, b: { x, y: 600 }, levelId: 'ground', kind: 'wall', state: 'closed', movement: true, sight, light, sound: false });
  return { scene, observer, target, wall };
}

test('enabled basic vision with zero intrinsic range sees externally illuminated points', () => {
  const { scene, observer, target } = fixture();
  assert.equal(observer.vision, 0);
  assert.equal(isPointIlluminated(scene, target, 'ground'), true);
  assert.equal(canTokenSeePoint(scene, observer, target), true);
  scene.lights[0].enabled = false;
  assert.equal(canTokenSeePoint(scene, observer, target), false);
  observer.vision = 450;
  assert.equal(canTokenSeePoint(scene, observer, target), true);
});

test('illumination and observer sight use independent blocking channels', () => {
  const { scene, observer, target, wall } = fixture();
  scene.walls = [wall(525, false, true)]; // Blocks the lamp but not observer sight.
  assert.equal(isPointIlluminated(scene, target, 'ground'), false);
  assert.equal(canTokenSeePoint(scene, observer, target), false);
  scene.walls = [wall(300, true, false)]; // Target remains lit, observer cannot see it.
  assert.equal(isPointIlluminated(scene, target, 'ground'), true);
  assert.equal(canTokenSeePoint(scene, observer, target), false);
  scene.walls[0].kind = 'door'; scene.walls[0].state = 'open';
  assert.equal(canTokenSeePoint(scene, observer, target), true);
});

test('global light and unlimited sight do not bypass disabled vision, walls or level membership', () => {
  const { scene, observer, target, wall } = fixture();
  scene.lights = []; scene.globalLightEnabled = true;
  assert.equal(canTokenSeePoint(scene, observer, target), true);
  observer.visionEnabled = false;
  assert.equal(canTokenSeePoint(scene, observer, target), false);
  observer.visionEnabled = true; scene.globalLightEnabled = false; observer.visionUnlimited = true;
  assert.equal(canTokenSeePoint(scene, observer, target), true);
  assert.equal(canTokenSeePoint(scene, observer, target, 'upper'), false);
  scene.walls = [wall(300, true, true)];
  assert.equal(canTokenSeePoint(scene, observer, target), false);
});

test('light membership is explicit, including one shared light object on several levels', () => {
  const { scene, observer, target } = fixture();
  scene.levels.push({ id: 'upper', name: 'Upper', bottom: 20, top: 40 });
  observer.levelId = 'upper';
  assert.equal(canTokenSeePoint(scene, observer, target), false);
  scene.lights[0].levelIds = ['ground', 'upper'];
  assert.equal(canTokenSeePoint(scene, observer, target), true);
  scene.lights[0].levelIds = [];
  assert.equal(canTokenSeePoint(scene, observer, target), false);
});

test('server basic-lit projection still conceals hidden tokens, secret notes and import source metadata', () => {
  const campaign = seedCampaign('Projection fixture', 'GM');
  const player = { id: 'player', name: 'Player', role: 'player' as const, color: '#ffffff' };
  campaign.members.push(player);
  const { scene, observer, target } = fixture();
  const seen: Token = { ...structuredClone(observer), id: 'seen', name: 'Seen', ...target, owners: [], source: { sourceTokenId: 'private-source-token', sourceActorRef: 'private-source-actor', actorResolution: 'unresolved', rotationConvention: 'foundry-zero-south', elevation: 0, sightMetadata: {} } };
  const hidden = { ...structuredClone(seen), id: 'hidden', name: 'Hidden secret', hidden: true };
  scene.visionEnabled = true; scene.tokens = [observer, seen, hidden];
  campaign.scenes = [scene]; campaign.activeSceneId = scene.id;
  campaign.chat.push({ id: 'gm-message', authorId: campaign.members[0].id, authorName: 'GM', text: 'GM only text', visibility: 'gm', createdAt: new Date().toISOString() });
  const snapshot = projectSnapshot(campaign, player, 'private-invite');
  assert.deepEqual(snapshot.campaign.scenes[0].tokens.map(t => t.id), ['observer', 'seen']);
  const wire = JSON.stringify(snapshot);
  for (const secret of ['Hidden secret', 'GM only text', 'private-source-token', 'private-source-actor', 'private-invite']) assert.equal(wire.includes(secret), false);
  scene.lights[0].enabled = false;
  assert.deepEqual(projectSnapshot(campaign, player, 'private-invite').campaign.scenes[0].tokens.map(t => t.id), ['observer']);
});
