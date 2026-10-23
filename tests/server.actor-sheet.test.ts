import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Store, type Session } from '../server/store.ts';
import { rollActorCheck } from '../server/engine.ts';
import { startServer } from '../server/app.ts';
import type { Actor, Command, ServerMessage } from '../shared/model.ts';

function fixture(path = ':memory:') {
  const store = new Store(path), gmAuth = store.create('Actor sheets', 'GM'), gm = store.authenticate(gmAuth.token);
  const invite = store.snapshot(gm).inviteCode!;
  const ownerAuth = store.join(invite, 'Owner'), owner = store.authenticate(ownerAuth.token);
  const otherAuth = store.join(invite, 'Other'), other = store.authenticate(otherAuth.token);
  const command = (session: Session, type: Command['type'], payload: Record<string, unknown>, options: Partial<Command> = {}) => store.command(session, { id: randomUUID(), type, payload, ...options }).ack;
  const ok = (session: Session, type: Command['type'], payload: Record<string, unknown>) => { const ack = command(session, type, payload); assert.equal(ack.ok, true, `${type}: ${ack.error}`); return ack; };
  ok(gm, 'actor.create', { name: 'Unplaced Hero', owners: [ownerAuth.memberId], hp: null, maxHp: null, sheetKind: 'dnd5e', abilities: { str: 16, dex: 9 } });
  const actorId = store.snapshot(gm).campaign.actors.find(a => a.name === 'Unplaced Hero')!.id;
  const actor = (session = gm) => store.snapshot(session).campaign.actors.find(a => a.id === actorId)!;
  return { store, gm, gmAuth, owner, ownerAuth, other, otherAuth, command, ok, actorId, actor };
}

test('owned unplaced Actor has a full sheet; visible foreign Actor exposes only a summary and revocation takes effect', () => {
  const f = fixture();
  try {
    assert.equal(f.actor(f.owner).sheetAccess, 'full'); assert.equal(f.actor(f.other), undefined);
    f.ok(f.owner, 'actor.update', { id: f.actorId, notes: 'private owner note', abilities: { wis: 14 } });
    f.ok(f.gm, 'actor.update', { id: f.actorId, gmNotes: 'GM secret' });
    f.ok(f.owner, 'actor.item.create', { id: f.actorId, name: 'Secret inventory item', quantity: 2 });
    f.ok(f.owner, 'actor.resource.create', { id: f.actorId, label: 'Secret pool', value: 2, max: 4 });
    f.ok(f.gm, 'actor.place', { id: f.actorId, x: 400, y: 500 });
    const summary = f.actor(f.other);
    assert.equal(summary.sheetAccess, 'summary'); assert.deepEqual(summary.items, []); assert.deepEqual(summary.resources, []);
    assert.equal(summary.abilities.str, null); assert.equal(summary.notes, ''); assert.equal(summary.gmNotes, '');
    assert.equal(f.actor(f.owner).items.length, 1); assert.equal(f.actor(f.owner).gmNotes, '');
    assert.equal(JSON.stringify(f.store.snapshot(f.other)).includes('Secret inventory item'), false);
    const itemId = f.actor().items[0].id;
    for (const [type, payload] of [
      ['actor.update', { id: f.actorId, owners: [f.otherAuth.memberId] }],
      ['actor.update', { id: f.actorId, sheetKind: 'generic' }],
      ['actor.update', { id: f.actorId, gmNotes: 'attack' }],
      ['actor.place', { id: f.actorId }],
    ] as [Command['type'], Record<string, unknown>][]) assert.equal(f.command(f.owner, type, payload).code, 'FORBIDDEN');
    assert.equal(f.command(f.other, 'actor.item.consume', { id: f.actorId, itemId, from: 'quantity' }).code, 'FORBIDDEN');
    assert.equal(f.command(f.other, 'actor.roll', { id: f.actorId, ability: 'str', role: 'gm' }).code, 'FORBIDDEN');
    f.ok(f.gm, 'actor.update', { id: f.actorId, owners: [] });
    assert.equal(f.actor(f.owner).sheetAccess, 'summary');
    assert.equal(f.command(f.owner, 'actor.item.update', { id: f.actorId, itemId, quantity: 9 }).code, 'FORBIDDEN');
  } finally { f.store.close(); }
});

test('inventory CRUD preserves independent quantities and charges; explicit consume never removes depleted items', () => {
  const f = fixture();
  try {
    f.ok(f.owner, 'actor.item.create', { id: f.actorId, name: 'Lantern', type: 'equipment', quantity: 3, weight: 0.5, weightUnit: 'lb', description: 'Manual item', uses: { value: 3, max: 4 } });
    const itemId = f.actor().items[0].id;
    f.ok(f.owner, 'actor.item.update', { id: f.actorId, itemId, equipped: true });
    f.ok(f.owner, 'actor.item.consume', { id: f.actorId, itemId, from: 'uses', amount: 3 });
    assert.equal(f.actor().items[0].quantity, 3); assert.equal(f.actor().items[0].uses!.value, 0);
    assert.equal(f.command(f.owner, 'actor.item.consume', { id: f.actorId, itemId, from: 'uses' }).code, 'INSUFFICIENT');
    f.ok(f.owner, 'actor.item.consume', { id: f.actorId, itemId, from: 'quantity', amount: 3 });
    assert.equal(f.actor().items.length, 1); assert.equal(f.actor().items[0].quantity, 0);
    assert.equal(f.command(f.owner, 'actor.item.consume', { id: f.actorId, itemId, from: 'quantity' }).code, 'INSUFFICIENT');
    f.ok(f.owner, 'actor.item.update', { id: f.actorId, itemId, uses: null });
    assert.equal(f.actor().items[0].uses, undefined);
    assert.equal(f.command(f.owner, 'actor.item.consume', { id: f.actorId, itemId, from: 'uses' }).code, 'INSUFFICIENT');
    f.ok(f.owner, 'actor.item.delete', { id: f.actorId, itemId }); assert.equal(f.actor().items.length, 0);
  } finally { f.store.close(); }
});

test('structured resources retain unknown values and reject partial invalid writes without changing HP', () => {
  const f = fixture();
  try {
    f.ok(f.owner, 'actor.resource.create', { id: f.actorId, label: 'Unknown pool' });
    const resourceId = f.actor().resources[0].id;
    assert.deepEqual(f.actor().resources[0], { id: resourceId, label: 'Unknown pool', value: null, max: null, kind: 'custom', level: null, unit: '', recovery: 'manual' });
    f.ok(f.owner, 'actor.resource.update', { id: f.actorId, resourceId, value: 1.5, max: 2 });
    const before = f.actor();
    assert.equal(f.command(f.owner, 'actor.resource.update', { id: f.actorId, resourceId, label: 'Must roll back', value: 3 }).code, 'VALIDATION');
    assert.deepEqual(f.actor(), before);
    assert.equal(f.command(f.owner, 'actor.update', { id: f.actorId, name: 'Must roll back', abilities: { str: 31 } }).code, 'VALIDATION');
    assert.equal(f.actor().name, 'Unplaced Hero'); assert.equal(f.actor().hp, null); assert.equal(f.actor().maxHp, null);
    f.ok(f.owner, 'actor.resource.update', { id: f.actorId, resourceId, value: null, max: 0 });
    assert.equal(f.actor().resources[0].value, null); assert.equal(f.actor().resources[0].max, 0);
    f.ok(f.owner, 'actor.resource.delete', { id: f.actorId, resourceId }); assert.equal(f.actor().resources.length, 0);
  } finally { f.store.close(); }
});

test('d20 selection is deterministic given draws, uses server scores, and does not infer generic or unknown ability rules', () => {
  const f = fixture();
  try {
    const actor = f.actor();
    for (const mode of ['normal', 'advantage', 'disadvantage'] as const) {
      const draws = [4, 18], roll = rollActorCheck(actor, { ability: 'str', mode }, () => draws.shift()!);
      assert.equal(roll.modifier, 3); assert.equal(roll.total, mode === 'advantage' ? 21 : 7);
      assert.deepEqual(roll.dice[0].values, mode === 'normal' ? [4] : [4, 18]);
      assert.equal(roll.d20!.keptIndex, mode === 'advantage' ? 1 : 0); assert.equal(roll.actor!.name, actor.name);
    }
    const dex = rollActorCheck(actor, { ability: 'dex' }, () => 10); assert.equal(dex.modifier, -1); assert.equal(dex.total, 9);
    assert.throws(() => rollActorCheck(actor, { ability: 'wis' }));
    assert.throws(() => rollActorCheck(actor, { ability: 'str', modifier: 999 }));
    const generic: Actor = { ...actor, sheetKind: 'generic' };
    assert.throws(() => rollActorCheck(generic, { ability: 'str' }));
    assert.equal(rollActorCheck(generic, { modifier: -2 }, () => 7).total, 5);
    assert.deepEqual(f.actor(), actor, 'rolls do not consume items or apply automatic effects');
  } finally { f.store.close(); }
});

test('consume and Actor rolls are idempotent; conflicting consumes cannot silently overwrite the same revision', () => {
  const f = fixture();
  try {
    f.ok(f.owner, 'actor.item.create', { id: f.actorId, name: 'Ammo', quantity: 2 });
    const itemId = f.actor().items[0].id, revision = f.store.snapshot(f.owner).campaign.revision;
    const command: Command = { id: randomUUID(), type: 'actor.item.consume', payload: { id: f.actorId, itemId, from: 'quantity' }, expectedRevision: revision };
    const first = f.store.command(f.owner, command).ack; assert.equal(first.ok, true);
    assert.deepEqual(f.store.command(f.owner, command).ack, first); assert.equal(f.actor().items[0].quantity, 1);
    assert.equal(f.command(f.gm, 'actor.item.consume', command.payload, { expectedRevision: revision }).code, 'CONFLICT');
    assert.equal(f.actor().items[0].quantity, 1);
    const roll: Command = { id: randomUUID(), type: 'actor.roll', payload: { id: f.actorId, ability: 'str', mode: 'advantage', visibility: 'self' } };
    assert.equal(f.store.command(f.owner, roll).ack.ok, true);
    const chat = f.store.snapshot(f.owner).campaign.chat;
    assert.equal(f.store.command(f.owner, roll).ack.ok, true); assert.deepEqual(f.store.snapshot(f.owner).campaign.chat, chat);
    assert.equal(chat.length, 1); assert.equal(chat[0].text, 'Unplaced Hero · Strength');
    assert.equal(f.store.snapshot(f.other).campaign.chat.length, 0); assert.equal(f.store.snapshot(f.gm).campaign.chat.length, 0);
  } finally { f.store.close(); }
});

test('legacy SQLite campaigns receive neutral sheet defaults and persist new inventory across reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vtt-actor-migration-')), path = join(directory, 'test.sqlite');
  let store: Store | undefined;
  try {
    const f = fixture(path), auth = f.gmAuth, campaign = f.store.export(f.gm);
    for (const actor of campaign.actors) { for (const key of ['sheetKind', 'abilities', 'items', 'resources', 'sheetAccess']) delete (actor as unknown as Record<string, unknown>)[key]; }
    f.store.close();
    const db = new DatabaseSync(path); db.prepare('UPDATE campaigns SET document=? WHERE id=?').run(JSON.stringify(campaign), campaign.id); db.close();
    store = new Store(path); let session = store.authenticate(auth.token), actor = store.snapshot(session).campaign.actors.find(a => a.id === f.actorId)!;
    assert.equal(actor.sheetKind, 'generic'); assert.equal(actor.hp, null); assert.equal(actor.abilities.str, null); assert.deepEqual(actor.items, []);
    assert.equal(store.command(session, { id: randomUUID(), type: 'actor.item.create', payload: { id: actor.id, name: 'Persistent item', quantity: 4, uses: { value: 2, max: 3 } } }).ack.ok, true);
    store.close(); store = new Store(path); session = store.authenticate(auth.token); actor = store.snapshot(session).campaign.actors.find(a => a.id === f.actorId)!;
    assert.equal(actor.items[0].quantity, 4); assert.equal(actor.items[0].uses!.value, 2); assert.equal(actor.abilities.str, null);
    assert.equal(store.export(session).actors[0].sheetAccess, undefined, 'projection access flags are never stored as authority');
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('two real WebSocket clients receive public Actor checks but foreign clients cannot invoke them', async () => {
  const app = await startServer({ port: 0, dbPath: ':memory:' });
  const sockets: WebSocket[] = [];
  try {
    const gmAuth = app.store.create('Actor socket', 'GM'), gm = app.store.authenticate(gmAuth.token), invite = app.store.snapshot(gm).inviteCode!;
    const ownerAuth = app.store.join(invite, 'Owner'), otherAuth = app.store.join(invite, 'Other');
    assert.equal(app.store.command(gm, { id: randomUUID(), type: 'actor.create', payload: { name: 'Socket Hero', owners: [ownerAuth.memberId], sheetKind: 'dnd5e', abilities: { str: 16 } } }).ack.ok, true);
    const actorId = app.store.snapshot(gm).campaign.actors.find(a => a.name === 'Socket Hero')!.id;
    async function connect(token: string) {
      const ws = new WebSocket(app.url.replace('http:', 'ws:') + '/ws'); sockets.push(ws);
      const messages: ServerMessage[] = [], wakes = new Set<() => void>();
      ws.on('message', data => { messages.push(JSON.parse(data.toString())); wakes.forEach(w => w()); });
      const wait = (predicate: (m: ServerMessage) => boolean) => new Promise<ServerMessage>((resolve, reject) => {
        const timer = setTimeout(() => { wakes.delete(check); reject(new Error('message timeout')); }, 5000);
        const check = () => { const value = messages.find(predicate); if (value) { clearTimeout(timer); wakes.delete(check); resolve(value); } };
        wakes.add(check); check();
      });
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      ws.send(JSON.stringify({ type: 'auth', token })); await wait(m => m.type === 'snapshot');
      return { ws, wait };
    }
    const [owner, other] = await Promise.all([connect(ownerAuth.token), connect(otherAuth.token)]);
    const id = randomUUID(); owner.ws.send(JSON.stringify({ type: 'command', command: { id, type: 'actor.roll', payload: { id: actorId, ability: 'str', mode: 'advantage' } } }));
    const ack = await owner.wait(m => m.type === 'ack' && m.id === id); assert.equal(ack.type === 'ack' && ack.ok, true);
    const message = await other.wait(m => m.type === 'snapshot' && m.data.campaign.chat.length === 1);
    assert.equal(message.type, 'snapshot'); if (message.type !== 'snapshot') return;
    const roll = message.data.campaign.chat[0].roll!;
    assert.equal(roll.actor!.name, 'Socket Hero'); assert.equal(roll.dice[0].values.length, 2); assert.equal(roll.total, Math.max(...roll.dice[0].values) + 3);
    assert.equal(message.data.campaign.actors.some(a => a.id === actorId), false, 'public roll does not expose the private sheet');
    const deniedId = randomUUID(); other.ws.send(JSON.stringify({ type: 'command', command: { id: deniedId, type: 'actor.roll', payload: { id: actorId, modifier: 50 } } }));
    const denied = await other.wait(m => m.type === 'ack' && m.id === deniedId); assert.equal(denied.type === 'ack' && denied.code, 'FORBIDDEN');
  } finally { sockets.forEach(s => s.terminate()); await app.close(); }
});
