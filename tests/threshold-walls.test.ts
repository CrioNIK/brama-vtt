import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { blocksMovement, effectiveVisionRadius, effectiveWallSenseMode, hasLineOfSight, prepareWallSource, thresholdWallIsBypassed, tokenExternalRadius, wallSourceContains } from '../shared/geometry.ts';
import { WALL_THRESHOLD_MAX, type Command, type Wall } from '../shared/model.ts';
import { readCampaign } from '../server/migrations.ts';
import { makeScene, seedCampaign } from '../server/engine.ts';
import { Store, type Session } from '../server/store.ts';

function fixture() {
  const store = new Store(':memory:'), auth = store.create('Threshold command fixture', 'GM'), gm = store.authenticate(auth.token);
  const playerAuth = store.join(store.snapshot(gm).inviteCode!, 'Player'), player = store.authenticate(playerAuth.token);
  const state = () => store.export(gm);
  const command = (type: Command['type'], payload: Record<string, unknown>, session: Session = gm) =>
    store.command(session, { id: randomUUID(), type, payload, expectedRevision: state().revision }).ack;
  const create = (patch: Record<string, unknown> = {}) => command('wall.create', { a: { x: 200, y: 100 }, b: { x: 200, y: 500 }, ...patch });
  const last = () => state().scenes[0].walls.at(-1)!;
  return { store, player, state, command, create, last };
}

function thresholdWall(x: number, mode: 'proximity' | 'distance' = 'proximity', patch: Partial<Wall> = {}): Wall {
  return { id: `w-${x}`, a: { x, y: -500 }, b: { x, y: 500 }, levelId: 'ground', kind: 'wall', state: 'closed',
    movement: true, sight: true, light: true, sound: true, senseModes: { sight: mode, light: mode, sound: mode },
    senseThresholds: { sight: 200, light: 200, sound: 200 }, ...patch };
}

test('threshold point exclusion uses finite-segment distance, strict boundaries and source extent independently per channel', () => {
  const origin = { x: 0, y: 0 };
  for (const channel of ['sight', 'light', 'sound'] as const) {
    assert.equal(thresholdWallIsBypassed(thresholdWall(199.9), origin, channel), true);
    assert.equal(thresholdWallIsBypassed(thresholdWall(200), origin, channel), false);
    assert.equal(thresholdWallIsBypassed(thresholdWall(200.1), origin, channel), false);
    assert.equal(thresholdWallIsBypassed(thresholdWall(250), origin, channel, 50), false);
    assert.equal(thresholdWallIsBypassed(thresholdWall(249.9), origin, channel, 50), true);
    assert.equal(thresholdWallIsBypassed(thresholdWall(199.9, 'distance'), origin, channel), false);
    assert.equal(thresholdWallIsBypassed(thresholdWall(200, 'distance'), origin, channel), false);
    assert.equal(thresholdWallIsBypassed(thresholdWall(200.1, 'distance'), origin, channel), true);
    assert.equal(thresholdWallIsBypassed(thresholdWall(150, 'distance'), origin, channel, 50), false);
    assert.equal(thresholdWallIsBypassed(thresholdWall(150.1, 'distance'), origin, channel, 50), true);
    const finite = thresholdWall(100, 'proximity', { a: { x: 100, y: 200 }, b: { x: 100, y: 500 } });
    assert.equal(thresholdWallIsBypassed(finite, origin, channel), false, 'nearest endpoint is farther than the infinite line');
  }
  const independent = thresholdWall(100, 'proximity', { senseThresholds: { sight: 200, light: null, sound: 50 } });
  assert.equal(thresholdWallIsBypassed(independent, origin, 'sight'), true);
  assert.equal(thresholdWallIsBypassed(independent, origin, 'light'), false);
  assert.equal(thresholdWallIsBypassed(independent, origin, 'sound'), false);
  assert.equal(thresholdWallIsBypassed(independent, origin, 'movement'), false);
});

test('raw threshold collision is opt-in and clamps external radius without applying attenuation', () => {
  const origin = { x: 0, y: 0 }, target = { x: 700, y: 0 }, wall = thresholdWall(100, 'proximity', { thresholdAttenuation: true });
  assert.equal(hasLineOfSight(origin, target, [wall], 'ground'), false);
  assert.equal(hasLineOfSight(origin, target, [wall], 'ground', 'sight', { radius: 1000, useThreshold: true }), true);
  assert.equal(wallSourceContains(prepareWallSource(origin, 1000, [wall], 'ground'), target), false, 'effective attenuation is separate from raw collision');
  const beyond = thresholdWall(250);
  assert.equal(hasLineOfSight(origin, target, [beyond], 'ground', 'sight', { radius: 50, externalRadius: 1000, useThreshold: true }), false);
  assert.equal(hasLineOfSight(origin, target, [beyond], 'ground', 'sight', { radius: 51, externalRadius: 1000, useThreshold: true }), true);
  for (const externalRadius of [-1, NaN, Infinity]) {
    assert.equal(hasLineOfSight(origin, target, [wall], 'ground', 'sight', { radius: 1000, externalRadius, useThreshold: true }), false);
  }
});

test('effective threshold regions keep baseline LOS and add only the exact attenuated radius behind bypassed walls', () => {
  const origin = { x: 0, y: 0 };
  for (const channel of ['sight', 'light', 'sound'] as const) {
    const wall = thresholdWall(100, 'proximity', { thresholdAttenuation: true });
    const source = prepareWallSource(origin, 1000, [wall], 'ground', channel);
    assert.equal(source.attenuationRadius, 200);
    assert.equal(wallSourceContains(source, { x: 200, y: 0 }), true);
    assert.equal(wallSourceContains(source, { x: 200.0001, y: 0 }), false);
    assert.equal(wallSourceContains(source, { x: -700, y: 0 }), true, 'attenuation does not shorten clear baseline LOS');
    const inverse = prepareWallSource(origin, 1000, [thresholdWall(300, 'distance', { thresholdAttenuation: true })], 'ground', channel);
    assert.equal(inverse.attenuationRadius, 400);
    assert.equal(wallSourceContains(inverse, { x: 400, y: 0 }), true);
    assert.equal(wallSourceContains(inverse, { x: 400.0001, y: 0 }), false);
    const saturated = prepareWallSource(origin, 1000, [thresholdWall(400, 'distance', { thresholdAttenuation: true })], 'ground', channel);
    assert.equal(saturated.attenuationRadius, 1000);
    assert.equal(wallSourceContains(saturated, { x: 900, y: 0 }), true);
    assert.equal(wallSourceContains(saturated, { x: 1000.001, y: 0 }), false);
  }
});

test('multiple contributors use their largest radius, including unattenuated and direction-excluded candidates', () => {
  const origin = { x: 0, y: 0 }, first = thresholdWall(100, 'proximity', { thresholdAttenuation: true });
  const second = thresholdWall(150, 'proximity', { senseThresholds: { sight: 300 }, thresholdAttenuation: true });
  assert.equal(prepareWallSource(origin, 1000, [first, second], 'ground').attenuationRadius, 300);
  second.thresholdAttenuation = false; second.direction = 'left';
  const source = prepareWallSource(origin, 1000, [first, second], 'ground');
  assert.equal(source.closedWalls.includes(second), false, 'the contributor does not block from this side');
  assert.equal(source.attenuationRadius, 1000, 'candidate collection intentionally does not repeat the direction gate');
  assert.equal(wallSourceContains(source, { x: 700, y: 0 }), true);
});

test('attenuation candidates use inclusive source-square AABB overlap, including candidates beyond the radial disk', () => {
  const origin = { x: 0, y: 0 }, first = thresholdWall(100, 'proximity', { thresholdAttenuation: true });
  const corner = thresholdWall(1000, 'proximity', { a: { x: 1000, y: 1000 }, b: { x: 1000, y: 1200 }, senseThresholds: { sight: 2000 } });
  assert.equal(prepareWallSource(origin, 1000, [first, corner], 'ground').attenuationRadius, 1000);
  corner.a.x = corner.b.x = 1000.001;
  assert.equal(prepareWallSource(origin, 1000, [first, corner], 'ground').attenuationRadius, 200);
});

test('radius-edge skipped contributors retain open LOS and malformed source or threshold data cannot open a barrier', () => {
  const origin = { x: 0, y: 0 }, wall = thresholdWall(100, 'proximity', { thresholdAttenuation: true });
  assert.equal(prepareWallSource(origin, 100, [wall], 'ground').attenuationRadius, null);
  assert.equal(prepareWallSource(origin, 50, [wall], 'ground').attenuationRadius, null);
  for (const value of [undefined, null, 0, -1, NaN, Infinity, 100001, '200']) {
    const invalid = { ...wall, senseThresholds: { sight: value } } as Wall;
    assert.equal(wallSourceContains(prepareWallSource(origin, 1000, [invalid], 'ground'), { x: 300, y: 0 }), false);
  }
  for (const patch of [{ senseThresholds: { sight: 200, unknown: 10 } }, { thresholdAttenuation: 'true' }]) {
    assert.equal(wallSourceContains(prepareWallSource(origin, 1000, [{ ...wall, ...patch } as Wall], 'ground'), { x: 300, y: 0 }), false);
  }
  assert.equal(wallSourceContains(prepareWallSource({ x: NaN, y: 0 }, 1000, [wall], 'ground'), origin), false);
  assert.equal(wallSourceContains(prepareWallSource(origin, Infinity, [wall], 'ground'), origin), false);
});

test('threshold bypass preserves ordinary and LIMITED blockers, exact membership, open doors and movement collision', () => {
  const origin = { x: 0, y: 0 }, target = { x: 700, y: 0 }, threshold = thresholdWall(100);
  const normal = thresholdWall(300, 'proximity', { senseModes: { sight: 'normal' } });
  assert.equal(wallSourceContains(prepareWallSource(origin, 1000, [threshold, normal], 'ground'), target), false);
  const limited = (x: number) => thresholdWall(x, 'proximity', { senseModes: { sight: 'limited' } });
  assert.equal(wallSourceContains(prepareWallSource(origin, 1000, [threshold, limited(300)], 'ground'), target), true);
  assert.equal(wallSourceContains(prepareWallSource(origin, 1000, [threshold, limited(300), limited(500)], 'ground'), target), false);
  const attenuated = thresholdWall(100, 'proximity', { thresholdAttenuation: true });
  for (const patch of [{ levelIds: [] }, { levelId: 'upper' }, { kind: 'door' as const, state: 'open' as const }]) {
    const source = prepareWallSource(origin, 1000, [{ ...attenuated, ...patch }], 'ground');
    assert.equal(source.attenuationRadius, null); assert.equal(wallSourceContains(source, target), true);
  }
  const scene = makeScene('Threshold movement');
  scene.walls = [thresholdWall(300, 'proximity', { a: { x: 300, y: 0 }, b: { x: 300, y: 800 } })];
  const token = seedCampaign('Movement fixture', 'GM').scenes[0].tokens[0];
  Object.assign(token, { x: 100, y: 400, width: 1, height: 1, levelId: 'ground' });
  assert.equal(blocksMovement(scene, token, { x: 600, y: 400 }), true);
});

test('threshold wall documents preserve optional data without inventing values on migration', () => {
  const campaign = seedCampaign('Threshold migration', 'GM'), [legacy, explicit] = campaign.scenes[0].walls;
  explicit.senseModes = { sight: 'proximity', light: 'distance' };
  explicit.senseThresholds = { sight: 125.5, light: null };
  explicit.thresholdAttenuation = true;
  const migrated = readCampaign(JSON.stringify(campaign));
  assert.deepEqual(migrated.scenes[0].walls[0], legacy);
  assert.equal(Object.hasOwn(migrated.scenes[0].walls[0], 'senseThresholds'), false);
  assert.equal(Object.hasOwn(migrated.scenes[0].walls[0], 'thresholdAttenuation'), false);
  assert.deepEqual(migrated.scenes[0].walls[1], explicit);
});

test('threshold modes remain solid in raw point queries without a threshold-enabled source context', () => {
  const base: Wall = { id: 'w', a: { x: 200, y: 100 }, b: { x: 200, y: 500 }, levelId: 'ground',
    kind: 'wall', state: 'closed', movement: true, sight: true, light: true, sound: true };
  for (const mode of ['proximity', 'distance'] as const) {
    for (const value of [undefined, null, 100, -5, 0, NaN, Infinity, '100', false]) {
      const wall = { ...base, senseModes: { sight: mode }, senseThresholds: { sight: value } } as Wall;
      assert.equal(effectiveWallSenseMode(wall, 'sight'), mode);
      assert.equal(hasLineOfSight({ x: 100, y: 300 }, { x: 400, y: 300 }, [wall], 'ground'), false);
    }
  }
});

test('GM can create and independently edit per-sense pixel thresholds and shared attenuation', () => {
  const f = fixture();
  try {
    assert.equal(f.create({ senseModes: { sight: 'proximity', light: 'distance', sound: 'limited' },
      senseThresholds: { sight: 125.5, light: WALL_THRESHOLD_MAX }, thresholdAttenuation: true, direction: 'left' }).ok, true);
    const id = f.last().id;
    assert.deepEqual(f.last().senseModes, { sight: 'proximity', light: 'distance', sound: 'limited' });
    assert.deepEqual(f.last().senseThresholds, { sight: 125.5, light: WALL_THRESHOLD_MAX });
    assert.equal(f.last().thresholdAttenuation, true);
    assert.equal(f.last().sight, true); assert.equal(f.last().light, true); assert.equal(f.last().sound, true);
    assert.equal(f.command('wall.update', { id, senseThresholds: { light: null, sound: .01 }, thresholdAttenuation: false }).ok, true);
    assert.deepEqual(f.last().senseThresholds, { sight: 125.5, light: null, sound: .01 });
    assert.equal(f.last().thresholdAttenuation, false);
    assert.equal(f.last().direction, 'left');
    assert.equal(f.command('wall.update', { id, state: 'locked' }).ok, true);
    assert.deepEqual(f.last().senseThresholds, { sight: 125.5, light: null, sound: .01 });
  } finally { f.store.close(); }
});

test('mode-only and empty threshold patches preserve absence; explicit null clears only its channel', () => {
  const f = fixture();
  try {
    assert.equal(f.create({ senseModes: { sight: 'proximity' }, senseThresholds: {} }).ok, true);
    const id = f.last().id;
    assert.equal(Object.hasOwn(f.last(), 'senseThresholds'), false);
    assert.equal(Object.hasOwn(f.last(), 'thresholdAttenuation'), false);
    assert.equal(f.command('wall.update', { id, senseThresholds: { sight: 100, light: 200 } }).ok, true);
    assert.equal(f.command('wall.update', { id, senseModes: { sight: 'normal' }, senseThresholds: { sight: null } }).ok, true);
    assert.deepEqual(f.last().senseThresholds, { sight: null, light: 200 });
    assert.equal(f.last().senseModes!.sight, 'normal');
    assert.equal(f.command('wall.update', { id, light: false }).ok, true);
    assert.equal(f.last().senseModes!.light, undefined);
    assert.equal(f.last().senseThresholds!.light, 200, 'inactive values are preserved unless the command explicitly clears them');
    assert.equal(effectiveWallSenseMode(f.last(), 'light'), 'none');
  } finally { f.store.close(); }
});

test('invalid threshold distances reject both create and update without campaign changes', () => {
  const f = fixture();
  try {
    const id = f.state().scenes[0].walls[0].id;
    for (const value of [0, -0, -1, WALL_THRESHOLD_MAX + 1, NaN, Infinity, -Infinity, '50', true, [], {}, undefined]) {
      for (const type of ['wall.create', 'wall.update'] as const) {
        const before = f.state(), payload = { id, a: { x: 200, y: 100 }, b: { x: 200, y: 500 },
          state: 'open', senseModes: { sight: 'proximity' }, senseThresholds: { sight: value } };
        assert.equal(f.command(type, payload).code, 'VALIDATION', `${type}: ${String(value)}`);
        assert.deepEqual(f.state(), before);
      }
    }
  } finally { f.store.close(); }
});

test('threshold containers, channels, attenuation flags and mirrored booleans are strict', () => {
  const f = fixture();
  try {
    const id = f.state().scenes[0].walls[0].id;
    const invalid = [
      ...[null, [], '100', 100, true].map(senseThresholds => ({ senseThresholds })),
      { senseThresholds: { movement: 100 } }, { senseThresholds: { sight: 100, unknown: null } },
      ...[null, 0, 1, 'true', [], {}].map(thresholdAttenuation => ({ thresholdAttenuation })),
      { sight: false, senseModes: { sight: 'proximity' } }, { light: false, senseModes: { light: 'distance' } },
      { senseModes: { movement: 'proximity' } },
    ];
    for (const patch of invalid) {
      const before = f.state();
      assert.equal(f.command('wall.update', { id, direction: 'right', ...patch }).code, 'VALIDATION');
      assert.deepEqual(f.state(), before);
    }
  } finally { f.store.close(); }
});

test('players cannot configure threshold modes, distances or attenuation', () => {
  const f = fixture();
  try {
    const id = f.state().scenes[0].walls[0].id;
    for (const patch of [{ senseModes: { sight: 'proximity' } }, { senseThresholds: { sight: 100 } }, { thresholdAttenuation: true }]) {
      const before = f.state();
      assert.equal(f.command('wall.update', { id, ...patch }, f.player).code, 'FORBIDDEN');
      assert.deepEqual(f.state(), before);
    }
  } finally { f.store.close(); }
});

test('positive edge-based vision range tracks occupied token size and grid without changing center profiles', () => {
  const base = { width: 2, height: 1, vision: 300 };
  assert.equal(tokenExternalRadius(base, 100), 0);
  assert.equal(effectiveVisionRadius(base, 100), 300);
  assert.equal(effectiveVisionRadius({ ...base, visionRangeOrigin: 'center' }, 100), 300);
  const edge = { ...base, visionRangeOrigin: 'token-edge' as const };
  assert.equal(tokenExternalRadius(edge, 100), 50);
  assert.equal(effectiveVisionRadius(edge, 100), 350);
  assert.equal(effectiveVisionRadius({ ...edge, height: 3 }, 100), 400);
  assert.equal(effectiveVisionRadius(edge, 50), 325);
  assert.equal(effectiveVisionRadius({ ...edge, width: .25 }, 100), 312.5);
  assert.deepEqual(base, { width: 2, height: 1, vision: 300 });
});

test('GM vision-origin commands are strict, preserve legacy absence and survive migration', () => {
  const f = fixture();
  try {
    const legacy = f.state().scenes[0].tokens[0];
    assert.equal(Object.hasOwn(legacy, 'visionRangeOrigin'), false);
    assert.equal(f.command('token.create', { name: 'Edge observer', visionRangeOrigin: 'token-edge', owners: [f.player.memberId] }).ok, true);
    const id = f.state().scenes[0].tokens.at(-1)!.id;
    assert.equal(f.command('token.update', { id, vision: 300 }).ok, true);
    assert.equal(f.state().scenes[0].tokens.at(-1)!.visionRangeOrigin, 'token-edge');
    const restored = readCampaign(JSON.stringify(f.state()));
    assert.equal(restored.scenes[0].tokens.at(-1)!.visionRangeOrigin, 'token-edge');
    assert.equal(Object.hasOwn(restored.scenes[0].tokens[0], 'visionRangeOrigin'), false);
    assert.equal(f.command('token.update', { id, visionRangeOrigin: 'center' }).ok, true);
    for (const value of [null, true, 0, {}, [], 'edge', 'CENTER']) {
      const before = f.state();
      assert.equal(f.command('token.update', { id, vision: 100, visionRangeOrigin: value }).code, 'VALIDATION');
      assert.deepEqual(f.state(), before);
    }
    const before = f.state();
    assert.equal(f.command('token.update', { id, visionRangeOrigin: 'token-edge' }, f.player).code, 'FORBIDDEN');
    assert.deepEqual(f.state(), before);
  } finally { f.store.close(); }
});
