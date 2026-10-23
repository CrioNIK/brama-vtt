import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, type Session } from '../server/store.ts';
import type { ActorAction, Campaign, Command } from '../shared/model.ts';

// Independent boundary tests use only Store and their own campaigns/databases.
// They do not inject dice, reuse production previews as an oracle, or contact a server.
function fixture(path = ':memory:') {
  let store = new Store(path);
  const gmAuth = store.create('Independent outcome review', 'GM'), gm = store.authenticate(gmAuth.token);
  const invite = store.snapshot(gm).inviteCode!;
  const ownerAuth = store.join(invite, 'Caster and target owner'), owner = store.authenticate(ownerAuth.token);
  const coAuth = store.join(invite, 'Caster co-owner'), co = store.authenticate(coAuth.token);
  const targetAuth = store.join(invite, 'Target-only owner'), targetOwner = store.authenticate(targetAuth.token);
  const foreignAuth = store.join(invite, 'Unrelated player'), foreign = store.authenticate(foreignAuth.token);
  const state = () => store.export(gm);
  const envelope = (type: Command['type'], payload: Record<string, unknown>, extra: Partial<Command> = {}): Command =>
    ({ id: randomUUID(), type, payload, expectedRevision: state().revision, ...extra });
  const command = (session: Session, type: Command['type'], payload: Record<string, unknown>, extra: Partial<Command> = {}) =>
    store.command(session, envelope(type, payload, extra)).ack;
  const ok = (session: Session, type: Command['type'], payload: Record<string, unknown>, extra: Partial<Command> = {}) => {
    const ack = command(session, type, payload, extra);
    assert.equal(ack.ok, true, `${type}: ${ack.code} ${ack.error}`); return ack;
  };
  ok(gm, 'scene.create', { name: 'Outcome lab' });
  const sceneId = state().activeSceneId, scene = () => state().scenes.find(s => s.id === sceneId)!;
  ok(gm, 'actor.create', { name: 'Caster', owners: [ownerAuth.memberId, coAuth.memberId], hp: 12, maxHp: 12 });
  const casterId = state().actors.find(a => a.name === 'Caster')!.id;
  ok(gm, 'actor.create', { name: 'HP target', owners: [ownerAuth.memberId, targetAuth.memberId], hp: 50, maxHp: 50 });
  const targetId = state().actors.find(a => a.name === 'HP target')!.id;
  const actor = (id = casterId) => state().actors.find(a => a.id === id)!;
  const place = (id: string, patch: Record<string, unknown> = {}) => {
    ok(gm, 'actor.place', { id, x: 200, y: 200, ...patch });
    return state().scenes.find(s => s.id === state().activeSceneId)!.tokens.at(-1)!;
  };
  const targetToken = place(targetId), aliasToken = place(targetId, { x: 300 });
  ok(gm, 'actor.resource.create', { id: casterId, label: 'Slot 1', value: 2, max: 2, kind: 'spell-slot', level: 1, recovery: 'long-rest' });
  const slotId = actor().resources[0].id;
  const action = (patch: Record<string, unknown> = {}) => {
    ok(gm, 'actor.action.create', { id: casterId, name: 'Typed spell', description: '', sourceLabel: 'PRIVATE_SOURCE_SENTINEL', category: 'test',
      known: true, prepared: true, requiresPreparation: false, enabled: true, target: 'none', costs: [{ resourceId: slotId, amount: 1 }],
      outcome: { kind: 'damage', allowCritical: true, parts: [{ number: 1, denomination: 6, bonus: 2, type: 'force' }] }, ...patch });
    return actor().actions.at(-1)!;
  };
  const execution = (a: ActorAction, patch: Record<string, unknown> = {}) => ({ id: casterId, actionId: a.id, actionVersion: a.version, visibility: 'public', ...patch });
  const cast = (a = action(), session = owner, patch: Record<string, unknown> = {}) => {
    const ack = ok(session, 'actor.action.execute', execution(a, patch));
    return state().actionResolutions.find(r => r.id === ack.id)!;
  };
  const roll = (resolutionId: string, session = owner, critical = false) => {
    const ack = ok(session, 'actor.action.rollOutcome', { id: casterId, resolutionId, critical });
    return state().outcomeRolls.find(r => r.id === ack.id)!;
  };
  const application = (outcomeId: string, tokenId = targetToken.id, multiplier = 1) => ({ id: casterId, outcomeId, targetTokenId: tokenId, multiplier });
  return { get store() { return store; }, gm, owner, co, targetOwner, foreign, ownerAuth, coAuth, targetAuth, gmAuth, state, scene, sceneId,
    envelope, command, ok, actor, casterId, targetId, targetToken, aliasToken, place, slotId, action, execution, cast, roll, application,
    reopen() { store.close(); store = new Store(path); }, close() { store.close(); } };
}
type Fixture = ReturnType<typeof fixture>;
function unchanged(f: Fixture, before: Campaign) {
  assert.deepEqual(f.state(), before, 'Rejected/retried operation changed persisted HP, costs, chat, histories or revision.');
}
function reject(f: Fixture, session: Session, type: Command['type'], payload: Record<string, unknown>, code: string, extra: Partial<Command> = {}) {
  const before = f.state(), ack = f.command(session, type, payload, extra);
  assert.equal(ack.ok, false); assert.equal(ack.code, code); unchanged(f, before); return ack;
}
async function removeOwnTemp(directory: string) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('vtt-outcome-review-'));
  await rm(directory, { recursive: true, force: true });
}

test('outcome review: execute, roll and HP application require current explicit revision', () => {
  const f = fixture();
  try {
    const a = f.action();
    reject(f, f.gm, 'actor.action.execute', f.execution(a), 'REVISION_REQUIRED', { expectedRevision: undefined });
    reject(f, f.owner, 'actor.action.execute', f.execution(a), 'CONFLICT', { expectedRevision: f.state().revision - 1 });
    const cast = f.cast(a), rollPayload = { id: f.casterId, resolutionId: cast.id, critical: false };
    reject(f, f.gm, 'actor.action.rollOutcome', rollPayload, 'REVISION_REQUIRED', { expectedRevision: undefined });
    reject(f, f.owner, 'actor.action.rollOutcome', rollPayload, 'CONFLICT', { expectedRevision: f.state().revision - 1 });
    const roll = f.roll(cast.id), applyPayload = f.application(roll.id);
    reject(f, f.gm, 'actor.action.applyOutcome', applyPayload, 'REVISION_REQUIRED', { expectedRevision: undefined });
    reject(f, f.owner, 'actor.action.applyOutcome', applyPayload, 'CONFLICT', { expectedRevision: f.state().revision - 1 });
    assert.equal(f.actor().resources[0].value, 1); assert.equal(f.actor(f.targetId).hp, 50);
  } finally { f.close(); }
});

test('outcome review: SQLite reopen preserves the exact cast, dice and HP application ACKs without repetition', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vtt-outcome-review-')), f = fixture(join(directory, 'retry.sqlite'));
  try {
    const a = f.action(), castCommand = f.envelope('actor.action.execute', f.execution(a));
    const castAck = f.store.command(f.owner, castCommand).ack; assert.equal(castAck.ok, true);
    const castState = f.state(); assert.equal(castState.outcomeRolls.length, 0); assert.equal(f.actor(f.targetId).hp, 50);
    f.reopen(); assert.deepEqual(f.store.command(f.owner, castCommand), { ack: castAck, changed: false }); unchanged(f, castState);
    const rollCommand = f.envelope('actor.action.rollOutcome', { id: f.casterId, resolutionId: castAck.id, critical: true });
    const rollAck = f.store.command(f.owner, rollCommand).ack; assert.equal(rollAck.ok, true);
    const rolled = f.state(), receipt = rolled.outcomeRolls[0];
    assert.equal(receipt.parts[0].roll.dice[0].values.length, 2);
    assert.equal(receipt.parts[0].roll.modifier, 2, 'Critical doubles dice, not the flat bonus.');
    assert.equal(receipt.total, receipt.parts[0].roll.dice[0].values.reduce((s, v) => s + v, 2));
    f.reopen(); assert.deepEqual(f.store.command(f.owner, rollCommand), { ack: rollAck, changed: false }); unchanged(f, rolled);
    const applyCommand = f.envelope('actor.action.applyOutcome', f.application(rollAck.id));
    const applyAck = f.store.command(f.owner, applyCommand).ack; assert.equal(applyAck.ok, true);
    const applied = f.state(); assert.equal(f.actor(f.targetId).hp, 50 - receipt.total);
    assert.deepEqual(applied.hpApplications[0].hpPool, { kind: 'actor', id: f.targetId });
    f.reopen();
    for (const [command, ack] of [[castCommand, castAck], [rollCommand, rollAck], [applyCommand, applyAck]] as const) {
      assert.deepEqual(f.store.command(f.owner, command), { ack, changed: false }); unchanged(f, applied);
    }
    assert.deepEqual([applied.actionResolutions.length, applied.outcomeRolls.length, applied.hpApplications.length, applied.chat.length], [1, 1, 1, 3]);
    assert.equal(f.actor().resources[0].value, 1);
  } finally { f.close(); await removeOwnTemp(directory); }
});

test('outcome review: changed envelopes and another session cannot reuse any successful lifecycle command ID', () => {
  const f = fixture();
  try {
    const cast = f.cast(), rolled = f.roll(cast.id), applied = f.ok(f.owner, 'actor.action.applyOutcome', f.application(rolled.id));
    const cases: [string, Command['type'], Record<string, unknown>][] = [
      [cast.id, 'actor.action.execute', f.execution(f.actor().actions[0], { visibility: 'gm' })],
      [rolled.id, 'actor.action.rollOutcome', { id: f.casterId, resolutionId: cast.id, critical: true }],
      [applied.id, 'actor.action.applyOutcome', f.application(rolled.id, f.targetToken.id, 0.5)],
    ];
    for (const [id, type, payload] of cases) {
      reject(f, f.owner, type, payload, 'ID_REUSED', { id });
      reject(f, f.gm, type, payload, 'ID_REUSED', { id });
    }
    reject(f, f.gm, 'actor.action.rollOutcome', { id: f.casterId, resolutionId: cast.id, critical: false }, 'ID_REUSED', { id: cast.id });
  } finally { f.close(); }
});

test('outcome review: rejected cast and outcome commands preserve the complete Campaign', () => {
  const f = fixture();
  try {
    const a = f.action({ costs: [{ resourceId: f.slotId, amount: 3 }] });
    reject(f, f.owner, 'actor.action.execute', f.execution(a), 'INSUFFICIENT');
    f.ok(f.gm, 'actor.action.update', { id: f.casterId, actionId: a.id, actionVersion: a.version, costs: [{ resourceId: f.slotId, amount: 1 }] });
    reject(f, f.owner, 'actor.action.execute', f.execution(a), 'ACTION_STALE');
    const cast = f.cast(f.actor().actions[0]);
    const rollPayload = { id: f.casterId, resolutionId: cast.id, critical: false };
    reject(f, f.owner, 'actor.action.rollOutcome', { ...rollPayload, parts: [] }, 'VALIDATION');
    reject(f, f.owner, 'actor.action.rollOutcome', { ...rollPayload, critical: 'true' }, 'VALIDATION');
    reject(f, f.owner, 'actor.action.rollOutcome', { ...rollPayload, resolutionId: randomUUID() }, 'OUTCOME_UNAVAILABLE');
    const rolled = f.roll(cast.id);
    reject(f, f.owner, 'actor.action.applyOutcome', f.application(rolled.id, f.targetToken.id, 0.25), 'VALIDATION');
    reject(f, f.owner, 'actor.action.applyOutcome', { ...f.application(rolled.id), requestedAmount: 999 }, 'VALIDATION');
    reject(f, f.owner, 'actor.action.applyOutcome', f.application(rolled.id, f.targetToken.id, 0), 'NO_CHANGE');
    f.ok(f.gm, 'actor.update', { id: f.targetId, hp: null });
    reject(f, f.owner, 'actor.action.applyOutcome', f.application(rolled.id), 'HP_UNKNOWN');
    assert.equal(f.actor().resources[0].value, 1); assert.equal(f.state().hpApplications.length, 0);
  } finally { f.close(); }
});

test('outcome review: invalid typed definitions and critical aggregate limits do not partially commit', () => {
  const f = fixture();
  try {
    const a = f.action(), part = { number: 1, denomination: 6, bonus: 0, type: 'force' };
    for (const outcome of [
      { kind: 'damage', allowCritical: true, parts: [{ ...part, number: '1' }] },
      { kind: 'damage', allowCritical: true, parts: [part, { ...part, type: 'unknown' }] },
      { kind: 'damage', allowCritical: true, parts: [{ ...part, formula: 'globalThis.bad = 1' }] },
      { kind: 'damage', allowCritical: true, parts: Array.from({ length: 21 }, () => part) },
      { kind: 'damage', allowCritical: true, parts: [{ ...part, number: 60 }, { ...part, number: 60 }] },
      { kind: 'healing', allowCritical: true, parts: [{ ...part, type: 'healing' }] },
    ]) {
      const before = f.state(), ack = f.command(f.gm, 'actor.action.update', { id: f.casterId, actionId: a.id, actionVersion: a.version, name: 'Must not persist', outcome });
      assert.equal(ack.ok, false); unchanged(f, before);
    }
    const many = f.action({ outcome: { kind: 'damage', allowCritical: true, parts: [{ ...part, number: 60, denomination: 2 }] } });
    const cast = f.cast(many);
    reject(f, f.owner, 'actor.action.rollOutcome', { id: f.casterId, resolutionId: cast.id, critical: true }, 'LIMIT');
    assert.equal(f.state().outcomeRolls.length, 0); assert.equal(f.actor().resources[0].value, 1);
  } finally { f.close(); }
});

test('outcome review: revoking caster ownership stops new roll and apply intents from a previously valid cast', () => {
  const f = fixture();
  try {
    const a = f.action(), cast = f.cast(a), rolled = f.roll(cast.id);
    f.ok(f.gm, 'actor.update', { id: f.casterId, owners: [f.coAuth.memberId] });
    reject(f, f.owner, 'actor.action.execute', f.execution(a), 'FORBIDDEN');
    reject(f, f.owner, 'actor.action.rollOutcome', { id: f.casterId, resolutionId: cast.id, critical: false }, 'FORBIDDEN');
    reject(f, f.owner, 'actor.action.applyOutcome', f.application(rolled.id), 'FORBIDDEN');
    // Being the cast author preserves its historical receipt, never future authority.
    assert.equal(f.store.snapshot(f.owner).campaign.actionResolutions.length, 1);
    assert.equal(f.actor(f.targetId).hp, 50);
  } finally { f.close(); }
});

test('outcome review: HP application requires both caster and actual pool ownership; token aliases do not grant Actor rights', () => {
  const f = fixture();
  try {
    const cast = f.cast(), rolled = f.roll(cast.id);
    reject(f, f.targetOwner, 'actor.action.applyOutcome', f.application(rolled.id), 'FORBIDDEN');
    reject(f, f.foreign, 'actor.action.applyOutcome', f.application(rolled.id), 'FORBIDDEN');
    f.ok(f.gm, 'token.update', { id: f.targetToken.id, owners: [f.coAuth.memberId] });
    reject(f, f.co, 'actor.action.applyOutcome', f.application(rolled.id), 'FORBIDDEN');
    f.ok(f.gm, 'actor.update', { id: f.targetId, owners: [f.coAuth.memberId, f.targetAuth.memberId] });
    reject(f, f.owner, 'actor.action.applyOutcome', f.application(rolled.id), 'FORBIDDEN');
    f.ok(f.co, 'actor.action.applyOutcome', f.application(rolled.id));
    assert.equal(f.actor(f.targetId).hp, 50 - rolled.total);
  } finally { f.close(); }
});

test('outcome review: one HP pool cannot be hit twice through linked aliases, while an unlinked token is independent', () => {
  const f = fixture();
  try {
    const cast = f.cast(), rolled = f.roll(cast.id);
    f.ok(f.owner, 'actor.action.applyOutcome', f.application(rolled.id));
    reject(f, f.owner, 'actor.action.applyOutcome', f.application(rolled.id, f.aliasToken.id), 'ALREADY_APPLIED');
    const detached = f.place(f.targetId, { linked: false, x: 400 });
    f.ok(f.gm, 'token.update', { id: detached.id, hp: 30, maxHp: 50 });
    f.ok(f.owner, 'actor.action.applyOutcome', f.application(rolled.id, detached.id));
    assert.equal(f.actor(f.targetId).hp, 50 - rolled.total);
    assert.equal(f.scene().tokens.find(t => t.id === detached.id)!.hp, 30 - rolled.total);
    assert.deepEqual(f.state().hpApplications.map(r => r.hpPool), [{ kind: 'actor', id: f.targetId }, { kind: 'token', id: detached.id }]);
    assert.equal(f.actor().resources[0].value, 1);
  } finally { f.close(); }
});

test('outcome review: hidden, missing, inactive-level and other-scene apply targets are uniformly unavailable', () => {
  const f = fixture();
  try {
    const cast = f.cast(), rolled = f.roll(cast.id);
    f.ok(f.gm, 'token.update', { id: f.aliasToken.id, hidden: true, name: 'SECRET_TARGET_SENTINEL' });
    f.ok(f.gm, 'level.create', { name: 'Upper', bottom: 20, top: 40 }); const upper = f.place(f.targetId);
    f.ok(f.gm, 'level.activate', { id: 'ground' });
    f.ok(f.gm, 'scene.create', { name: 'Other scene' }); const elsewhere = f.place(f.targetId);
    f.ok(f.gm, 'scene.activate', { id: f.sceneId });
    const errors = [randomUUID(), f.aliasToken.id, upper.id, elsewhere.id].map(id =>
      reject(f, f.owner, 'actor.action.applyOutcome', f.application(rolled.id, id), 'TARGET_UNAVAILABLE'));
    assert.equal(new Set(errors.map(ack => ack.error)).size, 1);
    assert.equal(JSON.stringify(errors).includes('SECRET_TARGET_SENTINEL'), false);
    assert.equal(f.state().hpApplications.length, 0);
  } finally { f.close(); }
});

test('outcome review: GM-only cast history redacts hidden target HP and includes only the application for a target-only owner', () => {
  const f = fixture();
  try {
    f.ok(f.gm, 'actor.update', { id: f.targetId, owners: [f.targetAuth.memberId] });
    f.ok(f.gm, 'token.update', { id: f.targetToken.id, name: 'SECRET_TARGET_SENTINEL', hidden: true, owners: [f.targetAuth.memberId] });
    const a = f.action({ target: 'token' }), cast = f.cast(a, f.gm, { visibility: 'gm', targetTokenId: f.targetToken.id });
    const rolled = f.roll(cast.id, f.gm); f.ok(f.gm, 'actor.action.applyOutcome', f.application(rolled.id));
    const persisted = f.state(), casterView = f.store.snapshot(f.owner).campaign;
    assert.deepEqual(casterView.actionResolutions[0].target, { kind: 'redacted' });
    assert.equal(casterView.outcomeRolls.length, 1); assert.equal(casterView.chat.length, 0);
    for (const view of [casterView, f.store.snapshot(f.targetOwner).campaign]) {
      const app = view.hpApplications[0]; assert.ok(app);
      assert.deepEqual(app.target, { kind: 'redacted' }); assert.deepEqual(app.hpPool, { kind: 'redacted' });
      assert.deepEqual([app.before, app.after, app.max, app.appliedAmount], [null, null, null, null]);
      assert.equal(JSON.stringify(app).includes('SECRET_TARGET_SENTINEL'), false);
      assert.equal(JSON.stringify(app).includes(f.targetId), false);
    }
    const stranger = f.store.snapshot(f.foreign).campaign;
    assert.deepEqual([stranger.actionResolutions.length, stranger.outcomeRolls.length, stranger.hpApplications.length, stranger.chat.length], [0, 0, 0, 0]);
    unchanged(f, persisted);
    f.ok(f.gm, 'token.update', { id: f.targetToken.id, hidden: false });
    const recipient = f.store.snapshot(f.targetOwner).campaign;
    assert.deepEqual([recipient.actionResolutions.length, recipient.outcomeRolls.length, recipient.hpApplications.length, recipient.chat.length], [0, 0, 1, 0]);
    assert.equal(recipient.hpApplications[0].before, 50); assert.equal(recipient.hpApplications[0].after, 50 - rolled.total);
    assert.equal(JSON.stringify(recipient.hpApplications).includes('PRIVATE_SOURCE_SENTINEL'), false);
    const nonOwner = f.store.snapshot(f.owner).campaign.hpApplications[0];
    assert.equal(nonOwner.target.kind, 'token'); assert.deepEqual(nonOwner.hpPool, { kind: 'redacted' }); assert.equal(nonOwner.before, null);
  } finally { f.close(); }
});

test('outcome review: committed outcome definitions survive edit/delete and negative dice parts cannot become healing', () => {
  const f = fixture();
  try {
    const a = f.action({ outcome: { kind: 'damage', allowCritical: false, parts: [{ number: 1, denomination: 2, bonus: -10, type: 'force' }] } });
    const cast = f.cast(a);
    f.ok(f.gm, 'actor.action.update', { id: f.casterId, actionId: a.id, actionVersion: a.version, name: 'Edited', outcome: { kind: 'manual', text: 'New definition' } });
    f.ok(f.gm, 'actor.action.delete', { id: f.casterId, actionId: a.id, actionVersion: a.version + 1 });
    const rolled = f.roll(cast.id); assert.equal(rolled.kind, 'damage'); assert.equal(rolled.total, 0);
    assert.ok(rolled.parts[0].roll.total < 0); assert.equal(rolled.parts[0].amount, 0);
    assert.equal(f.state().actionResolutions[0].action.name, 'Typed spell');
    reject(f, f.owner, 'actor.action.applyOutcome', f.application(rolled.id), 'NO_CHANGE');
    assert.equal(f.actor(f.targetId).hp, 50); assert.equal(f.actor().resources[0].value, 1);
  } finally { f.close(); }
});

test('outcome review: deliberate reroll creates a new outcome without another cost, with its own per-pool application', () => {
  const f = fixture();
  try {
    const cast = f.cast(), first = f.roll(cast.id), second = f.roll(cast.id, f.owner, true);
    assert.notEqual(first.id, second.id);
    assert.deepEqual(f.state().outcomeRolls.map(r => r.resolutionId), [cast.id, cast.id]);
    assert.equal(f.actor().resources[0].value, 1); assert.equal(f.state().actionResolutions.length, 1);
    assert.equal(first.parts[0].roll.dice[0].values.length, 1); assert.equal(second.parts[0].roll.dice[0].values.length, 2);
    f.ok(f.owner, 'actor.action.applyOutcome', f.application(first.id));
    f.ok(f.owner, 'actor.action.applyOutcome', f.application(second.id, f.aliasToken.id));
    assert.equal(f.actor(f.targetId).hp, 50 - first.total - second.total);
    reject(f, f.owner, 'actor.action.applyOutcome', f.application(first.id, f.aliasToken.id), 'ALREADY_APPLIED');
    reject(f, f.owner, 'actor.action.applyOutcome', f.application(second.id), 'ALREADY_APPLIED');
    assert.equal(f.state().hpApplications.length, 2); assert.equal(f.actor().resources[0].value, 1);
  } finally { f.close(); }
});

test('outcome review: legacy SQLite adds empty outcome histories without replacing unknown HP or resources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vtt-outcome-review-')), path = join(directory, 'legacy.sqlite'), f = fixture(path);
  let reopened: Store | undefined;
  try {
    f.ok(f.gm, 'actor.update', { id: f.targetId, hp: null, maxHp: null });
    f.ok(f.gm, 'actor.resource.update', { id: f.casterId, resourceId: f.slotId, value: null, max: null });
    const raw = f.state() as unknown as Record<string, unknown>; delete raw.outcomeRolls; delete raw.hpApplications;
    f.close(); const db = new DatabaseSync(path);
    try { db.prepare('UPDATE campaigns SET document=? WHERE id=?').run(JSON.stringify(raw), raw.id as string); } finally { db.close(); }
    reopened = new Store(path); const restored = reopened.export(reopened.authenticate(f.gmAuth.token));
    assert.deepEqual(restored.outcomeRolls, []); assert.deepEqual(restored.hpApplications, []);
    assert.deepEqual(restored, { ...raw, outcomeRolls: [], hpApplications: [] });
    assert.equal(restored.actors.find(a => a.id === f.targetId)!.hp, null);
    assert.equal(restored.actors.find(a => a.id === f.casterId)!.resources[0].value, null);
  } finally { try { f.close(); } catch {} reopened?.close(); await removeOwnTemp(directory); }
});
