import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { importNeutralScene, SceneImportError } from '../shared/import.ts';
import { blankActorChecks, previewCheck } from '../shared/checks.ts';
import { Store } from '../server/store.ts';

// Synthetic neutral documents exercise the supported interchange contract.
function document() {
  const value = JSON.parse(readFileSync(new URL('./fixtures/spellcasting-ready.json', import.meta.url), 'utf8'));
  value.schemaVersion = value.provenance.converterVersion = '0.7.0';
  const { version, ...checks } = blankActorChecks();
  checks.proficiency = { mode: 'class-level', level: 0, bonus: 1 };
  checks.skills.acr = { ability: 'int', proficiency: 2, bonus: 3, passiveBonus: 2, mode: 'advantage' };
  checks.saves.dex = { proficiency: 1, bonus: 2, mode: 'disadvantage' };
  checks.global.save.bonus = 1;
  value.actors[0].sheet.checks = checks;
  value.actors[0].sheet.abilities.int = 16; value.actors[0].sheet.abilities.dex = 14;
  value.actors[0].sheet.effects = [];
  return value;
}

test('fixture: baseline/configured records import the expected skill and save values', () => {
  for (const [stage, level, modifier, passive, save] of [['baseline', 0, 0, 10, 0], ['configured', 0, 8, 25, 6], ['class-level1', 1, 13, 30, 7], ['class-level5', 5, 15, 32, 8], ['effect-enabled', 5, 16, 33, 8], ['final', 5, 15, 32, 8]] as const) {
    const value = JSON.parse(readFileSync(new URL(`./fixtures/checks/${stage}.json`, import.meta.url), 'utf8'));
    const actor = importNeutralScene(value).actors[0];
    assert.equal(actor.name, 'Research Checks Hero');
    assert.deepEqual(actor.checks!.proficiency, { mode: 'class-level', level, bonus: Math.floor((level + 7) / 4) });
    assert.deepEqual(actor.checks!.unsupported, []);
    const acrobatics = previewCheck(actor, { kind: 'skill', key: 'acr' });
    assert.equal(acrobatics.modifier, modifier);
    assert.equal(acrobatics.passive, passive);
    assert.equal(previewCheck(actor, { kind: 'save', key: 'dex' }).modifier, save);
    if (stage === 'effect-enabled' || stage === 'final') {
      assert.equal(actor.abilities.int, 16);
      assert.equal(actor.effects.length, 1); assert.equal(actor.effects[0].disabled, stage === 'final');
      assert.deepEqual(actor.effects[0].duration, { rounds: null, seconds: null });
    }
  }
});

test('0.7 checks preserve all skill/save definitions, computed proficiency, source and unchanged input', () => {
  const value = document(), before = JSON.stringify(value), result = importNeutralScene(value), actor = result.actors[0];
  assert.equal(actor.checks!.version, 1); assert.equal(Object.keys(actor.checks!.skills).length, 18); assert.equal(Object.keys(actor.checks!.saves).length, 6);
  assert.equal(previewCheck(actor, { kind: 'skill', key: 'acr' }).modifier, 8);
  assert.equal(previewCheck(actor, { kind: 'skill', key: 'acr' }).passive, 25);
  assert.equal(previewCheck(actor, { kind: 'save', key: 'dex' }).modifier, 6);
  assert.equal(result.sheetSummary.checksProfiles, 1); assert.equal(result.sheetSummary.unsupportedChecks, 0);
  assert.equal(JSON.stringify(value), before); assert.ok(actor.spellcasting, 'checks coexist with spellcasting');
});

test('old schema rejects checks injection and does not infer an absent profile', () => {
  const value = document(); value.schemaVersion = '0.6.0';
  assert.throws(() => importNeutralScene(value), SceneImportError);
  delete value.actors[0].sheet.checks;
  const result = importNeutralScene(value);
  assert.equal(result.actors[0].checks, undefined); assert.equal(result.sheetSummary.checksProfiles, 0);
});

test('inert unsupported formulas block only matching checks; source paths remain GM metadata', () => {
  const value = document();
  value.actors[0].sheet.checks.unsupported = [{ scope: 'skill', key: 'acr', code: 'FORMULA', reason: 'Unsupported formula', sourcePath: '/actors/private-source/system/skills/acr/roll/bonus' }];
  const actor = importNeutralScene(value).actors[0];
  assert.equal(previewCheck(actor, { kind: 'skill', key: 'acr' }).modifier, null);
  assert.equal(previewCheck(actor, { kind: 'save', key: 'dex' }).modifier, 6);
  assert.equal(actor.source!.checkRefs![0].sourcePath, value.actors[0].sheet.checks.unsupported[0].sourcePath);
  assert.equal(JSON.stringify(actor.checks).includes('private-source'), false);
});

test('checks reject malformed modes, proficiency derivation, missing keys, extra keys, formulas and ranges', () => {
  const mutations = [
    (v: any) => { v.skills.acr.bonus = '1d4'; }, (v: any) => { v.skills.acr.proficiency = 1.5; },
    (v: any) => { v.skills.acr.mode = 1; }, (v: any) => { delete v.skills.ste; },
    (v: any) => { v.saves.str.proficiency = 2; }, (v: any) => { v.skills.acr.bonus = 0.5; },
    (v: any) => { v.skills.acr.bonus = 1001; }, (v: any) => { v.global.script = 'arbitrary'; },
    (v: any) => { v.proficiency.bonus = 2; }, (v: any) => { v.version = 99; },
    (v: any) => { v.unsupported = [{ scope: 'skill', key: 'missing', code: 'x', reason: 'x', sourcePath: '/x' }]; },
  ];
  for (const mutate of mutations) { const value = document(); mutate(value.actors[0].sheet.checks); assert.throws(() => importNeutralScene(value), SceneImportError); }
});

test('unknown proficiency stays unknown and affects only trained checks', () => {
  const value = document(); value.actors[0].sheet.checks.proficiency = { mode: 'unknown', bonus: null, level: null };
  const actor = importNeutralScene(value).actors[0];
  assert.equal(previewCheck(actor, { kind: 'skill', key: 'acr' }).modifier, null);
  assert.equal(previewCheck(actor, { kind: 'skill', key: 'ste' }).modifier, 2);
  assert.equal(previewCheck(actor, { kind: 'ability', key: 'int' }).modifier, 3);
});

test('server import is atomic on invalid checks and complete on valid checks', () => {
  const store = new Store(':memory:');
  try {
    const auth = store.create('Checks import', 'GM'), gm = store.authenticate(auth.token), before = store.snapshot(gm).campaign;
    const bad = document(); bad.actors[0].sheet.checks.proficiency.level = 5;
    const invalid = store.command(gm, { id: randomUUID(), type: 'scene.import', payload: { document: bad }, expectedRevision: before.revision }).ack;
    assert.equal(invalid.ok, false); assert.deepEqual(store.snapshot(gm).campaign, before);
    const valid = store.command(gm, { id: randomUUID(), type: 'scene.import', payload: { document: document() }, expectedRevision: before.revision }).ack;
    assert.equal(valid.ok, true, valid.error);
    const actor = store.snapshot(gm).campaign.actors.find(a => a.checks)!;
    assert.equal(actor.checks!.proficiency.bonus, 1); assert.equal(previewCheck(actor, { kind: 'skill', key: 'acr' }).passive, 25);
  } finally { store.close(); }
});
