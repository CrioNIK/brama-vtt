import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importNeutralScene, SceneImportError } from '../shared/import.ts';

function fixture() {
  const document = JSON.parse(readFileSync(new URL('./fixtures/token-linked.json', import.meta.url), 'utf8'));
  const token = document.scene.tokens[0];
  token.detectionModesMetadata = { basicSight: { enabled: true, range: token.sightMetadata.range } };
  return document;
}

test('redundant basic detection metadata preserves supported zero, finite and unlimited sight', () => {
  for (const range of [0, 100, null]) {
    const document = fixture(), source = document.scene.tokens[0];
    source.sightMetadata.range = range;
    source.sight.rangePixels = range === null ? null : range * document.scene.grid.sizePixels / document.scene.grid.distance;
    source.detectionModesMetadata.basicSight.range = range;
    const before = JSON.stringify(document);
    const { scene } = importNeutralScene(document);
    assert.equal(scene.tokens[0].visionEnabled, true);
    assert.equal(scene.tokens[0].visionUnlimited, range === null);
    assert.equal(scene.tokens[0].vision, source.sight.rangePixels ?? 0);
    assert.equal(JSON.stringify(document), before);
  }
});

test('conflicting or extended detection metadata cannot silently change imported sight', () => {
  const mutations = [
    (t: any) => { t.detectionModesMetadata.basicSight.enabled = false; },
    (t: any) => { t.detectionModesMetadata.basicSight.range = 5; },
    (t: any) => { t.detectionModesMetadata.basicSight.range = null; },
    (t: any) => { t.detectionModesMetadata.basicSight.enabled = 'true'; },
    (t: any) => { delete t.detectionModesMetadata.basicSight.range; },
    (t: any) => { t.detectionModesMetadata.basicSight = null; },
    (t: any) => { t.detectionModesMetadata.basicSight = []; },
    (t: any) => { t.detectionModesMetadata.basicSight.extra = true; },
    (t: any) => { t.detectionModesMetadata.special = { enabled: true, range: 100 }; },
    (t: any) => { t.sight.enabled = false; t.sightMetadata.enabled = false; },
  ];
  for (const mutate of mutations) {
    const document = fixture(); mutate(document.scene.tokens[0]);
    assert.throws(() => importNeutralScene(document), SceneImportError);
  }
});
