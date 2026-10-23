import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { startServer } from '../server/app.ts';
import type { AuthResult, Campaign, Command, CommandResult, ServerMessage, Snapshot } from '../shared/model.ts';

class WireClient {
  messages: ServerMessage[] = [];
  wake = new Set<() => void>();
  constructor(readonly socket: WebSocket, readonly dropAcks = false) {
    socket.on('message', data => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      if (this.dropAcks && message.type === 'ack') return;
      this.messages.push(message);
      for (const callback of this.wake) callback();
    });
  }
  static async connect(url: string, token: string, dropAcks = false) {
    const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws');
    const client = new WireClient(socket, dropAcks);
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'auth', token }));
    await client.wait((message): message is Extract<ServerMessage, { type: 'snapshot' }> => message.type === 'snapshot');
    return client;
  }
  wait<T extends ServerMessage>(predicate: (message: ServerMessage) => message is T, offset = 0): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.wake.delete(check); reject(new Error('Timed out waiting for server protocol')); }, 5000);
      const check = () => {
        const found = this.messages.slice(offset).find(predicate);
        if (found) { clearTimeout(timer); this.wake.delete(check); resolve(found); }
      };
      this.wake.add(check); check();
    });
  }
  async send(command: Command) {
    const offset = this.messages.length;
    this.socket.send(JSON.stringify({ type: 'command', command }));
    return this.wait((message): message is CommandResult => message.type === 'ack' && message.id === command.id, offset);
  }
  close() { this.socket.terminate(); }
}

test('WebSocket lost acknowledgement recovers the original action after reconnect without spending or rolling again', async () => {
  const app = await startServer({ dbPath: ':memory:', port: 0 });
  const clients: WireClient[] = [];
  const connect = async (token: string, drop = false) => { const client = await WireClient.connect(app.url, token, drop); clients.push(client); return client; };
  const post = async (path: string, payload: unknown) => {
    const response = await fetch(app.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(response.status, 201); return await response.json() as AuthResult;
  };
  const get = async <T>(path: string, token: string) => {
    const response = await fetch(app.url + path, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200); return await response.json() as T;
  };
  try {
    const gmAuth = await post('/api/campaigns', { name: 'Action protocol regression', gmName: 'GM' });
    const initial = await get<Snapshot>('/api/snapshot', gmAuth.token);
    const ownerAuth = await post('/api/join', { inviteCode: initial.inviteCode, name: 'Owner' });
    const outsiderAuth = await post('/api/join', { inviteCode: initial.inviteCode, name: 'Observer' });
    const gm = await connect(gmAuth.token);
    const edit = async (type: Command['type'], payload: Record<string, unknown>) => {
      const state = await get<Snapshot>('/api/snapshot', gmAuth.token);
      const ack = await gm.send({ id: randomUUID(), type, payload, expectedRevision: state.campaign.revision });
      assert.equal(ack.ok, true, `${type}: ${ack.code} ${ack.error}`);
    };
    const actorId = initial.campaign.actors[0].id;
    await edit('actor.update', { id: actorId, owners: [ownerAuth.memberId], sheetKind: 'dnd5e', abilities: { int: 16 } });
    await edit('actor.resource.create', { id: actorId, label: 'Private charge', value: 2, max: 2, kind: 'charge', recovery: 'long-rest' });
    const withResource = await get<Snapshot>('/api/snapshot', gmAuth.token);
    const resourceId = withResource.campaign.actors.find(actor => actor.id === actorId)!.resources[0].id;
    await edit('actor.action.create', { id: actorId, name: 'Protocol check', description: 'One deliberate use', sourceLabel: 'Private research source', category: 'Skill', known: true, prepared: true, requiresPreparation: true, enabled: true, target: 'none', costs: [{ resourceId, amount: 1 }], outcome: { kind: 'roll', ability: 'int', modifier: 0, mode: 'advantage' } });
    const ready = await get<Snapshot>('/api/snapshot', ownerAuth.token);
    const action = ready.campaign.actors.find(actor => actor.id === actorId)!.actions[0];
    const envelope: Command = { id: randomUUID(), type: 'actor.action.execute', payload: { id: actorId, actionId: action.id, actionVersion: action.version, visibility: 'public' }, expectedRevision: ready.campaign.revision };
    const first = await connect(ownerAuth.token, true);
    const observer = await connect(outsiderAuth.token);
    const offset = first.messages.length;
    first.socket.send(JSON.stringify({ type: 'command', command: envelope }));
    const committed = await first.wait((message): message is Extract<ServerMessage, { type: 'snapshot' }> => message.type === 'snapshot' && message.data.campaign.revision > ready.campaign.revision, offset);
    assert.equal(first.messages.some(message => message.type === 'ack'), false, 'simulated caller never receives ACK');
    const beforeRetry = await get<Campaign>('/api/export', gmAuth.token);
    assert.equal(beforeRetry.actionResolutions.length, 1);
    assert.equal(beforeRetry.actors.find(actor => actor.id === actorId)!.resources[0].value, 1);
    assert.equal(beforeRetry.chat.length, 1);
    assert.equal(beforeRetry.chat[0].roll!.dice[0].values.length, 2);
    first.close();
    const reconnected = await connect(ownerAuth.token);
    const recovered = await reconnected.send(envelope);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.revision, committed.data.campaign.revision);
    assert.deepEqual(await get<Campaign>('/api/export', gmAuth.token), beforeRetry, 'exact retry preserves every persisted field');
    const reused = await reconnected.send({ ...envelope, payload: { ...envelope.payload, visibility: 'self' } });
    assert.equal(reused.code, 'ID_REUSED');
    assert.deepEqual(await get<Campaign>('/api/export', gmAuth.token), beforeRetry);
    const publicState = await get<Snapshot>('/api/snapshot', outsiderAuth.token);
    assert.equal(publicState.campaign.actionResolutions.length, 0);
    assert.equal(publicState.campaign.chat.length, 1);
    assert.equal(publicState.campaign.chat[0].roll?.abilitySnapshot, undefined);
    assert.equal(JSON.stringify(publicState).includes('Private research source'), false);
    assert.equal(JSON.stringify(publicState).includes('Private charge'), false);
    const broadcast = await observer.wait((message): message is Extract<ServerMessage, { type: 'snapshot' }> => message.type === 'snapshot' && message.data.campaign.revision === committed.data.campaign.revision);
    assert.equal(broadcast.data.campaign.actionResolutions.length, 0);
  } finally { clients.forEach(client => client.close()); await app.close(); }
});

test('separate roll and HP lost acknowledgements recover over real WebSockets without another roll, spend or application', async () => {
  const app = await startServer({ dbPath: ':memory:', port: 0 });
  const clients: WireClient[] = [];
  const connect = async (token: string, drop = false) => { const client = await WireClient.connect(app.url, token, drop); clients.push(client); return client; };
  const post = async (path: string, payload: unknown) => {
    const response = await fetch(app.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(response.status, 201); return await response.json() as AuthResult;
  };
  const get = async <T>(path: string, token: string) => {
    const response = await fetch(app.url + path, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200); return await response.json() as T;
  };
  try {
    const gmAuth = await post('/api/campaigns', { name: 'Outcome protocol regression', gmName: 'GM' });
    const initial = await get<Snapshot>('/api/snapshot', gmAuth.token);
    const ownerAuth = await post('/api/join', { inviteCode: initial.inviteCode, name: 'Owner' });
    const outsiderAuth = await post('/api/join', { inviteCode: initial.inviteCode, name: 'Observer' });
    const gm = await connect(gmAuth.token), actorId = initial.campaign.actors[0].id;
    const edit = async (type: Command['type'], payload: Record<string, unknown>) => {
      const state = await get<Snapshot>('/api/snapshot', gmAuth.token);
      const ack = await gm.send({ id: randomUUID(), type, payload, expectedRevision: state.campaign.revision });
      assert.equal(ack.ok, true, `${type}: ${ack.code} ${ack.error}`);
    };
    await edit('actor.update', { id: actorId, owners: [ownerAuth.memberId], hp: 20, maxHp: 20 });
    await edit('actor.resource.create', { id: actorId, label: 'Private spell slot', value: 2, max: 2, kind: 'spell-slot', level: 1, recovery: 'long-rest' });
    const prepared = await get<Snapshot>('/api/snapshot', gmAuth.token);
    const resourceId = prepared.campaign.actors.find(a => a.id === actorId)!.resources[0].id;
    const tokenId = prepared.campaign.scenes[0].tokens.find(t => t.linked && t.actorId === actorId)!.id;
    await edit('actor.action.create', { id: actorId, name: 'Staged force', description: '', sourceLabel: 'Private outcome source', category: 'Spell', known: true, prepared: true, requiresPreparation: true, enabled: true, target: 'self', costs: [{ resourceId, amount: 1 }], outcome: { kind: 'damage', parts: [{ number: 1, denomination: 4, bonus: 0, type: 'force' }], allowCritical: false } });
    const ready = await get<Snapshot>('/api/snapshot', ownerAuth.token), owner = await connect(ownerAuth.token);
    const action = ready.campaign.actors.find(a => a.id === actorId)!.actions[0];
    const castAck = await owner.send({ id: randomUUID(), type: 'actor.action.execute', payload: { id: actorId, actionId: action.id, actionVersion: action.version, visibility: 'public' }, expectedRevision: ready.campaign.revision });
    assert.equal(castAck.ok, true);
    const castState = await get<Campaign>('/api/export', gmAuth.token);
    assert.equal(castState.actors.find(a => a.id === actorId)!.hp, 20);
    assert.equal(castState.outcomeRolls.length, 0);
    assert.equal(castState.hpApplications.length, 0);
    assert.equal(castState.actors.find(a => a.id === actorId)!.resources[0].value, 1);
    const resolutionId = castState.actionResolutions[0].id;

    async function lostAckRetry(type: Command['type'], payload: Record<string, unknown>) {
      const before = await get<Snapshot>('/api/snapshot', ownerAuth.token);
      const envelope: Command = { id: randomUUID(), type, payload, expectedRevision: before.campaign.revision };
      const first = await connect(ownerAuth.token, true), offset = first.messages.length;
      first.socket.send(JSON.stringify({ type: 'command', command: envelope }));
      const committed = await first.wait((m): m is Extract<ServerMessage, { type: 'snapshot' }> => m.type === 'snapshot' && m.data.campaign.revision > before.campaign.revision, offset);
      assert.equal(first.messages.some(m => m.type === 'ack'), false);
      const persisted = await get<Campaign>('/api/export', gmAuth.token);
      first.close();
      const recoveredClient = await connect(ownerAuth.token);
      const recovered = await recoveredClient.send(envelope);
      assert.equal(recovered.ok, true); assert.equal(recovered.revision, committed.data.campaign.revision);
      assert.deepEqual(await get<Campaign>('/api/export', gmAuth.token), persisted, `${type} exact retry must preserve every field`);
      return { persisted, envelope, recoveredClient };
    }

    const rolled = await lostAckRetry('actor.action.rollOutcome', { id: actorId, resolutionId, critical: false });
    assert.equal(rolled.persisted.outcomeRolls.length, 1);
    assert.equal(rolled.persisted.hpApplications.length, 0);
    assert.equal(rolled.persisted.actors.find(a => a.id === actorId)!.hp, 20);
    const outcome = rolled.persisted.outcomeRolls[0];
    assert.ok(outcome.total >= 1 && outcome.total <= 4);
    const applied = await lostAckRetry('actor.action.applyOutcome', { id: actorId, outcomeId: outcome.id, targetTokenId: tokenId, multiplier: 1 });
    assert.equal(applied.persisted.outcomeRolls.length, 1);
    assert.equal(applied.persisted.hpApplications.length, 1);
    assert.equal(applied.persisted.actors.find(a => a.id === actorId)!.hp, 20 - outcome.total);
    assert.equal(applied.persisted.actors.find(a => a.id === actorId)!.resources[0].value, 1);
    const duplicate = await applied.recoveredClient.send({ ...applied.envelope, id: randomUUID(), expectedRevision: applied.persisted.revision });
    assert.equal(duplicate.code, 'ALREADY_APPLIED');
    const changedIntent = await applied.recoveredClient.send({ ...applied.envelope, payload: { ...applied.envelope.payload, multiplier: 2 } });
    assert.equal(changedIntent.code, 'ID_REUSED');
    assert.deepEqual(await get<Campaign>('/api/export', gmAuth.token), applied.persisted);
    const outsider = await get<Snapshot>('/api/snapshot', outsiderAuth.token);
    assert.equal(outsider.campaign.actionResolutions.length, 0);
    assert.equal(outsider.campaign.outcomeRolls.length, 0);
    assert.equal(outsider.campaign.hpApplications.length, 0);
    assert.equal(JSON.stringify(outsider).includes('Private outcome source'), false);
    assert.equal(JSON.stringify(outsider).includes('Private spell slot'), false);
  } finally { clients.forEach(client => client.close()); await app.close(); }
});
