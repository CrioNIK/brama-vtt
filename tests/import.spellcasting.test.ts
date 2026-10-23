import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { importNeutralScene, SceneImportError } from '../shared/import.ts';
import { actionPreparation, previewAction, previewRecovery } from '../shared/actions.ts';
import { Store } from '../server/store.ts';
import type { CommandType } from '../shared/model.ts';

const bundle = (stage = 'ready') => JSON.parse(readFileSync(new URL(`./fixtures/spellcasting-${stage}.json`, import.meta.url), 'utf8'));

test('fixture: 0.6 ready/cast/final preserve one Spell, two Activities, shared slot and distinct inventory', () => {
  for (const stage of ['ready', 'cast', 'final']) {
    const document = bundle(stage), before = JSON.stringify(document), result = importNeutralScene(document), actor = result.actors[0];
    assert.equal(actor.spellcasting!.spells.length, 1); assert.equal(actor.actions.length, 2); assert.equal(actor.resources.length, 9);
    const spell = actor.spellcasting!.spells[0], slot = actor.resources.find(r => r.level === 1)!;
    assert.equal(spell.name, 'Research Spark'); assert.equal(spell.preparation, 'prepared'); assert.equal(spell.level, 1);
    assert.equal(slot.value, stage === 'ready' ? 2 : 1); assert.equal(slot.max, 2);
    assert.equal(actor.items.some(item => item.name === 'Research Spark'), false);
    assert.equal(result.sheetSummary.spells, 1); assert.equal(result.sheetSummary.activities, 2); assert.equal(result.sheetSummary.slotPools, 9);
    for (const action of actor.actions) {
      assert.equal(action.spellId, spell.id); assert.deepEqual(action.costs, [{ resourceId: slot.id, amount: 1 }]);
      assert.equal(actionPreparation(actor, action).prepared, true);
      assert.deepEqual(action.casting, { activation: { type: 'action' }, duration: { type: 'instantaneous' }, range: { type: 'distance', value: 30, unit: 'ft' }, target: { type: 'creature', count: 1, prompt: true } });
      assert.deepEqual(action.inheritance, { activation: 'item-merge', duration: 'item-merge', range: 'item-merge', target: 'item-merge' });
      assert.equal(action.target, 'none'); assert.equal(previewAction(actor, action, { memberId: 'gm', role: 'gm', visibleTokens: [] }).available, true);
      assert.ok(action.outcome.kind === 'damage' || action.outcome.kind === 'healing');
      assert.equal(action.outcome.parts[0].bonus, 0, 'GUI situational healing bonus10 is not imported as a definition');
      assert.equal(action.outcome.parts[0].number, 1); assert.equal(action.outcome.parts[0].denomination, 4);
    }
    assert.equal(JSON.stringify(document), before);
  }
});

test('fresh IDs remap both Activities and the one shared resource; native identities stay in source only', () => {
  const first = importNeutralScene(bundle()).actors[0], second = importNeutralScene(bundle()).actors[0];
  const firstIds = new Set([first.id, ...first.actions.map(a => a.id), ...first.resources.map(r => r.id), ...first.spellcasting!.spells.map(s => s.id)]);
  for (const id of [second.id, ...second.actions.map(a => a.id), ...second.resources.map(r => r.id), ...second.spellcasting!.spells.map(s => s.id)]) assert.equal(firstIds.has(id), false);
  assert.equal(first.source!.spellRefs![0].sourceItemId, 'EujxAdEYC7q5Pe1J');
  assert.equal(first.source!.activityRefs!.length, 2); assert.equal(first.source!.resourceRefs!.length, 9);
  const runtime = { ...first }; delete runtime.source;
  for (const identity of ['EujxAdEYC7q5Pe1J', 'izEAXHmC7gDegatu', 'gH2b11woFWT4IIj4', 'originalUtf8Text', 'sourcePath']) assert.equal(JSON.stringify(runtime).includes(identity), false);
});

test('unknown unused slot maxima remain null and recovery affects only explicit known maximum', () => {
  const actor = importNeutralScene(bundle('final')).actors[0];
  assert.deepEqual(actor.resources.filter(r => r.level !== 1).map(r => [r.value, r.max]), Array.from({ length: 8 }, () => [0, null]));
  const recovered = previewRecovery(actor, 'long-rest');
  assert.equal(recovered.changes.filter(c => c.applied).length, 1);
  assert.equal(recovered.changes.find(c => c.applied)!.after, 2);
  assert.equal(recovered.changes.filter(c => c.reason === 'unknown').length, 8);
  assert.equal(previewRecovery(actor, 'short-rest').available, false);
  const document = bundle(); document.actors[0].sheet.spellcasting.resources[0].value = null;
  const unknown = importNeutralScene(document).actors[0];
  assert.equal(previewAction(unknown, unknown.actions[0], { memberId: 'gm', role: 'gm', visibleTokens: [] }).available, false);
});

test('unsupported pact remains a blocked visible entry without a playable resource or action', () => {
  const actor = importNeutralScene(bundle()).actors[0];
  assert.equal(actor.spellcasting!.unsupported.length, 1);
  assert.equal(actor.spellcasting!.unsupported[0].kind, 'resource');
  assert.equal(actor.resources.some(resource => resource.label.toLowerCase().includes('pact')), false);
  assert.equal(actor.actions.length, 2);
});

test('fixture: range override changes Heal to self range without inventing self targeting', () => {
  const actor = importNeutralScene(bundle('range-override')).actors[0];
  const heal = actor.actions.find(a => a.outcome.kind === 'healing')!, damage = actor.actions.find(a => a.outcome.kind === 'damage')!;
  assert.deepEqual(heal.casting!.range, { type: 'self' }); assert.equal(heal.inheritance!.range, 'activity');
  assert.deepEqual(heal.casting!.target, { type: 'creature', count: 1, prompt: true }); assert.equal(heal.target, 'none');
  assert.deepEqual(damage.casting!.range, { type: 'distance', value: 30, unit: 'ft' }); assert.equal(damage.inheritance!.range, 'item-merge');
});

test('strict 0.6 validation rejects broken identity, inheritance, cost, context and outcome atomically', () => {
  const changes = [
    (d: any) => { d.schemaVersion = '0.5.0'; },
    (d: any) => { d.actors[0].systemVersion = '6.0.7'; },
    (d: any) => { d.actors[0].sheet.spellcasting.profile = 'full'; },
    (d: any) => { const s = d.actors[0].sheet.spellcasting; s.spells.push(structuredClone(s.spells[0])); },
    (d: any) => { const s = d.actors[0].sheet.spellcasting; s.activities[1].id = s.activities[0].id; },
    (d: any) => { const s = d.actors[0].sheet.spellcasting; s.activities[1].sourceActivityId = s.activities[0].sourceActivityId; },
    (d: any) => { d.actors[0].sheet.spellcasting.activities[0].spellId = 'missing'; },
    (d: any) => { const s = d.actors[0].sheet.spellcasting; s.activities[0].cost.resourceId = s.resources[1].id; },
    (d: any) => { d.actors[0].sheet.spellcasting.activities[0].cost.amount = 0; },
    (d: any) => { d.actors[0].sheet.spellcasting.activities[0].cost.castLevel = 2; },
    (d: any) => { d.actors[0].sheet.spellcasting.activities[0].inheritance.range = 'guess'; },
    (d: any) => { d.actors[0].sheet.spellcasting.activities[0].context.activation.cost = 2; },
    (d: any) => { d.actors[0].sheet.spellcasting.activities[0].context.range.value = 0; },
    (d: any) => { d.actors[0].sheet.spellcasting.activities[0].context.target.count = 2; },
    (d: any) => { d.actors[0].sheet.spellcasting.activities[0].outcome.formula = '@mod'; },
    (d: any) => { d.actors[0].sheet.spellcasting.activities[0].outcome.parts[0].bonus = '10'; },
    (d: any) => { const s = d.actors[0].sheet.spellcasting; s.activities[1].outcome.allowCritical = true; },
    (d: any) => { const r = d.actors[0].sheet.spellcasting.resources[0]; r.max = null; r.maxSource = 'unknown'; },
    (d: any) => { d.actors[0].sheet.spellcasting.resources[0].maxSource = 'unknown'; },
    (d: any) => { d.actors[0].sheet.spellcasting.resources[0].value = 3; },
    (d: any) => { const s = d.actors[0].sheet.spellcasting; s.unsupported.push({ kind: 'spell', sourcePath: '/items/2', sourceItemId: s.spells[0].sourceItemId, sourceActivityId: null, name: 'broken', codes: ['RULE'], reason: 'Unknown shared rule' }); },
  ];
  for (const [index, change] of changes.entries()) { const document = bundle(); change(document); const before = JSON.stringify(document); assert.throws(() => importNeutralScene(document), SceneImportError, `mutation ${index}`); assert.equal(JSON.stringify(document), before); }
});

test('fixture: bundle Store import, cast and archive preserve exact source while player projections strip references', () => {
  const store = new Store(':memory:');
  try {
    const gm = store.authenticate(store.create('Spells import integration', 'GM').token), player = store.authenticate(store.join(store.snapshot(gm).inviteCode!, 'Player').token);
    const document = bundle();
    const cmd = (type: CommandType, payload: Record<string, unknown>) => store.command(gm, { id: randomUUID(), type, payload, expectedRevision: store.snapshot(gm).campaign.revision }).ack;
    const bad = structuredClone(document); bad.actors[0].sheet.spellcasting.activities[0].cost.amount = 2;
    const initial = store.export(gm);
    assert.equal(cmd('scene.import', { document: bad }).ok, false); assert.deepEqual(store.export(gm), initial); assert.equal(store.imports(gm).length, 0);
    assert.equal(cmd('scene.import', { document }).ok, true);
    const campaign = store.export(gm), sceneId = campaign.activeSceneId, actor = campaign.actors.find(a => a.spellcasting)!;
    assert.equal(cmd('actor.update', { id: actor.id, owners: [player.memberId] }).ok, true);
    assert.equal(cmd('actor.action.execute', { id: actor.id, actionId: actor.actions[0].id, actionVersion: 1, visibility: 'public' }).ok, true);
    const after = store.export(gm), receipt = after.actionResolutions[0];
    assert.equal(receipt.spell!.name, 'Research Spark'); assert.equal(receipt.spell!.version, 1); assert.equal(receipt.costs[0].before, 2); assert.equal(receipt.costs[0].after, 1);
    assert.equal(after.outcomeRolls.length, 0); assert.equal(after.actors.find(a => a.id === actor.id)!.hp, actor.hp);
    const playerActor = store.snapshot(player).campaign.actors.find(a => a.id === actor.id)!;
    assert.equal(playerActor.source, undefined); assert.equal(playerActor.actions.length, 2); assert.equal(playerActor.spellcasting!.spells.length, 1);
    const archive: any = store.importArchive(gm, sceneId); assert.deepEqual(archive, document);
    for (const source of archive.provenance.additionalSources) assert.equal(createHash('sha256').update(source.originalUtf8Text).digest('hex'), source.sourceSha256);
  } finally { store.close(); }
});
