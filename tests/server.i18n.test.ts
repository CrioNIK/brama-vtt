import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startServer } from '../server/app.ts';
import { blankActorChecks } from '../shared/checks.ts';
import type { AuthResult, ChatMessage, Command, Snapshot } from '../shared/model.ts';

async function post(url: string, path: string, data: unknown) {
  return fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}
async function create(url: string, data: Record<string, unknown>): Promise<AuthResult> {
  const response = await post(url, '/api/campaigns', data);
  assert.equal(response.status, 201);
  return await response.json() as AuthResult;
}
async function snapshot(url: string, token: string): Promise<Snapshot> {
  const response = await fetch(url + '/api/snapshot', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  return await response.json() as Snapshot;
}
async function fixture() {
  const app = await startServer({ port: 0, dbPath: ':memory:' });
  const gm = await create(app.url, { name: 'Literal {campaign}', gmName: 'GM {name}', locale: 'uk' });
  const initial = await snapshot(app.url, gm.token);
  const join = async (name: string) => {
    const response = await post(app.url, '/api/join', { name, inviteCode: initial.inviteCode });
    assert.equal(response.status, 201);
    return await response.json() as AuthResult;
  };
  const owner = await join('Owner {name}'), observer = await join('Observer');
  const command = (auth: AuthResult, type: Command['type'], payload: Record<string, unknown>) => {
    const session = app.store.authenticate(auth.token), state = app.store.snapshot(session);
    return app.store.command(session, { id: randomUUID(), type, payload, expectedRevision: state.campaign.revision });
  };
  const ok = (auth: AuthResult, type: Command['type'], payload: Record<string, unknown>) => {
    const result = command(auth, type, payload);
    assert.equal(result.ack.ok, true, `${type}: ${result.ack.error}`);
    assert.equal(result.changed, true);
    return result.ack;
  };
  return { app, gm, owner, observer, command, ok, actorId: initial.campaign.actors[0].id, tokenId: initial.campaign.scenes[0].tokens[0].id };
}

test('REST campaign creation forwards every supported locale and rejects invalid locale payloads', async () => {
  const app = await startServer({ port: 0, dbPath: ':memory:' });
  try {
    const expected = { en: 'Observatory hall', es: 'Sala del observatorio', uk: 'Зала обсерваторії', pl: 'Sala obserwatorium', cs: 'Síň observatoře' };
    for (const [locale, name] of Object.entries(expected)) {
      const auth = await create(app.url, { name: 'USER {name}', gmName: 'USER {gm}', locale });
      const state = await snapshot(app.url, auth.token);
      assert.equal(state.campaign.scenes[0].name, name);
      assert.equal(state.campaign.name, 'USER {name}'); assert.equal(state.self.name, 'USER {gm}');
      assert.equal(state.self.role, 'gm');
    }
    for (const locale of ['ru', 'de', '', 'EN', null, 123, ['en'], { language: 'en' }]) {
      const response = await post(app.url, '/api/campaigns', { name: 'Rejected locale', gmName: 'GM', locale });
      assert.equal(response.status, 400, JSON.stringify(locale));
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body.code, 'VALIDATION'); assert.equal(body.token, undefined);
      assert.equal(body.error, 'Unsupported locale. Choose en, es, uk, pl or cs.');
    }
  } finally { await app.close(); }
});

test('player-authored chat cannot forge localization metadata or leak private text through snapshots', async () => {
  const f = await fixture();
  try {
    const literal = 'Damage · Healing · outcome applied {actor} <b>literal</b>';
    const spoof = { key: '{actor} · {action} · outcome applied', parameters: { actor: 'FORGED', action: 'FORGED' }, localizedParameters: ['actor', 'action'] };
    f.ok(f.owner, 'chat.send', { text: literal, visibility: 'self', system: spoof });
    const own = await snapshot(f.app.url, f.owner.token);
    assert.equal(own.campaign.chat.at(-1)!.text, literal);
    assert.equal(own.campaign.chat.at(-1)!.system, undefined);
    assert.equal(own.campaign.chat.at(-1)!.authorId, f.owner.memberId);
    for (const auth of [f.gm, f.observer]) assert.equal((await snapshot(f.app.url, auth.token)).campaign.chat.length, 0);
    f.ok(f.owner, 'chat.send', { text: literal, visibility: 'public', system: spoof });
    const publicMessage = (await snapshot(f.app.url, f.observer.token)).campaign.chat.at(-1)!;
    assert.equal(publicMessage.text, literal); assert.equal(publicMessage.system, undefined);
    const before = await snapshot(f.app.url, f.owner.token);
    const denied = f.command(f.owner, 'actor.roll', { id: f.actorId, modifier: 0, visibility: 'public', system: spoof });
    assert.equal(denied.ack.ok, false); assert.equal(denied.ack.code, 'FORBIDDEN'); assert.equal(denied.changed, false);
    assert.deepEqual(await snapshot(f.app.url, f.owner.token), before);
  } finally { await f.app.close(); }
});

test('authorized rolls and action outcomes persist controlled labels separately from literal names', async () => {
  const f = await fixture();
  try {
    const actorName = 'Damage {value}', actionName = 'Healing {kind}';
    f.ok(f.gm, 'actor.update', { id: f.actorId, name: actorName, sheetKind: 'dnd5e', abilities: { str: 12 }, owners: [f.owner.memberId] });
    const { version: _version, ...checks } = blankActorChecks();
    f.ok(f.owner, 'actor.checks.update', { id: f.actorId, checksVersion: 0, checks });
    const last = async (auth = f.owner): Promise<ChatMessage> => (await snapshot(f.app.url, auth.token)).campaign.chat.at(-1)!;
    f.ok(f.owner, 'actor.roll', { id: f.actorId, ability: 'str', visibility: 'public' });
    assert.deepEqual((await last()).system, { key: '{actor} · {label}', parameters: { actor: actorName, label: 'Strength' }, localizedParameters: ['label'] });
    f.ok(f.owner, 'actor.check.roll', { id: f.actorId, kind: 'save', key: 'str', mode: 'normal', visibility: 'gm' });
    const savingThrow = await last();
    assert.deepEqual(savingThrow.system, { key: '{actor} · {kind}: {ability}', parameters: { actor: actorName, kind: 'Saving throw', ability: 'Strength' }, localizedParameters: ['kind', 'ability'] });
    assert.equal((await last(f.gm)).id, savingThrow.id);
    assert.notEqual((await last(f.observer)).id, savingThrow.id);
    f.ok(f.gm, 'actor.action.create', { id: f.actorId, name: actionName, outcome: { kind: 'damage', parts: [{ number: 1, denomination: 4, bonus: 0, type: 'force' }], allowCritical: false } });
    let state = await snapshot(f.app.url, f.owner.token);
    const action = state.campaign.actors.find(a => a.id === f.actorId)!.actions[0];
    f.ok(f.owner, 'actor.action.execute', { id: f.actorId, actionId: action.id, actionVersion: action.version, visibility: 'self' });
    assert.deepEqual((await last()).system, { key: '{actor} · {action} · cost saved; roll pending', parameters: { actor: actorName, action: actionName } });
    state = await snapshot(f.app.url, f.owner.token);
    const resolutionId = state.campaign.actionResolutions.at(-1)!.id;
    f.ok(f.owner, 'actor.action.rollOutcome', { id: f.actorId, resolutionId, critical: false });
    const outcomeMessage = await last();
    assert.equal(outcomeMessage.system!.key, '{actor} · {action} · {kind}: {total}');
    assert.deepEqual(outcomeMessage.system!.localizedParameters, ['kind']);
    assert.deepEqual({ ...outcomeMessage.system!.parameters, total: 0 }, { actor: actorName, action: actionName, kind: 'damage', total: 0 });
    assert.ok(Number(outcomeMessage.system!.parameters.total) >= 1 && Number(outcomeMessage.system!.parameters.total) <= 4);
    state = await snapshot(f.app.url, f.owner.token);
    const outcomeId = state.campaign.outcomeRolls.at(-1)!.id;
    f.ok(f.owner, 'actor.action.applyOutcome', { id: f.actorId, outcomeId, targetTokenId: f.tokenId, multiplier: 1 });
    assert.deepEqual((await last()).system, { key: '{actor} · {action} · outcome applied', parameters: { actor: actorName, action: actionName } });
    for (const auth of [f.gm, f.observer]) {
      const serialized = JSON.stringify((await snapshot(f.app.url, auth.token)).campaign.chat);
      assert.equal(serialized.includes(actionName), false, 'private action metadata must follow chat visibility');
    }
    const before = await snapshot(f.app.url, f.observer.token);
    const denied = f.command(f.observer, 'actor.action.execute', { id: f.actorId, actionId: action.id, actionVersion: action.version, visibility: 'public' });
    assert.equal(denied.ack.code, 'FORBIDDEN'); assert.equal(denied.changed, false);
    assert.deepEqual(await snapshot(f.app.url, f.observer.token), before);
  } finally { await f.app.close(); }
});
