import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Session } from '../server/store.ts';
import { readCampaign } from '../server/migrations.ts';
import type { Command, Combatant } from '../shared/model.ts';

function fixture(path = ':memory:') {
  let store = new Store(path);
  const gmAuth = store.create('Combat contract', 'GM'), gm = store.authenticate(gmAuth.token);
  const ownerAuth = store.join(store.snapshot(gm).inviteCode!, 'Owner'), owner = store.authenticate(ownerAuth.token);
  const foreignAuth = store.join(store.snapshot(gm).inviteCode!, 'Other'), foreign = store.authenticate(foreignAuth.token);
  const state = () => store.export(gm);
  const command = (type: Command['type'], payload: Record<string, unknown> = {}, who: Session = gm, extra: Partial<Command> = {}) => store.command(who, { id: randomUUID(), type, payload, expectedRevision: state().revision, ...extra }).ack;
  const ok = (type: Command['type'], payload: Record<string, unknown> = {}, who: Session = gm, extra: Partial<Command> = {}) => { const ack = command(type, payload, who, extra); assert.equal(ack.ok, true, `${type}: ${ack.code} ${ack.error}`); return ack; };
  const token = state().scenes[0].tokens[0];
  ok('token.update', { id: token.id, owners: [ownerAuth.memberId] });
  ok('actor.update', { id: token.actorId!, abilities: { dex: 14 } });
  const add = (tokenId = token.id) => { ok('combat.add', { id: tokenId }); return state().combat.combatants.find(e => e.tokenId === tokenId)!; };
  const custom = (name: string, patch: Record<string, unknown> = {}) => { ok('combat.custom', { name, ...patch }); return state().combat.combatants.find(e => e.name === name)!; };
  const row = (id: string) => state().combat.combatants.find(e => e.id === id)!;
  const current = () => state().combat.combatants[state().combat.turn]?.id;
  return { get store() { return store; }, gm, gmAuth, owner, foreign, ownerAuth, state, command, ok, token, add, custom, row, current,
    reopen: () => { store.close(); store = new Store(path); } };
}

test('combat migration preserves legacy current order, unrolled values and no fabricated events', () => {
  const f = fixture(); try {
    const doc = f.state(); const a = f.add(); const b = f.custom('Counter');
    const legacy = { active: true, round: 4, turn: 1, combatants: [a, b].map(({ id, sceneId, tokenId, name, initiative }) => ({ id, sceneId, tokenId, name, initiative })) };
    const migrated = readCampaign(JSON.stringify({ ...doc, combat: legacy, combatReceipts: undefined }));
    assert.equal(migrated.combat.round, 4); assert.equal(migrated.combat.turn, 1);
    assert.deepEqual(migrated.combat.combatants.map(e => e.id), [a.id, b.id]);
    assert.deepEqual(migrated.combat.combatants.map(e => e.initiative), [null, null]);
    assert.equal(migrated.combat.version, 1); assert.deepEqual(migrated.combatReceipts, []); assert.deepEqual(migrated.combat.counterHistory, []);
  } finally { f.store.close(); }
});

test('all combat writes require revision and unknown fields fail atomically', () => {
  const f = fixture(); try {
    const before = f.state();
    for (const type of ['combat.add','combat.remove','combat.roll','combat.next','combat.end','combat.custom','combat.update','combat.previous','combat.settings','combat.reset','combat.clear','combat.endTurn'] as Command['type'][]) {
      assert.equal(f.command(type, {}, f.gm, { expectedRevision: undefined }).code, 'REVISION_REQUIRED');
      assert.deepEqual(f.state(), before);
    }
    assert.equal(f.command('combat.custom', { name: 'bad', counter: { value: 1.5, step: 1, event: 'turn' } }).code, 'VALIDATION');
    assert.equal(f.command('combat.settings', { skipDefeated: true, arbitrary: true }).code, 'VALIDATION');
    assert.deepEqual(f.state(), before);
  } finally { f.store.close(); }
});

test('two stale next intentions cannot skip a turn; exact retry is unchanged', () => {
  const f = fixture(); try {
    const a = f.add(), b = f.custom('B'); f.custom('C'); f.ok('combat.next');
    const revision = f.state().revision, id = randomUUID();
    const ack = f.ok('combat.next', {}, f.gm, { expectedRevision: revision, id }); const after = f.state();
    assert.equal(f.current(), b.id); assert.notEqual(f.current(), a.id);
    assert.equal(f.command('combat.next', {}, f.gm, { expectedRevision: revision }).code, 'CONFLICT');
    assert.deepEqual(f.command('combat.next', {}, f.gm, { expectedRevision: revision, id }), ack); assert.deepEqual(f.state(), after);
  } finally { f.store.close(); }
});

test('dice and transition ACK survive SQLite reopen and cross-session command IDs cannot repeat', () => {
  const directory = mkdtempSync(join(tmpdir(), 'vtt-combat-')); const f = fixture(join(directory, 'test.sqlite'));
  try {
    const e = f.add(), revision = f.state().revision, id = randomUUID();
    const ack = f.ok('combat.roll', { id: e.id }, f.owner, { expectedRevision: revision, id }); const after = f.state();
    f.reopen(); assert.deepEqual(f.command('combat.roll', { id: e.id }, f.owner, { expectedRevision: revision, id }), ack); assert.deepEqual(f.state(), after);
    assert.equal(f.command('combat.roll', { id: e.id, formula: '20' }, f.owner, { expectedRevision: revision, id }).code, 'ID_REUSED');
    assert.equal(f.command('combat.roll', { id: e.id }, f.gm, { id }).code, 'ID_REUSED');
    f.ok('combat.next'); const nextId = randomUUID(), nextRevision = f.state().revision;
    const nextAck = f.ok('combat.next', {}, f.gm, { id: nextId, expectedRevision: nextRevision }); const nextState = f.state();
    f.reopen(); assert.deepEqual(f.command('combat.next', {}, f.gm, { id: nextId, expectedRevision: nextRevision }), nextAck); assert.deepEqual(f.state(), nextState);
  } finally { f.store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('initiative derives current DEX effects, rejects owner formulas and unknown DEX; manual decimals stay explicit', () => {
  const f = fixture(); try {
    const e = f.add(); f.ok('actor.effect.create', { id: f.token.actorId!, name: 'DEX grant', disabled: false, changes: [{ ability: 'dex', mode: 'add', value: 2 }] });
    f.ok('combat.roll', { id: e.id }, f.owner); const roll = f.row(e.id).roll!;
    assert.equal(roll.modifier, 3); assert.equal(roll.total, roll.dice[0].values[0] + 3); assert.equal(f.state().chat.length, 0);
    const before = f.state(); assert.equal(f.command('combat.roll', { id: e.id, formula: '999' }, f.owner).code, 'FORBIDDEN'); assert.deepEqual(f.state(), before);
    f.ok('actor.update', { id: f.token.actorId!, abilities: { dex: null } });
    assert.equal(f.command('combat.roll', { id: e.id }, f.owner).code, 'INITIATIVE_UNKNOWN');
    f.ok('combat.roll', { id: e.id, formula: '1d20+0' }); assert.equal(f.row(e.id).roll!.modifier, 0);
    f.ok('combat.update', { id: e.id, initiative: 12.5 }); assert.equal(f.row(e.id).initiative, 12.5); assert.equal(f.row(e.id).roll, undefined);
  } finally { f.store.close(); }
});

test('stable tie rank is independent of roll order and manual tie reorder preserves current participant', () => {
  const f = fixture(); try {
    const a = f.custom('A'), b = f.custom('B'), c = f.custom('C');
    for (const e of [c,b,a]) f.ok('combat.roll', { id: e.id, formula: '10' });
    assert.deepEqual(f.state().combat.combatants.map(e => e.id), [a.id,b.id,c.id]);
    f.ok('combat.next'); f.ok('combat.next');
    f.ok('combat.update', { id: c.id, beforeId: a.id }); assert.equal(f.current(), b.id);
    assert.deepEqual(f.state().combat.combatants.map(e => e.id), [c.id,a.id,b.id]);
    f.ok('combat.roll', { id: a.id, formula: '40' }); assert.equal(f.current(), b.id);
    assert.equal(f.command('combat.update', { id: c.id, beforeId: a.id }).code, 'VALIDATION');
  } finally { f.store.close(); }
});

test('end keeps roster and counters; reset initiative and clear are separate, receipts survive', () => {
  const f = fixture(); try {
    const a = f.custom('Timer', { initiative: 12, counter: { value: 5, step: -1, event: 'round' } });
    f.ok('combat.next'); assert.equal(f.command('combat.reset').code, 'COMBAT_ACTIVE'); f.ok('combat.next'); f.ok('combat.end');
    assert.equal(f.row(a.id).initiative, 12); assert.equal(f.row(a.id).counter!.value, 4); assert.equal(f.state().combat.active, false);
    f.ok('combat.reset'); assert.equal(f.row(a.id).initiative, null); assert.equal(f.row(a.id).counter!.value, 4);
    f.ok('combat.settings', { skipDefeated: false, allowPlayerEndTurn: true });
    const receiptCount = f.state().combatReceipts.length; f.ok('combat.clear'); assert.equal(f.state().combat.combatants.length, 0); assert.equal(f.state().combatReceipts.length, receiptCount + 1);
    assert.deepEqual(f.state().combat.settings, { skipDefeated: false, allowPlayerEndTurn: true });
  } finally { f.store.close(); }
});

test('turn counters tick only on that entry, round counters only on wrap, previous exactly restores both', () => {
  const f = fixture(); try {
    const a = f.custom('Turn A', { initiative: 20, counter: { value: 10, step: -1, event: 'turn' } });
    const b = f.custom('Round B', { initiative: 10, counter: { value: 2, step: 3, event: 'round' } });
    f.ok('combat.next'); assert.equal(f.row(a.id).counter!.value, 10);
    f.ok('combat.next'); assert.equal(f.current(), b.id); assert.equal(f.row(a.id).counter!.value, 10); assert.equal(f.row(b.id).counter!.value, 2);
    f.ok('combat.next'); assert.equal(f.state().combat.round, 2); assert.equal(f.row(a.id).counter!.value, 9); assert.equal(f.row(b.id).counter!.value, 5);
    const beforeSnapshots = f.state(); f.store.snapshot(f.owner); f.store.snapshot(f.gm); assert.deepEqual(f.state(), beforeSnapshots);
    f.ok('combat.previous'); assert.equal(f.current(), b.id); assert.equal(f.state().combat.round, 1); assert.equal(f.row(a.id).counter!.value, 10); assert.equal(f.row(b.id).counter!.value, 2);
    f.ok('combat.previous'); assert.equal(f.current(), a.id); assert.equal(f.command('combat.previous').code, 'NO_PREVIOUS');
    f.ok('combat.next'); f.ok('combat.update', { id: a.id, initiative: 21 }); assert.equal(f.command('combat.previous').code, 'NO_PREVIOUS');
  } finally { f.store.close(); }
});

test('defeated skipping includes counters and all-defeated fails without partial transition', () => {
  const f = fixture(); try {
    const a = f.custom('Alive', { initiative: 20 }); const b = f.custom('Skipped', { initiative: 10, counter: { value: 0, step: 1, event: 'round' } });
    f.ok('combat.update', { id: b.id, defeated: true }); f.ok('combat.next'); f.ok('combat.next'); assert.equal(f.current(), a.id); assert.equal(f.row(b.id).counter!.value, 0);
    f.ok('combat.settings', { skipDefeated: false }); f.ok('combat.next'); assert.equal(f.current(), b.id); f.ok('combat.next'); assert.equal(f.row(b.id).counter!.value, 1);
    f.ok('combat.settings', { skipDefeated: true }); f.ok('combat.update', { id: a.id, defeated: true }); const before = f.state();
    assert.equal(f.command('combat.next').code, 'VALIDATION'); assert.deepEqual(f.state(), before);
  } finally { f.store.close(); }
});

test('counter overflow rejects the whole next and its receipt', () => {
  const f = fixture(); try {
    const a = f.custom('Overflow', { counter: { value: 1_000_000, step: 1, event: 'turn' } });
    f.ok('combat.next'); const before = f.state(); assert.equal(f.command('combat.next').code, 'VALIDATION'); assert.deepEqual(f.state(), before);
    f.ok('combat.update', { id: a.id, counter: { value: -1_000_000, step: -1, event: 'round' } }); const lower = f.state(); assert.equal(f.command('combat.next').code, 'VALIDATION'); assert.deepEqual(f.state(), lower);
  } finally { f.store.close(); }
});

test('owner end-turn needs enabled policy, current identity, current ownership, active scene and level', () => {
  const f = fixture(); try {
    const a = f.add(); f.custom('B'); f.ok('combat.next');
    assert.equal(f.command('combat.endTurn', { id: a.id }, f.owner).code, 'FORBIDDEN');
    f.ok('combat.settings', { allowPlayerEndTurn: true });
    assert.equal(f.command('combat.endTurn', { id: a.id }, f.foreign).code, 'FORBIDDEN');
    f.ok('combat.endTurn', { id: a.id }, f.owner); assert.equal(f.command('combat.endTurn', { id: a.id }, f.owner).code, 'TURN_CHANGED');
    f.ok('combat.next'); f.ok('token.update', { id: f.token.id, owners: [] }); assert.equal(f.command('combat.endTurn', { id: a.id }, f.owner).code, 'FORBIDDEN');
    f.ok('token.update', { id: f.token.id, owners: [f.ownerAuth.memberId] });
    f.ok('level.create', { name: 'Other floor' }); assert.equal(f.command('combat.roll', { id: a.id }, f.owner).code, 'FORBIDDEN');
    const oldScene = f.state().activeSceneId; f.ok('scene.create', { name: 'Other scene' }); assert.equal(f.command('combat.endTurn', { id: a.id }, f.owner).code, 'FORBIDDEN');
    assert.equal(f.state().combat.combatants.find(e => e.id === a.id)!.sceneId, oldScene);
  } finally { f.store.close(); }
});

test('hidden custom/token/LOS/other-scene names, dice and reverse history are absent in player projection', () => {
  const f = fixture(); try {
    const visible = f.add(); f.ok('combat.roll', { id: visible.id }, f.owner);
    const hidden = f.custom('SECRET_COUNTER', { initiative: 100, hidden: true, counter: { value: 19, step: 1, event: 'turn' } });
    const otherToken = f.state().scenes[0].tokens[1]; f.ok('token.update', { id: otherToken.id, name: 'SECRET_UNSEEN' }); const unseen = f.add(otherToken.id);
    f.ok('combat.roll', { id: unseen.id, formula: '17' });
    f.ok('token.update', { id: f.token.id, owners: [] }); f.ok('scene.update', { id: f.state().activeSceneId, visionEnabled: true });
    f.ok('combat.next'); f.ok('combat.next');
    const projected = f.store.snapshot(f.owner).campaign, serialized = JSON.stringify(projected);
    assert.equal(projected.combat.counterHistory, undefined); assert.equal(projected.combat.combatants.length, 0);
    assert.ok(!serialized.includes('SECRET_COUNTER')); assert.ok(!serialized.includes('SECRET_UNSEEN')); assert.ok(!serialized.includes(hidden.id));
    assert.equal(projected.chat.length, 0); assert.equal(projected.combatReceipts.length, 1); assert.equal(projected.combatReceipts[0].authorId, f.ownerAuth.memberId);
    f.ok('scene.create', { name: 'Elsewhere' }); assert.equal(f.store.snapshot(f.owner).campaign.combat.combatants.length, 0);
  } finally { f.store.close(); }
});

test('token rename is reflected, deletion retains custom entries and selects successor without a round tick', () => {
  const f = fixture(); try {
    const a = f.add(), defeated = f.custom('Defeated'), b = f.custom('B');
    f.ok('combat.update', { id: defeated.id, defeated: true }); f.ok('combat.next');
    f.ok('token.update', { id: f.token.id, name: 'Renamed' }); assert.equal(f.store.snapshot(f.gm).campaign.combat.combatants.find(e => e.id === a.id)!.name, 'Renamed');
    const version = f.state().combat.version; f.ok('token.delete', { id: f.token.id });
    assert.equal(f.current(), b.id); assert.equal(f.state().combat.round, 1); assert.equal(f.state().combat.version, version + 1); assert.equal(f.state().combat.combatants.length, 2);
    f.ok('combat.remove', { id: b.id }); assert.equal(f.state().combat.active, false); assert.equal(f.state().combat.round, 0); assert.equal(f.state().combat.combatants[0].id, defeated.id);
  } finally { f.store.close(); }
});
