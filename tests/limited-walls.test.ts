import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { blocksMovement, canTokenSeeToken, effectiveWallSenseMode, firstBlockingWallHit, hasLineOfSight, isPointIlluminated, visibilityPolygon } from '../shared/geometry.ts';
import { importNeutralScene, SceneImportError } from '../shared/import.ts';
import { makeScene, projectSnapshot, seedCampaign } from '../server/engine.ts';
import { readCampaign } from '../server/migrations.ts';
import { Store, type Session } from '../server/store.ts';
import type { Command, Point, Token, Wall, WallSenseMode } from '../shared/model.ts';

const origin = { x: 0, y: 0 }, target = { x: 300, y: 0 };
function wall(x: number, mode: WallSenseMode = 'limited', patch: Partial<Wall> = {}): Wall {
  return { id: `wall-${x}`, a: { x, y: -1000 }, b: { x, y: 1000 }, levelId: 'ground',
    kind: 'wall', state: 'closed', movement: true, sight: true, light: true, sound: true,
    senseModes: { sight: mode, light: mode, sound: mode }, ...patch };
}
function token(patch: Partial<Token> = {}): Token {
  return { id: 'observer', name: 'Observer', x: 50, y: 300, width: 1, height: 1, rotation: 0,
    color: '#ffffff', levelId: 'ground', owners: ['player'], hidden: false, actorId: null, linked: false,
    hp: null, maxHp: null, vision: 1000, visionEnabled: true, conditions: [], ...patch };
}
function contains(polygon: Point[], p: Point): boolean {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}

test('ordered limited crossings pass once and block at the second, independent of wall array order', () => {
  assert.equal(firstBlockingWallHit(origin, target, [wall(100)], 'ground'), null);
  assert.equal(hasLineOfSight(origin, target, [wall(100)], 'ground'), true);
  for (const walls of [[wall(100), wall(200)], [wall(200), wall(100)], [wall(250), wall(200), wall(100)]]) {
    assert.equal(firstBlockingWallHit(origin, target, walls, 'ground'), 2 / 3);
    assert.equal(hasLineOfSight(origin, target, walls, 'ground'), false);
  }
  assert.equal(firstBlockingWallHit(target, origin, [wall(100), wall(200)], 'ground'), 2 / 3);
});

test('any normal crossing blocks immediately, before or after a pass-through limited crossing', () => {
  for (const [walls, expected] of [
    [[wall(100, 'normal')], 100],
    [[wall(100), wall(50, 'normal')], 50],
    [[wall(100), wall(150, 'normal')], 150],
    [[wall(100), wall(200), wall(250, 'normal')], 200],
    [[wall(100), wall(200), wall(150, 'normal')], 150],
  ] as [Wall[], number][]) {
    assert.ok(Math.abs(firstBlockingWallHit(origin, target, walls, 'ground')! * 300 - expected) < 1e-8);
    assert.equal(hasLineOfSight(origin, target, walls, 'ground'), false);
  }
});

test('legacy booleans and explicit sense overrides coexist without changing movement', () => {
  const legacy = wall(100, 'limited', { senseModes: undefined, sight: false });
  assert.equal(effectiveWallSenseMode(legacy, 'sight'), 'none');
  assert.equal(effectiveWallSenseMode(legacy, 'light'), 'normal');
  assert.equal(hasLineOfSight(origin, target, [legacy], 'ground'), true);
  const mixed = wall(100, 'limited', { sight: false, senseModes: { sight: 'limited', light: 'normal', sound: 'none' } });
  assert.equal(effectiveWallSenseMode(mixed, 'sight'), 'limited', 'explicit override wins over legacy storage');
  assert.equal(hasLineOfSight(origin, target, [mixed], 'ground', 'sight'), true);
  assert.equal(hasLineOfSight(origin, target, [mixed], 'ground', 'light'), false);
  assert.equal(hasLineOfSight(origin, target, [mixed], 'ground', 'sound'), true);
  assert.equal(hasLineOfSight(origin, target, [mixed], 'ground', 'movement'), false);
  const scene = makeScene('Movement remains solid'); scene.walls = [mixed];
  assert.equal(blocksMovement(scene, token(), { x: 150, y: 300 }), true);
  assert.equal(effectiveWallSenseMode(wall(100, 'limited', { senseModes: { sight: 'unsupported' as WallSenseMode } }), 'sight'), 'normal');
});

test('open doors and walls outside explicit level membership do not consume the pass-through crossing', () => {
  for (const kind of ['door', 'secret'] as const) for (const state of ['closed', 'locked', 'open'] as const) {
    assert.equal(hasLineOfSight(origin, target, [wall(100), wall(200, 'limited', { kind, state })], 'ground'), state === 'open');
  }
  const second = wall(200, 'limited', { levelId: 'upper' });
  assert.equal(hasLineOfSight(origin, target, [wall(100), second], 'ground'), true);
  second.levelIds = ['ground', 'upper'];
  assert.equal(hasLineOfSight(origin, target, [wall(100), second], 'ground'), false);
  second.levelIds = [];
  assert.equal(hasLineOfSight(origin, target, [wall(100), second], 'ground'), true);
});

test('coincident intersections count as one BRAMA crossing; a normal wall at the same point still blocks', () => {
  const first = wall(100), duplicate = { ...wall(100), id: 'duplicate', a: first.b, b: first.a };
  const joined = [wall(100, 'limited', { a: { x: 100, y: -30 }, b: { x: 100, y: 0 } }),
    wall(100, 'limited', { a: { x: 100, y: 0 }, b: { x: 100, y: 30 } })];
  const crossing = [wall(100, 'limited', { a: { x: 50, y: -50 }, b: { x: 150, y: 50 } }),
    wall(100, 'limited', { a: { x: 50, y: 50 }, b: { x: 150, y: -50 } })];
  for (const sameCrossing of [[first, duplicate], joined, crossing]) {
    assert.equal(hasLineOfSight(origin, target, sameCrossing, 'ground'), true);
    assert.equal(firstBlockingWallHit(origin, target, [...sameCrossing, wall(200)], 'ground'), 2 / 3);
    assert.equal(firstBlockingWallHit(origin, target, [...sameCrossing, wall(100, 'normal')], 'ground'), 1 / 3);
  }
});

test('endpoint and origin contact rules remain explicit for limited barriers', () => {
  assert.equal(hasLineOfSight(origin, { x: 100, y: 0 }, [wall(100)], 'ground'), true, 'one limited endpoint hit passes');
  assert.equal(hasLineOfSight(origin, { x: 200, y: 0 }, [wall(100), wall(200)], 'ground'), false, 'second limited hit at the target blocks');
  assert.equal(hasLineOfSight(origin, target, [wall(0), wall(100)], 'ground'), true, 'isolated origin contact does not consume a crossing');
  const overlapping = wall(50, 'limited', { a: { x: 50, y: 0 }, b: { x: 100, y: 0 } });
  assert.equal(hasLineOfSight(origin, target, [overlapping], 'ground'), true);
  assert.equal(firstBlockingWallHit(origin, target, [overlapping, wall(200)], 'ground'), 2 / 3);
  assert.equal(firstBlockingWallHit(origin, target, [{ ...overlapping, senseModes: { sight: 'normal' } }], 'ground'), 1 / 6);
});

test('sight and light polygons use the same ordered-crossing rule as point queries', () => {
  for (const channel of ['sight', 'light', 'sound'] as const) {
    const single = visibilityPolygon(origin, 300, [wall(100)], 'ground', channel);
    const double = visibilityPolygon(origin, 300, [wall(100), wall(200)], 'ground', channel);
    const mixed = visibilityPolygon(origin, 300, [wall(100), wall(150, 'normal')], 'ground', channel);
    assert.ok(Math.max(...single.map(p => p.x)) > 299);
    assert.ok(double.every(p => p.x <= 200 + 1e-8));
    assert.ok(mixed.every(p => p.x <= 150 + 1e-8));
    for (const p of [{ x: 150, y: 0 }, { x: 150, y: 60 }, { x: 250, y: 0 }, { x: 250, y: -60 }]) {
      assert.equal(contains(double, p), hasLineOfSight(origin, p, [wall(100), wall(200)], 'ground', channel));
    }
  }
});

test('limited light channels control illumination independently from sight', () => {
  const scene = makeScene('Limited lighting');
  scene.lights = [{ id: 'lamp', name: 'Lamp', x: 50, y: 300, levelId: 'ground', bright: 0, dim: 1000, color: '#ffffff', enabled: true }];
  const observer = token({ vision: 0 }), seen = token({ id: 'seen', x: 250, owners: [] });
  scene.walls = [wall(100, 'limited', { sight: false, senseModes: { sight: 'none', light: 'limited' } })];
  assert.equal(isPointIlluminated(scene, seen, 'ground'), true);
  assert.equal(canTokenSeeToken(scene, observer, seen), true);
  scene.walls.push(wall(200, 'limited', { sight: false, senseModes: { sight: 'none', light: 'limited' } }));
  assert.equal(isPointIlluminated(scene, seen, 'ground'), false);
  assert.equal(canTokenSeeToken(scene, observer, seen), false);
});

test('intersecting limited barriers do not render a wedge beyond the second crossing', () => {
  const origin = { x: 200, y: 400 };
  const barriers = [
    wall(1200, 'limited', { a: { x: 1200, y: 0 }, b: { x: 1200, y: 1000 } }),
    wall(700, 'limited', { a: { x: 700, y: 20 }, b: { x: 1500, y: 820 } }),
  ];
  for (const channel of ['sight', 'light', 'sound'] as const) for (const walls of [barriers, [...barriers].reverse()]) {
    const polygon = visibilityPolygon(origin, 4000, walls, 'ground', channel);
    // Neither intersection angle is one of the fixed base rays or wall endpoints.
    for (const slope of [.11999, .12001]) {
      const behind = { x: 1210, y: 400 + 1010 * slope };
      assert.equal(hasLineOfSight(origin, behind, walls, 'ground', channel), false);
      assert.equal(contains(polygon, behind), false, 'the chord must follow the inward intersection corner');
      const before = { x: 1190, y: 400 + 990 * slope };
      assert.equal(hasLineOfSight(origin, before, walls, 'ground', channel), true);
      assert.equal(contains(polygon, before), true);
    }
    const coincidentRay = { x: 1300, y: 532 };
    assert.equal(hasLineOfSight(origin, coincidentRay, walls, 'ground', channel), true, 'point queries retain one coincident crossing');
    assert.equal(contains(polygon, coincidentRay), false, 'a zero-width point ray must not produce a finite rendered spike');
  }
});

test('dense limited intersection work falls back conservatively without mutating walls or point rules', () => {
  const walls = Array.from({ length: 257 }, (_, i) => ({ ...wall(100), id: `duplicate-${i}` }));
  const before = structuredClone(walls), target = { x: 200, y: 0 };
  assert.equal(hasLineOfSight(origin, target, walls, 'ground'), true, 'coincident point crossings still count once');
  const polygon = visibilityPolygon(origin, 300, walls, 'ground');
  assert.equal(contains(polygon, target), false, 'exhausting the bounded pair search must never discard blockers');
  assert.ok(polygon.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
  assert.deepEqual(walls, before);
});

test('wrapped intersection angles retain their conservative bound without a rounding-induced spike', () => {
  const observer = { x: 500, y: 500 }, target = { x: 937.5745092984289, y: 446.157940197736 };
  const walls = [
    wall(0, 'limited', { a: { x: 866.2850137334317, y: 298.55261323973536 }, b: { x: 524.62084335275, y: 745.3497089445591 } }),
    wall(1, 'limited', { a: { x: 965.6612568069249, y: 539.5545195788145 }, b: { x: 222.76989906094968, y: 302.3024001158774 } }),
  ];
  assert.equal(hasLineOfSight(observer, target, walls, 'ground'), false);
  assert.equal(contains(visibilityPolygon(observer, 1600, walls, 'ground'), target), false);
});

test('player projection reveals a target after one limited wall and conceals targets after two', () => {
  const campaign = seedCampaign('Limited projection', 'GM'), scene = makeScene('Barriers'); scene.visionEnabled = true;
  const player = { id: 'player', name: 'Player', role: 'player' as const, color: '#ffffff' };
  campaign.members.push(player); campaign.scenes = [scene]; campaign.activeSceneId = scene.id; campaign.actors = [];
  const observer = token(), first = token({ id: 'first', x: 150, owners: [] }), second = token({ id: 'second', x: 250, owners: [] });
  scene.tokens = [observer, first, second, token({ id: 'hidden', x: 150, hidden: true, owners: [] })];
  scene.walls = [wall(100), wall(200, 'limited', { kind: 'secret' })];
  const view = () => projectSnapshot(campaign, player, '').campaign.scenes[0];
  assert.deepEqual(view().tokens.map(t => t.id), ['observer', 'first']);
  assert.equal(view().walls[1].kind, 'wall');
  assert.equal(effectiveWallSenseMode(view().walls[1], 'sight'), 'limited', 'secret-wall projection preserves geometry without exposing door identity');
  scene.walls[1].state = 'open';
  assert.deepEqual(view().tokens.map(t => t.id), ['observer', 'first', 'second']);
});

function storeFixture() {
  const store = new Store(':memory:'), auth = store.create('Limited command fixture', 'GM'), gm = store.authenticate(auth.token);
  const playerAuth = store.join(store.snapshot(gm).inviteCode!, 'Player'), player = store.authenticate(playerAuth.token);
  const state = () => store.export(gm);
  const command = (type: Command['type'], payload: Record<string, unknown>, session: Session = gm) =>
    store.command(session, { id: randomUUID(), type, payload, expectedRevision: state().revision }).ack;
  return { store, gm, player, state, command };
}

test('GM wall commands mirror modes into legacy booleans and boolean-only edits clear only that override', () => {
  const f = storeFixture();
  try {
    assert.equal(f.command('wall.create', { a: { x: 100, y: 100 }, b: { x: 100, y: 200 }, senseModes: { sight: 'limited', light: 'none', sound: 'normal' } }).ok, true);
    const id = f.state().scenes[0].walls.at(-1)!.id, read = () => f.state().scenes[0].walls.find(w => w.id === id)!;
    assert.deepEqual([read().sight, read().light, read().sound], [true, false, true]);
    assert.deepEqual(read().senseModes, { sight: 'limited', light: 'none', sound: 'normal' });
    assert.equal(f.command('wall.update', { id, kind: 'door', state: 'open' }).ok, true);
    assert.equal(read().senseModes!.sight, 'limited', 'unrelated fields preserve mode');
    assert.equal(f.command('wall.update', { id, sight: false }).ok, true);
    assert.equal(read().senseModes!.sight, undefined); assert.equal(effectiveWallSenseMode(read(), 'sight'), 'none');
    assert.equal(read().senseModes!.light, 'none');
    assert.equal(f.command('wall.update', { id, sight: true, senseModes: { sight: 'limited' } }).ok, true);
    assert.equal(effectiveWallSenseMode(read(), 'sight'), 'limited');
    assert.equal(f.command('wall.update', { id, sight: true }).ok, true);
    assert.equal(effectiveWallSenseMode(read(), 'sight'), 'normal');
  } finally { f.store.close(); }
});

test('invalid sense edits and player edits fail without altering campaign or revision', () => {
  const f = storeFixture();
  try {
    const id = f.state().scenes[0].walls[0].id;
    for (const payload of [
      { senseModes: null }, { senseModes: [] }, { senseModes: 'limited' },
      { senseModes: { movement: 'limited' } }, { senseModes: { sight: 'proximity' } },
      { senseModes: { sight: 10 } }, { senseModes: { sound: null } },
      { sight: false, senseModes: { sight: 'limited' } }, { light: true, senseModes: { light: 'none' } },
      { senseModes: { sight: 'limited', darkness: 'normal' } },
    ]) {
      const before = f.state();
      assert.equal(f.command('wall.update', { id, state: 'open', ...payload }).code, 'VALIDATION');
      assert.deepEqual(f.state(), before);
    }
    const before = f.state();
    assert.equal(f.command('wall.update', { id, senseModes: { sight: 'limited' } }, f.player).code, 'FORBIDDEN');
    assert.deepEqual(f.state(), before);
  } finally { f.store.close(); }
});

test('JSON migration preserves old boolean walls and explicit limited modes without inventing defaults', () => {
  const campaign = seedCampaign('Legacy and new walls', 'GM');
  const legacy = campaign.scenes[0].walls[0], explicit = { ...wall(200), id: 'new-wall' };
  campaign.scenes[0].walls.push(explicit);
  const restored = readCampaign(JSON.stringify(campaign));
  assert.deepEqual(restored.scenes[0].walls[0], legacy);
  assert.equal(Object.hasOwn(restored.scenes[0].walls[0], 'senseModes'), false);
  assert.deepEqual(restored.scenes[0].walls.at(-1), explicit);
});

const importedDocument = () => {
  const document = JSON.parse(readFileSync(new URL('./fixtures/scene-populated.json', import.meta.url), 'utf8'));
  document.schemaVersion = '0.9.0'; document.provenance.converterVersion = '0.9.0'; return document;
};
test('neutral 0.9 imports explicit limited senses with a scoped warning and preserved source document', () => {
  const document = importedDocument();
  document.scene.walls[0].restrictions = { movement: 'block', sight: 'limited', light: 'none', sound: 'limited' };
  document.scene.walls[1].restrictions.sight = 'limited';
  const before = structuredClone(document), result = importNeutralScene(document), [first, second] = result.scene.walls;
  assert.deepEqual(first.senseModes, { sight: 'limited', sound: 'limited' });
  assert.deepEqual([first.movement, first.sight, first.light, first.sound], [true, true, false, true]);
  assert.equal(second.kind, 'door'); assert.equal(second.state, 'closed'); assert.equal(second.senseModes!.sight, 'limited');
  assert.equal(result.warnings.filter(w => w.startsWith('Limited wall senses')).length, 1);
  assert.deepEqual(document, before);
});

test('neutral limited support never guesses unspecified, directional, threshold or movement semantics', () => {
  for (const restriction of ['unspecified', 'proximity', 'distance', 'normal', 10]) {
    const document = importedDocument(); document.scene.walls[0].restrictions.sight = restriction;
    assert.throws(() => importNeutralScene(document), SceneImportError);
  }
  const movement = importedDocument(); movement.scene.walls[0].restrictions.movement = 'limited';
  assert.throws(() => importNeutralScene(movement), SceneImportError);
  const directional = importedDocument(); directional.scene.walls[0].restrictions.sight = 'limited'; directional.scene.walls[0].direction = 'foundry-left';
  assert.throws(() => importNeutralScene(directional), SceneImportError);
  const old = importedDocument(); old.schemaVersion = '0.8.0'; old.provenance.converterVersion = '0.8.0'; old.scene.walls[0].restrictions.sight = 'limited';
  assert.throws(() => importNeutralScene(old), SceneImportError, 'new neutral semantics require their declared schema version');
});

test('neutral 0.9 retains earlier advancement, checks and sheet capabilities', () => {
  const document = JSON.parse(readFileSync(new URL('./fixtures/advancement/runtime-compatible.json', import.meta.url), 'utf8'));
  const previous = importNeutralScene(document);
  document.schemaVersion = '0.9.0'; document.provenance.converterVersion = '0.9.0';
  const next = importNeutralScene(document);
  assert.deepEqual(next.sheetSummary, previous.sheetSummary);
  assert.deepEqual(next.actors[0].observedAdvancement, previous.actors[0].observedAdvancement);
  assert.deepEqual(next.actors[0].checks, previous.actors[0].checks);
  assert.deepEqual(next.actors[0].source!.advancementEvidence, previous.actors[0].source!.advancementEvidence);
});

test('a rejected limited import rolls back the entire scene transaction', () => {
  const f = storeFixture();
  try {
    const document = importedDocument(); document.scene.walls[0].restrictions.sight = 'limited';
    assert.equal(f.command('scene.import', { document }).ok, true);
    const before = f.state(), broken = importedDocument(); broken.scene.walls[0].restrictions.sight = 'limited'; broken.scene.walls[1].restrictions.sound = 'distance';
    assert.equal(f.command('scene.import', { document: broken }).code, 'VALIDATION');
    assert.deepEqual(f.state(), before);
  } finally { f.store.close(); }
});
