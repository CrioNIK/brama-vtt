import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { Store, type Session } from '../server/store.ts';
import { startServer } from '../server/app.ts';
import { rollActorCheck } from '../server/engine.ts';
import { abilityBreakdown, effectiveAbilityScores } from '../shared/abilities.ts';
import { importNeutralScene, SceneImportError } from '../shared/import.ts';
import type { Command, ServerMessage } from '../shared/model.ts';

const nativeBundle = (state: 'enabled' | 'disabled') => JSON.parse(readFileSync(new URL(`./fixtures/effects-${state}.json`, import.meta.url), 'utf8'));
const change = (value = 2) => ({ ability: 'str', mode: 'add', value });
function fixture(path = ':memory:') {
  const store = new Store(path), gmAuth = store.create('Effects', 'GM'), gm = store.authenticate(gmAuth.token), invite = store.snapshot(gm).inviteCode!;
  const ownerAuth = store.join(invite, 'Owner'), owner = store.authenticate(ownerAuth.token), otherAuth = store.join(invite, 'Other'), other = store.authenticate(otherAuth.token);
  const command = (session: Session, type: Command['type'], payload: Record<string, unknown>, extra: Partial<Command> = {}) => store.command(session, { id: randomUUID(), type, payload, ...extra }).ack;
  const ok = (session: Session, type: Command['type'], payload: Record<string, unknown>) => { const ack = command(session, type, payload); assert.equal(ack.ok, true, ack.error); return ack; };
  ok(gm, 'actor.create', { name: 'Effects Hero', owners: [ownerAuth.memberId], sheetKind: 'dnd5e', hp: 7, maxHp: 10, abilities: { str: 10, dex: 11 } });
  const id = store.snapshot(gm).campaign.actors.find(a => a.name === 'Effects Hero')!.id;
  const actor = (session = gm) => store.snapshot(session).campaign.actors.find(a => a.id === id)!;
  return { store, gmAuth, gm, ownerAuth, owner, otherAuth, other, command, ok, id, actor };
}

test('additive effects derive independently from base scores, preserve unknowns and provide a copied breakdown', () => {
  const f = fixture();
  try {
    f.ok(f.owner, 'actor.effect.create', { id: f.id, name: 'Strength', changes: [change(2), { ability: 'wis', mode: 'add', value: 5 }], duration: { rounds: 2, seconds: null } });
    f.ok(f.owner, 'actor.effect.create', { id: f.id, name: 'Fractional penalty', changes: [change(-0.5)] });
    const actor = f.actor(), before = JSON.stringify(actor), derived = effectiveAbilityScores(actor), detail = abilityBreakdown(actor, 'str');
    assert.equal(actor.abilities.str, 10); assert.equal(derived.str, 11.5); assert.equal(derived.wis, null);
    assert.equal(detail.totalBonus, 1.5); assert.equal(detail.modifier, 0); assert.equal(detail.contributions.length, 2);
    detail.contributions[0].effectName = 'Mutated copy'; assert.equal(JSON.stringify(actor), before);
    f.ok(f.owner, 'actor.effect.update', { id: f.id, effectId: actor.effects[0].id, disabled: true, duration: null });
    assert.equal(effectiveAbilityScores(f.actor()).str, 9.5); assert.equal(f.actor().effects[0].duration, undefined);
    assert.equal(f.actor().abilities.str, 10); assert.equal(f.actor().hp, 7);
    assert.throws(() => rollActorCheck(f.actor(), { ability: 'wis' }));
    f.ok(f.owner, 'actor.effect.delete', { id: f.id, effectId: actor.effects[1].id }); assert.equal(effectiveAbilityScores(f.actor()).str, 10);
  } finally { f.store.close(); }
});

test('effect writes enforce owner authority, strict subset, finite bounds and atomic rollback without clamping', () => {
  const f = fixture();
  try {
    assert.equal(f.command(f.other, 'actor.effect.create', { id: f.id, changes: [change()], role: 'gm' }).code, 'FORBIDDEN');
    f.ok(f.owner, 'actor.effect.create', { id: f.id, name: 'Bounded', changes: [change()] }); const effectId = f.actor().effects[0].id;
    const before = f.store.export(f.gm);
    for (const payload of [
      { changes: [] }, { changes: [change(101)] }, { changes: [change(Infinity)] }, { changes: [{ ...change(), mode: 'multiply' }] },
      { changes: [{ ...change(), formula: '1d20' }] }, { changes: [{ ...change(), ability: 'hp' }] },
      { duration: { rounds: 1, seconds: 2 } }, { duration: { rounds: 1.5, seconds: null } }, { conditions: '{}' },
      { changes: Array.from({ length: 10 }, () => change(100)) },
    ]) { assert.equal(f.command(f.owner, 'actor.effect.update', { id: f.id, effectId, name: 'Must roll back', ...payload }).code, 'VALIDATION'); assert.deepEqual(f.store.export(f.gm), before); }
    assert.equal(f.command(f.owner, 'actor.update', { id: f.id, effects: [] }).code, 'VALIDATION');
    f.ok(f.owner, 'actor.effect.update', { id: f.id, effectId, changes: Array.from({ length: 10 }, () => change(99)) });
    assert.equal(effectiveAbilityScores(f.actor()).str, 1000);
    const bounded = f.actor(); assert.equal(f.command(f.owner, 'actor.update', { id: f.id, abilities: { str: 11 } }).code, 'VALIDATION'); assert.deepEqual(f.actor(), bounded);
    assert.equal(rollActorCheck(f.actor(), { ability: 'str' }, () => 1).modifier, 495);
    f.ok(f.owner, 'actor.effect.update', { id: f.id, effectId, changes: [...Array.from({ length: 10 }, () => change(-100)), change(-10)] });
    assert.equal(effectiveAbilityScores(f.actor()).str, -1000); assert.equal(rollActorCheck(f.actor(), { ability: 'str' }, () => 1).modifier, -505);
    assert.equal(f.command(f.owner, 'actor.effect.update', { id: f.id, effectId, changes: [...Array.from({ length: 10 }, () => change(-100)), change(-11)] }).code, 'VALIDATION');
    assert.equal(effectiveAbilityScores(f.actor()).str, -1000);
  } finally { f.store.close(); }
});

test('effect revision/idempotence and immutable roll provenance survive toggle; public projection protects private sheet details', () => {
  const f = fixture();
  try {
    f.ok(f.gm, 'actor.place', { id: f.id, x: 400, y: 500 });
    const revision = f.store.snapshot(f.owner).campaign.revision, id = randomUUID();
    const create: Command = { id, type: 'actor.effect.create', payload: { id: f.id, name: 'Secret source of bonus', changes: [change()] }, expectedRevision: revision };
    const first = f.store.command(f.owner, create).ack; assert.equal(first.ok, true); assert.deepEqual(f.store.command(f.owner, create).ack, first); assert.equal(f.actor().effects.length, 1);
    assert.equal(f.command(f.gm, 'actor.effect.delete', { id: f.id, effectId: f.actor().effects[0].id }, { expectedRevision: revision }).code, 'CONFLICT');
    const rollCommand: Command = { id: randomUUID(), type: 'actor.roll', payload: { id: f.id, ability: 'str', mode: 'advantage' } };
    assert.equal(f.store.command(f.owner, rollCommand).ack.ok, true);
    const history = f.store.snapshot(f.owner).campaign.chat[0].roll!, original = structuredClone(history);
    assert.equal(history.modifier, 1); assert.equal(history.abilitySnapshot!.base, 10); assert.equal(history.abilitySnapshot!.effective, 12);
    assert.equal(f.store.command(f.owner, rollCommand).ack.ok, true); assert.equal(f.store.snapshot(f.owner).campaign.chat.length, 1);
    f.ok(f.owner, 'actor.effect.update', { id: f.id, effectId: f.actor().effects[0].id, disabled: true, name: 'Renamed later' });
    assert.deepEqual(f.store.snapshot(f.owner).campaign.chat[0].roll, original); assert.equal(effectiveAbilityScores(f.actor()).str, 10);
    const foreign = f.store.snapshot(f.other); assert.deepEqual(f.actor(f.other).effects, []); assert.equal(foreign.campaign.chat[0].roll!.abilitySnapshot, undefined);
    assert.equal(JSON.stringify(foreign).includes('Secret source of bonus'), false); assert.equal(foreign.campaign.chat[0].roll!.modifier, 1);
    f.ok(f.gm, 'actor.update', { id: f.id, owners: [] }); assert.equal(f.actor(f.owner).sheetAccess, 'summary');
    assert.deepEqual(f.store.snapshot(f.owner).campaign.chat[0].roll!.abilitySnapshot, original.abilitySnapshot, 'author retains their already-published historical detail');
    assert.equal(f.command(f.owner, 'actor.effect.delete', { id: f.id, effectId: f.actor().effects[0].id }).code, 'FORBIDDEN');
  } finally { f.store.close(); }
});

test('legacy campaigns default to no effects and new definitions plus historical rolls persist across SQLite reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vtt-effects-')), path = join(directory, 'test.sqlite'); let store: Store | undefined;
  try {
    const f = fixture(path), raw = f.store.export(f.gm); for (const actor of raw.actors) delete (actor as unknown as Record<string, unknown>).effects;
    f.store.close(); const db = new DatabaseSync(path); db.prepare('UPDATE campaigns SET document=? WHERE id=?').run(JSON.stringify(raw), raw.id); db.close();
    store = new Store(path); let owner = store.authenticate(f.ownerAuth.token); assert.deepEqual(store.snapshot(owner).campaign.actors.find(a => a.id === f.id)!.effects, []);
    const create: Command = { id: randomUUID(), type: 'actor.effect.create', payload: { id: f.id, name: 'Persistent', changes: [change()], duration: { rounds: null, seconds: 0 } } };
    assert.equal(store.command(owner, create).ack.ok, true); assert.equal(store.command(owner, { id: randomUUID(), type: 'actor.roll', payload: { id: f.id, ability: 'str' } }).ack.ok, true);
    const before = store.snapshot(owner); store.close(); store = new Store(path); owner = store.authenticate(f.ownerAuth.token);
    assert.deepEqual(store.snapshot(owner), before); assert.equal(store.command(owner, create).ack.ok, true);
    assert.equal(store.snapshot(owner).campaign.actors.find(a => a.id === f.id)!.effects.length, 1, 'idempotency is persisted across restart');
    assert.equal(effectiveAbilityScores(store.snapshot(owner).campaign.actors.find(a => a.id === f.id)!).str, 12, 'zero duration is metadata, not automatic expiry');
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('fixture: enabled/disabled bridge0.5 fixtures preserve base10, derive12/10, metadata and fresh runtime IDs', () => {
  for (const state of ['enabled', 'disabled'] as const) {
    const document = nativeBundle(state), before = JSON.stringify(document), first = importNeutralScene(document), second = importNeutralScene(document), actor = first.actors[0];
    assert.equal(actor.abilities.str, 10); assert.equal(actor.hp, 7); assert.equal(actor.maxHp, 10); assert.equal(actor.effects.length, 1);
    assert.equal(actor.effects[0].disabled, state === 'disabled'); assert.deepEqual(actor.effects[0].duration, { rounds: 2, seconds: null });
    assert.equal(effectiveAbilityScores(actor).str, state === 'enabled' ? 12 : 10); assert.equal(actor.items.length, 2);
    assert.equal(first.sheetSummary.effects, 1); assert.equal(first.sheetSummary.activeEffects, state === 'enabled' ? 1 : 0);
    assert.notEqual(actor.id, second.actors[0].id); assert.notEqual(actor.effects[0].id, second.actors[0].effects[0].id);
    assert.equal(actor.source!.effectRefs![0].sourceEffectId, '80pSNcmRFWTtIGwr'); assert.equal(actor.source!.effectRefs![0].effectId, actor.effects[0].id);
    assert.equal(JSON.stringify(document), before); assert.ok(first.warnings.some(w => w.includes('automatic expiry')));
  }
});

test('unsupported active/unknown effects block import; disabled unsupported effects are explicit losses, and malformed supported effects never partially apply', () => {
  const unsupported = { sourceEffectId: 'unsupported-source', name: 'Unmapped condition', disabled: false, reason: 'Conditional effect is unsupported' };
  for (const disabled of [false, null]) {
    const document = nativeBundle('disabled'); document.actors[0].sheet.effectsUnsupported = [{ ...unsupported, disabled }];
    assert.throws(() => importNeutralScene(document), /Unsupported active or indeterminate effect/);
  }
  const document = nativeBundle('disabled'); document.actors[0].sheet.effectsUnsupported = [{ ...unsupported, disabled: true }];
  const result = importNeutralScene(document); assert.equal(result.sheetSummary.unsupportedEffects, 1); assert.ok(result.warnings.some(w => w.includes('unsupported disabled effect')));
  const mutations = [
    (e: any) => { e.changes[0].value = '2'; }, (e: any) => { e.changes[0].phase = 'final'; }, (e: any) => { e.changes = []; },
    (e: any) => { e.changes[0].mode = 'override'; }, (e: any) => { e.changes[0].value = -101; },
    (e: any) => { e.duration = { rounds: 2, seconds: 1 }; }, (e: any) => { e.duration.expired = false; },
    (e: any) => { e.disabled = false; e.changes = Array.from({ length: 10 }, () => change(100)); },
  ];
  for (const mutate of mutations) { const doc = nativeBundle('disabled'); mutate(doc.actors[0].sheet.effects[0]); assert.throws(() => importNeutralScene(doc), SceneImportError); }
  const duplicate = nativeBundle('disabled'); duplicate.actors[0].sheet.effects.push(structuredClone(duplicate.actors[0].sheet.effects[0])); assert.throws(() => importNeutralScene(duplicate), /Duplicate effect/);
  const overflow = nativeBundle('disabled'); overflow.actors[0].sheet.effectsUnsupported = Array.from({ length: 100 }, (_, index) => ({ ...unsupported, sourceEffectId: `unsupported-${index}`, disabled: true }));
  assert.throws(() => importNeutralScene(overflow), /At most100/);
});

test('effect imports persist a GM-only original archive and source references; failed active-effect import leaves no scene or archive', () => {
  const f = fixture();
  try {
    const document = nativeBundle('enabled'); f.ok(f.gm, 'scene.import', { document });
    const sceneId = f.store.snapshot(f.gm).campaign.activeSceneId, actor = f.store.snapshot(f.gm).campaign.actors.find(a => a.source?.effectRefs?.length)!;
    f.ok(f.gm, 'actor.update', { id: actor.id, owners: [f.ownerAuth.memberId] }); f.ok(f.gm, 'scene.update', { id: sceneId, visionEnabled: false });
    const full = f.store.snapshot(f.owner), foreign = f.store.snapshot(f.other);
    assert.equal(full.campaign.actors.find(a => a.id === actor.id)!.effects.length, 1); assert.deepEqual(foreign.campaign.actors.find(a => a.id === actor.id)!.effects, []);
    assert.equal(JSON.stringify(full).includes('80pSNcmRFWTtIGwr'), false); assert.equal(JSON.stringify(foreign).includes('80pSNcmRFWTtIGwr'), false);
    f.ok(f.owner, 'actor.effect.update', { id: actor.id, effectId: actor.effects[0].id, disabled: true });
    assert.deepEqual(f.store.importArchive(f.gm, sceneId), document); assert.throws(() => f.store.importArchive(f.owner, sceneId));
    const before = f.store.export(f.gm), archives = f.store.imports(f.gm), invalid = nativeBundle('disabled');
    invalid.actors[0].sheet.effectsUnsupported = [{ sourceEffectId: null, name: null, disabled: null, reason: 'Unknown activation' }];
    assert.equal(f.command(f.gm, 'scene.import', { document: invalid }).ok, false); assert.deepEqual(f.store.export(f.gm), before); assert.deepEqual(f.store.imports(f.gm), archives);
  } finally { f.store.close(); }
});

test('two WebSocket clients observe effect projection; reconnect returns persisted latest state without exposing owner-only roll provenance', async () => {
  const app = await startServer({ port: 0, dbPath: ':memory:' }); const sockets: WebSocket[] = [];
  try {
    const gmAuth = app.store.create('Effects sockets', 'GM'), gm = app.store.authenticate(gmAuth.token), invite = app.store.snapshot(gm).inviteCode!;
    const ownerAuth = app.store.join(invite, 'Owner'), otherAuth = app.store.join(invite, 'Other');
    app.store.command(gm, { id: randomUUID(), type: 'actor.create', payload: { name: 'Socket Effect Hero', owners: [ownerAuth.memberId], sheetKind: 'dnd5e', abilities: { str: 10 } } });
    const id = app.store.snapshot(gm).campaign.actors.find(a => a.name === 'Socket Effect Hero')!.id;
    async function connect(token: string) {
      const ws = new WebSocket(app.url.replace('http:', 'ws:') + '/ws'); sockets.push(ws); const messages: ServerMessage[] = [], wakes = new Set<() => void>();
      ws.on('message', data => { messages.push(JSON.parse(data.toString())); wakes.forEach(w => w()); });
      const wait = (predicate: (m: ServerMessage) => boolean) => new Promise<ServerMessage>((resolve, reject) => {
        const timer = setTimeout(() => { wakes.delete(check); reject(new Error('WS timeout')); }, 5000);
        const check = () => { const value = messages.find(predicate); if (value) { clearTimeout(timer); wakes.delete(check); resolve(value); } }; wakes.add(check); check();
      });
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }); ws.send(JSON.stringify({ type: 'auth', token })); await wait(m => m.type === 'snapshot'); return { ws, wait };
    }
    const [owner, other] = await Promise.all([connect(ownerAuth.token), connect(otherAuth.token)]), createId = randomUUID();
    owner.ws.send(JSON.stringify({ type: 'command', command: { id: createId, type: 'actor.effect.create', payload: { id, name: 'Private effect', changes: [change()] } } }));
    assert.equal((await owner.wait(m => m.type === 'ack' && m.id === createId) as any).ok, true);
    const latest = await owner.wait(m => m.type === 'snapshot' && m.data.campaign.actors.some(a => a.id === id && a.effects.length === 1)); assert.equal(latest.type, 'snapshot');
    const rollId = randomUUID(); owner.ws.send(JSON.stringify({ type: 'command', command: { id: rollId, type: 'actor.roll', payload: { id, ability: 'str' } } }));
    const publicState = await other.wait(m => m.type === 'snapshot' && m.data.campaign.chat.length === 1); assert.equal(publicState.type, 'snapshot');
    if (publicState.type !== 'snapshot') return; assert.equal(publicState.data.campaign.chat[0].roll!.modifier, 1); assert.equal(publicState.data.campaign.chat[0].roll!.abilitySnapshot, undefined);
    owner.ws.terminate(); const reconnect = await connect(ownerAuth.token), resumed = await reconnect.wait(m => m.type === 'snapshot' && m.data.campaign.chat.length === 1);
    assert.equal(resumed.type, 'snapshot'); if (resumed.type !== 'snapshot') return;
    assert.equal(resumed.data.campaign.actors.find(a => a.id === id)!.effects.length, 1); assert.equal(resumed.data.campaign.chat[0].roll!.abilitySnapshot!.effective, 12);
  } finally { sockets.forEach(ws => ws.terminate()); await app.close(); }
});
