import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tabletop } from '../client/Tabletop.tsx';
import { canTokenSeePoint, effectiveLightPerceptionRadius, effectiveVisionRadius } from '../shared/geometry.ts';
import { makeScene, projectSnapshot, seedCampaign } from '../server/engine.ts';
import { readCampaign } from '../server/migrations.ts';
import { Store, type Session } from '../server/store.ts';
import type { Member, Scene, Token } from '../shared/model.ts';

const player: Member = { id: 'player', name: 'Player', role: 'player', color: '#ffffff' };
function fixture() {
  const scene = makeScene('Light perception');
  scene.width = 2000; scene.height = 2000; scene.grid.size = 100; scene.visionEnabled = true;
  const observer: Token = { id: 'observer', name: 'Observer', x: 100, y: 100, width: 1, height: 1,
    rotation: 0, color: '#ffffff', levelId: 'ground', owners: [player.id], hidden: false,
    actorId: null, linked: false, hp: null, maxHp: null, vision: 0, visionEnabled: true, conditions: [] };
  scene.tokens = [observer];
  return { scene, observer };
}
function html(scene: Scene) {
  return renderToStaticMarkup(createElement(Tabletop, { scene, actors: [], self: player, selection: null,
    setSelection: () => {}, command: async () => { throw new Error('SSR must not send commands'); }, onCreateToken: () => {}, online: false }));
}
function mask(scene: Scene) {
  const found = html(scene).match(/<mask id="vision-mask"[^>]*>(.*?)<\/mask>/s);
  assert.ok(found);
  return found[1];
}

test('light perception defaults to unlimited while explicit disabled, zero and malformed profiles stay closed', () => {
  const { observer } = fixture();
  assert.equal(effectiveLightPerceptionRadius(observer, 100), Infinity);
  assert.equal(effectiveLightPerceptionRadius({ ...observer, lightPerception: { enabled: true, range: null } }, 100), Infinity);
  for (const lightPerception of [
    { enabled: false, range: null }, { enabled: false, range: 200 }, { enabled: true, range: 0 },
    { enabled: true, range: -1 }, { enabled: true, range: Infinity }, { enabled: true, range: NaN },
    { enabled: true, range: '100' }, { enabled: 'true', range: 100 }, {}, null,
  ]) assert.equal(effectiveLightPerceptionRadius({ ...observer, visionRangeOrigin: 'token-edge', lightPerception } as Token, 100), 0);
});

test('bounded external-light detection uses the same center or token-edge range as the renderer', () => {
  const { scene, observer } = fixture();
  scene.globalLightEnabled = true;
  observer.lightPerception = { enabled: true, range: 100 };
  assert.equal(canTokenSeePoint(scene, observer, { x: 200, y: 100 }), true);
  assert.equal(canTokenSeePoint(scene, observer, { x: 200.001, y: 100 }), false);
  observer.visionRangeOrigin = 'token-edge';
  assert.equal(effectiveLightPerceptionRadius(observer, 100), 150);
  assert.equal(canTokenSeePoint(scene, observer, { x: 250, y: 100 }), true);
  assert.equal(canTokenSeePoint(scene, observer, { x: 250.001, y: 100 }), false);
  assert.match(mask(scene), /<g clip-path="url\(#sight-observer\)"><circle cx="100" cy="100" r="150"/);
  assert.doesNotMatch(mask(scene), /<polygon/, 'bounded global illumination must not open the entire LOS polygon');
  observer.width = 2; observer.height = 2;
  assert.equal(effectiveLightPerceptionRadius(observer, 100), 200);
  assert.equal(canTokenSeePoint(scene, observer, { x: 290, y: 100 }), true);
  assert.match(mask(scene), /r="200"/);
});

test('light perception requires illumination and cannot bypass sight or light walls', () => {
  const { scene, observer } = fixture(), target = { x: 350, y: 100 };
  observer.lightPerception = { enabled: true, range: 500 };
  assert.equal(canTokenSeePoint(scene, observer, target), false);
  scene.lights = [{ id: 'lamp', name: 'Lamp', x: 350, y: 300, bright: 0, dim: 500, color: '#ffffff', enabled: true, levelId: 'ground' }];
  assert.equal(canTokenSeePoint(scene, observer, target), true);
  scene.walls = [{ id: 'w', a: { x: 250, y: 0 }, b: { x: 250, y: 200 }, levelId: 'ground', kind: 'wall', state: 'closed',
    movement: true, sight: true, light: false, sound: true }];
  assert.equal(canTokenSeePoint(scene, observer, target), false);
  Object.assign(scene.walls[0], { a: { x: 300, y: 200 }, b: { x: 400, y: 200 }, sight: false, light: true });
  assert.equal(canTokenSeePoint(scene, observer, target), false);
  assert.match(html(scene), /<clipPath id="light-perception-observer"><circle cx="100" cy="100" r="500"/);
  assert.match(mask(scene), /<g clip-path="url\(#sight-observer\)"><g clip-path="url\(#light-perception-observer\)"><circle[^>]+clip-path="url\(#light-clip-lamp\)"/);
});

test('disabled or zero light perception does not disable intrinsic sight and global light cannot override it', () => {
  const { scene, observer } = fixture(), target = { x: 250, y: 100 };
  scene.globalLightEnabled = true;
  for (const lightPerception of [{ enabled: false, range: null }, { enabled: true, range: 0 }]) {
    observer.lightPerception = lightPerception;
    observer.vision = 0;
    assert.equal(canTokenSeePoint(scene, observer, target), false);
    assert.doesNotMatch(mask(scene), /<circle|<polygon/);
    observer.vision = 160;
    assert.equal(canTokenSeePoint(scene, observer, target), true);
    assert.match(mask(scene), /r="160"/);
  }
  observer.vision = 100; observer.visionRangeOrigin = 'token-edge';
  assert.equal(effectiveVisionRadius(observer, scene.grid.size), 150);
  assert.equal(canTokenSeePoint(scene, observer, target), true);
  assert.match(mask(scene), /r="150"/);
  observer.vision = 0; observer.visionUnlimited = true;
  assert.equal(canTokenSeePoint(scene, observer, { x: 1500, y: 1500 }), true);
  assert.match(mask(scene), /<polygon/);
});

test('projection uses bounded external perception for partial token bodies and retains hidden-token policy', () => {
  const { scene, observer } = fixture();
  scene.globalLightEnabled = true; observer.lightPerception = { enabled: true, range: 300 };
  scene.tokens.push({ ...observer, id: 'partial', x: 430, owners: [] }, { ...observer, id: 'outside', x: 500, owners: [] },
    { ...observer, id: 'hidden', x: 200, owners: [], hidden: true });
  const campaign = seedCampaign('Bounded detection', 'GM');
  campaign.members.push(player); campaign.scenes = [scene]; campaign.activeSceneId = scene.id;
  assert.deepEqual(projectSnapshot(campaign, player, '').campaign.scenes[0].tokens.map(t => t.id), ['observer', 'partial']);
  delete observer.lightPerception;
  assert.deepEqual(projectSnapshot(campaign, player, '').campaign.scenes[0].tokens.map(t => t.id), ['observer', 'partial', 'outside']);
});

test('threshold sight rendering unions baseline LOS with an exact disk clipped to threshold-open LOS', () => {
  const { scene, observer } = fixture();
  scene.globalLightEnabled = true;
  scene.walls = [{ id: 'threshold', a: { x: 200, y: 0 }, b: { x: 200, y: 400 }, levelId: 'ground', kind: 'wall', state: 'closed',
    movement: true, sight: true, light: false, sound: true, senseModes: { sight: 'proximity' }, senseThresholds: { sight: 200 }, thresholdAttenuation: true }];
  assert.equal(canTokenSeePoint(scene, observer, { x: 300, y: 100 }), true);
  assert.equal(canTokenSeePoint(scene, observer, { x: 300.001, y: 100 }), false);
  const rendered = html(scene);
  assert.match(rendered, /<clipPath id="sight-observer-open"><polygon/);
  assert.match(rendered, /<clipPath id="sight-observer"><polygon[^>]*><\/polygon><circle cx="100" cy="100" r="200" clip-path="url\(#sight-observer-open\)"/);
  assert.match(mask(scene), /<polygon[^>]*><\/polygon><circle cx="100" cy="100" r="200" clip-path="url\(#sight-observer-open\)"/);
  scene.tokens.push({ ...observer, id: 'outside', x: 350, owners: [] });
  const campaign = seedCampaign('Threshold projection', 'GM');
  campaign.members.push(player); campaign.scenes = [scene]; campaign.activeSceneId = scene.id;
  assert.deepEqual(projectSnapshot(campaign, player, '').campaign.scenes[0].tokens.map(t => t.id), ['observer']);
});

test('threshold light rendering and external token detection share the attenuated light region', () => {
  const { scene, observer } = fixture();
  observer.x = 500;
  scene.lights = [{ id: 'lamp', name: 'Lamp', x: 100, y: 100, bright: 0, dim: 500, color: '#ffffff', enabled: true, levelId: 'ground' }];
  scene.walls = [{ id: 'threshold', a: { x: 200, y: 0 }, b: { x: 200, y: 400 }, levelId: 'ground', kind: 'wall', state: 'closed',
    movement: true, sight: false, light: true, sound: true, senseModes: { light: 'proximity' }, senseThresholds: { light: 200 }, thresholdAttenuation: true }];
  assert.equal(canTokenSeePoint(scene, observer, { x: 300, y: 100 }), true);
  assert.equal(canTokenSeePoint(scene, observer, { x: 300.001, y: 100 }), false);
  const rendered = html(scene);
  assert.match(rendered, /<clipPath id="light-clip-lamp-open"><polygon/);
  assert.match(rendered, /<clipPath id="light-clip-lamp"><polygon[^>]*><\/polygon><circle cx="100" cy="100" r="200" clip-path="url\(#light-clip-lamp-open\)"/);
  assert.match(mask(scene), /<g clip-path="url\(#sight-observer\)"><circle cx="100" cy="100" r="500" clip-path="url\(#light-clip-lamp\)"/);
});

test('light-perception command validation is atomic, GM-only and preserves absent legacy profiles', () => {
  const store = new Store(':memory:'), auth = store.create('Detection validation', 'GM'), gm = store.authenticate(auth.token);
  const playerAuth = store.join(store.snapshot(gm).inviteCode!, 'Player'), owner = store.authenticate(playerAuth.token);
  const state = () => store.export(gm);
  const command = (payload: Record<string, unknown>, session: Session = gm) => store.command(session, {
    id: randomUUID(), type: 'token.update', payload, expectedRevision: state().revision }).ack;
  try {
    const id = state().scenes[0].tokens[0].id, read = () => state().scenes[0].tokens[0];
    assert.equal(command({ id, owners: [owner.memberId] }).ok, true);
    assert.equal(Object.hasOwn(read(), 'lightPerception'), false);
    for (const profile of [{ enabled: true, range: null }, { enabled: true, range: 100000 }, { enabled: false, range: 0 }]) {
      assert.equal(command({ id, lightPerception: profile }).ok, true);
      assert.deepEqual(read().lightPerception, profile);
      assert.deepEqual(readCampaign(JSON.stringify(state())).scenes[0].tokens[0].lightPerception, profile);
    }
    for (const profile of [null, [], false, {}, { enabled: true }, { range: 100 }, { enabled: 1, range: 100 },
      { enabled: true, range: -1 }, { enabled: true, range: 100001 }, { enabled: true, range: Infinity },
      { enabled: true, range: '100' }, { enabled: true, range: 100, unknown: false }]) {
      const before = state();
      assert.equal(command({ id, vision: 1, lightPerception: profile }).code, 'VALIDATION');
      assert.deepEqual(state(), before);
    }
    const before = state();
    assert.equal(command({ id, lightPerception: { enabled: true, range: null } }, owner).code, 'FORBIDDEN');
    assert.deepEqual(state(), before);
  } finally { store.close(); }
});
