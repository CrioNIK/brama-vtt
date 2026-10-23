import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Store, type Session } from '../server/store.ts';
import type { Command } from '../shared/model.ts';
import { draftProgressionActor, previewProgression, type ProgressionDefinition, type ProgressionPlan } from '../shared/progression.ts';

// Independent integration checks use only synthetic campaigns and isolated SQLite files.
function fixture(path = ':memory:') {
  let store = new Store(path);
  const gmAuth = store.create('Independent combat review', 'GM'), gm = store.authenticate(gmAuth.token);
  const playerAuth = store.join(store.snapshot(gm).inviteCode!, 'Owner'), player = store.authenticate(playerAuth.token);
  const state = () => store.export(gm);
  const command = (who: Session, type: Command['type'], payload: Record<string, unknown> = {}, extra: Partial<Command> = {}) =>
    store.command(who, { id: randomUUID(), type, payload, expectedRevision: state().revision, ...extra });
  const ok = (who: Session, type: Command['type'], payload: Record<string, unknown> = {}, extra: Partial<Command> = {}) => {
    const result = command(who, type, payload, extra);
    assert.equal(result.ack.ok, true, `${type}: ${result.ack.code} ${result.ack.error}`);
    return result.ack;
  };
  return { get store() { return store; }, gm, player, playerAuth, state, command, ok,
    reopen() { store.close(); store = new Store(path); } };
}

test('review: combat and action receipts reject cross-session command-ID reuse in both directions', () => {
  for (const combatFirst of [true, false]) {
    const f = fixture();
    try {
      f.ok(f.gm, 'actor.create', { name: 'Owner actor', owners: [f.playerAuth.memberId] });
      const actorId = f.state().actors.find(actor => actor.name === 'Owner actor')!.id;
      f.ok(f.gm, 'actor.action.create', { id: actorId, name: 'Manual action', description: '', sourceLabel: '', category: 'test',
        known: true, prepared: true, requiresPreparation: false, enabled: true, target: 'none', costs: [], outcome: { kind: 'manual', text: 'Own test' } });
      const action = f.state().actors.find(actor => actor.id === actorId)!.actions[0];
      const actionPayload = { id: actorId, actionId: action.id, actionVersion: action.version, visibility: 'self' };
      const id = randomUUID();
      if (combatFirst) f.ok(f.gm, 'combat.settings', { allowPlayerEndTurn: true }, { id });
      else f.ok(f.player, 'actor.action.execute', actionPayload, { id });
      const before = f.state();
      const rejected = combatFirst
        ? f.command(f.player, 'actor.action.execute', actionPayload, { id })
        : f.command(f.gm, 'combat.settings', { allowPlayerEndTurn: true }, { id });
      assert.equal(rejected.ack.code, 'ID_REUSED', `combatFirst=${combatFirst}`);
      assert.equal(rejected.changed, false);
      assert.deepEqual(f.state(), before, 'A reused cross-family ID must not commit a second receipt, chat or state change.');
    } finally { f.store.close(); }
  }
});

test('review: combat and progression receipts reject cross-session command-ID reuse in both directions', () => {
  const definition: ProgressionDefinition = { name: 'Synthetic one-level profile', description: '', maxLevel: 1,
    abilityArray: [15, 14, 13, 12, 10, 8], baseHp: 0, proficiencyByLevel: [2],
    backgrounds: [{ key: 'plain', name: 'Plain', grants: [] }],
    classes: [{ key: 'test', name: 'Test', levels: [{ level: 1, grants: [], choices: [] }] }], resources: [], actions: [], items: [] };
  for (const combatFirst of [true, false]) {
    const f = fixture();
    try {
      f.ok(f.gm, 'progression.profile.publish', { baseVersion: 0, definition });
      const profile = f.state().progressionProfiles[0], actorId = randomUUID();
      const plan: ProgressionPlan = { operation: 'create', backgroundKey: 'plain', steps: [{ id: randomUUID(), classKey: 'test', choices: [] }],
        baseAbilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, proficiencyPolicy: 'profile' };
      const preview = previewProgression(draftProgressionActor(actorId, 'Created hero', [f.playerAuth.memberId]), profile, plan);
      assert.equal(preview.ready, true);
      const payload = { id: actorId, name: 'Created hero', profile: { id: profile.id, version: profile.version }, plan, previewKey: preview.previewKey };
      const id = randomUUID();
      if (combatFirst) f.ok(f.gm, 'combat.settings', { skipDefeated: false }, { id });
      else f.ok(f.player, 'actor.progression.create', payload, { id });
      const before = f.state();
      const rejected = combatFirst
        ? f.command(f.player, 'actor.progression.create', payload, { id })
        : f.command(f.gm, 'combat.settings', { skipDefeated: false }, { id });
      assert.equal(rejected.ack.code, 'ID_REUSED', `combatFirst=${combatFirst}`);
      assert.equal(rejected.changed, false);
      assert.deepEqual(f.state(), before, 'Rejected adoption/creation cannot append a phantom Actor or progression grant.');
    } finally { f.store.close(); }
  }
});

test('review: previous restores exact turn and round counters after projections and SQLite reopen, and retry cannot undo twice', () => {
  const directory = mkdtempSync(join(tmpdir(), 'vtt-combat-review-'));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('vtt-combat-review-'));
  const f = fixture(join(directory, 'review.sqlite'));
  try {
    f.ok(f.gm, 'combat.custom', { name: 'Round counter', initiative: 20, counter: { value: 3, step: -1, event: 'round' } });
    f.ok(f.gm, 'combat.custom', { name: 'Turn counter', initiative: 10, counter: { value: 10, step: -2, event: 'turn' } });
    f.ok(f.gm, 'combat.next');
    const started = f.state().combat;
    assert.deepEqual(started.combatants.map(entry => entry.counter!.value), [3, 10]);
    f.ok(f.gm, 'combat.next');
    const first = f.state().combat;
    assert.deepEqual(first.combatants.map(entry => entry.counter!.value), [3, 8]);
    f.ok(f.gm, 'combat.next');
    const wrapped = f.state();
    assert.equal(wrapped.combat.round, 2);
    assert.deepEqual(wrapped.combat.combatants.map(entry => entry.counter!.value), [2, 8]);
    for (let i = 0; i < 3; i++) {
      assert.equal(f.store.snapshot(f.player).campaign.combat.counterHistory, undefined);
      assert.equal(f.store.snapshot(f.gm).campaign.combat.counterHistory!.length, 2);
    }
    assert.deepEqual(f.state(), wrapped, 'Rendering/projecting snapshots must not advance or rewrite counters.');
    f.reopen();
    assert.deepEqual(f.state(), wrapped);
    const command: Command = { id: randomUUID(), type: 'combat.previous', payload: {}, expectedRevision: wrapped.revision };
    const ack = f.store.command(f.gm, command).ack;
    assert.equal(ack.ok, true);
    const once = f.state();
    assert.equal(once.combat.turn, first.turn); assert.equal(once.combat.round, first.round);
    assert.deepEqual(once.combat.combatants, first.combatants);
    assert.deepEqual(once.combat.counterHistory, first.counterHistory);
    f.reopen();
    assert.deepEqual(f.store.command(f.gm, command).ack, ack);
    assert.deepEqual(f.state(), once, 'The exact retry must not undo the preceding transition too.');
    f.ok(f.gm, 'combat.previous');
    const restored = f.state().combat;
    assert.equal(restored.turn, started.turn); assert.equal(restored.round, started.round);
    assert.deepEqual(restored.combatants, started.combatants); assert.deepEqual(restored.counterHistory, []);
    const stable = f.state();
    assert.equal(f.command(f.gm, 'combat.previous').ack.code, 'NO_PREVIOUS');
    assert.deepEqual(f.state(), stable);
    assert.equal(stable.chat.length, 0);
  } finally { f.store.close(); rmSync(directory, { recursive: true, force: true }); }
});
