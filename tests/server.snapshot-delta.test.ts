import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { startServer } from '../server/app.ts';
import type { AuthResult, Command, CommandResult, ServerMessage, Snapshot } from '../shared/model.ts';
import { applySnapshotDelta, SNAPSHOT_SYNC_PROTOCOL } from '../shared/snapshot-sync.ts';

type StateMessage = Extract<ServerMessage, { type: 'snapshot' | 'snapshot-delta' }>;
interface Received { message: ServerMessage; raw: string; bytes: number }
const wireClone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

class DeltaClient {
  received: Received[] = [];
  current: Snapshot | null = null;
  rejectedDeltas = 0;
  dropNextState = false;
  private wake = new Set<() => void>();
  constructor(readonly socket: WebSocket) {
    socket.on('message', data => {
      const raw = data.toString(), message = JSON.parse(raw) as ServerMessage;
      this.received.push({ message, raw, bytes: Buffer.byteLength(raw) });
      if (message.type === 'snapshot' || message.type === 'snapshot-delta') {
        if (this.dropNextState) this.dropNextState = false;
        else if (message.type === 'snapshot') this.current = message.data;
        else {
          const next = this.current && applySnapshotDelta(this.current, message.data);
          if (next) this.current = next;
          else this.rejectedDeltas++;
        }
      }
      for (const listener of this.wake) listener();
    });
  }
  static async connect(url: string, token: string, sync: boolean) {
    const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws'), client = new DeltaClient(socket);
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'auth', token, ...(sync ? { sync: SNAPSHOT_SYNC_PROTOCOL } : {}) }));
    await client.wait(record => record.message.type === 'snapshot');
    return client;
  }
  wait(predicate: (record: Received) => boolean, offset = 0): Promise<Received> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.wake.delete(check); reject(new Error('Timed out waiting for snapshot protocol')); }, 5000);
      const check = () => {
        const result = this.received.slice(offset).find(predicate);
        if (result) { clearTimeout(timer); this.wake.delete(check); resolve(result); }
      };
      this.wake.add(check); check();
    });
  }
  state(revision: number, offset = 0) {
    return this.wait(record => {
      const m = record.message;
      return m.type === 'snapshot' ? m.data.campaign.revision === revision : m.type === 'snapshot-delta' && m.data.revision === revision;
    }, offset);
  }
  async command(command: Command): Promise<CommandResult> {
    const offset = this.received.length;
    this.socket.send(JSON.stringify({ type: 'command', command }));
    return (await this.wait(record => record.message.type === 'ack' && record.message.id === command.id, offset)).message as CommandResult;
  }
  close() { this.socket.terminate(); }
}

async function fixture() {
  const app = await startServer({ dbPath: ':memory:', port: 0 }), clients: DeltaClient[] = [];
  const gmAuth = app.store.create('Private delta fixture', 'GM');
  const gmSession = app.store.authenticate(gmAuth.token);
  const first = app.store.snapshot(gmSession);
  const ownerAuth = app.store.join(first.inviteCode, 'Owner');
  const observerAuth = app.store.join(first.inviteCode, 'Observer');
  const snapshot = (auth: AuthResult) => wireClone(app.store.snapshot(app.store.authenticate(auth.token)));
  function setup(type: Command['type'], payload: Record<string, unknown>) {
    const result = app.store.command(gmSession, { id: randomUUID(), type, payload, expectedRevision: snapshot(gmAuth).campaign.revision });
    assert.equal(result.ack.ok, true, `${type}: ${result.ack.error}`);
  }
  async function connect(auth: AuthResult, sync = true) {
    const client = await DeltaClient.connect(app.url, auth.token, sync); clients.push(client); return client;
  }
  async function edit(gm: DeltaClient, type: Command['type'], payload: Record<string, unknown>) {
    const command: Command = { id: randomUUID(), type, payload, expectedRevision: snapshot(gmAuth).campaign.revision };
    const ack = await gm.command(command); assert.equal(ack.ok, true, `${type}: ${ack.code} ${ack.error}`);
    return { ack, command, revision: ack.revision! };
  }
  return { app, gmAuth, ownerAuth, observerAuth, snapshot, setup, connect, edit,
    close: async () => { clients.forEach(client => client.close()); await app.close(); } };
}

test('negotiated wire deltas preserve per-player privacy, ownership revocation, hidden-token removal and secret-door projection', async () => {
  const f = await fixture();
  try {
    const initial = f.snapshot(f.gmAuth), actorId = initial.campaign.actors[0].id;
    const scene = initial.campaign.scenes.find(s => s.id === initial.campaign.activeSceneId)!;
    const tokenId = scene.tokens.find(t => t.actorId === actorId)!.id, wallId = scene.walls[0].id;
    f.setup('scene.update', { id: scene.id, visionEnabled: false });
    f.setup('actor.update', { id: actorId, owners: [f.ownerAuth.memberId], notes: 'OWNER_PRIVATE_NOTES', gmNotes: 'GM_PRIVATE_NOTES' });
    f.setup('actor.resource.create', { id: actorId, label: 'OWNER_PRIVATE_CHARGE', value: 2, max: 2, kind: 'charge', recovery: 'long-rest' });
    const gm = await f.connect(f.gmAuth, false), owner = await f.connect(f.ownerAuth), observer = await f.connect(f.observerAuth);
    assert.equal(owner.current!.campaign.actors.find(a => a.id === actorId)!.notes, 'OWNER_PRIVATE_NOTES');
    assert.equal(observer.current!.campaign.actors.find(a => a.id === actorId)!.sheetAccess, 'summary');
    const advance = async (type: Command['type'], payload: Record<string, unknown>) => {
      const result = await f.edit(gm, type, payload);
      await Promise.all([gm.state(result.revision), owner.state(result.revision), observer.state(result.revision)]);
      for (const [client, auth] of [[gm, f.gmAuth], [owner, f.ownerAuth], [observer, f.observerAuth]] as const) assert.deepEqual(client.current, f.snapshot(auth));
      return result;
    };
    await advance('chat.send', { text: 'GM_SECRET_MESSAGE', visibility: 'gm' });
    const beforeRevoke = owner.received.length;
    await advance('actor.update', { id: actorId, owners: [] });
    const revoked = owner.current!.campaign.actors.find(a => a.id === actorId)!;
    assert.equal(revoked.sheetAccess, 'summary'); assert.equal(revoked.notes, ''); assert.equal(revoked.resources.length, 0);
    assert.ok(owner.received.slice(beforeRevoke).some(r => r.message.type === 'snapshot-delta'));
    const revokeWire = owner.received.slice(beforeRevoke).map(r => r.raw).join('\n');
    assert.equal(revokeWire.includes('OWNER_PRIVATE_NOTES'), false); assert.equal(revokeWire.includes('OWNER_PRIVATE_CHARGE'), false);
    await advance('token.update', { id: tokenId, hidden: true });
    assert.equal(owner.current!.campaign.scenes[0].tokens.some(t => t.id === tokenId), false);
    assert.equal(owner.current!.campaign.actors.some(a => a.id === actorId), false);
    await advance('wall.update', { id: wallId, kind: 'secret', state: 'closed' });
    assert.equal(observer.current!.campaign.scenes[0].walls.find(w => w.id === wallId)!.kind, 'wall');
    await advance('wall.update', { id: wallId, state: 'open' });
    assert.equal(observer.current!.campaign.scenes[0].walls.some(w => w.id === wallId), false);
    await advance('wall.update', { id: wallId, state: 'closed' });
    assert.equal(observer.current!.campaign.scenes[0].walls.find(w => w.id === wallId)!.kind, 'wall');
    await advance('scene.create', { name: 'Second scene' });
    assert.equal(observer.current!.campaign.scenes.length, 1);
    assert.equal(observer.current!.campaign.scenes[0].name, 'Second scene');
    const observerWire = observer.received.map(r => r.raw).join('\n');
    for (const secret of ['OWNER_PRIVATE_NOTES', 'OWNER_PRIVATE_CHARGE', 'GM_PRIVATE_NOTES', 'GM_SECRET_MESSAGE', initial.inviteCode!]) assert.equal(observerWire.includes(secret), false, secret);
    assert.equal(observerWire.includes('"secret"'), false);
    assert.equal(gm.received.some(r => r.message.type === 'snapshot-delta'), false, 'legacy sessions keep the full-snapshot protocol');
    assert.ok(observer.received.filter(r => r.message.type === 'snapshot-delta').length >= 7);
    assert.equal(owner.rejectedDeltas + observer.rejectedDeltas, 0);
  } finally { await f.close(); }
});

test('a missed delta rejects the wrong base, explicit resync and reconnect restore full state, and exact command retries do not replay', async () => {
  const f = await fixture();
  try {
    const gm = await f.connect(f.gmAuth), observer = await f.connect(f.observerAuth), legacy = await f.connect(f.observerAuth, false);
    const old = wireClone(observer.current!); observer.dropNextState = true;
    const first = await f.edit(gm, 'chat.send', { text: 'First update', visibility: 'public' });
    const missed = (await observer.state(first.revision)).message as StateMessage;
    assert.equal(missed.type, 'snapshot-delta'); assert.deepEqual(observer.current, old);
    const second = await f.edit(gm, 'chat.send', { text: 'Second update', visibility: 'public' });
    await observer.state(second.revision);
    assert.equal(observer.rejectedDeltas, 1); assert.deepEqual(observer.current, old, 'a patch with a missing base never partially applies');
    const offset = observer.received.length;
    observer.socket.send(JSON.stringify({ type: 'resync' }));
    await observer.wait(r => r.message.type === 'snapshot', offset);
    assert.deepEqual(observer.current, f.snapshot(f.observerAuth));
    const retryOffset = gm.received.length;
    const retry = await gm.command(second.command);
    assert.equal(retry.ok, true); assert.equal(retry.revision, second.revision);
    await gm.wait(r => r.message.type === 'snapshot', retryOffset);
    assert.equal(f.snapshot(f.gmAuth).campaign.chat.filter(m => m.text === 'Second update').length, 1);
    const reconnected = await f.connect(f.observerAuth);
    assert.equal(reconnected.received[0].message.type, 'snapshot');
    assert.deepEqual(reconnected.current, observer.current);
    const legacyOffset = legacy.received.length;
    legacy.socket.send(JSON.stringify({ type: 'resync' }));
    await legacy.wait(r => r.message.type === 'error', legacyOffset);
    assert.equal(legacy.received.some(r => r.message.type === 'snapshot-delta'), false);
  } finally { await f.close(); }
});

test('token movement sends a small real WebSocket delta without repeating static walls, and legacy/full states agree', async () => {
  const f = await fixture();
  try {
    const initial = f.snapshot(f.gmAuth), scene = initial.campaign.scenes.find(s => s.id === initial.campaign.activeSceneId)!;
    f.setup('scene.update', { id: scene.id, visionEnabled: false });
    for (let i = 0; i < 100; i++) f.setup('wall.create', { a: { x: 10 + i * 5, y: 10 }, b: { x: 10 + i * 5, y: 40 } });
    const gm = await f.connect(f.gmAuth), player = await f.connect(f.observerAuth), legacy = await f.connect(f.observerAuth, false);
    const token = scene.tokens.find(t => !t.hidden)!;
    const { revision } = await f.edit(gm, 'token.move', { id: token.id, x: token.x + 5, y: token.y, bypass: true });
    const patch = await player.state(revision), full = await legacy.state(revision);
    assert.equal(patch.message.type, 'snapshot-delta'); assert.equal(full.message.type, 'snapshot');
    assert.deepEqual(player.current, legacy.current); assert.deepEqual(player.current, f.snapshot(f.observerAuth));
    assert.ok(patch.bytes < full.bytes / 10, `delta ${patch.bytes} bytes, full ${full.bytes} bytes`);
    assert.equal(patch.raw.includes('"walls"'), false);
    assert.equal(patch.raw.includes(scene.walls[0].id), false);
    if (patch.message.type === 'snapshot-delta') assert.equal(patch.message.data.baseRevision, revision - 1);
  } finally { await f.close(); }
});
