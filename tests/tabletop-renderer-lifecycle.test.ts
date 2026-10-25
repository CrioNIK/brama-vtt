import test from 'node:test';
import assert from 'node:assert/strict';
import { startMapRenderer, type MapRenderer } from '../client/tabletop-renderer-lifecycle.ts';

type Input = { id: string; viewport: { width: number; height: number } };
function fixture() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const updates: Input[] = [], sizes: number[][] = [], errors: unknown[] = [];
  let destroys = 0;
  const renderer: MapRenderer<Input> = { init: () => pending, update: input => { updates.push(input); },
    resize: (width, height) => { sizes.push([width, height]); }, destroy: () => { destroys++; } };
  const session = startMapRenderer(renderer, error => errors.push(error));
  return { resolve, reject, updates, sizes, errors, renderer, session, destroys: () => destroys };
}
const frame = (id: string, width = 900): Input => ({ id, viewport: { width, height: 600 } });

test('async renderer receives only the latest committed frame and dimensions after initialization', async () => {
  const f = fixture(); f.session.update(frame('old')); f.session.update(frame('latest', 1200));
  assert.equal(f.updates.length, 0); f.resolve(); await f.session.ready;
  assert.deepEqual(f.updates.map(input => input.id), ['latest']);
  assert.deepEqual(f.sizes, [[1200, 600]]);
  f.session.update(frame('next')); assert.deepEqual(f.updates.map(input => input.id), ['latest', 'next']);
  f.session.destroy(); f.session.destroy(); assert.equal(f.destroys(), 1);
  f.session.update(frame('unmounted')); assert.equal(f.updates.length, 2);
});

test('unmount during initialization cleans resources again on late completion without painting or errors', async () => {
  const f = fixture(); f.session.update(frame('never')); f.session.destroy(); f.resolve(); await f.session.ready;
  assert.deepEqual(f.updates, []); assert.deepEqual(f.sizes, []); assert.deepEqual(f.errors, []);
  assert.equal(f.destroys(), 2, 'renderer destruction is idempotent and catches resources created after initial disposal');
});

test('initialization rejection is surfaced once while mounted and remains quiet after unmount', async () => {
  const active = fixture(), error = new Error('No WebGL context'); active.reject(error); await active.session.ready;
  assert.deepEqual(active.errors, [error]); assert.equal(active.destroys(), 1);
  active.session.update(frame('failed')); assert.deepEqual(active.updates, []);
  const disposed = fixture(); disposed.session.destroy(); disposed.reject(error); await disposed.session.ready;
  assert.deepEqual(disposed.errors, []);
});

test('update failure stops further painting; a retry uses a separate renderer session', async () => {
  const first = fixture(), error = new Error('Context initialization failed');
  first.renderer.update = () => { throw error; }; first.session.update(frame('old')); first.resolve(); await first.session.ready;
  assert.deepEqual(first.errors, [error]); assert.equal(first.destroys(), 1);
  first.session.update(frame('ignored')); assert.equal(first.errors.length, 1);
  first.session.destroy();
  const retry = fixture(); retry.session.update(frame('retry')); retry.resolve(); await retry.session.ready;
  assert.deepEqual(retry.updates.map(input => input.id), ['retry']); assert.deepEqual(retry.errors, []);
});
