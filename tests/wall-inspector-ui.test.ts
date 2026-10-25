import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WallInspector } from '../client/Panels.tsx';
import { ImportedWallSummary } from '../client/ImportScene.tsx';
import { makeScene } from '../server/engine.ts';
import { importNeutralScene } from '../shared/import.ts';
import { LOCALES, setLocale, t, translateSystemMessage } from '../shared/i18n.ts';
import type { Member, Wall } from '../shared/model.ts';

const gm: Member = { id: 'gm', name: 'GM', role: 'gm', color: '#ffffff' };
const baseWall: Wall = { id: 'test-wall', a: { x: 10, y: 10 }, b: { x: 10, y: 200 },
  levelId: 'ground', kind: 'wall', state: 'closed', movement: true, sight: true, light: false, sound: true };
function inspector(wall: Wall, self = gm) {
  return renderToStaticMarkup(createElement(WallInspector, { wall, self, scene: makeScene('Inspector test'),
    revision: 1, onClose: () => {}, command: async () => { throw new Error('Rendering must not send commands'); } }));
}
function select(html: string, channel: 'sight' | 'light' | 'sound') {
  const match = html.match(new RegExp(`<select\\b[^>]*name="${channel}"[^>]*>(.*?)</select>`, 's'));
  assert.ok(match, `missing ${channel} selector`);
  assert.match(match[0], /aria-describedby="wall-restrictions-test-wall"/);
  return match[1];
}
function selected(html: string) {
  const match = html.match(/<option value="([^"]+)" selected="">/);
  assert.ok(match, 'the effective mode must be selected');
  return match[1];
}

test('wall inspector displays independent canonical modes instead of stale legacy booleans', () => {
  const wall: Wall = { ...baseWall, senseModes: { sight: 'limited', light: 'normal', sound: 'none' } };
  const html = inspector(wall);
  assert.equal(selected(select(html, 'sight')), 'limited');
  assert.equal(selected(select(html, 'light')), 'normal');
  assert.equal(selected(select(html, 'sound')), 'none');
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 1, 'movement remains the only boolean control');
  assert.match(html, /type="checkbox" checked=""/);
  assert.deepEqual(wall.senseModes, { sight: 'limited', light: 'normal', sound: 'none' });
});

test('legacy wall booleans and omitted override channels remain correctly editable', () => {
  const html = inspector({ ...baseWall, senseModes: { sound: 'limited' } });
  assert.equal(selected(select(html, 'sight')), 'normal');
  assert.equal(selected(select(html, 'light')), 'none');
  assert.equal(selected(select(html, 'sound')), 'limited');
  const legacy = inspector(baseWall);
  assert.equal(selected(select(legacy, 'sound')), 'normal');
});

test('wall modes and their explanations render in all five languages without changing stored values', () => {
  try {
    for (const locale of LOCALES) {
      setLocale(locale);
      const wall: Wall = { ...baseWall, kind: 'door', state: 'open', senseModes: { sight: 'limited' } };
      const html = inspector(wall);
      for (const label of ['Sight restriction', 'Light restriction', 'Sound restriction',
        'Open doors do not block movement, sight, light, or sound.',
        'Sound restrictions are saved with the scene. Spatial audio playback is not available.']) {
        assert.ok(html.includes(t(label)), `${locale}: ${label}`);
      }
      for (const channel of ['sight', 'light', 'sound'] as const) {
        const options = select(html, channel);
        for (const label of ['None', 'Normal', 'Limited']) assert.ok(options.includes(t(label)), `${locale}: ${channel}/${label}`);
      }
      assert.equal(selected(select(html, 'sight')), 'limited', 'an open door preserves its configured closed-door restriction');
      assert.equal(wall.senseModes?.sight, 'limited');
    }
  } finally { setLocale('en'); }
});

test('player wall view does not expose GM restriction editors', () => {
  const html = inspector({ ...baseWall, senseModes: { sight: 'limited' } }, { ...gm, role: 'player' });
  assert.doesNotMatch(html, /<form|<select|type="checkbox"/);
  assert.doesNotMatch(html, /aria-label="Delete wall"/);
});

test('import preview counts each imported limited wall once across channels and localizes diagnostics', () => {
  const document = JSON.parse(readFileSync(new URL('./fixtures/scene-populated.json', import.meta.url), 'utf8'));
  document.schemaVersion = document.provenance.converterVersion = '0.9.0';
  document.scene.walls[0].restrictions.sight = 'limited';
  document.scene.walls[0].restrictions.light = 'limited';
  const imported = importNeutralScene(document);
  const warning = 'Limited wall senses use one pass-through crossing and block at the second distinct crossing. Coincident crossings count once.';
  assert.ok(imported.warnings.includes(warning));
  try {
    for (const locale of LOCALES) {
      setLocale(locale);
      const html = renderToStaticMarkup(createElement(ImportedWallSummary, { walls: imported.scene.walls }));
      assert.ok(html.includes(`<dt>${t('Walls / doors')}</dt><dd>2</dd>`));
      assert.ok(html.includes(`<dt>${t('Walls with limited restrictions')}</dt><dd>1</dd>`));
      assert.equal(translateSystemMessage(warning), t(warning));
      if (locale !== 'en') assert.notEqual(translateSystemMessage(warning), warning);
    }
    setLocale('en');
    const legacy = renderToStaticMarkup(createElement(ImportedWallSummary, { walls: [baseWall] }));
    assert.doesNotMatch(legacy, /Walls with limited restrictions/);
  } finally { setLocale('en'); }
});
