import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importNeutralScene, SceneImportError } from '../shared/import.ts';

const fixture = (name = 'scene-populated') => {
  const document = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url),'utf8'));
  document.schemaVersion = document.provenance.converterVersion = '0.11.0';
  return document;
};
function thresholdDocument() {
  const document = fixture(), wall = document.scene.walls[0];
  wall.restrictions = { movement:'block',sight:'proximity',light:'distance',sound:'limited' };
  wall.thresholds = {sightPixels:200,lightPixels:300,soundPixels:null,attenuation:true};
  return document;
}

test('0.11 imports independent threshold modes, pixel values and attenuation without mutating source',()=>{
  const document = thresholdDocument(), original = JSON.stringify(document);
  const {scene,warnings} = importNeutralScene(document), wall=scene.walls[0];
  assert.deepEqual(wall.senseModes,{sight:'proximity',light:'distance',sound:'limited'});
  assert.deepEqual(wall.senseThresholds,{sight:200,light:300,sound:null});
  assert.equal(wall.thresholdAttenuation,true);assert.equal(wall.movement,true);
  assert.ok(warnings.some(w=>w.startsWith('Proximity and reverse')));
  assert.ok(warnings.some(w=>w.startsWith('Limited wall senses')));
  assert.equal(JSON.stringify(document),original);
});

test('threshold schema gates reject relabeled old bundles and missing explicit settings',()=>{
  for(const version of ['0.1.0','0.8.0','0.9.0','0.10.0']) {
    const document=thresholdDocument();document.schemaVersion=version;
    assert.throws(()=>importNeutralScene(document),SceneImportError);
  }
  const missing=thresholdDocument();delete missing.scene.walls[0].thresholds;
  assert.throws(()=>importNeutralScene(missing),/explicit threshold settings/);
  const old=fixture();old.schemaVersion='0.10.0';old.scene.walls[0].thresholds={sightPixels:null,lightPixels:null,soundPixels:null,attenuation:false};
  assert.throws(()=>importNeutralScene(old),/schema 0.11.0/);
});

test('threshold imports reject coercion, invalid distances, unknown settings and movement modes',()=>{
  for(const invalid of [0,-1,NaN,Infinity,'20',true,{},undefined,100001]) {
    const document=thresholdDocument();document.scene.walls[0].thresholds.sightPixels=invalid;
    assert.throws(()=>importNeutralScene(document),SceneImportError);
  }
  for(const mutate of [
    (wall:any)=>wall.thresholds.extra=1,
    (wall:any)=>wall.thresholds.attenuation='false',
    (wall:any)=>delete wall.thresholds.soundPixels,
    (wall:any)=>wall.restrictions.movement='proximity',
  ]) {const document=thresholdDocument();mutate(document.scene.walls[0]);assert.throws(()=>importNeutralScene(document),SceneImportError);}
});

test('explicit null threshold and positive fractional values remain distinct',()=>{
  const document=thresholdDocument();document.scene.walls[0].thresholds.sightPixels=null;document.scene.walls[0].thresholds.lightPixels=0.125;
  const wall=importNeutralScene(document).scene.walls[0];
  assert.equal(wall.senseModes?.sight,'proximity');assert.equal(wall.senseThresholds?.sight,null);
  assert.equal(wall.senseThresholds?.light,0.125);
});

test('vision range origin is explicit in 0.11 and absent legacy profiles remain absent',()=>{
  for(const origin of ['center','token-edge']) {
    const document=fixture('token-linked');document.scene.tokens[0].sight.rangeOrigin=origin;
    assert.equal(importNeutralScene(document).scene.tokens[0].visionRangeOrigin,origin);
    document.schemaVersion='0.10.0';assert.throws(()=>importNeutralScene(document),/schema 0.11.0/);
  }
  const document=fixture('token-linked');assert.equal(importNeutralScene(document).scene.tokens[0].visionRangeOrigin,undefined);
  document.scene.tokens[0].sight.rangeOrigin='guess';assert.throws(()=>importNeutralScene(document),SceneImportError);
});

test('finite, disabled and unlimited light perception retain verified source units',()=>{
  for(const enabled of [true,false]) for(const range of [0,10.25,null]) {
    const document=fixture('token-linked'), source=document.scene.tokens[0];
    source.sight.rangeOrigin='token-edge';source.detectionModesMetadata.lightPerception={enabled,range};
    const pixels=range===null?null:range*document.scene.grid.sizePixels/document.scene.grid.distance;
    source.lightPerception={enabled,rangePixels:pixels};
    const token=importNeutralScene(document).scene.tokens[0];
    assert.deepEqual(token.lightPerception,{enabled,range:pixels});assert.equal(token.visionRangeOrigin,'token-edge');
  }
});

test('absent native light-perception mode has an explicit enabled unlimited mapping',()=>{
  const document=fixture('token-linked');document.scene.tokens[0].lightPerception={enabled:true,rangePixels:null};
  assert.deepEqual(importNeutralScene(document).scene.tokens[0].lightPerception,{enabled:true,range:null});
  document.scene.tokens[0].lightPerception.rangePixels=20;
  assert.throws(()=>importNeutralScene(document),/disagrees with source metadata/);
});

test('light perception cannot silently accept mismatched metadata or new semantics in old versions',()=>{
  for(const change of [
    (doc:any)=>doc.schemaVersion='0.10.0',
    (doc:any)=>doc.scene.tokens[0].lightPerception.rangePixels=21,
    (doc:any)=>doc.scene.tokens[0].lightPerception.enabled=false,
    (doc:any)=>delete doc.scene.tokens[0].lightPerception,
    (doc:any)=>doc.scene.tokens[0].lightPerception.extra=1,
    (doc:any)=>doc.scene.tokens[0].detectionModesMetadata.lightPerception.extra=1,
    (doc:any)=>doc.scene.tokens[0].detectionModesMetadata.tremorsense={enabled:true,range:10},
  ]) {
    const document=fixture('token-linked'),source=document.scene.tokens[0];
    source.detectionModesMetadata.lightPerception={enabled:true,range:10};
    source.lightPerception={enabled:true,rangePixels:10*document.scene.grid.sizePixels/document.scene.grid.distance};
    change(document);assert.throws(()=>importNeutralScene(document),SceneImportError);
  }
});

test('0.11 preserves existing advancement and checks alongside the new scene semantics',()=>{
  const document=JSON.parse(readFileSync(new URL('./fixtures/advancement/runtime-compatible.json',import.meta.url),'utf8'));
  const before=importNeutralScene(document);
  document.schemaVersion=document.provenance.converterVersion='0.11.0';
  const after=importNeutralScene(document);
  assert.deepEqual(after.sheetSummary,before.sheetSummary);
  assert.deepEqual(after.actors[0].checks,before.actors[0].checks);
  assert.deepEqual(after.actors[0].observedAdvancement,before.actors[0].observedAdvancement);
});
