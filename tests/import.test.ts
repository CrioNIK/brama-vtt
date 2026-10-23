import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importNeutralScene, SceneImportError } from '../shared/import.js';
import { blocksMovement, inLevel } from '../shared/geometry.js';

const populatedURL = new URL('./fixtures/scene-populated.json', import.meta.url);
const blankURL = new URL('./fixtures/scene-empty.json', import.meta.url);
const populated = () => JSON.parse(readFileSync(populatedURL, 'utf8'));
const blank = () => JSON.parse(readFileSync(blankURL, 'utf8'));

test('fixture: neutral document imports walls, closed door, pixel light radii and level membership', () => {
  const document = populated(), before = JSON.stringify(document);
  const { scene, warnings } = importNeutralScene(document);
  assert.equal(scene.width, 4000); assert.equal(scene.height, 3000);
  assert.equal(scene.grid.size, 100); assert.equal(scene.grid.distance, 5);
  assert.equal(scene.activeLevelId, 'defaultLevel0000');
  assert.deepEqual(scene.levels, [{ id: 'defaultLevel0000', name: 'Level', bottom: 0, top: 20 }]);
  assert.equal(scene.walls.length, 2);
  assert.deepEqual(scene.walls[0].a, { x: 1775, y: 1900 });
  assert.deepEqual(scene.walls[0].b, { x: 2300, y: 1900 });
  assert.equal(scene.walls[1].kind, 'door'); assert.equal(scene.walls[1].state, 'closed');
  assert.deepEqual(scene.walls[1].levelIds, ['defaultLevel0000']);
  assert.equal(scene.lights.length, 1);
  assert.equal(scene.lights[0].bright, 100); assert.equal(scene.lights[0].dim, 200);
  assert.deepEqual(scene.lights[0].levelIds, ['defaultLevel0000']);
  assert.ok(warnings.some(w => w.includes('source fields')));
  assert.equal(JSON.stringify(document), before, 'import must not mutate source');
  assert.equal(scene.importWarnings, warnings);
});

test('fixture: empty native scene imports without inventing walls/lights', () => {
  const { scene } = importNeutralScene(blank());
  assert.equal(scene.walls.length, 0); assert.equal(scene.lights.length, 0);
  assert.equal(scene.background, '#999999');
});

test('multiple memberships preserve one wall/light object and shared door state', () => {
  const doc = populated();
  const upper = structuredClone(doc.scene.levels[0]);
  upper.id = 'upper'; upper.name = 'Upper'; upper.elevation = { bottom: 20, top: 40 };
  doc.scene.levels.push(upper);
  for (const entity of [...doc.scene.walls, ...doc.scene.portals, ...doc.scene.lights]) entity.levelIds.push('upper');
  const { scene } = importNeutralScene(doc);
  assert.equal(scene.levels.length, 2); assert.equal(scene.walls.length, 2); assert.equal(scene.lights.length, 1);
  const door = scene.walls[1];
  assert.equal(inLevel(door, 'upper'), true); assert.equal(inLevel(door, 'defaultLevel0000'), true);
  door.state = 'open';
  assert.equal(scene.walls.filter(w => w.id === door.id).length, 1);
  const token = { id: 't', name: 't', x: 2450, y: 1750, levelId: 'upper', width: 1, height: 1, rotation: 0,
    color: '#ffffff', owners: [], hidden: false, actorId: null, linked: false, hp: 1, maxHp: 1, vision: 100, conditions: [] };
  assert.equal(blocksMovement(scene, token, { x: 2450, y: 2050 }), false);
  door.state = 'closed';
  assert.equal(blocksMovement(scene, token, { x: 2450, y: 2050 }), true);
});

test('hex grids, partial wall restrictions and directional walls fail explicitly', () => {
  const cases = [
    (d: ReturnType<typeof populated>) => { d.scene.grid.type = 'hex-odd-r'; },
    (d: ReturnType<typeof populated>) => { d.scene.walls[0].restrictions.sight = 'unspecified'; },
    (d: ReturnType<typeof populated>) => { d.scene.walls[0].direction = 'foundry-left'; },
    (d: ReturnType<typeof populated>) => { d.scene.portals[0].kind = 'unspecified'; },
    (d: ReturnType<typeof populated>) => { d.scene.levels[0].elevation.top = null; },
    (d: ReturnType<typeof populated>) => { d.scene.levels[0].visibilityLevelIds = ['other']; },
  ];
  for (const change of cases) { const doc = populated(); change(doc); assert.throws(() => importNeutralScene(doc), SceneImportError); }
});

test('ambiguous empty/unresolved/missing multilevel memberships are not flattened', () => {
  for (const ids of [[], ['missing'], ['defaultLevel0000', 'defaultLevel0000']]) {
    const doc = populated(); doc.scene.walls[0].levelIds = ids;
    assert.throws(() => importNeutralScene(doc), SceneImportError);
  }
  const doc = populated(), second = structuredClone(doc.scene.levels[0]);
  second.id = 'upper'; doc.scene.levels.push(second); delete doc.scene.walls[0].levelIds;
  assert.throws(() => importNeutralScene(doc), /Missing level association/);
});

test('bounds, portal references and geometry are validated before scene construction', () => {
  const cases = [
    (d: ReturnType<typeof populated>) => { d.scene.width = Infinity; },
    (d: ReturnType<typeof populated>) => { d.scene.grid.sizePixels = 0; },
    (d: ReturnType<typeof populated>) => { d.scene.walls[0].segment = [[1, 1], [1, 1]]; },
    (d: ReturnType<typeof populated>) => { d.scene.walls[0].segment[0][0] = -1; },
    (d: ReturnType<typeof populated>) => { d.scene.portals[0].wallId = 'missing'; },
    (d: ReturnType<typeof populated>) => { d.scene.portals[0].segment[0][0] = 1; },
    (d: ReturnType<typeof populated>) => { d.scene.lights[0].brightRadiusPixels = 1000; },
    (d: ReturnType<typeof populated>) => { d.scene.lights[0].enabled = 'true'; },
  ];
  for (const change of cases) { const doc = populated(); change(doc); assert.throws(() => importNeutralScene(doc), SceneImportError); }
  assert.throws(() => importNeutralScene(null), SceneImportError);
});

test('asset references and source archive remain inert and do not become runtime URLs', () => {
  const doc = populated();
  doc.scene.assets.push({ kind: 'external-reference', sourcePath: '/background/src', uri: 'https://example.invalid/private.webp' });
  doc.provenance.originalUtf8Text = '{"macro":"never execute this"}';
  const { scene, warnings } = importNeutralScene(doc);
  assert.ok(!JSON.stringify(scene).includes('example.invalid'));
  assert.ok(!JSON.stringify(scene).includes('never execute this'));
  assert.ok(warnings.some(w => w.includes('not requested or rendered')));
});

test('older 0.1 bridge documents without levels get an explicit single-level warning', () => {
  const doc = blank(); doc.schemaVersion = '0.1.0'; doc.provenance.converterVersion = '0.1.0';
  delete doc.scene.levels; delete doc.scene.initialLevelId;
  const { scene, warnings } = importNeutralScene(doc);
  assert.equal(scene.levels.length, 1);
  assert.ok(warnings.some(w => w.includes('No level metadata')));
});

test('unsafe source IDs are normalized and their references remain consistent', () => {
  const doc = populated();
  const bad = '../level<script>';
  doc.scene.levels[0].id = bad; doc.scene.initialLevelId = bad;
  for (const entity of [...doc.scene.walls, ...doc.scene.portals, ...doc.scene.lights]) entity.levelIds = [bad];
  const { scene } = importNeutralScene(doc);
  assert.match(scene.activeLevelId, /^[A-Za-z0-9_-]+$/);
  assert.equal(scene.walls[0].levelIds?.[0], scene.activeLevelId);
});
