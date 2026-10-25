import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { castRayBatch, castRayBatchReference, getRaycastBackendStatus, installRaycastKernel, resetRaycastBackendCounters } from '../shared/raycast-backend.ts';
import { createGeometryWasmKernel, initializeGeometryWasm } from '../shared/wasm-raycast.ts';
import { effectiveWallSenseMode, firstBlockingWallHit, prepareWallSource, visibilityPolygon, wallBlocksFrom, wallSourcePolygons } from '../shared/geometry.ts';
import type { Point, Wall } from '../shared/model.ts';

const bytes = Uint8Array.from(readFileSync(new URL('../public/wasm/brama_raycast.wasm', import.meta.url)));
const kernel = await createGeometryWasmKernel(bytes);
test('distributed WASM is pinned to its Rust source/build manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../public/wasm/brama_raycast.build.json', import.meta.url), 'utf8'));
  const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
  assert.equal(manifest.schema, 'brama-raycast-build/1'); assert.equal(manifest.abi, 1);
  assert.equal(manifest.sha256, hash(bytes)); assert.equal(manifest.bytes, bytes.length);
  for (const [source, expected] of Object.entries(manifest.sources)) {
    assert.equal(hash(readFileSync(new URL(`../rust/raycast/${source}`, import.meta.url))), expected, source);
  }
});
const makeWall = (ax: number, ay: number, bx: number, by: number, patch: Partial<Wall> = {}): Wall => ({
  id: 'wall', a: { x: ax, y: ay }, b: { x: bx, y: by }, kind: 'wall', state: 'closed', levelId: 'ground',
  movement: true, sight: true, light: true, sound: true, ...patch,
});
function packed(origin: Point, walls: Wall[], targets: Point[]) {
  const eligible = walls.filter(wall => wallBlocksFrom(wall, origin, 'ground', 'sight'));
  return { walls: Float64Array.from(eligible.flatMap(w => [w.a.x, w.a.y, w.b.x, w.b.y, effectiveWallSenseMode(w, 'sight') === 'limited' ? 1 : 0])),
    rays: Float64Array.from(targets.flatMap(p => [p.x, p.y, Math.hypot(p.x - origin.x, p.y - origin.y)])) };
}
function compare(origin: Point, walls: Wall[], targets: Point[]) {
  const input = packed(origin, walls, targets);
  const expected = targets.map(target => firstBlockingWallHit(origin, target, walls, 'ground') ?? -1);
  assert.deepEqual(Array.from(castRayBatchReference(origin.x, origin.y, input.walls, input.rays)), expected);
  assert.deepEqual(Array.from(kernel.cast(origin.x, origin.y, input.walls, input.rays)), expected);
}

test('actual compiled WASM matches original ordered crossing reference, including EPS/coincident endpoints', () => {
  const limited = { senseModes: { sight: 'limited' as const } };
  const vertical = (x: number, patch: Partial<Wall> = {}) => makeWall(x, -100, x, 100, patch);
  const targets = [{ x: 300, y: 0 }, { x: 300, y: 300 }, { x: 300, y: -300 }, { x: 0, y: 0 }, { x: 1e-10, y: 0 }];
  for (const walls of [[], [vertical(100)], [vertical(100, limited)], [vertical(100, limited), vertical(200, limited)],
    [vertical(100, limited), vertical(100 + 1e-9, limited)], [vertical(100, limited), vertical(100 + 1e-7, limited)],
    [vertical(100, limited), vertical(100, limited), vertical(150)],
    [makeWall(100, -100, 100, 0, limited), makeWall(100, 0, 100, 100, limited)],
    [vertical(100, { direction: 'left' }), vertical(150, { direction: 'right' })],
    [vertical(100, { state: 'open', kind: 'door' }), vertical(200, { levelId: 'upper' })],
    [makeWall(0, -100, 0, 100)], [makeWall(100, 0, 200, 0)]]) {
    compare({ x: 0, y: 0 }, walls, targets);
    compare({ x: 300, y: 0 }, walls.slice().reverse(), targets.map(p => ({ x: -p.x, y: p.y })));
  }
});

test('seeded fractional batches match independent point queries exactly across normal/limited/source-side filters', () => {
  let seed = 0x1234abcd;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let scene = 0; scene < 20; scene++) {
    const origin = { x: random() * 500, y: random() * 500 };
    const walls = Array.from({ length: 200 }, (_, i) => makeWall(random() * 1000, random() * 1000, random() * 1000, random() * 1000,
      { senseModes: { sight: i % 3 ? 'normal' : 'limited' }, direction: i % 5 === 0 ? 'left' : i % 7 === 0 ? 'right' : 'both' }));
    compare(origin, walls, Array.from({ length: 128 }, () => ({ x: random() * 1500 - 250, y: random() * 1500 - 250 })));
  }
});

test('WASM polygon path keeps threshold unions, LIMITED intersection bounds, door/level/direction semantics', () => {
  const origin = { x: 0, y: 0 };
  const fixtures = [
    [makeWall(100, -500, 100, 500, { senseModes: { sight: 'limited' } }), makeWall(50, -38, 150, 62, { senseModes: { sight: 'limited' } })],
    [makeWall(100, -500, 100, 500, { senseModes: { sight: 'proximity' }, senseThresholds: { sight: 200 }, thresholdAttenuation: true }), makeWall(300, -100, 300, 100)],
    [makeWall(100, -500, 100, 500, { senseModes: { sight: 'distance' }, senseThresholds: { sight: 50 }, thresholdAttenuation: true }), makeWall(300, -100, 300, 100, { direction: 'right' })],
    [makeWall(200, -100, 200, 100, { kind: 'door', state: 'open' }), makeWall(500, -100, 500, 100, { levelIds: [] })],
  ];
  try {
    for (const walls of fixtures) {
      installRaycastKernel(null);
      const source = prepareWallSource(origin, 1000, walls, 'ground', 'sight', 20);
      const expected = wallSourcePolygons(source, 1000);
      installRaycastKernel(kernel); resetRaycastBackendCounters();
      assert.deepEqual(wallSourcePolygons(source, 1000), expected);
      assert.ok(getRaycastBackendStatus().wasmBatches >= 1);
      assert.equal(getRaycastBackendStatus().fallbackBatches, 0);
    }
    // Dense LIMITED intersection fallback remains conservative in the common TS preparation.
    const dense = Array.from({ length: 300 }, (_, i) => makeWall(50 + i, -500, 450 - i, 500, { senseModes: { sight: 'limited' } }));
    installRaycastKernel(null); const expected = visibilityPolygon(origin, 1000, dense, 'ground');
    installRaycastKernel(kernel); assert.deepEqual(visibilityPolygon(origin, 1000, dense, 'ground'), expected);
  } finally { installRaycastKernel(null); }
});

test('batch scratch storage survives growth and returned arrays are owned snapshots', () => {
  const one = new Float64Array([5, -5, 5, 5, 0]), ray = new Float64Array([10, 0, 10]);
  const initial = kernel.cast(0, 0, one, ray);
  const large = Float64Array.from({ length: 30_000 }, (_, i) => i % 3 === 1 ? 0 : 10);
  const output = kernel.cast(0, 0, one, large);
  assert.equal(output.length, 10_000); assert.ok(output.every(value => value === 0.5));
  kernel.cast(0, 0, new Float64Array(), ray);
  assert.deepEqual(Array.from(initial), [0.5]); assert.equal(output[0], 0.5);
  assert.throws(() => kernel.cast(0, 0, new Float64Array([NaN, 0, 0, 0, 0]), ray), /Invalid packed wall/);
});

test('failed WASM execution records a reason and falls back to the reference for the whole batch', () => {
  try {
    installRaycastKernel({ name: 'wasm', cast() { throw new Error('Synthetic kernel fault'); } }); resetRaycastBackendCounters();
    assert.deepEqual(Array.from(castRayBatch(0, 0, new Float64Array([5, -5, 5, 5, 0]), new Float64Array([10, 0, 10]))), [0.5]);
    assert.deepEqual(getRaycastBackendStatus(), { backend: 'typescript', wasmBatches: 0, wasmRays: 0, fallbackBatches: 1, fallbackRays: 1, error: 'Synthetic kernel fault' });
  } finally { installRaycastKernel(null); }
});

test('browser bootstrap exposes actual WASM use and an explicit fetch failure fallback', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(bytes);
    assert.equal((await initializeGeometryWasm()).backend, 'wasm');
    resetRaycastBackendCounters(); visibilityPolygon({ x: 0, y: 0 }, 100, [], 'ground');
    assert.equal(getRaycastBackendStatus().wasmBatches, 1);
    assert.equal(getRaycastBackendStatus().wasmRays, 128);
    globalThis.fetch = async () => new Response('missing', { status: 404 });
    const failed = await initializeGeometryWasm();
    assert.equal(failed.backend, 'typescript'); assert.match(failed.error!, /HTTP 404/);
  } finally { globalThis.fetch = original; installRaycastKernel(null); }
});
