import test from 'node:test';
import assert from 'node:assert/strict';
import { seedCampaign, projectSnapshot } from '../server/engine.ts';
import type { Snapshot } from '../shared/model.ts';
import { applySnapshotDelta, createSnapshotDelta, hasSnapshotStructure, SNAPSHOT_MAX_OPERATIONS, type SnapshotDelta, type SnapshotOperation } from '../shared/snapshot-sync.ts';

function fixture(): Snapshot {
  const campaign = seedCampaign('Snapshot synchronization', 'GM');
  return JSON.parse(JSON.stringify(projectSnapshot(campaign, campaign.members[0], 'fixture-invite')));
}
function advance(before: Snapshot): Snapshot { const next = structuredClone(before); next.campaign.revision++; return next; }
function patch(before: Snapshot, operations: SnapshotOperation[]): SnapshotDelta {
  return { campaignId: before.campaign.id, baseRevision: before.campaign.revision, revision: before.campaign.revision + 1,
    operations: [{ op: 'set', path: ['campaign', 'revision'], value: before.campaign.revision + 1 }, ...operations] };
}

test('sparse nested updates reconstruct the projected snapshot without resending static walls', () => {
  const before = fixture(), after = advance(before), scene = after.campaign.scenes[0];
  scene.tokens[0].x += 25;
  scene.walls[0].a.x += 1;
  after.campaign.name = 'Брама — Światlo — světy';
  const delta = createSnapshotDelta(before, after)!;
  assert.ok(delta);
  assert.ok(delta.operations.some(op => op.path.join('.') === 'campaign.scenes.0.tokens.0.x'));
  assert.ok(delta.operations.some(op => op.path.join('.') === 'campaign.scenes.0.walls.0.a.x'));
  assert.ok(JSON.stringify(delta).length < JSON.stringify(after).length);
  assert.deepEqual(applySnapshotDelta(before, delta), after);
  assert.notEqual(before.campaign.scenes[0].tokens[0].x, after.campaign.scenes[0].tokens[0].x);
});

test('object additions and deletions preserve exact JSON wire semantics', () => {
  const before = fixture(), after = advance(before);
  delete after.inviteCode;
  after.campaign.scenes[0].tokens[0].source = {
    sourceTokenId: 'fixture', sourceActorRef: null, actorResolution: 'none', rotationConvention: 'foundry-zero-south', elevation: 0, sightMetadata: {}
  };
  const delta = createSnapshotDelta(before, after)!;
  assert.ok(delta.operations.some(op => op.op === 'delete' && op.path.join('.') === 'inviteCode'));
  assert.deepEqual(applySnapshotDelta(before, delta), after);
  const restored = advance(after); restored.inviteCode = 'restored';
  assert.deepEqual(applySnapshotDelta(after, createSnapshotDelta(after, restored)), restored);
});

test('array removal replaces that array so revoked actor and token contents disappear', () => {
  const before = fixture(), after = advance(before);
  const removedActor = after.campaign.actors.pop()!;
  after.campaign.scenes[0].tokens = after.campaign.scenes[0].tokens.filter(token => token.actorId !== removedActor.id);
  const delta = createSnapshotDelta(before, after)!;
  assert.ok(delta.operations.some(op => op.op === 'set' && op.path.join('.') === 'campaign.actors'));
  const applied = applySnapshotDelta(before, delta)!;
  assert.deepEqual(applied, after);
  assert.equal(applied.campaign.actors.some(actor => actor.id === removedActor.id), false);
  assert.equal(before.campaign.actors.some(actor => actor.id === removedActor.id), true);
});

test('reordered equal-length arrays and a later insertion reconstruct exactly', () => {
  const before = fixture(), after = advance(before);
  after.campaign.scenes[0].tokens.reverse();
  const applied = applySnapshotDelta(before, createSnapshotDelta(before, after))!;
  assert.deepEqual(applied, after);
  const appended = advance(applied);
  appended.campaign.scenes[0].tokens.push({ ...appended.campaign.scenes[0].tokens[0], id: 'new-token' });
  assert.deepEqual(applySnapshotDelta(applied, createSnapshotDelta(applied, appended)), appended);
});

test('campaign, audience and non-increasing revisions require a full snapshot', () => {
  const before = fixture();
  for (const mutate of [
    (next: Snapshot) => { next.campaign.id = 'other'; },
    (next: Snapshot) => { next.self.id = 'other'; },
    (next: Snapshot) => { next.self.role = 'player'; },
    (next: Snapshot) => { next.self.name = 'Different audience context'; },
    (next: Snapshot) => { next.campaign.revision = before.campaign.revision; },
    (next: Snapshot) => { next.campaign.revision = -1; },
    (next: Snapshot) => { next.campaign.revision = Number.MAX_SAFE_INTEGER + 1; }
  ]) { const next = advance(before); mutate(next); assert.equal(createSnapshotDelta(before, next), null); }
  const valid = createSnapshotDelta(before, advance(before))!;
  for (const changes of [{ campaignId: 'other' }, { baseRevision: before.campaign.revision + 1 }, { revision: before.campaign.revision }, { revision: NaN }, { revision: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(applySnapshotDelta(before, { ...valid, ...changes }), null);
  }
  assert.equal(applySnapshotDelta(advance(before), valid), null);
});

test('invalid operations fail atomically after an earlier valid change', () => {
  const before = fixture(), untouched = structuredClone(before);
  const delta = patch(before, [
    { op: 'set', path: ['campaign', 'name'], value: 'Transient' },
    { op: 'set', path: ['campaign', 'missing', 'child'], value: 1 }
  ]);
  assert.equal(applySnapshotDelta(before, delta), null);
  assert.deepEqual(before, untouched);
  assert.equal(applySnapshotDelta(before, patch(before, [{ op: 'delete', path: ['absent'] }])), null);
  assert.equal(applySnapshotDelta(before, patch(before, [{ op: 'delete', path: ['campaign', 'scenes', 0] }])), null);
  assert.equal(applySnapshotDelta(before, patch(before, [{ op: 'set', path: ['self', 'id'], value: 'another-member' }])), null);
});

test('prototype keys, inherited members, invalid indices and non-JSON payloads are rejected', () => {
  const before = fixture();
  for (const key of ['__proto__', 'prototype', 'constructor']) {
    assert.equal(applySnapshotDelta(before, patch(before, [{ op: 'set', path: ['campaign', key, 'polluted'], value: true }])), null);
    assert.equal(applySnapshotDelta(before, patch(before, [{ op: 'set', path: ['campaign', 'name'], value: JSON.parse(`{"${key}":{"polluted":true}}`) }])), null);
  }
  for (const path of [[], ['campaign', 'scenes', '0'], ['campaign', 'scenes', -1], ['campaign', 'scenes', 1000000], ['campaign', 'toString', 'value']]) {
    assert.equal(applySnapshotDelta(before, patch(before, [{ op: 'set', path, value: 1 }])), null);
  }
  for (const value of [NaN, Infinity, undefined, () => 1, new Date()]) {
    assert.equal(applySnapshotDelta(before, patch(before, [{ op: 'set', path: ['campaign', 'name'], value } as unknown as SnapshotOperation])), null);
  }
  assert.equal((Object.prototype as { polluted?: boolean }).polluted, undefined);
});

test('revision metadata must agree with the applied value and patches stay bounded', () => {
  const before = fixture(), valid = patch(before, []);
  assert.equal(applySnapshotDelta(before, { ...valid, operations: [] }), null);
  assert.equal(applySnapshotDelta(before, { ...valid, operations: [{ op: 'set', path: ['campaign', 'name'], value: 'No revision' }] }), null);
  assert.equal(applySnapshotDelta(before, { ...valid, operations: Array.from({ length: SNAPSHOT_MAX_OPERATIONS + 1 }, () => valid.operations[0]) }), null);
  assert.equal(applySnapshotDelta(before, patch(before, [{ op: 'set', path: ['campaign', 'name'], value: 'x'.repeat(4 * 1024 * 1024 + 1) }])), null);
  assert.equal(applySnapshotDelta(before, { ...valid, unexpected: true }), null);
  assert.equal(applySnapshotDelta(before, { ...valid, operations: [{ ...valid.operations[0], unexpected: true }] }), null);
  let getterRead = false;
  const withGetter = { op: 'set', path: ['campaign', 'name'], get value() { getterRead = true; return 'Unexpected'; } };
  assert.equal(applySnapshotDelta(before, { ...valid, operations: [withGetter] }), null);
  assert.equal(getterRead, false);
});

test('patch payload and changed paths are detached from both baseline and caller values', () => {
  const before = fixture(), after = advance(before);
  after.campaign.scenes[0].tokens.push({ ...after.campaign.scenes[0].tokens[0], id: 'new-token' });
  const delta = createSnapshotDelta(before, after)!;
  const result = applySnapshotDelta(before, delta)!;
  after.campaign.scenes[0].tokens[0].name = 'After changed';
  const operation = delta.operations.find(op => op.op === 'set' && op.path.at(-1) === 'tokens')!;
  (operation as Extract<SnapshotOperation, { op: 'set' }>).value = [];
  assert.notEqual(result.campaign.scenes[0].tokens[0].name, 'After changed');
  assert.ok(result.campaign.scenes[0].tokens.length > before.campaign.scenes[0].tokens.length);
});

test('malformed required containers cannot reach rendering after a valid revision update', () => {
  const before = fixture(); assert.equal(hasSnapshotStructure(before), true);
  const corruptions: SnapshotOperation[] = [
    { op: 'set', path: ['campaign', 'scenes'], value: null },
    { op: 'delete', path: ['campaign', 'chat'] },
    { op: 'set', path: ['campaign', 'scenes', 0], value: {} },
    { op: 'set', path: ['campaign', 'scenes', 0, 'grid'], value: null },
    { op: 'set', path: ['campaign', 'scenes', 0, 'tokens'], value: [null] },
    { op: 'delete', path: ['campaign', 'scenes', 0, 'tokens', 0, 'owners'] },
    { op: 'set', path: ['campaign', 'scenes', 0, 'walls', 0, 'a'], value: null },
    { op: 'delete', path: ['campaign', 'combat', 'settings'] },
    { op: 'set', path: ['campaign', 'actors', 0, 'abilities'], value: {} },
    { op: 'set', path: ['campaign', 'actors', 0, 'actions'], value: null }
  ];
  for (const operation of corruptions) assert.equal(applySnapshotDelta(before, patch(before, [operation])), null, operation.path.join('.'));
  assert.equal(hasSnapshotStructure({ ...before, campaign: { ...before.campaign, scenes: null } }), false);
  assert.equal(hasSnapshotStructure({ ...before, self: { ...before.self, name: null } }), false);
});

test('generator falls back to full state when metadata changes exceed receiver path bounds', () => {
  const before = fixture();
  before.campaign.scenes[0].tokens[0].source = {
    sourceTokenId: null, sourceActorRef: null, actorResolution: 'none', rotationConvention: 'foundry-zero-south', elevation: 0,
    sightMetadata: { ['x'.repeat(257)]: 1 }
  };
  const after = advance(before); after.campaign.scenes[0].tokens[0].source!.sightMetadata['x'.repeat(257)] = 2;
  assert.ok(hasSnapshotStructure(after));
  assert.equal(createSnapshotDelta(before, after), null);
  const removed = advance(before); delete removed.campaign.scenes[0].tokens[0].source!.sightMetadata['x'.repeat(257)];
  assert.equal(createSnapshotDelta(before, removed), null);
  const deep = fixture(), metadata: Record<string, unknown> = {};
  deep.campaign.scenes[0].tokens[0].source = { ...before.campaign.scenes[0].tokens[0].source!, sightMetadata: metadata };
  let cursor = metadata;
  for (let i = 0; i < 41; i++) { const next = {}; cursor.child = next; cursor = next; }
  const added = advance(deep);
  cursor = added.campaign.scenes[0].tokens[0].source!.sightMetadata;
  for (let i = 0; i < 41; i++) cursor = cursor.child as Record<string, unknown>;
  cursor.extra = 1;
  assert.equal(createSnapshotDelta(deep, added), null);
  const deleted = structuredClone(deep); deleted.campaign.revision = added.campaign.revision + 1;
  assert.equal(createSnapshotDelta(added, deleted), null);
});
