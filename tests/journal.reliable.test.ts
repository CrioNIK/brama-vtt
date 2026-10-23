import test from 'node:test';
import assert from 'node:assert/strict';
import { JOURNAL_SCOPE, JOURNAL_RELIABLE_TYPES, COMBAT_SCOPE, newOperation, readOperations, writeOperations, hasOperationReceipt, reliableKey } from '../client/reliable.ts';
import type { ReliableReceiptSnapshot, ReliableType } from '../client/reliable.ts';
const storage = () => { const data = new Map<string, string>(); return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } }; };

test('all journal operations persist an exact immutable envelope with separate campaign-wide scope', () => {
  const saved = storage(); assert.equal(JOURNAL_RELIABLE_TYPES.length, 14);
  for (const type of JOURNAL_RELIABLE_TYPES) {
    const payload: Record<string, unknown> = type === 'journal.create' || type === 'journal.folder.create' ? { name: 'New' } : { id: 'real-document-or-folder-or-show' };
    const operation = newOperation('campaign', 'member', JOURNAL_SCOPE, type, payload, 17, 'Journal change');
    const original = structuredClone(operation); payload.name = 'changed after preview';
    writeOperations(saved, 'campaign', 'member', [operation]);
    assert.deepEqual(readOperations(saved, 'campaign', 'member'), [original]);
    assert.equal(original.command.expectedRevision, 17); assert.equal(original.command.id, operation.command.id);
  }
});

test('journal scope cannot impersonate actor or combat, and missing real target identities fail', () => {
  const saved = storage();
  const candidates: Array<[string, ReliableType, Record<string, unknown>]> = [
    ['hero', 'journal.show', { id: 'hero' }], [COMBAT_SCOPE, 'journal.create', {}],
    [JOURNAL_SCOPE, 'combat.next', {}], [JOURNAL_SCOPE, 'actor.action.execute', { id: JOURNAL_SCOPE }],
    [JOURNAL_SCOPE, 'journal.page.update', {}], [JOURNAL_SCOPE, 'journal.show', { id: JOURNAL_SCOPE }],
    [JOURNAL_SCOPE, 'journal.presentation.dismiss', { id: COMBAT_SCOPE }]
  ];
  const valid = newOperation('campaign', 'member', JOURNAL_SCOPE, 'journal.create', {}, 2, 'New');
  for (const [scope, type, payload] of candidates) {
    assert.throws(() => newOperation('campaign', 'member', scope, type, payload, 2, 'Bad'));
    saved.data.set(reliableKey('campaign', 'member'), JSON.stringify([{ ...valid, actorId: scope, command: { ...valid.command, type, payload } }]));
    assert.throws(() => readOperations(saved, 'campaign', 'member'));
  }
});

test('journal reconciliation needs matching campaign, author, action and valid receipt version', () => {
  const operation = newOperation('campaign', 'member', JOURNAL_SCOPE, 'journal.show', { id: 'doc' }, 6, 'Show');
  const receipt = { commandId: operation.command.id, authorId: 'member', action: operation.command.type, version: 3 };
  const state: ReliableReceiptSnapshot = { id: 'campaign', journalReceipts: [receipt] };
  assert.equal(hasOperationReceipt(operation, state), true);
  for (const changed of [{ ...receipt, authorId: 'other' }, { ...receipt, action: 'journal.update' as const }, { ...receipt, version: 0 }, { ...receipt, commandId: 'other' }]) {
    assert.equal(hasOperationReceipt(operation, { ...state, journalReceipts: [changed] }), false);
  }
  assert.equal(hasOperationReceipt(operation, { ...state, id: 'other' }), false);
  assert.equal(hasOperationReceipt(operation, { id: 'campaign', combatReceipts: [receipt] }), false);
});

test('actor, combat and journal queues coexist while storage failure preserves the original pending command', () => {
  const saved = storage();
  const ops = [newOperation('c', 'm', 'hero', 'actor.action.execute', { id: 'hero' }, 4, 'Action'),
    newOperation('c', 'm', COMBAT_SCOPE, 'combat.next', {}, 4, 'Next'),
    newOperation('c', 'm', JOURNAL_SCOPE, 'journal.create', {}, 4, 'Journal')];
  writeOperations(saved, 'c', 'm', ops); assert.deepEqual(readOperations(saved, 'c', 'm'), ops);
  assert.throws(() => writeOperations(saved, 'c', 'm', [...ops, ops[2]]));
  assert.throws(() => writeOperations({ setItem() { throw new Error('quota'); } }, 'c', 'm', [ops[2]]));
  assert.deepEqual(readOperations(saved, 'c', 'm'), ops);
});
