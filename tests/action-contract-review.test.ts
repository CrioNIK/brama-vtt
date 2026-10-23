import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, type Session } from '../server/store.ts';
import { previewAction, previewRecovery } from '../shared/actions.ts';
import type { ActorAction, Campaign, Command } from '../shared/model.ts';

// Independent Store-level tests: only temporary databases, no live server or GUI.
function fixture(path = ':memory:') {
  const store = new Store(path), gmAuth = store.create('Independent action review', 'GM');
  const gm = store.authenticate(gmAuth.token), invite = store.snapshot(gm).inviteCode!;
  const ownerAuth = store.join(invite, 'Owner'), owner = store.authenticate(ownerAuth.token);
  const coAuth = store.join(invite, 'Co-owner'), co = store.authenticate(coAuth.token);
  const foreignAuth = store.join(invite, 'Foreign'), foreign = store.authenticate(foreignAuth.token);
  const state = () => store.export(gm);
  const command = (session: Session, type: Command['type'], payload: Record<string, unknown>, extra: Partial<Command> = {}) =>
    store.command(session, { id: randomUUID(), type, payload, expectedRevision: state().revision, ...extra }).ack;
  const ok = (session: Session, type: Command['type'], payload: Record<string, unknown>, extra: Partial<Command> = {}) => {
    const ack = command(session, type, payload, extra); assert.equal(ack.ok, true, `${type}: ${ack.code} ${ack.error}`); return ack;
  };
  ok(gm, 'actor.create', { name: 'Review actor', owners: [ownerAuth.memberId, coAuth.memberId], sheetKind: 'dnd5e', hp: 7, maxHp: 10, abilities: { str: 14 } });
  const actorId = state().actors.find(a => a.name === 'Review actor')!.id;
  const actor = () => state().actors.find(a => a.id === actorId)!;
  const resource = (label: string, value: number | null, max: number | null, metadata: Record<string, unknown> = {}) => {
    ok(gm, 'actor.resource.create', { id: actorId, label, value, max, ...metadata });
    return actor().resources.find(r => r.label === label)!;
  };
  const action = (patch: Record<string, unknown> = {}) => {
    const before = new Set(actor().actions.map(a => a.id));
    ok(gm, 'actor.action.create', {
      id: actorId, name: 'Review action', description: 'Own test action', sourceLabel: 'PRIVATE_SOURCE_SENTINEL', category: 'test',
      known: true, prepared: true, requiresPreparation: false, enabled: true, target: 'none', costs: [],
      outcome: { kind: 'roll', ability: 'str', modifier: 0, mode: 'advantage' }, ...patch,
    });
    return actor().actions.find(a => !before.has(a.id))!;
  };
  const execution = (a: ActorAction, patch: Record<string, unknown> = {}) => ({ id: actorId, actionId: a.id, actionVersion: a.version, visibility: 'public', ...patch });
  return { store, gm, gmAuth, owner, ownerAuth, co, coAuth, foreign, foreignAuth, state, command, ok, actorId, actor, resource, action, execution };
}
type Fixture = ReturnType<typeof fixture>;
function unchanged(f: Fixture, before: Campaign) { assert.deepEqual(f.state(), before, 'Rejected operation changed persisted campaign/costs/chat/history/revision.'); }
async function removeOwnTemp(directory: string) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('vtt-action-review-'));
  await rm(directory, { recursive: true, force: true });
}

test('review: every new command requires revision and definition/recovery writes stay GM-only', () => {
  const f = fixture();
  try {
    f.resource('Turn', 0, 1, { kind: 'action', recovery: 'turn' }); const a = f.action();
    const cases: [Command['type'], Record<string, unknown>][] = [
      ['actor.action.create', { id: f.actorId, name: 'Must not appear' }],
      ['actor.action.update', { id: f.actorId, actionId: a.id, actionVersion: a.version, name: 'Must not change' }],
      ['actor.action.delete', { id: f.actorId, actionId: a.id, actionVersion: a.version }],
      ['actor.action.prepare', { id: f.actorId, actionId: a.id, actionVersion: a.version, prepared: false }],
      ['actor.action.execute', f.execution(a)], ['actor.resource.recover', { id: f.actorId, event: 'turn' }],
    ];
    const before = f.state();
    for (const [type, payload] of cases) { assert.equal(f.command(f.gm, type, payload, { expectedRevision: undefined }).ok, false); unchanged(f, before); }
    for (const [type, payload] of cases.filter(([type]) => !['actor.action.prepare', 'actor.action.execute'].includes(type))) {
      assert.equal(f.command(f.owner, type, payload).code, 'FORBIDDEN'); unchanged(f, before);
    }
  } finally { f.store.close(); }
});

test('review: failure on the final cost preserves every pool, HP, chat, history and revision', () => {
  const f = fixture();
  try {
    const r1 = f.resource('Action pool', 1, 1), r2 = f.resource('Slots', 2, 2), r3 = f.resource('Charges', 0, 1);
    const a = f.action({ costs: [{ resourceId: r1.id, amount: 1 }, { resourceId: r2.id, amount: 1 }, { resourceId: r3.id, amount: 1 }] });
    let before = f.state(); assert.equal(f.command(f.owner, 'actor.action.execute', f.execution(a)).code, 'INSUFFICIENT'); unchanged(f, before);
    f.ok(f.gm, 'actor.resource.update', { id: f.actorId, resourceId: r3.id, value: null });
    before = f.state(); assert.equal(f.command(f.owner, 'actor.action.execute', f.execution(a)).code, 'RESOURCE_UNKNOWN'); unchanged(f, before);
    f.ok(f.gm, 'actor.resource.update', { id: f.actorId, resourceId: r3.id, value: 1 }); f.ok(f.owner, 'actor.action.execute', f.execution(a));
    assert.deepEqual(f.actor().resources.map(r => r.value), [0, 1, 0]); assert.equal(f.actor().hp, 7);
    assert.equal(f.state().actionResolutions.length, 1); assert.equal(f.state().chat.length, 1);
  } finally { f.store.close(); }
});

test('review: duplicate pool costs and executable-looking typed values fail; manual DSL-looking text stays inert', () => {
  const f = fixture();
  try {
    const r = f.resource('One charge', 1, 1), a = f.action(); const before = f.state();
    for (const patch of [
      { costs: [{ resourceId: r.id, amount: 1 }, { resourceId: r.id, amount: 1 }] },
      { costs: [{ resourceId: r.id, amount: 'DealDamage(999,Fire)' }] },
      { outcome: { kind: 'roll', ability: null, modifier: 'globalThis.__actionReview = 1', mode: 'normal' } },
      { outcome: { kind: 'roll', ability: null, modifier: 0, mode: 'normal', SpellProperties: 'DealDamage(999,Fire)' } },
      { outcome: { kind: 'bg3', text: 'DealDamage(999,Fire)' } }, { UseCosts: 'ActionPoint:1;SpellSlotsGroup:1:1' },
    ]) { assert.equal(f.command(f.gm, 'actor.action.update', { id: f.actorId, actionId: a.id, actionVersion: a.version, ...patch }).ok, false); unchanged(f, before); }
    const text = 'DealDamage(999,Fire); globalThis.__actionReview = 1';
    f.ok(f.gm, 'actor.action.update', { id: f.actorId, actionId: a.id, actionVersion: a.version, outcome: { kind: 'manual', text } });
    f.ok(f.owner, 'actor.action.execute', f.execution(f.actor().actions[0]));
    assert.equal(f.state().actionResolutions[0].manualOutcome, text); assert.equal(f.actor().hp, 7);
    assert.equal((globalThis as unknown as Record<string, unknown>).__actionReview, undefined);
  } finally { f.store.close(); }
});

test('review: two owners observing the last charge yield one committed resolution', () => {
  const f = fixture();
  try {
    const r = f.resource('Last charge', 1, 1), a = f.action({ costs: [{ resourceId: r.id, amount: 1 }] });
    const revision = f.state().revision, payload = f.execution(a);
    f.ok(f.owner, 'actor.action.execute', payload, { expectedRevision: revision }); const afterWinner = f.state();
    assert.equal(f.command(f.co, 'actor.action.execute', payload, { expectedRevision: revision }).code, 'CONFLICT'); unchanged(f, afterWinner);
    assert.equal(f.command(f.co, 'actor.action.execute', payload).code, 'INSUFFICIENT'); unchanged(f, afterWinner);
    assert.equal(f.actor().resources[0].value, 0); assert.equal(f.state().actionResolutions.length, 1); assert.equal(f.state().chat.length, 1);
  } finally { f.store.close(); }
});

test('review: a positive cost too small for a representable decrement cannot produce a free success', () => {
  const f = fixture();
  try {
    const pool = f.resource('Finite balance', 1, 1);
    const a = f.action({ costs: [{ resourceId: pool.id, amount: Number.MIN_VALUE }] });
    assert.equal(1 - Number.MIN_VALUE, 1, 'Fixture must exercise floating-point loss of decrement.');
    const before = f.state();
    assert.equal(f.command(f.owner, 'actor.action.execute', f.execution(a)).code, 'PRECISION', 'Positive cost must reject its unrepresentable decrement.');
    unchanged(f, before);
  } finally { f.store.close(); }
});

test('review: exact retry after SQLite reopen preserves one RNG receipt; altered/cross-session IDs cannot repeat it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vtt-action-review-')), path = join(directory, 'review.sqlite');
  const f = fixture(path); let reopened: Store | undefined;
  try {
    const r = f.resource('Charges', 2, 2), a = f.action({ costs: [{ resourceId: r.id, amount: 1 }] });
    const command: Command = { id: randomUUID(), type: 'actor.action.execute', payload: f.execution(a), expectedRevision: f.state().revision };
    const first = f.store.command(f.owner, command).ack; assert.equal(first.ok, true); const saved = f.state();
    assert.equal(saved.actionResolutions[0].roll!.dice[0].values.length, 2);
    f.store.close(); reopened = new Store(path); const owner = reopened.authenticate(f.ownerAuth.token), gm = reopened.authenticate(f.gmAuth.token);
    assert.deepEqual(reopened.command(owner, command).ack, first); assert.deepEqual(reopened.export(gm), saved);
    assert.equal(reopened.command(owner, { ...command, payload: { ...command.payload, visibility: 'self' } }).ack.code, 'ID_REUSED'); assert.deepEqual(reopened.export(gm), saved);
    assert.equal(reopened.command(reopened.authenticate(f.coAuth.token), { ...command, expectedRevision: saved.revision }).ack.ok, false);
    assert.deepEqual(reopened.export(gm), saved);
  } finally { try { f.store.close(); } catch {} reopened?.close(); await removeOwnTemp(directory); }
});

test('review: a failed intent remains failed after refill and needs a new deliberate command ID', () => {
  const f = fixture();
  try {
    const r = f.resource('Empty', 0, 1), a = f.action({ costs: [{ resourceId: r.id, amount: 1 }] });
    const command: Command = { id: randomUUID(), type: 'actor.action.execute', payload: f.execution(a), expectedRevision: f.state().revision };
    const rejected = f.store.command(f.owner, command).ack; assert.equal(rejected.code, 'INSUFFICIENT');
    f.ok(f.gm, 'actor.resource.update', { id: f.actorId, resourceId: r.id, value: 1 }); const before = f.state();
    assert.deepEqual(f.store.command(f.owner, command).ack, rejected); unchanged(f, before);
    f.ok(f.owner, 'actor.action.execute', f.execution(a)); assert.equal(f.state().actionResolutions.length, 1);
  } finally { f.store.close(); }
});

test('review: hidden, missing, foreign-scene and inactive-level targets return indistinguishable denials', () => {
  const f = fixture();
  try {
    const a = f.action({ target: 'token' }), originalSceneId = f.state().activeSceneId, hidden = f.state().scenes[0].tokens.find(t => t.hidden)!;
    f.ok(f.gm, 'level.create', { name: 'Other level' }); const level = f.state().scenes[0].levels.find(l => l.id !== 'ground')!;
    f.ok(f.gm, 'token.create', { name: 'Other level target', x: 300, y: 300, levelId: level.id });
    const otherLevel = f.state().scenes[0].tokens.find(t => t.name === 'Other level target')!;
    f.ok(f.gm, 'level.activate', { id: 'ground' }); f.ok(f.gm, 'scene.create', { name: 'Other scene' });
    f.ok(f.gm, 'token.create', { name: 'Foreign scene target', x: 300, y: 300 });
    const otherScene = f.state().scenes.find(s => s.id === f.state().activeSceneId)!.tokens[0];
    f.ok(f.gm, 'scene.activate', { id: originalSceneId }); const before = f.state();
    const failures = [hidden.id, randomUUID(), otherScene.id, otherLevel.id].map(targetTokenId => {
      const ack = f.command(f.owner, 'actor.action.execute', f.execution(a, { targetTokenId }));
      assert.equal(ack.ok, false); unchanged(f, before); return { code: ack.code, error: ack.error };
    });
    for (const failure of failures) assert.deepEqual(failure, failures[0]);
    assert.equal(JSON.stringify(failures).includes(hidden.name), false);
  } finally { f.store.close(); }
});

test('review: GM hidden target is redacted even for an Actor owner; public summary hides target and source', () => {
  const f = fixture();
  try {
    const hidden = f.state().scenes[0].tokens.find(t => t.hidden)!, a = f.action({ target: 'token' });
    f.ok(f.gm, 'actor.action.execute', f.execution(a, { targetTokenId: hidden.id }));
    assert.equal(f.state().actionResolutions[0].target.kind, 'token');
    const ownerView = f.store.snapshot(f.owner).campaign;
    assert.deepEqual(ownerView.actionResolutions[0].target, { kind: 'redacted' });
    for (const value of [hidden.id, hidden.name]) assert.equal(JSON.stringify(ownerView).includes(value), false);
    const foreign = f.store.snapshot(f.foreign).campaign;
    assert.deepEqual(foreign.actionResolutions, []); assert.deepEqual(foreign.resourceRecoveries, []);
    for (const value of [hidden.id, hidden.name, 'PRIVATE_SOURCE_SENTINEL']) assert.equal(JSON.stringify(foreign).includes(value), false);
  } finally { f.store.close(); }
});

test('review: history is private per Actor; author retains receipt after revocation while self chat stays private', () => {
  const f = fixture();
  try {
    const a = f.action(); f.ok(f.owner, 'actor.action.execute', f.execution(a, { visibility: 'self' })); const ownReceipt = f.state().actionResolutions[0];
    assert.equal(f.store.snapshot(f.co).campaign.actionResolutions.length, 1); assert.equal(f.store.snapshot(f.co).campaign.chat.length, 0);
    assert.equal(f.store.snapshot(f.foreign).campaign.actionResolutions.length, 0);
    f.ok(f.gm, 'actor.create', { name: 'Foreign private actor', owners: [f.foreignAuth.memberId] });
    const otherId = f.state().actors.find(v => v.name === 'Foreign private actor')!.id;
    f.ok(f.gm, 'actor.action.create', { id: otherId, name: 'Foreign private action', outcome: { kind: 'manual', text: 'Foreign private outcome' } });
    const otherAction = f.state().actors.find(v => v.id === otherId)!.actions[0];
    f.ok(f.gm, 'actor.action.execute', { id: otherId, actionId: otherAction.id, actionVersion: otherAction.version, visibility: 'self' });
    assert.deepEqual(f.store.snapshot(f.owner).campaign.actionResolutions.map(v => v.id), [ownReceipt.id]);
    assert.equal(JSON.stringify(f.store.snapshot(f.owner)).includes('Foreign private outcome'), false);
    f.ok(f.gm, 'actor.update', { id: f.actorId, owners: [] });
    assert.deepEqual(f.store.snapshot(f.owner).campaign.actionResolutions[0], ownReceipt);
    assert.equal(f.store.snapshot(f.co).campaign.actionResolutions.length, 0);
    const before = f.state(); assert.equal(f.command(f.owner, 'actor.action.execute', f.execution(a)).code, 'FORBIDDEN'); unchanged(f, before);
  } finally { f.store.close(); }
});

test('review: edit/delete of definition, effect and resource label cannot rewrite the old resolution', () => {
  const f = fixture();
  try {
    const r = f.resource('Original label', 2, 2), a = f.action({ costs: [{ resourceId: r.id, amount: 1 }] });
    f.ok(f.owner, 'actor.effect.create', { id: f.actorId, name: 'Original bonus', changes: [{ ability: 'str', mode: 'add', value: 2 }] });
    const effectId = f.actor().effects[0].id; f.ok(f.owner, 'actor.action.execute', f.execution(a));
    const receipt = structuredClone(f.state().actionResolutions[0]), chat = structuredClone(f.state().chat);
    assert.equal(receipt.roll!.abilitySnapshot!.effective, 16);
    f.ok(f.gm, 'actor.action.update', { id: f.actorId, actionId: a.id, actionVersion: a.version, name: 'Renamed', costs: [], sourceLabel: 'New source' });
    const version = f.actor().actions[0].version;
    f.ok(f.gm, 'actor.resource.update', { id: f.actorId, resourceId: r.id, label: 'Renamed resource', value: 0 });
    f.ok(f.owner, 'actor.effect.delete', { id: f.actorId, effectId });
    f.ok(f.gm, 'actor.action.delete', { id: f.actorId, actionId: a.id, actionVersion: version });
    f.ok(f.gm, 'actor.update', { id: f.actorId, name: 'Renamed Actor' });
    assert.deepEqual(f.state().actionResolutions[0], receipt); assert.deepEqual(f.state().chat, chat);
    assert.equal(f.actor().abilities.str, 14); assert.equal(f.actor().hp, 7);
  } finally { f.store.close(); }
});

test('review: stale definition and revoked authority invalidate a previously available preview', () => {
  const f = fixture();
  try {
    const r = f.resource('Charge', 1, 1), a = f.action({ requiresPreparation: true, prepared: false, costs: [{ resourceId: r.id, amount: 1 }] });
    let before = f.state(); assert.equal(f.command(f.owner, 'actor.action.execute', f.execution(a)).code, 'UNPREPARED'); unchanged(f, before);
    f.ok(f.owner, 'actor.action.prepare', { id: f.actorId, actionId: a.id, actionVersion: a.version, prepared: true });
    before = f.state(); assert.equal(f.command(f.owner, 'actor.action.execute', f.execution(a)).code, 'ACTION_STALE'); unchanged(f, before);
    const latest = f.actor().actions[0];
    assert.equal(previewAction(f.actor(), latest, { memberId: f.ownerAuth.memberId, role: 'player', actionVersion: latest.version, visibleTokens: [] }).available, true); unchanged(f, before);
    f.ok(f.gm, 'actor.update', { id: f.actorId, owners: [] }); before = f.state();
    assert.equal(f.command(f.owner, 'actor.action.execute', f.execution(latest)).code, 'FORBIDDEN'); unchanged(f, before);
  } finally { f.store.close(); }
});

test('review: typed resource policy remains GM-owned and a referenced resource cannot be removed', () => {
  const f = fixture();
  try {
    const r = f.resource('Managed policy', 1, 1, { kind: 'action', recovery: 'turn' }); f.action({ costs: [{ resourceId: r.id, amount: 1 }] }); const before = f.state();
    for (const session of [f.owner, f.foreign]) {
      assert.equal(f.command(session, 'actor.resource.update', { id: f.actorId, resourceId: r.id, recovery: 'short-rest' }).code, 'FORBIDDEN'); unchanged(f, before);
    }
    assert.equal(f.command(f.owner, 'actor.resource.create', { id: f.actorId, label: 'Policy escalation', value: 1, max: 1, kind: 'spell-slot', level: 9, recovery: 'long-rest' }).code, 'FORBIDDEN'); unchanged(f, before);
    assert.equal(f.command(f.gm, 'actor.resource.delete', { id: f.actorId, resourceId: r.id }).ok, false); unchanged(f, before);
  } finally { f.store.close(); }
});

test('review: only explicit recovery applies matching known policies; preview and combat never refill implicitly', () => {
  const f = fixture();
  try {
    f.resource('Turn', 0, 1, { recovery: 'turn' }); f.resource('Short', 0, 2, { recovery: 'short-rest' });
    f.resource('Long', 0, 3, { recovery: 'long-rest' }); f.resource('Manual', 0, 4);
    f.resource('Unknown current', null, 5, { recovery: 'turn' }); f.resource('Unknown maximum', 0, null, { recovery: 'turn' });
    const before = f.state(); assert.equal(previewRecovery(f.actor(), 'turn').available, true); unchanged(f, before);
    f.ok(f.gm, 'combat.add', { id: f.state().scenes[0].tokens[0].id }); f.ok(f.gm, 'combat.next', {});
    assert.deepEqual(f.actor().resources, before.actors.find(v => v.id === f.actorId)!.resources); assert.equal(f.state().resourceRecoveries.length, 0);
    const denied = f.state(); assert.equal(f.command(f.owner, 'actor.resource.recover', { id: f.actorId, event: 'turn' }).code, 'FORBIDDEN'); unchanged(f, denied);
    f.ok(f.gm, 'actor.resource.recover', { id: f.actorId, event: 'turn' }); assert.deepEqual(f.actor().resources.map(r => r.value), [1, 0, 0, 0, null, 0]);
    const recovered = f.state(); assert.equal(f.command(f.gm, 'actor.resource.recover', { id: f.actorId, event: 'turn' }).ok, false); unchanged(f, recovered);
    f.ok(f.gm, 'actor.resource.recover', { id: f.actorId, event: 'long-rest' }); assert.deepEqual(f.actor().resources.map(r => r.value), [1, 2, 3, 0, null, 0]);
    assert.equal(f.state().resourceRecoveries.length, 2); assert.equal(f.actor().hp, 7);
  } finally { f.store.close(); }
});

test('review: migration preserves unknown legacy pools; known current with unknown cap may be spent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vtt-action-review-')), path = join(directory, 'legacy.sqlite');
  const f = fixture(path); let reopened: Store | undefined;
  try {
    f.resource('Unknown legacy', null, null); f.resource('Known balance unknown cap', 2, null);
    const raw = f.state() as unknown as Record<string, unknown>; delete raw.actionResolutions; delete raw.resourceRecoveries;
    for (const actor of raw.actors as Record<string, unknown>[]) {
      delete actor.actions;
      for (const r of actor.resources as Record<string, unknown>[]) { delete r.kind; delete r.level; delete r.unit; delete r.recovery; }
    }
    f.store.close(); const db = new DatabaseSync(path);
    try { db.prepare('UPDATE campaigns SET document=? WHERE id=?').run(JSON.stringify(raw), raw.id as string); } finally { db.close(); }
    reopened = new Store(path); const gm = reopened.authenticate(f.gmAuth.token), owner = reopened.authenticate(f.ownerAuth.token);
    const current = () => reopened!.export(gm), actor = () => current().actors.find(v => v.id === f.actorId)!;
    assert.deepEqual(actor().actions, []); assert.deepEqual(current().actionResolutions, []); assert.deepEqual(current().resourceRecoveries, []);
    assert.deepEqual(actor().resources.map(r => [r.value, r.max, r.kind, r.level, r.unit, r.recovery]), [[null, null, 'custom', null, '', 'manual'], [2, null, 'custom', null, '', 'manual']]);
    const cmd = (session: Session, type: Command['type'], payload: Record<string, unknown>) => reopened!.command(session, { id: randomUUID(), type, payload, expectedRevision: current().revision }).ack;
    assert.equal(cmd(gm, 'actor.action.create', { id: f.actorId, name: 'Known balance', costs: [{ resourceId: actor().resources[1].id, amount: 1 }], outcome: { kind: 'manual', text: 'Own annotation' } }).ok, true);
    const a = actor().actions[0]; assert.equal(cmd(owner, 'actor.action.execute', { id: f.actorId, actionId: a.id, actionVersion: a.version, visibility: 'public' }).ok, true);
    assert.equal(actor().resources[0].value, null); assert.equal(actor().resources[0].max, null);
    assert.equal(actor().resources[1].value, 1); assert.equal(actor().resources[1].max, null); assert.equal(current().actionResolutions[0].costs[0].max, null);
  } finally { try { f.store.close(); } catch {} reopened?.close(); await removeOwnTemp(directory); }
});
