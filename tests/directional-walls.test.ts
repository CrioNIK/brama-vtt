import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { blocksMovement, effectiveWallDirection, firstBlockingWallHit, hasLineOfSight, isPointIlluminated, visibilityPolygon, wallBlocksFrom } from '../shared/geometry.ts';
import { readCampaign } from '../server/migrations.ts';
import { makeScene, projectSnapshot, seedCampaign } from '../server/engine.ts';
import { Store, type Session } from '../server/store.ts';
import type { Command, Point, Token, Wall, WallDirection } from '../shared/model.ts';

const channels = ['sight', 'light', 'sound', 'movement'] as const;
function wall(direction: WallDirection = 'both', patch: Partial<Wall> = {}): Wall {
  return { id: 'wall', a: { x: 300, y: 100 }, b: { x: 300, y: 700 }, levelId: 'ground', kind: 'wall', state: 'closed',
    movement: true, sight: true, light: true, sound: true, direction, ...patch };
}
function token(patch: Partial<Token> = {}): Token {
  return { id: 'observer', name: 'Observer', x: 100, y: 400, width: 1, height: 1, rotation: 0,
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

test('blocked source side follows A-to-B in y-down coordinates for every point-query channel', () => {
  const cases = [
    { a: { x: 300, y: 100 }, b: { x: 300, y: 700 }, left: { x: 500, y: 400 }, right: { x: 100, y: 400 } },
    { a: { x: 100, y: 300 }, b: { x: 700, y: 300 }, left: { x: 400, y: 100 }, right: { x: 400, y: 500 } },
    { a: { x: 200, y: 200 }, b: { x: 600, y: 600 }, left: { x: 500, y: 300 }, right: { x: 300, y: 500 } },
  ];
  for (const fixture of cases) for (const channel of channels) {
    const w = wall('left', { a: fixture.a, b: fixture.b });
    assert.equal(hasLineOfSight(fixture.left, fixture.right, [w], 'ground', channel), false);
    assert.equal(hasLineOfSight(fixture.right, fixture.left, [w], 'ground', channel), true);
    w.direction = 'right';
    assert.equal(hasLineOfSight(fixture.left, fixture.right, [w], 'ground', channel), true);
    assert.equal(hasLineOfSight(fixture.right, fixture.left, [w], 'ground', channel), false);
    w.direction = 'both';
    assert.equal(hasLineOfSight(fixture.left, fixture.right, [w], 'ground', channel), false);
    assert.equal(hasLineOfSight(fixture.right, fixture.left, [w], 'ground', channel), false);
  }
});

test('endpoint reversal flips one-way blocking unless the direction is swapped too', () => {
  const west = { x: 100, y: 400 }, east = { x: 500, y: 400 }, original = wall('left');
  const reversed = { ...original, a: original.b, b: original.a };
  for (const channel of channels) {
    assert.equal(hasLineOfSight(west, east, [original], 'ground', channel), true);
    assert.equal(hasLineOfSight(west, east, [reversed], 'ground', channel), false);
    assert.equal(hasLineOfSight(west, east, [{ ...reversed, direction: 'right' }], 'ground', channel), true);
    assert.equal(hasLineOfSight(east, west, [{ ...reversed, direction: 'right' }], 'ground', channel), false);
  }
});

test('all point directions exclude a source on the supporting line while off-line destination contacts block', () => {
  for (const direction of ['both', 'left', 'right'] as const) for (const channel of channels) {
    const w = wall(direction);
    for (const source of [{ x: 300, y: 0 }, w.a, { x: 300, y: 400 }, w.b, { x: 300, y: 900 }]) {
      assert.equal(wallBlocksFrom(w, source, 'ground', channel), false);
      for (const target of [{ x: 100, y: 400 }, { x: 500, y: 400 }, { x: 300, y: 500 }]) {
        assert.equal(hasLineOfSight(source, target, [w], 'ground', channel), true);
        assert.equal(contains(visibilityPolygon(source, 1500, [w], 'ground', channel), target), true);
      }
    }
    const blockedSource = direction === 'left' ? { x: 500, y: 400 } : { x: 100, y: 400 };
    assert.equal(hasLineOfSight(blockedSource, { x: 300, y: 400 }, [w], 'ground', channel), false);
    assert.equal(hasLineOfSight(blockedSource, w.a, [w], 'ground', channel), false);
  }
});

test('fractional point coordinates remain continuous instead of rounding onto the wall', () => {
  const barrier = wall('right'), target = { x: 500, y: 400 };
  for (const x of [299.49, 299.51, 299.9]) {
    assert.equal(hasLineOfSight({ x, y: 400 }, target, [barrier], 'ground'), false);
    assert.equal(contains(visibilityPolygon({ x, y: 400 }, 500, [barrier], 'ground'), target), false);
  }
  assert.equal(hasLineOfSight({ x: 300, y: 400 }, target, [barrier], 'ground'), true);
  assert.equal(hasLineOfSight({ x: 300.1, y: 400 }, { x: 100, y: 400 }, [barrier], 'ground'), true);
});

test('open doors, disabled channels and exact level membership take precedence over direction', () => {
  const west = { x: 100, y: 400 }, east = { x: 500, y: 400 };
  for (const channel of channels) {
    for (const kind of ['door', 'secret'] as const) for (const state of ['closed', 'locked', 'open'] as const) {
      assert.equal(hasLineOfSight(west, east, [wall('right', { kind, state })], 'ground', channel), state === 'open');
    }
    assert.equal(hasLineOfSight(west, east, [wall('right', { [channel]: false })], 'ground', channel), true);
    assert.equal(hasLineOfSight(west, east, [wall('right', { levelId: 'upper' })], 'ground', channel), true);
    assert.equal(hasLineOfSight(west, east, [wall('right', { levelId: 'upper', levelIds: ['ground', 'upper'] })], 'ground', channel), false);
    assert.equal(hasLineOfSight(west, east, [wall('right', { levelIds: [] })], 'ground', channel), true);
  }
});

test('direction filtering happens before LIMITED counting and conservative polygon fallback', () => {
  const source = { x: 100, y: 400 }, target = { x: 700, y: 400 };
  const limited = { sight: 'limited', light: 'limited', sound: 'limited' } as const;
  const allowed = wall('left', { senseModes: limited });
  const first = wall('right', { id: 'first', a: { x: 500, y: 100 }, b: { x: 500, y: 700 }, senseModes: limited });
  const second = wall('right', { id: 'second', a: { x: 600, y: 100 }, b: { x: 600, y: 700 }, senseModes: limited });
  const manyAllowed = Array.from({ length: 257 }, (_, i) => ({ ...allowed, id: `allowed-${i}` }));
  for (const channel of ['sight', 'light', 'sound'] as const) {
    for (const walls of [[allowed, first], [...manyAllowed, first]]) {
      assert.equal(hasLineOfSight(source, target, walls, 'ground', channel), true);
      assert.equal(contains(visibilityPolygon(source, 1000, walls, 'ground', channel), target), true, 'ineligible barriers must not trigger dense fallback');
    }
    assert.equal(firstBlockingWallHit(source, target, [allowed, second, first], 'ground', channel), 5 / 6);
    assert.equal(contains(visibilityPolygon(source, 1000, [allowed, second, first], 'ground', channel), target), false);
    const denseBlocked = Array.from({ length: 257 }, (_, i) => ({ ...first, id: `blocked-${i}` }));
    assert.equal(hasLineOfSight(source, target, denseBlocked, 'ground', channel), true);
    assert.equal(contains(visibilityPolygon(source, 1000, denseBlocked, 'ground', channel), target), false, 'fallback must keep the active one-way barrier');
    assert.equal(contains(visibilityPolygon(target, 1000, denseBlocked, 'ground', channel), source), true, 'fallback must not reintroduce barriers from the passing side');
  }
});

test('illumination uses the light source side and player projection uses the observer side', () => {
  const state = makeScene('Directional light');
  state.walls = [wall('right', { sight: false })];
  state.lights = [{ id: 'lamp', name: 'Lamp', x: 100, y: 400, levelId: 'ground', bright: 0, dim: 1000, color: '#ffffff', enabled: true }];
  assert.equal(isPointIlluminated(state, { x: 500, y: 400 }, 'ground'), false);
  state.walls[0].direction = 'left';
  assert.equal(isPointIlluminated(state, { x: 500, y: 400 }, 'ground'), true);
  const campaign = seedCampaign('Directional projection', 'GM'), player = { id: 'player', name: 'Player', role: 'player' as const, color: '#ffffff' };
  state.visionEnabled = true; state.walls = [wall('left', { kind: 'secret' })];
  state.tokens = [token(), token({ id: 'target', x: 500, owners: [] }), token({ id: 'hidden', x: 500, owners: [], hidden: true })];
  campaign.members.push(player); campaign.scenes = [state]; campaign.activeSceneId = state.id; campaign.actors = [];
  const view = () => projectSnapshot(campaign, player, '').campaign.scenes[0];
  assert.deepEqual(view().tokens.map(t => t.id), ['observer', 'target']);
  assert.equal(view().walls[0].kind, 'wall'); assert.equal(view().walls[0].direction, 'left');
  state.walls[0].direction = 'right';
  assert.deepEqual(view().tokens.map(t => t.id), ['observer']);
});

test('movement gates from the starting center before swept-footprint collision, with explicit on-line policy', () => {
  const state = makeScene('Directional movement'), west = token(), east = token({ x: 500 });
  state.walls = [wall('left')];
  assert.equal(blocksMovement(state, west, east), false);
  assert.equal(blocksMovement(state, east, west), true);
  state.walls[0].direction = 'right';
  assert.equal(blocksMovement(state, west, east), true);
  assert.equal(blocksMovement(state, east, west), false);
  const nearEndpoint = token({ y: 85 });
  assert.equal(hasLineOfSight(nearEndpoint, { x: 500, y: 85 }, state.walls, 'ground', 'movement'), true);
  assert.equal(blocksMovement(state, nearEndpoint, { x: 500, y: 85 }), true, 'the footprint still catches the wall endpoint');
  const onLine = token({ x: 300, y: 50 });
  const alongLine = { x: 300, y: 400 };
  for (const direction of ['both', 'left', 'right'] as const) {
    state.walls[0].direction = direction;
    assert.equal(hasLineOfSight(onLine, alongLine, state.walls, 'ground', 'movement'), true);
    assert.equal(blocksMovement(state, onLine, alongLine), direction === 'both', 'BOTH preserves finite-body SAT on the line; directional source ambiguity excludes');
  }
  state.walls[0] = wall('right', { kind: 'door', state: 'open' });
  assert.equal(blocksMovement(state, west, east), false);
});

function storeFixture() {
  const store = new Store(':memory:'), auth = store.create('Directional command fixture', 'GM'), gm = store.authenticate(auth.token);
  const playerAuth = store.join(store.snapshot(gm).inviteCode!, 'Player'), player = store.authenticate(playerAuth.token);
  const state = () => store.export(gm);
  const command = (type: Command['type'], payload: Record<string, unknown>, session: Session = gm) =>
    store.command(session, { id: randomUUID(), type, payload, expectedRevision: state().revision }).ack;
  return { store, gm, player, state, command };
}

test('direction defaults preserve legacy documents and malformed persisted values fail closed', () => {
  assert.equal(effectiveWallDirection({}), 'both');
  for (const direction of ['both', 'left', 'right'] as const) assert.equal(effectiveWallDirection({ direction }), direction);
  for (const direction of ['unknown', 1, null, false] as unknown as WallDirection[]) assert.equal(effectiveWallDirection({ direction }), 'both');
  const campaign = seedCampaign('Directional migration', 'GM');
  const old = structuredClone(campaign.scenes[0].walls[0]);
  campaign.scenes[0].walls[1].direction = 'left';
  const restored = readCampaign(JSON.stringify(campaign));
  assert.deepEqual(restored.scenes[0].walls[0], old);
  assert.equal(Object.hasOwn(restored.scenes[0].walls[0], 'direction'), false);
  assert.equal(restored.scenes[0].walls[1].direction, 'left');
});

test('GM direction commands preserve endpoints and unrelated channel settings', () => {
  const f = storeFixture();
  try {
    assert.equal(f.command('wall.create', { a: { x: 100, y: 100 }, b: { x: 100, y: 200 }, direction: 'left', senseModes: { sight: 'limited' } }).ok, true);
    const id = f.state().scenes[0].walls.at(-1)!.id, read = () => f.state().scenes[0].walls.find(w => w.id === id)!;
    assert.equal(read().direction, 'left');
    const endpoints = [read().a, read().b];
    assert.equal(f.command('wall.update', { id, direction: 'right' }).ok, true);
    assert.deepEqual([read().a, read().b], endpoints);
    assert.equal(read().direction, 'right');
    assert.equal(read().senseModes!.sight, 'limited');
    assert.equal(f.command('wall.update', { id, sound: false }).ok, true);
    assert.equal(read().direction, 'right');
    assert.equal(f.command('wall.update', { id, direction: 'both' }).ok, true);
    assert.equal(effectiveWallDirection(read()), 'both');
    assert.equal(f.command('wall.update', { id, a: endpoints[1], b: endpoints[0], direction: 'left' }).ok, true);
    assert.deepEqual([read().a, read().b], [endpoints[1], endpoints[0]]);
    assert.equal(read().direction, 'left', 'endpoint edits do not silently swap the explicit enum');
  } finally { f.store.close(); }
});

test('invalid and player direction edits leave campaign and revision unchanged', () => {
  const f = storeFixture();
  try {
    const id = f.state().scenes[0].walls[0].id;
    for (const direction of [null, 0, 1, 2, true, [], {}, 'LEFT', 'foundry-left', 'none', '']) {
      const before = f.state();
      assert.equal(f.command('wall.update', { id, state: 'open', direction }).code, 'VALIDATION');
      assert.deepEqual(f.state(), before);
    }
    const before = f.state();
    assert.equal(f.command('wall.update', { id, direction: 'left' }, f.player).code, 'FORBIDDEN');
    assert.deepEqual(f.state(), before);
  } finally { f.store.close(); }
});
