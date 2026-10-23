import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { importNeutralScene, SceneImportError } from '../shared/import.ts';
import { tokenResources } from '../shared/model.ts';
import { Store } from '../server/store.ts';

const linkedURL = new URL('./fixtures/token-linked.json', import.meta.url);
const unlinkedURL = new URL('./fixtures/token-unlinked.json', import.meta.url);
const linked = () => JSON.parse(readFileSync(linkedURL, 'utf8'));
const unlinked = () => JSON.parse(readFileSync(unlinkedURL, 'utf8'));
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

test('fixture: 0.3 linked bundle maps center/rotation/level, exact Actor HP and enabled basic range zero', () => {
  const document = linked(), original = JSON.stringify(document);
  const { scene, actors } = importNeutralScene(document), token = scene.tokens[0], actor = actors[0];
  assert.equal(actors.length, 1); assert.equal(scene.tokens.length, 1);
  assert.deepEqual([token.x, token.y], [2350, 2750]); assert.equal(token.width, 1); assert.equal(token.height, 1);
  assert.equal(token.rotation, 315); assert.equal(token.source?.rotationConvention, 'foundry-zero-south');
  assert.equal(token.levelId, 'defaultLevel0000'); assert.equal(token.hidden, false);
  assert.equal(token.vision, 0); assert.equal(token.visionEnabled, true); assert.equal(token.visionUnlimited, false);
  assert.equal(scene.globalLightEnabled, false);
  assert.equal(token.linked, true); assert.equal(token.actorId, actor.id); assert.notEqual(actor.id, document.actors[0].id);
  assert.deepEqual(tokenResources(token, actors), { hp: 7, maxHp: 10 }); assert.equal(token.hp, null);
  assert.equal(actor.source?.sourceActorRef, '9WCR71fDOzsFpHnY'); assert.equal(actor.source?.systemVersion, '6.0.6');
  assert.deepEqual(actor.owners, []); assert.deepEqual(token.owners, []);
  assert.equal(JSON.stringify(document), original); assert.equal(JSON.stringify(scene).includes('originalUtf8Text'), false);
});

test('multiple linked tokens share one runtime Actor; independent imports have fresh identities', () => {
  const document = linked(), extra = structuredClone(document.scene.tokens[0]);
  extra.id = 'another-normalized-token'; extra.sourceTokenId = 'another-native-token'; extra.position = [2450, 2750]; document.scene.tokens.push(extra);
  const first = importNeutralScene(document), second = importNeutralScene(document);
  assert.equal(first.actors.length, 1); assert.equal(first.scene.tokens.length, 2);
  assert.equal(first.scene.tokens[0].actorId, first.scene.tokens[1].actorId);
  first.actors[0].hp = 4;
  assert.equal(tokenResources(first.scene.tokens[1], first.actors).hp, 4);
  assert.notEqual(first.actors[0].id, second.actors[0].id); assert.notEqual(first.scene.tokens[0].id, second.scene.tokens[0].id);
});

test('unresolved linked identity uses one shared placeholder with unknown HP, never default 0/10', () => {
  const document = linked(); document.actors = [];
  document.scene.tokens[0].actorId = null; document.scene.tokens[0].actorResolution = 'unresolved';
  const extra = structuredClone(document.scene.tokens[0]); extra.id = 'second'; extra.sourceTokenId = 'second-native'; document.scene.tokens.push(extra);
  const result = importNeutralScene(document);
  assert.equal(result.actors.length, 1); assert.equal(result.actors[0].source?.resolution, 'unresolved');
  assert.deepEqual(tokenResources(result.scene.tokens[0], result.actors), { hp: null, maxHp: null });
  assert.equal(result.scene.tokens[0].actorId, result.scene.tokens[1].actorId);
  assert.ok(result.warnings.some(w => w.includes('placeholder')));
  const unknownSystem = linked(); unknownSystem.actors[0].systemVersion = 'unknown-version'; unknownSystem.actors[0].hp = null;
  assert.equal(importNeutralScene(unknownSystem).actors[0].hp, null);
});

test('an unresolved Actor granted to a player never discloses its native source ID through its generated name', () => {
  const store = new Store(':memory:');
  try {
    const auth = store.create('Placeholder privacy', 'GM'), gm = store.authenticate(auth.token);
    const playerAuth = store.join(store.snapshot(gm).inviteCode!, 'Owner'), player = store.authenticate(playerAuth.token);
    const document = linked(), nativeActorId = document.scene.tokens[0].sourceActorRef;
    document.actors = []; document.scene.tokens[0].actorId = null; document.scene.tokens[0].actorResolution = 'unresolved';
    const command = (type: string, payload: Record<string, unknown>) => store.command(gm, { id: randomUUID(), type, payload }).ack;
    assert.equal(command('scene.import', { document }).ok, true);
    const campaign = store.snapshot(gm).campaign, scene = campaign.scenes.find(s => s.id === campaign.activeSceneId)!, actorId = scene.tokens[0].actorId!;
    assert.equal(command('actor.update', { id: actorId, owners: [playerAuth.memberId] }).ok, true);
    assert.equal(command('scene.update', { id: scene.id, visionEnabled: false }).ok, true);
    const snapshot = store.snapshot(player), actor = snapshot.campaign.actors.find(a => a.id === actorId)!;
    assert.equal(actor.name, 'Unknown character 1'); assert.equal(actor.sheetAccess, 'full'); assert.equal(actor.source, undefined);
    assert.equal(actor.name.includes(nativeActorId), false); assert.equal(JSON.stringify(snapshot).includes(nativeActorId), false);
    assert.equal(store.snapshot(gm).campaign.actors.find(a => a.id === actorId)!.source!.sourceActorRef, nativeActorId);
  } finally { store.close(); }
});

test('fixture: unlinked ActorDelta HP5/10 remains independent of base Actor7/10 and its linked instances', () => {
  const document = unlinked(), linkedToken = structuredClone(linked().scene.tokens[0]);
  linkedToken.id = 'linked-companion'; linkedToken.sourceTokenId = 'linked-native-companion'; document.scene.tokens.push(linkedToken);
  const result = importNeutralScene(document), independent = result.scene.tokens[0], connected = result.scene.tokens[1];
  assert.equal(independent.linked, false); assert.equal(independent.actorId, connected.actorId);
  assert.deepEqual(tokenResources(independent, result.actors), { hp: 5, maxHp: 10 });
  assert.deepEqual(tokenResources(connected, result.actors), { hp: 7, maxHp: 10 });
  result.actors[0].hp = 2;
  assert.equal(tokenResources(independent, result.actors).hp, 5); assert.equal(tokenResources(connected, result.actors).hp, 2);
  assert.deepEqual(independent.conditions, [], 'source ActorDelta effects are not executed or invented as conditions');
  assert.ok(document.provenance.originalUtf8Text.includes('delta'));
});

test('references, ownership policy, geometry and incompatible sight reject instead of guessing', () => {
  const mutations = [
    (d: ReturnType<typeof linked>) => { d.scene.tokens[0].sourceActorRef = 'different-source'; },
    (d: ReturnType<typeof linked>) => { d.scene.tokens[0].actorId = 'missing-actor'; },
    (d: ReturnType<typeof linked>) => { d.actors[0].sourceId = 'missing-archive'; },
    (d: ReturnType<typeof linked>) => { d.scene.tokens[0].permissionPolicy = 'all-players'; },
    (d: ReturnType<typeof linked>) => { d.scene.tokens[0].positionAnchor = 'top-left'; },
    (d: ReturnType<typeof linked>) => { d.scene.tokens[0].levelId = null; },
    (d: ReturnType<typeof linked>) => { d.scene.tokens[0].position = [0, 0]; },
    (d: ReturnType<typeof linked>) => { d.scene.tokens[0].actorResolution = 'unlinked'; },
    (d: ReturnType<typeof linked>) => { d.scene.tokens[0].hp = { value: 5, max: 10, temp: 0, tempMax: 0 }; },
    (d: ReturnType<typeof linked>) => { d.scene.tokens[0].sight.mode = 'darkvision'; },
    (d: ReturnType<typeof linked>) => { d.scene.tokens[0].sight.angle = 90; },
    (d: ReturnType<typeof linked>) => { d.scene.tokens[0].sight = null; },
    (d: ReturnType<typeof linked>) => { d.scene.tokens[0].detectionModesMetadata = { special: { range: 50 } }; },
    (d: ReturnType<typeof linked>) => { d.scene.tokens[0].sight.rangePixels = 500; },
    (d: ReturnType<typeof linked>) => { d.actors[0].systemVersion = 'unknown-version'; },
  ];
  for (const change of mutations) { const document = linked(); change(document); assert.throws(() => importNeutralScene(document), SceneImportError); }
});

test('explicit null vision range means unlimited; global illumination honors exported thresholds', () => {
  const document = linked(); document.scene.tokens[0].sight.rangePixels = null; document.scene.tokens[0].sightMetadata.range = null;
  let result = importNeutralScene(document);
  assert.equal(result.scene.tokens[0].visionUnlimited, true); assert.equal(result.scene.tokens[0].visionEnabled, true);
  document.scene.globalLightEnabled = true; document.scene.globalLightMetadata.enabled = true;
  document.scene.globalLightMetadata.darkness = { min: 0.2, max: 0.6 }; document.scene.darknessLevel = 0.4;
  assert.equal(importNeutralScene(document).scene.globalLightEnabled, true);
  document.scene.darknessLevel = 0.8;
  result = importNeutralScene(document); assert.equal(result.scene.globalLightEnabled, false);
  assert.ok(result.warnings.some(w => w.includes('inactive')));
});

test('campaign import assigns current GM, preserves archive originals, and never reuses source users or actor identities', () => {
  const store = new Store(':memory:');
  try {
    const gmAuth = store.create('Import campaign', 'GM'), gm = store.authenticate(gmAuth.token);
    const playerAuth = store.join(store.snapshot(gm).inviteCode!, 'Player'), player = store.authenticate(playerAuth.token);
    const document = unlinked(), companion = structuredClone(linked().scene.tokens[0]);
    companion.id = 'linked-companion'; companion.sourceTokenId = 'linked-native-companion'; document.scene.tokens.push(companion);
    document.actors[0].owners = [playerAuth.memberId]; document.scene.tokens[0].owners = [playerAuth.memberId];
    const command = (type: string, payload: Record<string, unknown>) => store.command(gm, { id: randomUUID(), type, payload });
    const imported = command('scene.import', { document }); assert.equal(imported.ack.ok, true, imported.ack.error);
    const state = store.snapshot(gm), scene = state.campaign.scenes.find(s => s.id === state.campaign.activeSceneId)!;
    const actor = state.campaign.actors.find(a => a.id === scene.tokens[0].actorId)!;
    assert.deepEqual(actor.owners, [gmAuth.memberId]); for (const token of scene.tokens) assert.deepEqual(token.owners, [gmAuth.memberId]);
    assert.equal(store.command(player, { id: randomUUID(), type: 'token.update', payload: { id: scene.tokens[0].id, hp: 1 } }).ack.code, 'FORBIDDEN');
    assert.equal(command('token.update', { id: scene.tokens[0].id, hp: 3 }).ack.ok, true);
    let current = store.snapshot(gm).campaign;
    assert.equal(current.actors.find(a => a.id === actor.id)!.hp, 7);
    assert.equal(command('token.update', { id: scene.tokens[1].id, hp: 6 }).ack.ok, true);
    current = store.snapshot(gm).campaign;
    assert.equal(current.actors.find(a => a.id === actor.id)!.hp, 6);
    assert.equal(current.scenes.find(s => s.id === scene.id)!.tokens[0].hp, 3);
    const archive = store.importArchive(gm, scene.id) as ReturnType<typeof unlinked>;
    assert.deepEqual(archive, document);
    assert.equal(digest(archive.provenance.originalUtf8Text), archive.provenance.sourceSha256);
    for (const source of archive.provenance.additionalSources) assert.equal(digest(source.originalUtf8Text), source.sourceSha256);
    assert.equal(archive.provenance.additionalSources[0].originalUtf8Text, readFileSync(new URL('./fixtures/actor-token.json', import.meta.url), 'utf8'));
    const projected = JSON.stringify(store.snapshot(player));
    assert.equal(projected.includes('originalUtf8Text'), false); assert.equal(projected.includes('sourceActorRef'), false);
    assert.throws(() => store.importArchive(player, scene.id));
    assert.equal(command('scene.import', { document }).ack.ok, true);
    const repeated = store.snapshot(gm).campaign;
    const nextScene = repeated.scenes.find(s => s.id === repeated.activeSceneId)!;
    assert.notEqual(nextScene.tokens[0].actorId, actor.id);
    assert.equal(repeated.actors.find(a => a.id === nextScene.tokens[0].actorId)!.hp, 7, 'new import must not overwrite old or merge by source ID');
  } finally { store.close(); }
});

test('saving names or colors with explicit unknown HP retains null instead of inventing zero', () => {
  const store = new Store(':memory:');
  try {
    const auth = store.create('Unknown resources', 'GM'), session = store.authenticate(auth.token), document = linked();
    document.actors = []; document.scene.tokens[0].actorId = null; document.scene.tokens[0].actorResolution = 'unresolved';
    const command = (type: string, payload: Record<string, unknown>) => store.command(session, { id: randomUUID(), type, payload });
    assert.equal(command('scene.import', { document }).ack.ok, true);
    let state = store.snapshot(session).campaign, scene = state.scenes.find(s => s.id === state.activeSceneId)!, token = scene.tokens[0];
    assert.equal(command('token.update', { id: token.id, name: 'Unknown renamed', color: '#112233', hp: null, maxHp: null }).ack.ok, true);
    assert.equal(command('actor.update', { id: token.actorId, name: 'Unknown actor', hp: null, maxHp: null }).ack.ok, true);
    state = store.snapshot(session).campaign; scene = state.scenes.find(s => s.id === state.activeSceneId)!; token = scene.tokens[0];
    assert.deepEqual(tokenResources(token, state.actors), { hp: null, maxHp: null });
    assert.equal(token.name, 'Unknown renamed'); assert.equal(token.color, '#112233');
    assert.equal(command('token.update', { id: token.id, hp: '0', maxHp: 10 }).ack.code, 'VALIDATION', 'numeric strings are never coerced');
  } finally { store.close(); }
});

test('relink without resource edits adopts Actor HP and leaves independent copies unchanged', () => {
  const store = new Store(':memory:');
  try {
    const auth = store.create('Relink resources', 'GM'), session = store.authenticate(auth.token), document = unlinked();
    const extra = structuredClone(document.scene.tokens[0]); extra.id = 'independent-copy'; extra.sourceTokenId = 'independent-native'; document.scene.tokens.push(extra);
    const command = (type: string, payload: Record<string, unknown>) => store.command(session, { id: randomUUID(), type, payload });
    assert.equal(command('scene.import', { document }).ack.ok, true);
    let state = store.snapshot(session).campaign, scene = state.scenes.find(s => s.id === state.activeSceneId)!;
    const tokenId = scene.tokens[0].id, actorId = scene.tokens[0].actorId!;
    assert.deepEqual(tokenResources(scene.tokens[0], state.actors), { hp: 5, maxHp: 10 });
    assert.equal(command('token.update', { id: tokenId, linked: true }).ack.ok, true);
    state = store.snapshot(session).campaign; scene = state.scenes.find(s => s.id === state.activeSceneId)!;
    assert.deepEqual(tokenResources(scene.tokens[0], state.actors), { hp: 7, maxHp: 10 });
    assert.equal(state.actors.find(a => a.id === actorId)!.hp, 7, 'relink alone must never write stale local HP into Actor');
    assert.equal(scene.tokens[0].hp, 5, 'retained local field is inactive while linked');
    assert.deepEqual(tokenResources(scene.tokens[1], state.actors), { hp: 5, maxHp: 10 });
    assert.equal(command('actor.update', { id: actorId, hp: 6 }).ack.ok, true);
    state = store.snapshot(session).campaign; scene = state.scenes.find(s => s.id === state.activeSceneId)!;
    assert.equal(tokenResources(scene.tokens[0], state.actors).hp, 6);
    assert.equal(tokenResources(scene.tokens[1], state.actors).hp, 5);
  } finally { store.close(); }
});

test('imported vision at the shared upper bound remains editable and invalid overflow rolls back', () => {
  const store = new Store(':memory:');
  try {
    const auth = store.create('Vision bounds', 'GM'), session = store.authenticate(auth.token), document = linked();
    document.scene.tokens[0].sight.rangePixels = 100000;
    document.scene.tokens[0].sightMetadata.range = 100000 * document.scene.grid.distance / document.scene.grid.sizePixels;
    const command = (type: string, payload: Record<string, unknown>) => store.command(session, { id: randomUUID(), type, payload });
    const imported = command('scene.import', { document }); assert.equal(imported.ack.ok, true, imported.ack.error);
    let state = store.snapshot(session).campaign, token = state.scenes.find(s => s.id === state.activeSceneId)!.tokens[0];
    assert.equal(command('token.update', { id: token.id, name: 'Long range', vision: 100000 }).ack.ok, true);
    assert.equal(command('token.update', { id: token.id, name: 'Must roll back', vision: 100001 }).ack.code, 'VALIDATION');
    state = store.snapshot(session).campaign; token = state.scenes.find(s => s.id === state.activeSceneId)!.tokens[0];
    assert.equal(token.name, 'Long range'); assert.equal(token.vision, 100000);
  } finally { store.close(); }
});
