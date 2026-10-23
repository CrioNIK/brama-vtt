import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMBAT_SCOPE, COMBAT_RELIABLE_TYPES, hasOperationReceipt,
  newOperation, readOperations, reliableKey, writeOperations
} from '../client/reliable.ts';
import type { PendingOperation, ReliableReceiptSnapshot, ReliableType } from '../client/reliable.ts';

function storage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
const needsId = new Set(['combat.add', 'combat.remove', 'combat.roll', 'combat.update', 'combat.endTurn']);

test('all combat envelopes round-trip with real payload IDs or no ID, retaining the exact command and preview revision', () => {
  const saved = storage();
  assert.equal(COMBAT_RELIABLE_TYPES.length, 12);
  for (const type of COMBAT_RELIABLE_TYPES) {
    const payload: Record<string, unknown> = needsId.has(type) ? { id: 'real-token-or-combatant' } : {};
    if (type === 'combat.settings') payload.turnRecovery = true;
    const operation = newOperation('campaign', 'member', COMBAT_SCOPE, type, payload, 19, 'Edit combat');
    const exact = structuredClone(operation);
    payload.id = 'later-selection';
    payload.changedAfterPreview = true;
    writeOperations(saved, 'campaign', 'member', [operation]);
    const [loaded] = readOperations(saved, 'campaign', 'member');
    assert.deepEqual(loaded, exact);
    assert.equal(loaded.version, 1, 'existing durable storage schema remains readable');
    assert.equal(loaded.actorId, COMBAT_SCOPE);
    assert.equal(loaded.command.expectedRevision, 19, 'reload must not substitute a newer campaign revision');
    assert.equal(loaded.command.id, operation.command.id, 'retry must retain the original deduplication ID');
    assert.equal(Object.hasOwn(loaded.command.payload, 'id'), needsId.has(type));
    if (needsId.has(type)) assert.equal(loaded.command.payload.id, 'real-token-or-combatant');
  }
});

test('new and persisted operations reject actor/combat scope confusion, fake payload identities and invalid revisions', () => {
  const saved = storage(), key = reliableKey('campaign', 'member');
  const valid = newOperation('campaign', 'member', COMBAT_SCOPE, 'combat.next', {}, 2, 'Next');
  const invalid: Array<{ scope: string; type: ReliableType; payload: Record<string, unknown>; revision: number }> = [
    { scope: 'hero', type: 'combat.next', payload: { id: 'hero' }, revision: 2 },
    { scope: COMBAT_SCOPE, type: 'actor.action.execute', payload: { id: COMBAT_SCOPE }, revision: 2 },
    { scope: COMBAT_SCOPE, type: 'combat.add', payload: {}, revision: 2 },
    { scope: COMBAT_SCOPE, type: 'combat.endTurn', payload: {}, revision: 2 },
    { scope: COMBAT_SCOPE, type: 'combat.roll', payload: { id: COMBAT_SCOPE }, revision: 2 },
    { scope: COMBAT_SCOPE, type: 'combat.remove', payload: { id: '' }, revision: 2 },
    { scope: COMBAT_SCOPE, type: 'combat.update', payload: { id: 12 }, revision: 2 },
    { scope: COMBAT_SCOPE, type: 'combat.next', payload: { id: null }, revision: 2 },
    { scope: COMBAT_SCOPE, type: 'combat.next', payload: {}, revision: -1 },
    { scope: COMBAT_SCOPE, type: 'combat.next', payload: {}, revision: 0.5 },
    { scope: COMBAT_SCOPE, type: 'combat.next', payload: {}, revision: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const candidate of invalid) {
    assert.throws(() => newOperation('campaign', 'member', candidate.scope, candidate.type, candidate.payload, candidate.revision, 'Invalid'));
    saved.data.set(key, JSON.stringify([{ ...valid, actorId: candidate.scope, command: { ...valid.command,
      type: candidate.type, payload: candidate.payload, expectedRevision: candidate.revision } }]));
    assert.throws(() => readOperations(saved, 'campaign', 'member'));
  }
  for (const command of [
    { ...valid.command, type: 'combat.unknown' },
    { ...valid.command, payload: [] },
    { ...valid.command, expectedRevision: undefined }
  ]) {
    saved.data.set(key, JSON.stringify([{ ...valid, command }]));
    assert.throws(() => readOperations(saved, 'campaign', 'member'));
  }
});

test('legacy actor requests coexist with one combat queue, while duplicate scopes and cross-scope command IDs fail closed', () => {
  const saved = storage(), key = reliableKey('campaign', 'member');
  const actor = newOperation('campaign', 'member', 'hero', 'actor.resource.recover', { id: 'hero', event: 'turn' }, 4, 'Resource');
  const combat = newOperation('campaign', 'member', COMBAT_SCOPE, 'combat.next', {}, 4, 'Turn');
  writeOperations(saved, 'campaign', 'member', [actor, combat]);
  assert.deepEqual(readOperations(saved, 'campaign', 'member'), [actor, combat]);
  assert.deepEqual(readOperations(saved, 'other-campaign', 'member'), []);
  assert.deepEqual(readOperations(saved, 'campaign', 'other-member'), []);
  const second = newOperation('campaign', 'member', COMBAT_SCOPE, 'combat.end', {}, 5, 'End');
  for (const entries of [[combat, second], [actor, { ...combat, command: { ...combat.command, id: actor.command.id } }]]) {
    assert.throws(() => writeOperations(saved, 'campaign', 'member', entries));
    saved.data.set(key, JSON.stringify(entries));
    assert.throws(() => readOperations(saved, 'campaign', 'member'));
  }
});

test('combat receipt reconciliation requires matching campaign, author, command type and valid post-command version', () => {
  const operation = newOperation('campaign', 'member', COMBAT_SCOPE, 'combat.next', {}, 19, 'Turn');
  const exact = structuredClone(operation.command);
  const receipt = { commandId: operation.command.id, authorId: 'member', action: operation.command.type, version: 7 };
  const snapshot: ReliableReceiptSnapshot = { id: 'campaign', combatReceipts: [receipt] };
  assert.equal(hasOperationReceipt(operation, snapshot), true);
  for (const wrong of [
    { ...snapshot, id: 'foreign-campaign' },
    { id: 'campaign', combatReceipts: [] },
    { id: 'campaign', actionResolutions: [{ commandId: operation.command.id }] },
    ...[
      { ...receipt, commandId: 'other-command' }, { ...receipt, authorId: 'other-member' },
      { ...receipt, action: 'combat.end' as const }, { ...receipt, version: 0 },
      { ...receipt, version: -1 }, { ...receipt, version: 1.5 }, { ...receipt, version: Infinity }
    ].map(other => ({ id: 'campaign', combatReceipts: [other] }))
  ]) assert.equal(hasOperationReceipt(operation, wrong), false);
  assert.deepEqual(operation.command, exact, 'receipt reconciliation does not rewrite the immutable envelope');
  assert.equal(operation.command.expectedRevision, 19, 'combat version is not a replacement campaign revision');
});

test('actor receipt reconciliation remains compatible and cannot be cleared by a combat receipt', () => {
  const operation = newOperation('campaign', 'member', 'hero', 'actor.progression.commit', { id: 'hero', previewKey: 'preview' }, 12, 'Progression');
  assert.equal(hasOperationReceipt(operation, { id: 'campaign', progressionCommits: [{ commandId: operation.command.id }] }), true);
  assert.equal(hasOperationReceipt(operation, { id: 'campaign', combatReceipts: [{ commandId: operation.command.id,
    authorId: 'member', version: 1, action: 'combat.next' }] }), false);
  assert.equal(hasOperationReceipt(operation, { id: 'foreign', progressionCommits: [{ commandId: operation.command.id }] }), false);
});

test('combat storage failures propagate and never replace the previously persisted envelope', () => {
  const saved = storage(), key = reliableKey('campaign', 'member');
  const operation = newOperation('campaign', 'member', COMBAT_SCOPE, 'combat.roll', { id: 'combatant' }, 6, 'Initiative');
  writeOperations(saved, 'campaign', 'member', [operation]);
  const before = saved.data.get(key);
  const denied = { setItem: (_key: string, _value: string): never => { throw new Error('quota'); } };
  assert.throws(() => writeOperations(denied, 'campaign', 'member', []), /quota/);
  assert.equal(saved.data.get(key), before);
  assert.deepEqual(readOperations(saved, 'campaign', 'member'), [operation]);
  const malformed = { ...operation, actorId: 'other' } satisfies PendingOperation;
  assert.throws(() => writeOperations(saved, 'campaign', 'member', [malformed]));
  assert.equal(saved.data.get(key), before, 'invalid scope is rejected before replacing durable data');
});
