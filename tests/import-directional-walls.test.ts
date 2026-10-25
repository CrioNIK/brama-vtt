import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importNeutralScene, SceneImportError } from '../shared/import.ts';
import { effectiveWallDirection } from '../shared/geometry.ts';

const versions = ['0.1.0','0.2.0','0.3.0','0.4.0','0.5.0','0.6.0','0.7.0','0.8.0','0.9.0','0.10.0'];
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/scene-populated.json', import.meta.url), 'utf8'));
test('explicit source wall directions retain endpoint order across every supported interchange version', () => {
  for (const version of versions) for (const [source, expected] of [['both','both'],['foundry-left','left'],['foundry-right','right']]) {
    const document = fixture();
    document.schemaVersion = document.provenance.converterVersion = version;
    document.scene.walls[0].direction = source;
    const original = JSON.stringify(document), segment = document.scene.walls[0].segment;
    const { scene, warnings } = importNeutralScene(document);
    assert.equal(effectiveWallDirection(scene.walls[0]), expected);
    assert.deepEqual(scene.walls[0].a, {x:segment[0][0],y:segment[0][1]});
    assert.deepEqual(scene.walls[0].b, {x:segment[1][0],y:segment[1][1]});
    assert.equal(JSON.stringify(document), original);
    assert.equal(warnings.some(w => w.startsWith('Directional walls block')), expected !== 'both');
  }
});

test('reversed portal geometry does not reverse the owning wall direction or sense modes', () => {
  const document = fixture(); document.schemaVersion = document.provenance.converterVersion = '0.10.0';
  const portal = document.scene.portals[0], wall = document.scene.walls.find((w: any) => w.id === portal.wallId);
  wall.direction = 'foundry-right'; wall.restrictions.sight = 'limited';
  portal.segment.reverse();
  const imported = importNeutralScene(document).scene.walls.find(w => w.kind === 'door')!;
  assert.equal(imported.direction, 'right'); assert.equal(imported.senseModes?.sight, 'limited');
  assert.deepEqual(imported.a, {x:wall.segment[0][0],y:wall.segment[0][1]});
  assert.deepEqual(imported.b, {x:wall.segment[1][0],y:wall.segment[1][1]});
});

test('unknown, missing and local-only direction spellings cannot acquire source semantics', () => {
  for (const value of ['left','right','up',1,2,null,undefined,{},true]) {
    const document = fixture(); document.scene.walls[0].direction = value;
    assert.throws(() => importNeutralScene(document), SceneImportError);
  }
});

test('0.10 keeps inherited advancement and check adapters available', () => {
  const document = JSON.parse(readFileSync(new URL('./fixtures/advancement/runtime-compatible.json', import.meta.url), 'utf8'));
  const previous = importNeutralScene(document);
  document.schemaVersion = document.provenance.converterVersion = '0.10.0';
  const next = importNeutralScene(document);
  assert.deepEqual(next.sheetSummary, previous.sheetSummary);
  assert.deepEqual(next.actors[0].observedAdvancement, previous.actors[0].observedAdvancement);
  assert.deepEqual(next.actors[0].checks, previous.actors[0].checks);
  assert.deepEqual(next.actors[0].source!.advancementEvidence, previous.actors[0].source!.advancementEvidence);
});

test('0.10 retains limited wall senses', () => {
  const document = fixture(); document.schemaVersion = document.provenance.converterVersion = '0.10.0';
  document.scene.walls[0].restrictions.sight = 'limited';
  assert.equal(importNeutralScene(document).scene.walls[0].senseModes?.sight, 'limited');
});
