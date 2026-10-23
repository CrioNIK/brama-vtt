import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { importNeutralScene, SceneImportError } from '../shared/import.ts';
import { ABILITY_KEYS } from '../shared/model.ts';
import { rollActorCheck } from '../server/engine.ts';
import { Store } from '../server/store.ts';

const bundle = () => JSON.parse(readFileSync(new URL('./fixtures/inventory.json', import.meta.url), 'utf8'));
const legacy = () => JSON.parse(readFileSync(new URL('./fixtures/token-linked.json', import.meta.url), 'utf8'));

test('fixture: 0.4 native inventory maps explicit scores, per-unit weight, plaintext and remaining charges without activities', () => {
  const document = bundle(), before = JSON.stringify(document), result = importNeutralScene(document), actor = result.actors[0];
  assert.equal(actor.sheetKind, 'dnd5e'); assert.equal(actor.items.length, 2);
  assert.deepEqual(actor.abilities, { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 });
  assert.deepEqual(result.sheetSummary, { actorSheets: 1, items: 2, knownAbilities: 6, unknownAbilities: 0, effects: 0, activeEffects: 0, unsupportedEffects: 0, spells: 0, activities: 0, slotPools: 0, unsupportedSpellcasting: 0, checksProfiles: 0, unsupportedChecks: 0 });
  const ration = actor.items.find(i => i.name === 'Research Ration')!, blade = actor.items.find(i => i.name === 'Research Training Blade')!;
  assert.equal(ration.type, 'equipment'); assert.equal(ration.quantity, 3); assert.equal(ration.weight, 0.5); assert.equal(ration.weightUnit, 'lb');
  assert.equal(ration.equipped, true); assert.deepEqual(ration.uses, { value: 2, max: 4 });
  assert.equal(ration.description, 'A handmade test ration for the VTT Research Lab. No special rules.');
  assert.equal(blade.type, 'weapon'); assert.equal(blade.uses, undefined); assert.equal(blade.description, '');
  assert.equal('activities' in blade, false); assert.equal('sourceItemId' in blade, false);
  assert.equal(actor.source!.itemRefs!.find(ref => ref.itemId === ration.id)!.sourceItemId, 'EAREHKNa8sd8ySEO');
  assert.ok(result.warnings.some(w => w.includes('activities')));
  assert.equal(JSON.stringify(document), before, 'consumer never edits source bundle');
  assert.equal(JSON.stringify(actor).includes('originalUtf8Text'), false);
});

test('unknown ability scores and omitted uses remain unknown and do not become zero or derived defaults', () => {
  const document = bundle(); document.actors[0].sheet.abilities.wis = null; delete document.actors[0].sheet.items[0].uses;
  const result = importNeutralScene(document), actor = result.actors[0];
  assert.equal(actor.abilities.wis, null); assert.equal(actor.items[0].uses, undefined);
  assert.deepEqual(result.sheetSummary, { actorSheets: 1, items: 2, knownAbilities: 5, unknownAbilities: 1, effects: 0, activeEffects: 0, unsupportedEffects: 0, spells: 0, activities: 0, slotPools: 0, unsupportedSpellcasting: 0, checksProfiles: 0, unsupportedChecks: 0 });
  assert.throws(() => rollActorCheck(actor, { ability: 'wis' }));
  assert.equal(rollActorCheck(actor, { ability: 'str' }, () => 12).total, 12);
});

test('an unlinked token retains independent HP but its referenced sheet remains the base Actor sheet', () => {
  const document = bundle(), token = document.scene.tokens[0];
  token.actorLink = false; token.actorResolution = 'unlinked'; token.hp = { value: 5, max: 10, temp: 0, tempMax: 0 };
  const result = importNeutralScene(document);
  assert.equal(result.scene.tokens[0].linked, false); assert.equal(result.scene.tokens[0].hp, 5);
  assert.equal(result.actors[0].hp, 7); assert.equal(result.actors[0].items[0].quantity, 3); assert.equal(result.actors[0].abilities.str, 10);
  assert.equal(result.scene.tokens[0].actorId, result.actors[0].id);
  assert.equal('items' in result.scene.tokens[0], false); assert.equal('abilities' in result.scene.tokens[0], false);
  assert.ok(result.warnings.some(w => w.includes('base Actor sheet') && w.includes('deltas are not applied')));
});

test('each import creates fresh Actor and Item identities while linked tokens share their single imported sheet', () => {
  const document = bundle(), extra = structuredClone(document.scene.tokens[0]);
  extra.id = 'second-normalized-token'; extra.sourceTokenId = 'second-native-token'; document.scene.tokens.push(extra);
  const first = importNeutralScene(document), second = importNeutralScene(document);
  assert.equal(first.actors.length, 1); assert.equal(first.scene.tokens[0].actorId, first.scene.tokens[1].actorId);
  assert.notEqual(first.actors[0].id, second.actors[0].id);
  const ids = new Set(first.actors[0].items.map(item => item.id));
  for (const item of second.actors[0].items) assert.equal(ids.has(item.id), false);
  for (const [index, item] of first.actors[0].items.entries()) {
    assert.notEqual(item.id, document.actors[0].sheet.items[index].id);
    assert.equal(first.actors[0].source!.itemRefs![index].itemId, item.id);
  }
});

test('strict sheet validation rejects unsupported kind/version, duplicates, malformed bounds and executable-shaped fields', () => {
  const changes: ((document: ReturnType<typeof bundle>) => void)[] = [
    d => { d.actors[0].sheet.kind = 'pf2e'; },
    d => { d.schemaVersion = '0.3.0'; },
    d => { d.actors[0].systemVersion = '6.0.7'; },
    d => { d.actors[0].sheet.abilities.str = 0; },
    d => { d.actors[0].sheet.abilities.str = 31; },
    d => { d.actors[0].sheet.abilities.str = 10.5; },
    d => { d.actors[0].sheet.abilities.str = '10'; },
    d => { delete d.actors[0].sheet.abilities.str; },
    d => { d.actors[0].sheet.abilities.luck = 10; },
    d => { d.actors[0].sheet.items[1].id = d.actors[0].sheet.items[0].id; },
    d => { d.actors[0].sheet.items[1].sourceItemId = d.actors[0].sheet.items[0].sourceItemId; },
    d => { d.actors[0].sheet.items[0].quantity = 0.5; },
    d => { d.actors[0].sheet.items[0].quantity = 100001; },
    d => { d.actors[0].sheet.items[0].weight = -1; },
    d => { d.actors[0].sheet.items[0].weight = Infinity; },
    d => { d.actors[0].sheet.items[0].weightUnit = 'oz'; },
    d => { d.actors[0].sheet.items[0].equipped = 1; },
    d => { d.actors[0].sheet.items[0].name = ' '; },
    d => { d.actors[0].sheet.items[0].type = 'a'.repeat(61); },
    d => { d.actors[0].sheet.items[0].description = 'x'.repeat(20001); },
    d => { d.actors[0].sheet.items[0].uses = { value: 2, max: '4' }; },
    d => { d.actors[0].sheet.items[0].uses = { value: 5, max: 4 }; },
    d => { d.actors[0].sheet.items[0].uses = { value: -1, max: 4 }; },
    d => { d.actors[0].sheet.items[0].uses = null; },
    d => { d.actors[0].sheet.items[0].activities = { attack: '1d20' }; },
    d => { d.actors[0].sheet.resources = []; },
    d => { d.actors[0].sheet.items = Array.from({ length: 201 }, (_, i) => ({ ...d.actors[0].sheet.items[0], id: `item-${i}`, sourceItemId: `native-${i}` })); },
  ];
  for (const [index, change] of changes.entries()) { const document = bundle(); change(document); assert.throws(() => importNeutralScene(document), SceneImportError, `mutation ${index}`); }
  const edge = bundle(), item = edge.actors[0].sheet.items[0];
  item.quantity = 0; item.weight = 100000; item.uses = { value: 0, max: 0 }; edge.actors[0].sheet.abilities.str = 1; edge.actors[0].sheet.abilities.dex = 30;
  const result = importNeutralScene(edge); assert.equal(result.actors[0].items[0].quantity, 0); assert.deepEqual(result.actors[0].items[0].uses, { value: 0, max: 0 });
});

test('literal angle brackets and script-shaped text remain inert description data without reinterpretation', () => {
  const document = bundle();
  const literal = '<blade> & <script>text</script> <img src=x onerror="throw 1">';
  document.actors[0].sheet.items[0].description = literal;
  const result = importNeutralScene(document), item = result.actors[0].items[0];
  assert.equal(item.description, literal);
  assert.equal(JSON.parse(JSON.stringify(item)).description, literal);
  assert.equal('html' in item, false); assert.equal('activities' in item, false);
});

test('old bridge versions remain blank sheets and loss reports remain visible without inferring native data', () => {
  const old = importNeutralScene(legacy());
  assert.equal(old.actors[0].sheetKind, 'generic'); assert.deepEqual(old.actors[0].items, []);
  for (const key of ABILITY_KEYS) assert.equal(old.actors[0].abilities[key], null);
  assert.deepEqual(old.sheetSummary, { actorSheets: 0, items: 0, knownAbilities: 0, unknownAbilities: 0, effects: 0, activeEffects: 0, unsupportedEffects: 0, spells: 0, activities: 0, slotPools: 0, unsupportedSpellcasting: 0, checksProfiles: 0, unsupportedChecks: 0 });
  const document = bundle(); delete document.actors[0].sheet; document.actors[0].systemVersion = 'unsupported'; document.actors[0].hp = null;
  document.report.issues.push({ code: 'unsupported-sheet-sentinel', path: '/actors/0', message: 'Unsupported source remains in the original archive.' });
  const result = importNeutralScene(document);
  assert.equal(result.actors[0].sheetKind, 'generic'); assert.equal(result.actors[0].hp, null); assert.deepEqual(result.actors[0].items, []);
  assert.ok(result.warnings.some(w => w.includes('unsupported-sheet-sentinel')));
  assert.equal(document.provenance.additionalSources[0].originalUtf8Text.includes('Research Ration'), true);
});

test('campaign imports persist sheet ownership and source privacy; invalid second Item rolls back scene, Actors and archive atomically', () => {
  const store = new Store(':memory:');
  try {
    const gmAuth = store.create('Sheet bridge', 'GM'), gm = store.authenticate(gmAuth.token), invite = store.snapshot(gm).inviteCode!;
    const ownerAuth = store.join(invite, 'Owner'), owner = store.authenticate(ownerAuth.token), other = store.authenticate(store.join(invite, 'Other').token);
    const command = (type: string, payload: Record<string, unknown>) => store.command(gm, { id: randomUUID(), type, payload }).ack;
    const document = bundle(), imported = command('scene.import', { document }); assert.equal(imported.ok, true, imported.error);
    let state = store.snapshot(gm).campaign, scene = state.scenes.find(s => s.id === state.activeSceneId)!, actor = state.actors.find(a => a.id === scene.tokens[0].actorId)!;
    const actorId = actor.id, sceneId = scene.id, rationId = actor.items.find(i => i.name === 'Research Ration')!.id;
    assert.deepEqual(actor.owners, [gmAuth.memberId]);
    assert.equal(command('actor.update', { id: actorId, owners: [ownerAuth.memberId] }).ok, true);
    assert.equal(command('scene.update', { id: sceneId, visionEnabled: false }).ok, true);
    const full = store.snapshot(owner).campaign.actors.find(a => a.id === actorId)!, summary = store.snapshot(other).campaign.actors.find(a => a.id === actorId)!;
    assert.equal(full.items.length, 2); assert.equal(full.source, undefined); assert.equal(summary.sheetAccess, 'summary'); assert.deepEqual(summary.items, []);
    for (const session of [owner, other]) assert.equal(JSON.stringify(store.snapshot(session)).includes('EAREHKNa8sd8ySEO'), false);
    assert.equal(store.command(other, { id: randomUUID(), type: 'actor.item.consume', payload: { id: actorId, itemId: rationId, from: 'uses' } }).ack.code, 'FORBIDDEN');
    assert.equal(store.command(owner, { id: randomUUID(), type: 'actor.item.consume', payload: { id: actorId, itemId: rationId, from: 'uses' } }).ack.ok, true);
    actor = store.snapshot(gm).campaign.actors.find(a => a.id === actorId)!;
    assert.equal(actor.items.find(i => i.id === rationId)!.uses!.value, 1); assert.equal(actor.items.find(i => i.id === rationId)!.quantity, 3); assert.equal(actor.hp, 7);
    const archive = store.importArchive(gm, sceneId) as ReturnType<typeof bundle>; assert.deepEqual(archive, document);
    assert.equal(archive.actors[0].sheet.items.find((i: { name: string }) => i.name === 'Research Ration').uses.value, 2);
    const before = store.export(gm), archivesBefore = store.imports(gm), invalid = bundle(); invalid.actors[0].sheet.items[1].quantity = -1;
    assert.equal(command('scene.import', { document: invalid }).ok, false);
    assert.deepEqual(store.export(gm), before); assert.deepEqual(store.imports(gm), archivesBefore);
    assert.equal(command('scene.import', { document }).ok, true);
    state = store.snapshot(gm).campaign; scene = state.scenes.find(s => s.id === state.activeSceneId)!; actor = state.actors.find(a => a.id === scene.tokens[0].actorId)!;
    assert.notEqual(actor.id, actorId); assert.notEqual(actor.items[0].id, rationId); assert.equal(actor.items.find(i => i.name === 'Research Ration')!.uses!.value, 2);
  } finally { store.close(); }
});
