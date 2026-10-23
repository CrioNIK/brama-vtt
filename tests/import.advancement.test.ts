import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { importNeutralScene, SceneImportError } from '../shared/import.ts';
import { previewCheck } from '../shared/checks.ts';
import { Store, type Session } from '../server/store.ts';
import type { Command } from '../shared/model.ts';

// These regression bundles use synthetic archive envelopes. Mutations exercise validation;
// they do not constitute live interoperability tests.
function document(stage = 'runtime-compatible') {
  return JSON.parse(readFileSync(new URL(`./fixtures/advancement/${stage}.json`, import.meta.url), 'utf8'));
}
function fixture() {
  const store = new Store(':memory:'), auth = store.create('Advancement import review', 'GM'), gm = store.authenticate(auth.token);
  const invite = store.snapshot(gm).inviteCode!, ownerAuth = store.join(invite, 'Owner'), foreignAuth = store.join(invite, 'Other');
  const owner = store.authenticate(ownerAuth.token), foreign = store.authenticate(foreignAuth.token);
  const state = () => store.export(gm);
  const command = (session: Session, type: Command['type'], payload: Record<string, unknown>) => store.command(session, { id: randomUUID(), type, payload, expectedRevision: state().revision }).ack;
  const ok = (session: Session, type: Command['type'], payload: Record<string, unknown>) => { const ack = command(session, type, payload); assert.equal(ack.ok, true, `${ack.code}: ${ack.error}`); return ack; };
  return { store, auth, gm, ownerAuth, owner, foreignAuth, foreign, state, command, ok };
}

test('0.8 baseline and cancelled snapshots preserve empty evidence and archived bytes', () => {
  const before = document('baseline'), cancelled = document('cancelled');
  assert.deepEqual(before, cancelled);
  for (const value of [before, cancelled]) {
    const unchanged = structuredClone(value), result = importNeutralScene(value), actor = result.actors[0];
    assert.equal(actor.name, 'Research Advancement Hero'); assert.equal(result.scene.tokens.length, 0);
    assert.deepEqual(actor.observedAdvancement, { classes: [], steps: [], grantCount: 0, issueCount: 0 });
    assert.deepEqual(actor.source!.advancementEvidence, value.actors[0].advancementEvidence);
    assert.equal(actor.progression, undefined); assert.equal(actor.hp, null); assert.equal(actor.maxHp, null);
    assert.deepEqual(value, unchanged);
    const native = readFileSync(new URL('./fixtures/advancement/actor-baseline.json', import.meta.url), 'utf8');
    assert.equal(value.provenance.additionalSources[0].originalUtf8Text, native);
  }
});

test('fixture: active Fighter Item effects still block import atomically instead of being discarded', () => {
  const f = fixture();
  try {
    for (const stage of ['fighter-level1', 'level2-cancelled', 'fighter-level2']) {
      const value = document(stage); assert.throws(() => importNeutralScene(value), /Unsupported active or indeterminate effect/i);
      const before = f.state(), archives = f.store.imports(f.gm);
      assert.equal(f.command(f.gm, 'scene.import', { document: value }).ok, false);
      assert.deepEqual(f.state(), before); assert.deepEqual(f.store.imports(f.gm), archives);
    }
  } finally { f.store.close(); }
});

test('fixture: compatible Fighter imports current values without replaying native grants or derived HP', () => {
  const value = document(), input = structuredClone(value), result = importNeutralScene(value), actor = result.actors[0];
  assert.deepEqual(actor.abilities, value.actors[0].sheet.abilities);
  assert.deepEqual(actor.abilities, { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 });
  assert.equal(actor.hp, null); assert.equal(actor.maxHp, null); assert.equal(actor.progression, undefined);
  assert.deepEqual(actor.items, []); assert.deepEqual(actor.actions, []); assert.deepEqual(actor.effects, []);
  assert.equal(actor.resources.length, 9); assert.ok(actor.resources.every(r => r.kind === 'spell-slot' && r.value === 0 && r.max === null));
  assert.equal(previewCheck(actor, { kind: 'skill', key: 'ath' }).modifier, 2);
  assert.equal(previewCheck(actor, { kind: 'skill', key: 'prc' }).modifier, 2);
  assert.equal(previewCheck(actor, { kind: 'save', key: 'str' }).modifier, 2);
  const graph = actor.source!.advancementEvidence!;
  assert.deepEqual(graph.history, []); assert.equal(graph.steps.length, 31);
  assert.equal(graph.observedGrants.filter(g => g.confidence === 'confirmed').length, 6);
  const missing = graph.observedGrants.find(g => g.materialization === 'unresolved')!;
  assert.equal(missing.sourceTargetItemId, 'RJmjrJu5Bzfhg8uq'); assert.equal(missing.evidence, 'value-only');
  assert.deepEqual(missing.normalizedTargets, []); assert.equal(missing.targetName, null);
  assert.deepEqual(actor.observedAdvancement!.classes, [{ name: 'Fighter', levels: 2 }]);
  assert.equal(actor.observedAdvancement!.grantCount, 7); assert.equal(actor.observedAdvancement!.issueCount, 1);
  assert.ok(result.warnings.some(w => /observations, not a completed build/.test(w)));
  assert.ok(result.warnings.some(w => /disabled/i.test(w))); assert.deepEqual(value, input);
});

test('Store keeps original 0.8 archive and raw refs GM-only, owner whitelist, and no fabricated progression history', () => {
  const f = fixture();
  try {
    const value = document(); f.ok(f.gm, 'scene.import', { document: value });
    const imported = f.state().actors.find(a => a.source?.sourceActorRef === value.actors[0].sourceActorRef)!;
    assert.deepEqual(imported.owners, [f.auth.memberId]); assert.notEqual(imported.id, value.actors[0].id);
    assert.deepEqual(f.state().progressionCommits, []); assert.deepEqual(f.state().progressionProfiles, []);
    const sceneId = f.state().activeSceneId;
    assert.deepEqual(f.store.importArchive(f.gm, sceneId), value);
    f.ok(f.gm, 'actor.update', { id: imported.id, owners: [f.ownerAuth.memberId] });
    f.ok(f.gm, 'scene.update', { id: sceneId, visionEnabled: false });
    f.ok(f.gm, 'token.create', { actorId: imported.id, linked: true, x: 300, y: 300, owners: [f.ownerAuth.memberId] });
    const gmActor = f.store.snapshot(f.gm).campaign.actors.find(a => a.id === imported.id)!;
    assert.deepEqual(gmActor.source!.advancementEvidence, value.actors[0].advancementEvidence);
    const ownerActor = f.store.snapshot(f.owner).campaign.actors.find(a => a.id === imported.id)!;
    assert.equal(ownerActor.source, undefined); assert.equal(ownerActor.sheetAccess, 'full');
    assert.deepEqual(ownerActor.observedAdvancement, imported.observedAdvancement);
    const ownerText = JSON.stringify(ownerActor);
    for (const privateText of ['JecbWqDJnxH9j5XH', 'EmTANp6x6GfXFTmU', 'Compendium.', 'sourcePath', 'configuration', 'originalUtf8Text']) assert.equal(ownerText.includes(privateText), false, privateText);
    const foreignActor = f.store.snapshot(f.foreign).campaign.actors.find(a => a.id === imported.id)!;
    assert.equal(foreignActor.sheetAccess, 'summary'); assert.equal(foreignActor.observedAdvancement, undefined); assert.equal(foreignActor.source, undefined);
    assert.throws(() => f.store.importArchive(f.owner, sceneId), /Only the GM can export/);
    assert.throws(() => f.store.imports(f.foreign), /Only the GM can export/);
    const unchanged = f.state();
    for (const session of [f.gm, f.owner]) assert.equal(f.command(session, 'actor.update', { id: imported.id, observedAdvancement: { grantCount: 999 } }).ok, false);
    assert.deepEqual(f.state(), unchanged);
    f.ok(f.gm, 'scene.import', { document: value });
    assert.equal(new Set(f.state().actors.filter(a => a.source?.sourceActorRef === value.actors[0].sourceActorRef).map(a => a.id)).size, 2);
    assert.deepEqual(f.state().progressionCommits, []);
  } finally { f.store.close(); }
});

test('strict advancement shape rejects fabricated history, extra fields, wrong version and malformed identity', () => {
  const mutations: ((g: any) => void)[] = [
    g => { g.history.push({ event: 'imaginary commit' }); }, g => { g.exec = 'run()'; },
    g => { delete g.classes; }, g => { g.profile = 'executable-grants'; },
    g => { g.classes[0].levels = 1.5; }, g => { g.classes[0].levels = 1001; },
    g => { g.classes[0].sourceItemId = ''; }, g => { g.steps[0].sourceAdvancementId = '\u0000'; },
    g => { g.steps[0].support = 'applied'; }, g => { g.steps[0].configuration = []; },
  ];
  for (const mutate of mutations) { const value = document(); mutate(value.actors[0].advancementEvidence); assert.throws(() => importNeutralScene(value), SceneImportError); }
  const value = document(); value.schemaVersion = '0.7.0'; assert.throws(() => importNeutralScene(value), SceneImportError);
  delete value.actors[0].advancementEvidence; assert.equal(importNeutralScene(value).actors[0].observedAdvancement, undefined);
});

test('duplicate source identities and dangling graph/normalized refs reject instead of creating phantom targets', () => {
  const mutations: ((g: any) => void)[] = [
    g => { g.classes.push({ ...g.classes[0] }); },
    g => { g.classes.push({ ...g.classes[0], id: 'other-class' }); },
    g => { g.steps.push({ ...g.steps[0], id: 'other-step' }); },
    g => { g.steps[0].classId = 'absent'; }, g => { g.steps[0].sourceItemId = 'wrong-parent'; },
    g => { g.observedGrants[0].stepId = 'absent'; },
    g => { g.observedGrants.push({ ...g.observedGrants[0] }); },
    g => { g.observedGrants[0].normalizedTargets = [{ kind: 'item', id: 'native-feature-not-normalized' }]; },
    g => { g.observedGrants[0].evidence = 'origin-only'; },
    g => { g.observedGrants[0].materialization = 'unresolved'; },
    g => { g.observedGrants[0].confidence = 'conflict'; },
  ];
  for (const mutate of mutations) { const value = document(); mutate(value.actors[0].advancementEvidence); assert.throws(() => importNeutralScene(value), SceneImportError); }
});

test('raw evidence JSON has finite-number, node, depth and UTF16 bounds without evaluation', () => {
  const nested: any = {}; let child = nested; for (let i = 0; i < 32; ++i) { child.next = {}; child = child.next; }
  for (const raw of [{ number: Infinity }, { number: NaN }, { many: Array(10001).fill(null) }, { s: 'x'.repeat(20001) }, { s: '😀'.repeat(10001) }, { s: '\u0001' }, nested, null, []]) {
    const value = document(); value.actors[0].advancementEvidence.steps[0].configuration = raw;
    assert.throws(() => importNeutralScene(value), SceneImportError);
  }
  const value = document(), raw = JSON.parse('{"__proto__":{"polluted":"sentinel"},"script":"globalThis.__advancementExecuted = true","html":"<script>run()</script>","empty":""}');
  value.actors[0].advancementEvidence.steps[0].configuration = raw;
  const actor = importNeutralScene(value).actors[0];
  assert.deepEqual(actor.source!.advancementEvidence!.steps[0].configuration, raw);
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
  assert.equal(Object.hasOwn(globalThis, '__advancementExecuted'), false);
  assert.equal(JSON.stringify(actor.observedAdvancement).includes('script'), false);
});

test('synthetic ASI evidence is retained but never adds or subtracts already materialized ability scores', () => {
  const value = document(), graph = value.actors[0].advancementEvidence;
  const asi = graph.steps.find((s: any) => s.type === 'AbilityScoreImprovement');
  assert.ok(asi); asi.value = { type: 'asi', assignments: { int: 2 } };
  value.actors[0].sheet.abilities.int = 16;
  const actor = importNeutralScene(value).actors[0];
  assert.equal(actor.abilities.int, 16); assert.equal(actor.progression, undefined);
  assert.deepEqual(actor.source!.advancementEvidence!.steps.find(s => s.id === asi.id)!.value, asi.value);
});

test('malformed evidence import is atomic for campaign, source archive and all progression receipts', () => {
  const f = fixture();
  try {
    const value = document(); value.actors[0].advancementEvidence.history = [{ when: 'invented' }];
    const before = f.state(), archives = f.store.imports(f.gm);
    assert.equal(f.command(f.gm, 'scene.import', { document: value }).ok, false);
    assert.deepEqual(f.state(), before); assert.deepEqual(f.store.imports(f.gm), archives);
    assert.equal(f.command(f.owner, 'scene.import', { document: document() }).ok, false);
    assert.deepEqual(f.state(), before);
  } finally { f.store.close(); }
});
