import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { startServer } from '../server/app.ts';
import type { AuthResult, Command, CommandResult, Snapshot, ServerMessage } from '../shared/model.ts';
import { tokenResources } from '../shared/model.ts';

class Client {
  readonly messages: ServerMessage[] = [];
  private waiters = new Set<() => void>();
  constructor(readonly socket: WebSocket, readonly url: string, readonly token: string) {
    socket.on('message', data => { this.messages.push(JSON.parse(data.toString()) as ServerMessage); for (const wake of this.waiters) wake(); });
  }
  static async connect(url: string, token: string) {
    const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws'); const client = new Client(socket, url, token);
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'auth', token })); await client.snapshot(); return client;
  }
  wait<T extends ServerMessage>(predicate: (message: ServerMessage) => message is T, from = 0): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(check); reject(new Error('WebSocket message timeout')); }, 5000);
      const check = () => { const value = this.messages.slice(from).find(predicate); if (value) { clearTimeout(timer); this.waiters.delete(check); resolve(value); } };
      this.waiters.add(check); check();
    });
  }
  async snapshot(revision = 0): Promise<Snapshot> {
    const message = await this.wait((m): m is Extract<ServerMessage, { type: 'snapshot' }> => m.type === 'snapshot' && m.data.campaign.revision >= revision);
    return message.data;
  }
  async command(type: Command['type'], payload: Record<string, unknown>, options: Partial<Pick<Command, 'id' | 'expectedRevision'>> = {}) {
    // Combat and journals require the real API's current revision; explicit stale revisions remain testable.
    if ((type.startsWith('combat.') || type.startsWith('journal.')) && options.expectedRevision === undefined) options = { ...options, expectedRevision: (await snapshot(this.url, this.token)).campaign.revision };
    const command: Command = { id: options.id ?? randomUUID(), type, payload, ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }) };
    const offset = this.messages.length; this.socket.send(JSON.stringify({ type: 'command', command }));
    return this.wait((m): m is CommandResult => m.type === 'ack' && m.id === command.id, offset);
  }
  close() { this.socket.terminate(); }
}
async function post(url: string, path: string, data: unknown) {
  const response = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  assert.equal(response.status, 201); return await response.json() as AuthResult;
}
async function snapshot(url: string, token: string) {
  const response = await fetch(url + '/api/snapshot', { headers: { Authorization: `Bearer ${token}` } }); assert.equal(response.status, 200); return await response.json() as Snapshot;
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'vtt-server-test-')), dbPath = join(directory, 'test.sqlite');
  const app = await startServer({ port: 0, dbPath });
  const gmAuth = await post(app.url, '/api/campaigns', { name: 'Integration campaign', gmName: 'GM' });
  const gmState = await snapshot(app.url, gmAuth.token);
  const playerAuth = await post(app.url, '/api/join', { inviteCode: gmState.inviteCode, name: 'Player', role: 'gm', memberId: gmAuth.memberId });
  const otherAuth = await post(app.url, '/api/join', { inviteCode: gmState.inviteCode, name: 'Other player' });
  const [gm, player, other] = await Promise.all([Client.connect(app.url, gmAuth.token), Client.connect(app.url, playerAuth.token), Client.connect(app.url, otherAuth.token)]);
  return { app, dbPath, directory, gmAuth, playerAuth, otherAuth, gm, player, other, cleanup: async () => { gm.close(); player.close(); other.close(); await app.close(); await rm(directory, { recursive: true, force: true }); } };
}
async function assertOK(client: Client, type: Command['type'], payload: Record<string, unknown>, options?: Partial<Pick<Command, 'id' | 'expectedRevision'>>) {
  const ack = await client.command(type, payload, options); assert.equal(ack.ok, true, `${type}: ${ack.code} ${ack.error}`); return ack.revision!;
}

test('REST identities are server-assigned; each WebSocket receives a private projection', async () => {
  const f = await setup();
  try {
    const gm = await f.gm.snapshot(), player = await f.player.snapshot(), other = await f.other.snapshot();
    assert.equal(gm.self.role, 'gm'); assert.equal(player.self.role, 'player'); assert.notEqual(player.self.id, gm.self.id);
    assert.ok(gm.inviteCode); assert.equal(player.inviteCode, undefined); assert.equal(other.inviteCode, undefined);
    assert.equal(gm.campaign.scenes[0].tokens.length, 3); assert.equal(player.campaign.scenes[0].tokens.length, 2);
    assert.ok(!JSON.stringify(player).includes('A hidden guardian')); assert.ok(!player.campaign.actors.some(a => a.name === 'Guardian'));
    assert.equal(player.campaign.actors.some(a => a.owners.includes(player.self.id)), false);
    assert.equal((await fetch(f.app.url + '/api/snapshot')).status, 401);
    assert.equal((await fetch(f.app.url + '/api/export', { headers: { Authorization: `Bearer ${f.playerAuth.token}` } })).status, 403);
    const exported = await fetch(f.app.url + '/api/export', { headers: { Authorization: `Bearer ${f.gmAuth.token}` } }); assert.equal(exported.status, 200);
    assert.ok(JSON.stringify(await exported.json()).includes('A hidden guardian'));
    const token = gm.campaign.scenes[0].tokens[0];
    const denied = await f.player.command('token.move', { id: token.id, x: 450, y: 350, role: 'gm' }); assert.equal(denied.code, 'FORBIDDEN');
    assert.equal((await f.player.command('scene.create', { name: 'Forbidden' })).code, 'FORBIDDEN');
  } finally { await f.cleanup(); }
});

test('authorized movement, physical barriers, nearby doors and linked resources are authoritative', async () => {
  const f = await setup();
  try {
    const gm = await f.gm.snapshot(), scene = gm.campaign.scenes[0], token = scene.tokens[0], door = scene.walls.find(w => w.kind === 'door')!;
    await assertOK(f.gm, 'token.update', { id: token.id, owners: [f.playerAuth.memberId] });
    assert.equal((await f.player.command('token.update', { id: token.id, hidden: false })).code, 'FORBIDDEN');
    assert.equal((await f.player.command('token.move', { id: token.id, x: 1000, y: 300 })).code, 'BLOCKED');
    assert.equal((await f.gm.command('token.move', { id: token.id, x: 1000, y: 300 })).code, 'BLOCKED');
    assert.equal((await f.player.command('token.move', { id: token.id, x: 1000, y: 300, bypass: true })).code, 'FORBIDDEN');
    assert.equal((await f.player.command('door.toggle', { id: door.id })).code, 'FORBIDDEN');
    await assertOK(f.player, 'token.move', { id: token.id, x: 700, y: 485 });
    await assertOK(f.player, 'door.toggle', { id: door.id });
    const moved = await assertOK(f.player, 'token.move', { id: token.id, x: 850, y: 485 });
    assert.equal((await f.other.snapshot(moved)).campaign.scenes[0].tokens.find(t => t.id === token.id)?.x, 850);
    await assertOK(f.gm, 'wall.update', { id: door.id, state: 'locked' });
    assert.equal((await f.player.command('door.toggle', { id: door.id })).code, 'FORBIDDEN');
    await assertOK(f.gm, 'actor.place', { id: token.actorId, x: 450, y: 350 });
    const revision = await assertOK(f.player, 'token.update', { id: token.id, hp: 11, conditions: ['Poisoned'] });
    const current = (await f.gm.snapshot(revision)).campaign;
    assert.equal(current.actors.find(a => a.id === token.actorId)?.hp, 11);
    for (const placed of current.scenes[0].tokens.filter(t => t.actorId === token.actorId)) assert.equal(tokenResources(placed, current.actors).hp, 11);
    const detachedRevision = await assertOK(f.gm, 'token.update', { id: token.id, linked: false, hp: 5 });
    const detached = (await f.gm.snapshot(detachedRevision)).campaign;
    assert.equal(detached.actors.find(a => a.id === token.actorId)?.hp, 11);
    assert.equal(detached.scenes[0].tokens.find(t => t.id === token.id)?.hp, 5);
    await assertOK(f.gm, 'token.update', { id: token.id, linked: true });
    const actorId = token.actorId!;
    await assertOK(f.gm, 'actor.update', { id: actorId, owners: [f.playerAuth.memberId] });
    assert.equal((await f.player.command('actor.update', { id: actorId, gmNotes: 'overwrite' })).code, 'FORBIDDEN');
    await assertOK(f.player, 'actor.update', { id: actorId, notes: 'My note' });
  } finally { await f.cleanup(); }
});

test('chat recipients, crypto dice, idempotence and initiative do not leak hidden entities', async () => {
  const f = await setup();
  try {
    const original = await f.gm.snapshot(), token = original.campaign.scenes[0].tokens[0], hidden = original.campaign.scenes[0].tokens[2];
    await assertOK(f.gm, 'token.update', { id: token.id, owners: [f.playerAuth.memberId] });
    await assertOK(f.player, 'chat.send', { text: 'whisper-fixture', visibility: 'gm' });
    const secretRevision = await assertOK(f.player, 'chat.send', { text: 'self-fixture', visibility: 'self' });
    const [gm, p, other] = await Promise.all([f.gm.snapshot(secretRevision), f.player.snapshot(secretRevision), f.other.snapshot(secretRevision)]);
    assert.ok(gm.campaign.chat.some(m => m.text === 'whisper-fixture')); assert.ok(!gm.campaign.chat.some(m => m.text === 'self-fixture'));
    assert.ok(p.campaign.chat.some(m => m.text === 'self-fixture')); assert.equal(other.campaign.chat.length, 0);
    const id = randomUUID(), rev = await assertOK(f.player, 'chat.roll', { formula: '2d6+3', visibility: 'public' }, { id });
    const roll = (await f.other.snapshot(rev)).campaign.chat.at(-1)!.roll!;
    assert.ok(roll.total >= 5 && roll.total <= 15); assert.equal(roll.dice[0].values.length, 2);
    const repeat = await f.player.command('chat.roll', { formula: '2d6+3', visibility: 'public' }, { id }); assert.equal(repeat.revision, rev);
    assert.equal((await snapshot(f.app.url, f.playerAuth.token)).campaign.chat.filter(m => m.roll).length, 1);
    assert.equal((await f.player.command('chat.roll', { formula: '1d20' }, { id })).code, 'ID_REUSED');
    assert.equal((await f.player.command('chat.roll', { formula: 'process.exit()' })).code, 'VALIDATION');
    assert.equal((await f.player.command('chat.roll', { formula: '100d6+100d6' })).code, 'LIMIT');
    await assertOK(f.gm, 'combat.add', { id: token.id }); const added = await assertOK(f.gm, 'combat.add', { id: hidden.id });
    const full = await f.gm.snapshot(added), projected = await f.player.snapshot(added);
    assert.equal(full.campaign.combat.combatants.length, 2); assert.equal(projected.campaign.combat.combatants.length, 1);
    const combatant = full.campaign.combat.combatants.find(c => c.tokenId === token.id)!;
    await assertOK(f.gm, 'actor.update', { id: token.actorId, abilities: { dex: 14 } });
    await assertOK(f.player, 'combat.roll', { id: combatant.id });
    assert.equal((await f.other.command('combat.roll', { id: combatant.id })).code, 'FORBIDDEN');
    await assertOK(f.gm, 'combat.next', {}); await assertOK(f.gm, 'combat.end', {});
  } finally { await f.cleanup(); }
});

test('revision conflicts and validation roll back changes; visibility is projected on server', async () => {
  const f = await setup();
  try {
    const original = await f.gm.snapshot(), scene = original.campaign.scenes[0], actor = original.campaign.actors[0], token = scene.tokens[0];
    const before = original.campaign.revision;
    await assertOK(f.gm, 'actor.update', { id: actor.id, name: 'Updated' }, { expectedRevision: before });
    const conflict = await f.gm.command('actor.update', { id: actor.id, name: 'Lost update' }, { expectedRevision: before }); assert.equal(conflict.code, 'CONFLICT');
    const bad = await f.gm.command('actor.update', { id: actor.id, name: 'Partial mutation', hp: -1 }); assert.equal(bad.ok, false);
    const state = await snapshot(f.app.url, f.gmAuth.token); assert.equal(state.campaign.actors[0].name, 'Updated'); assert.equal(state.campaign.revision, before + 1);
    await assertOK(f.gm, 'token.update', { id: token.id, owners: [f.playerAuth.memberId], vision: 2000 });
    const visible = await assertOK(f.gm, 'scene.update', { visionEnabled: true });
    const p = await f.player.snapshot(visible); assert.equal(p.campaign.scenes[0].tokens.length, 1);
    const other = await f.other.snapshot(visible); assert.equal(other.campaign.scenes[0].tokens.length, 0);
    await assertOK(f.gm, 'journal.create', { name: 'GM secret', content: 'private-fixture', visibleTo: 'gm' });
    const journalState = await snapshot(f.app.url, f.playerAuth.token); assert.ok(!JSON.stringify(journalState).includes('private-fixture'));
    assert.equal((await f.gm.command('scene.update', { background: 'https://evil.invalid/image.png' })).code, 'VALIDATION');
  } finally { await f.cleanup(); }
});

test('remaining scene, level, entity and journal commands persist complete state', async () => {
  const f = await setup();
  try {
    const original = await f.gm.snapshot(), firstScene = original.campaign.activeSceneId;
    let revision = await assertOK(f.gm, 'scene.create', { name: 'Upper floor', width: 1000, height: 800 });
    let state = await f.gm.snapshot(revision), scene = state.campaign.scenes.find(s => s.id === state.campaign.activeSceneId)!;
    const secondScene = scene.id;
    revision = await assertOK(f.gm, 'level.create', { name: 'Roof', bottom: 20, top: 40 });
    state = await f.gm.snapshot(revision); scene = state.campaign.scenes.find(s => s.id === secondScene)!;
    await assertOK(f.gm, 'level.activate', { id: 'ground' });
    await assertOK(f.gm, 'scene.update', { name: 'Renamed', grid: { size: 60, distance: 10, units: 'm', type: 'none' } });
    revision = await assertOK(f.gm, 'token.create', { name: 'Independent', x: 300, y: 300, hp: 7, maxHp: 9, hidden: false });
    let token = (await f.gm.snapshot(revision)).campaign.scenes.find(s => s.id === secondScene)!.tokens[0];
    await assertOK(f.gm, 'token.update', { id: token.id, name: 'Renamed token', rotation: 45 });
    await assertOK(f.gm, 'combat.add', { id: token.id });
    revision = await assertOK(f.gm, 'combat.roll', { id: (await snapshot(f.app.url, f.gmAuth.token)).campaign.combat.combatants[0].id, formula: '1d20+0' });
    const combatant = (await f.gm.snapshot(revision)).campaign.combat.combatants[0];
    await assertOK(f.gm, 'combat.remove', { id: combatant.id }); await assertOK(f.gm, 'token.delete', { id: token.id });
    revision = await assertOK(f.gm, 'wall.create', { a: { x: 100, y: 100 }, b: { x: 100, y: 200 } });
    const wall = (await f.gm.snapshot(revision)).campaign.scenes.find(s => s.id === secondScene)!.walls[0]; await assertOK(f.gm, 'wall.delete', { id: wall.id });
    revision = await assertOK(f.gm, 'light.create', { x: 300, y: 350, bright: 50, dim: 100 });
    const light = (await f.gm.snapshot(revision)).campaign.scenes.find(s => s.id === secondScene)!.lights[0];
    await assertOK(f.gm, 'light.update', { id: light.id, enabled: false }); await assertOK(f.gm, 'light.delete', { id: light.id });
    revision = await assertOK(f.gm, 'actor.create', { name: 'New Actor', hp: 2, maxHp: 4 });
    assert.ok((await f.gm.snapshot(revision)).campaign.actors.some(a => a.name === 'New Actor'));
    revision = await assertOK(f.gm, 'journal.create', { name: 'Public', content: 'first', visibleTo: 'all' });
    const journal = (await f.gm.snapshot(revision)).campaign.journals.find(j => j.name === 'Public')!;
    await assertOK(f.gm, 'journal.update', { id: journal.id, content: 'updated' });
    const document = JSON.parse(await readFile(new URL('./fixtures/scene-populated.json', import.meta.url), 'utf8'));
    revision = await assertOK(f.gm, 'scene.import', { document }); state = await f.gm.snapshot(revision);
    const imported = state.campaign.scenes.find(s => s.id === state.campaign.activeSceneId)!;
    assert.equal(imported.walls.length, 2); assert.equal(imported.lights.length, 1);
    const importedList = await fetch(f.app.url + '/api/imports', { headers: { Authorization: `Bearer ${f.gmAuth.token}` } });
    assert.deepEqual((await importedList.json() as { imports: { sceneId: string }[] }).imports.map(x => x.sceneId), [imported.id]);
    const archive = await fetch(f.app.url + `/api/imports/${imported.id}/download`, { headers: { Authorization: `Bearer ${f.gmAuth.token}` } });
    assert.equal(archive.status, 200); assert.deepEqual(await archive.json(), document);
    assert.equal((await fetch(f.app.url + '/api/imports', { headers: { Authorization: `Bearer ${f.playerAuth.token}` } })).status, 403);
    assert.equal((await fetch(f.app.url + `/api/imports/${imported.id}/download`, { headers: { Authorization: `Bearer ${f.playerAuth.token}` } })).status, 403);
    assert.ok(!JSON.stringify(state).includes('originalUtf8Text'));
    const badImport = await f.gm.command('scene.import', { document: { schemaVersion: 'invalid' } }); assert.equal(badImport.ok, false);
    const listAfterFailure = await fetch(f.app.url + '/api/imports', { headers: { Authorization: `Bearer ${f.gmAuth.token}` } });
    assert.equal((await listAfterFailure.json() as { imports: unknown[] }).imports.length, 1);
    await assertOK(f.gm, 'scene.activate', { id: firstScene });
  } finally { await f.cleanup(); }
});

test('database reopen and WebSocket reconnect preserve hashed sessions, command results and campaign', async () => {
  const f = await setup(); let reopened: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const id = randomUUID(); const revision = await assertOK(f.gm, 'chat.send', { text: 'Durable event' }, { id });
    f.gm.close(); f.player.close(); f.other.close(); await f.app.close();
    reopened = await startServer({ port: 0, dbPath: f.dbPath });
    const [gm, player] = await Promise.all([Client.connect(reopened.url, f.gmAuth.token), Client.connect(reopened.url, f.playerAuth.token)]);
    try {
      const latest = await player.snapshot(revision); assert.equal(latest.campaign.chat.filter(m => m.text === 'Durable event').length, 1);
      const repeat = await gm.command('chat.send', { text: 'Durable event' }, { id }); assert.equal(repeat.revision, revision);
      assert.equal((await snapshot(reopened.url, f.gmAuth.token)).campaign.revision, revision);
      const bytes = await readFile(f.dbPath); assert.equal(bytes.includes(Buffer.from(f.gmAuth.token)), false); assert.equal(bytes.includes(Buffer.from(f.playerAuth.token)), false);
    } finally { gm.close(); player.close(); }
  } finally {
    if (reopened) await reopened.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('two simultaneous clients cannot overwrite one revision, and revoked owners lose control immediately', async () => {
  const f = await setup();
  try {
    const initial = await snapshot(f.app.url, f.gmAuth.token), revision = initial.campaign.revision;
    const results = await Promise.all([
      f.gm.command('chat.send', { text: 'GM competing write' }, { expectedRevision: revision }),
      f.player.command('chat.send', { text: 'Player competing write' }, { expectedRevision: revision })
    ]);
    assert.equal(results.filter(r => r.ok).length, 1); assert.equal(results.filter(r => r.code === 'CONFLICT').length, 1);
    const current = await snapshot(f.app.url, f.gmAuth.token); assert.equal(current.campaign.revision, revision + 1); assert.equal(current.campaign.chat.length, 1);
    const token = initial.campaign.scenes[0].tokens[0];
    await assertOK(f.gm, 'token.update', { id: token.id, owners: [f.playerAuth.memberId] });
    await assertOK(f.player, 'token.move', { id: token.id, x: 450, y: 350 });
    await assertOK(f.gm, 'token.update', { id: token.id, owners: [f.gmAuth.memberId] });
    assert.equal((await f.player.command('token.move', { id: token.id, x: 500, y: 350 })).code, 'FORBIDDEN');
    const wall = initial.campaign.scenes[0].walls.find(w => w.kind === 'door')!;
    const secretRevision = await assertOK(f.gm, 'wall.update', { id: wall.id, kind: 'secret' });
    const projected = await f.player.snapshot(secretRevision);
    assert.equal(projected.campaign.scenes[0].walls.find(w => w.id === wall.id)?.kind, 'wall');
    assert.ok(!projected.campaign.scenes[0].walls.some(w => w.kind === 'secret'));
  } finally { await f.cleanup(); }
});

test('unauthenticated WebSocket commands and malformed REST inputs fail without creating a session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vtt-auth-test-'));
  const app = await startServer({ port: 0, dbPath: join(directory, 'test.sqlite') });
  const ws = new WebSocket(app.url.replace('http:', 'ws:') + '/ws');
  try {
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const response = new Promise<ServerMessage>(resolve => ws.once('message', raw => resolve(JSON.parse(raw.toString()))));
    ws.send(JSON.stringify({ type: 'command', command: { id: 'no-auth', type: 'scene.create', payload: { name: 'Unauthorized' } } }));
    assert.equal((await response).type, 'error');
    const malformed = await fetch(app.url + '/api/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }); assert.equal(malformed.status, 400);
    const absent = await fetch(app.url + '/api/snapshot', { headers: { Authorization: 'Bearer invalid-token-value-that-is-not-real' } }); assert.equal(absent.status, 401);
    const origin = await fetch(app.url + '/api/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://external.invalid' }, body: JSON.stringify({ name: 'A', gmName: 'B' }) }); assert.equal(origin.status, 403);
  } finally { ws.terminate(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('removing the current combatant chooses its successor without advancing the round, including token deletion', async () => {
  const f = await setup();
  try {
    const original = await f.gm.snapshot(), tokens = original.campaign.scenes[0].tokens;
    for (const token of tokens) await assertOK(f.gm, 'combat.add', { id: token.id });
    let state = await snapshot(f.app.url, f.gmAuth.token);
    const combatants = state.campaign.combat.combatants;
    await assertOK(f.gm, 'combat.next', {}); // Explicitly start at A.
    await assertOK(f.gm, 'combat.next', {}); // Current B.
    let revision = await assertOK(f.gm, 'combat.remove', { id: combatants[1].id });
    state = await f.gm.snapshot(revision);
    assert.equal(state.campaign.combat.combatants[state.campaign.combat.turn].id, combatants[2].id);
    assert.equal(state.campaign.combat.round, 1);
    revision = await assertOK(f.gm, 'token.delete', { id: tokens[2].id }); // Current last C -> wrap to A.
    state = await f.gm.snapshot(revision);
    assert.equal(state.campaign.combat.combatants[state.campaign.combat.turn].id, combatants[0].id);
    assert.equal(state.campaign.combat.round, 1);
    revision = await assertOK(f.gm, 'combat.remove', { id: combatants[0].id });
    state = await f.gm.snapshot(revision);
    const { active, round, turn, combatants: remaining } = state.campaign.combat;
    assert.deepEqual({ active, round, turn, combatants: remaining }, { active: false, round: 0, turn: 0, combatants: [] });
  } finally { await f.cleanup(); }
});

test('combat roster and initiative are preparation; explicit start selects the first sorted participant', async () => {
  const f = await setup();
  try {
    const initial = await f.gm.snapshot(), tokens = initial.campaign.scenes[0].tokens;
    assert.equal((await f.gm.command('combat.next', {})).code, 'VALIDATION');
    await assertOK(f.gm, 'combat.add', { id: tokens[0].id });
    let revision = await assertOK(f.gm, 'combat.add', { id: tokens[1].id });
    let state = await f.gm.snapshot(revision), roster = state.campaign.combat.combatants;
    assert.equal(state.campaign.combat.active, false); assert.equal(state.campaign.combat.round, 0);
    await assertOK(f.gm, 'combat.roll', { id: roster[0].id, formula: '10' });
    revision = await assertOK(f.gm, 'combat.roll', { id: roster[1].id, formula: '20' });
    state = await f.gm.snapshot(revision);
    assert.equal(state.campaign.combat.active, false); assert.equal(state.campaign.combat.round, 0);
    assert.equal(state.campaign.combat.combatants[0].id, roster[1].id);
    revision = await assertOK(f.gm, 'combat.next', {});
    state = await f.gm.snapshot(revision);
    assert.equal(state.campaign.combat.active, true); assert.equal(state.campaign.combat.round, 1);
    assert.equal(state.campaign.combat.combatants[state.campaign.combat.turn].id, roster[1].id);
    await assertOK(f.gm, 'combat.next', {});
    revision = await assertOK(f.gm, 'combat.add', { id: tokens[2].id });
    state = await f.gm.snapshot(revision);
    assert.equal(state.campaign.combat.active, true); assert.equal(state.campaign.combat.round, 1);
    assert.equal(state.campaign.combat.combatants[state.campaign.combat.turn].id, roster[0].id);
  } finally { await f.cleanup(); }
});
