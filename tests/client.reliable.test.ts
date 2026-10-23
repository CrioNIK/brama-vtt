import test from 'node:test';
import assert from 'node:assert/strict';
import { newOperation, readOperations, reliableKey, writeOperations } from '../client/reliable.ts';

function storage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}

test('reliable envelope reload preserves the exact request independently of changing input and campaign state', () => {
  const saved = storage(), payload = { id: 'hero', actionId: 'action-7', actionVersion: 4, targetTokenId: 'target', visibility: 'gm', nested: { value: 1 } };
  const operation = newOperation('campaign', 'member', 'hero', 'actor.action.execute', payload, 19, 'Apply');
  const envelope = JSON.stringify(operation.command);
  payload.actionVersion = 99; payload.nested.value = 12;
  assert.equal(JSON.stringify(operation.command), envelope);
  writeOperations(saved, 'campaign', 'member', [operation]);
  const reloaded = readOperations(saved, 'campaign', 'member');
  assert.equal(JSON.stringify(reloaded[0].command), envelope);
  assert.equal(reloaded[0].command.expectedRevision, 19, 'recovery must not substitute the latest revision');
  assert.equal(reloaded[0].command.id, operation.command.id);
  assert.deepEqual(readOperations(saved, 'other-campaign', 'member'), []);
  assert.deepEqual(readOperations(saved, 'campaign', 'other-member'), []);
  writeOperations(saved, 'campaign', 'member', []);
  assert.deepEqual(readOperations(saved, 'campaign', 'member'), []);
});

test('untrusted pending storage fails closed for corruption, wrong owner, duplicate actor, invalid revision or command', () => {
  const saved = storage(), key = reliableKey('campaign', 'member');
  const valid = newOperation('campaign', 'member', 'hero', 'actor.resource.recover', { id: 'hero', event: 'turn' }, 4, 'Recover');
  for (const bad of [
    'not json', '{}', 'null', JSON.stringify([null]),
    JSON.stringify([{ ...valid, campaignId: 'foreign' }]),
    JSON.stringify([{ ...valid, memberId: 'foreign' }]),
    JSON.stringify([valid, { ...valid, command: { ...valid.command, id: 'second' } }]),
    JSON.stringify([valid, { ...valid, actorId: 'other', command: { ...valid.command, payload: { id: 'other' } } }]),
    JSON.stringify([{ ...valid, command: { ...valid.command, expectedRevision: -1 } }]),
    JSON.stringify([{ ...valid, command: { ...valid.command, expectedRevision: 1.5 } }]),
    JSON.stringify([{ ...valid, command: { ...valid.command, type: 'actor.update' } }]),
    JSON.stringify([{ ...valid, command: { ...valid.command, payload: { id: 'different' } } }]),
  ]) { saved.data.set(key, bad); assert.throws(() => readOperations(saved, 'campaign', 'member')); }
});

test('storage read/write errors and invalid operation identity surface before a reliable request can be sent', () => {
  const broken = { getItem: (_key: string): string | null => { throw new Error('denied'); }, setItem: (_key: string, _value: string) => { throw new Error('quota'); } };
  const operation = newOperation('campaign', 'member', 'hero', 'actor.resource.recover', { id: 'hero', event: 'turn' }, 0, 'Recover');
  assert.throws(() => readOperations(broken, 'campaign', 'member'), /denied/);
  assert.throws(() => writeOperations(broken, 'campaign', 'member', [operation]), /quota/);
  assert.throws(() => newOperation('campaign', 'member', 'hero', 'actor.resource.recover', { id: 'other' }, 0, 'Bad'));
  assert.throws(() => newOperation('campaign', 'member', 'hero', 'actor.resource.recover', { id: 'hero' }, Number.NaN, 'Bad'));
});

test('separate outcome roll and HP application retain their exact pending envelopes across reload', () => {
  const saved = storage();
  const rollPayload = { id: 'hero', resolutionId: 'committed-cast', critical: true };
  const applyPayload = { id: 'hero', outcomeId: 'committed-roll', targetTokenId: 'target', multiplier: 0.5 };
  const roll = newOperation('campaign', 'member', 'hero', 'actor.action.rollOutcome', rollPayload, 12, 'Roll');
  const apply = newOperation('campaign', 'member', 'hero', 'actor.action.applyOutcome', applyPayload, 13, 'HP');
  const expected = [structuredClone(roll), structuredClone(apply)];
  rollPayload.critical = false; applyPayload.targetTokenId = 'different'; applyPayload.multiplier = 2;
  for (const [index, operation] of [roll, apply].entries()) {
    writeOperations(saved, 'campaign', 'member', [operation]);
    assert.deepEqual(readOperations(saved, 'campaign', 'member'), [expected[index]]);
  }
});
