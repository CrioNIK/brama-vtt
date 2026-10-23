import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applyActionCommand } from '../server/actions.ts';
import { DomainError, rollActorCheck, seedCampaign } from '../server/engine.ts';
import { ACTION_LIMITS, previewAction, previewRecovery } from '../shared/actions.ts';
import type { Actor, ActorAction, Campaign, Command, Member } from '../shared/model.ts';

function setup(patch: Partial<ActorAction> = {}) {
  const campaign = seedCampaign('Pure action lifecycle', 'GM'), member = campaign.members[0], actor = campaign.actors[0];
  actor.sheetKind = 'dnd5e'; actor.abilities.str = 14;
  actor.resources = [{ id: 'charge', label: 'Secret charge', value: 2, max: 2, kind: 'charge', recovery: 'long-rest' }, { id: 'action', label: 'Action', value: 1, max: 1, kind: 'action', recovery: 'turn' }];
  const action: ActorAction = { id: 'check', version: 1, name: 'Research check', description: '', sourceLabel: 'Private source', category: 'test', known: true, prepared: true, requiresPreparation: true, enabled: true, target: 'none', costs: [{ resourceId: 'charge', amount: 1 }, { resourceId: 'action', amount: 1 }], outcome: { kind: 'roll', ability: 'str', modifier: 0, mode: 'advantage' }, ...patch };
  actor.actions = [action];
  const execution = (extra: Record<string, unknown> = {}): Command => ({ id: randomUUID(), type: 'actor.action.execute', payload: { id: actor.id, actionId: action.id, actionVersion: action.version, visibility: 'public', ...extra }, expectedRevision: campaign.revision });
  return { campaign, member, actor, action, execution };
}
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;

test('all action preflight failures happen before RNG or any in-memory mutation', () => {
  const cases: { code: string; change: (f: ReturnType<typeof setup>) => void; payload?: Record<string, unknown> }[] = [
    { code: 'INSUFFICIENT', change: f => { f.actor.resources[1].value = 0; } },
    { code: 'RESOURCE_UNKNOWN', change: f => { f.actor.resources[1].value = null; } },
    { code: 'RESOURCE_MISSING', change: f => { f.actor.resources.pop(); } },
    { code: 'UNPREPARED', change: f => { f.action.prepared = false; } },
    { code: 'UNAVAILABLE', change: f => { f.action.enabled = false; } },
    { code: 'UNAVAILABLE', change: f => { f.action.known = false; } },
    { code: 'ABILITY_UNKNOWN', change: f => { f.actor.abilities.str = null; } },
    { code: 'ABILITY_UNKNOWN', change: f => { f.actor.sheetKind = 'generic'; } },
    { code: 'TARGET_UNAVAILABLE', change: f => { f.action.target = 'token'; }, payload: { targetTokenId: 'not-visible' } },
    { code: 'VALIDATION', change: () => {}, payload: { formula: 'globalThis.call()' } },
    { code: 'ACTION_STALE', change: () => {}, payload: { actionVersion: 99 } },
  ];
  for (const row of cases) {
    const f = setup(); row.change(f); const before = structuredClone(f.campaign); let calls = 0;
    assert.throws(() => applyActionCommand(f.campaign, f.member, f.execution(row.payload), { roll: () => { calls++; throw new Error('RNG must not run'); } }), code(row.code), row.code);
    assert.equal(calls, 0, row.code); assert.deepEqual(f.campaign, before, row.code);
  }
});

test('a representable fractional cost decreases the pool; subprecision costs fail before RNG', () => {
  for (const [beforeValue, amount] of [[1, Number.MIN_VALUE], [100000, 1e-12]]) {
    const f = setup({ costs: [{ resourceId: 'charge', amount }] }); f.actor.resources[0].value = beforeValue; f.actor.resources[0].max = beforeValue;
    const before = structuredClone(f.campaign); let called = false;
    assert.equal(previewAction(f.actor, f.action, { memberId: f.member.id, role: 'gm', visibleTokens: [] }).reasons[0].code, 'PRECISION');
    assert.throws(() => applyActionCommand(f.campaign, f.member, f.execution(), { roll: () => { called = true; throw new Error(); } }), code('PRECISION'));
    assert.equal(called, false); assert.deepEqual(f.campaign, before);
  }
  const f = setup({ costs: [{ resourceId: 'charge', amount: 0.25 }] });
  applyActionCommand(f.campaign, f.member, f.execution(), { roll: (a, p) => rollActorCheck(a, p, () => 10) });
  assert.equal(f.actor.resources[0].value, 1.75); assert.equal(f.campaign.actionResolutions[0].costs[0].amount, 0.25);
});

test('one successful action captures the derived roll and every cost; summary strips private breakdown', () => {
  const f = setup(); f.actor.effects = [{ id: 'private-effect', name: 'Private effect', description: '', disabled: false, changes: [{ ability: 'str', mode: 'add', value: 2 }] }];
  let calls = 0; const draws = [3, 17], command = f.execution();
  applyActionCommand(f.campaign, f.member, command, { roll: (a, p) => { calls++; return rollActorCheck(a, p, () => draws.shift()!); }, now: () => '2026-10-23T00:00:00Z' });
  assert.equal(calls, 1); assert.equal(draws.length, 0); assert.deepEqual(f.actor.resources.map(r => r.value), [1, 0]);
  const receipt = structuredClone(f.campaign.actionResolutions[0]);
  assert.equal(receipt.commandId, command.id); assert.equal(receipt.roll!.total, 20); assert.equal(receipt.roll!.abilitySnapshot!.effective, 16);
  assert.deepEqual(receipt.costs.map(c => [c.before, c.after]), [[2, 1], [1, 0]]);
  assert.deepEqual(f.campaign.chat[0].roll!.dice[0].values, [3, 17]);
  for (const key of ['actor', 'ability', 'abilitySnapshot']) assert.equal(Object.hasOwn(f.campaign.chat[0].roll!, key), false);
  assert.equal(JSON.stringify(f.campaign.chat).includes('Private'), false);
  f.action.name = 'Edited'; f.actor.resources[0].label = 'Edited pool'; f.actor.effects[0].changes[0].value = -10;
  assert.deepEqual(f.campaign.actionResolutions[0], receipt);
});

test('full durable journals and a previously consumed intent ID reject before RNG; no receipt is pruned', () => {
  const f = setup({ costs: [] });
  const command = f.execution(); applyActionCommand(f.campaign, f.member, command, { roll: (a, p) => rollActorCheck(a, p, () => 5) });
  let calls = 0; const deps = { roll: () => { calls++; throw new Error('RNG forbidden'); } };
  const committed = structuredClone(f.campaign);
  assert.throws(() => applyActionCommand(f.campaign, f.member, command, deps), code('ID_REUSED')); assert.deepEqual(f.campaign, committed);
  f.campaign.actionResolutions = Array.from({ length: ACTION_LIMITS.receipts }, (_, i) => ({ ...structuredClone(committed.actionResolutions[0]), id: `receipt-${i}`, commandId: `receipt-${i}` }));
  const full = structuredClone(f.campaign);
  assert.throws(() => applyActionCommand(f.campaign, f.member, f.execution(), deps), code('LIMIT')); assert.deepEqual(f.campaign, full); assert.equal(calls, 0);
});

test('invalid definition patches and missing revision cannot partially rewrite an in-memory Actor', () => {
  const f = setup(); const before = structuredClone(f.campaign);
  const command: Command = { id: randomUUID(), type: 'actor.action.update', expectedRevision: f.campaign.revision, payload: { id: f.actor.id, actionId: f.action.id, actionVersion: 1, name: 'Do not commit', costs: [{ resourceId: 'charge', amount: 1 }], outcome: { kind: 'roll', ability: 'str', modifier: 7, mode: 'normal' } } };
  assert.throws(() => applyActionCommand(f.campaign, f.member, command), code('VALIDATION')); assert.deepEqual(f.campaign, before);
  assert.throws(() => applyActionCommand(f.campaign, f.member, { ...f.execution(), expectedRevision: undefined }), code('REVISION_REQUIRED')); assert.deepEqual(f.campaign, before);
});

test('recovery skips unknown and unrelated pools, records exact changes, and rejects a no-op without writes', () => {
  const f = setup(); f.actor.resources[0].value = 0; f.actor.resources[1].value = 0;
  f.actor.resources.push({ id: 'unknown', label: 'Unknown', value: null, max: 4, recovery: 'long-rest' }, { id: 'short', label: 'Short', value: 1, max: 3, recovery: 'short-rest' });
  const preview = previewRecovery(f.actor, 'long-rest');
  assert.deepEqual(preview.changes.filter(c => c.applied).map(c => c.resourceId), ['charge', 'short']);
  const command: Command = { id: randomUUID(), type: 'actor.resource.recover', expectedRevision: f.campaign.revision, payload: { id: f.actor.id, event: 'long-rest' } };
  applyActionCommand(f.campaign, f.member, command);
  assert.deepEqual(f.actor.resources.map(r => r.value), [2, 0, null, 3]);
  assert.deepEqual(f.campaign.resourceRecoveries[0].changes, preview.changes);
  const before = structuredClone(f.campaign);
  assert.throws(() => applyActionCommand(f.campaign, f.member, { ...command, id: randomUUID() }), code('NO_CHANGE'));
  assert.deepEqual(f.campaign, before);
});
