import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WallInspector } from '../client/Panels.tsx';
import { Tabletop, WallDirectionPreview, WallOrientationMarker, wallDirectionLabel } from '../client/Tabletop.tsx';
import { makeScene } from '../server/engine.ts';
import { LOCALES, setLocale, t } from '../shared/i18n.ts';
import type { Member, Wall } from '../shared/model.ts';

const gm: Member = { id: 'gm', name: 'GM', role: 'gm', color: '#ffffff' };
const base: Wall = { id: 'direction-test', a: { x: 100, y: 100 }, b: { x: 100, y: 300 }, levelId: 'ground',
  kind: 'wall', state: 'closed', movement: true, sight: true, light: false, sound: true };
const command = async () => { throw new Error('Rendering must not send commands'); };
const markup = (wall: Wall, self = gm) => renderToStaticMarkup(createElement(WallInspector, {
  wall, self, scene: makeScene('Direction test'), revision: 7, command, onClose: () => {},
}));
const marker = (wall: Wall) => renderToStaticMarkup(createElement('svg', null, createElement(WallOrientationMarker, { wall })));
function directionControl(html: string) {
  const match = html.match(/<select\b[^>]*name="direction"[^>]*>(.*?)<\/select>/s);
  assert.ok(match, 'the direction control must exist');
  return match[0];
}
function sidePoints(html: string, side: 'left' | 'right') {
  const match = html.match(new RegExp(`data-blocked-side="${side}"[^>]*points="([^"]+)"`));
  assert.ok(match, `missing ${side} shaded side`);
  return match[1].split(' ').map(pair => pair.split(',').map(Number));
}

test('direction control defaults legacy walls to both without changing independent sense modes', () => {
  const wall: Wall = { ...base, senseModes: { sight: 'limited', light: 'none', sound: 'normal' } };
  const before = JSON.stringify(wall), html = markup(wall);
  assert.match(directionControl(html), /value="both" selected=""/);
  assert.match(directionControl(html), /aria-describedby="wall-direction-direction-test"/);
  assert.match(html, /name="sight"[^>]*>.*?value="limited" selected=""/s);
  assert.match(html, /name="light"[^>]*>.*?value="none" selected=""/s);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 1);
  assert.equal(JSON.stringify(wall), before);
});

test('all five languages describe side selection and preserve an open door’s configured direction', () => {
  try {
    for (const locale of LOCALES) {
      setLocale(locale);
      const wall: Wall = { ...base, direction: 'right', kind: 'door', state: 'open', senseModes: { sight: 'limited' } };
      const html = markup(wall);
      assert.match(directionControl(html), /value="right" selected=""/);
      for (const key of ['Blocking side', 'Both sides', 'Block from the left', 'Block from the right',
        'Left and right follow the A → B arrow. The highlighted side is the source side that the wall restricts.',
        'Open doors do not block movement, sight, light, or sound.']) assert.ok(html.includes(t(key)), `${locale}: ${key}`);
      assert.equal(wallDirectionLabel(wall), t('Configured blocking side: right of A → B'), 'an open door describes its saved configuration, not active blocking');
      assert.ok(html.includes(t('Configured blocking side: right of A → B')), locale);
      assert.match(html, /role="img" aria-label=/);
      assert.equal(wall.direction, 'right');
      assert.equal(wall.senseModes?.sight, 'limited');
    }
  } finally { setLocale('en'); }
});

test('side preview tracks A→B orientation, including reversed endpoints and horizontal walls', () => {
  const leftDown = sidePoints(marker({ ...base, direction: 'left' }), 'left');
  assert.ok(leftDown.every(([x]) => x >= 100));
  assert.ok(leftDown.some(([x]) => x > 100), 'visual left of a downward arrow is screen-right');
  const leftUp = sidePoints(marker({ ...base, a: base.b, b: base.a, direction: 'left' }), 'left');
  assert.ok(leftUp.every(([x]) => x <= 100));
  const rightReversed = sidePoints(marker({ ...base, a: base.b, b: base.a, direction: 'right' }), 'right');
  assert.ok(rightReversed.every(([x]) => x >= 100), 'reversing endpoints and swapping side preserves the physical side');
  const leftEast = sidePoints(marker({ ...base, b: { x: 300, y: 100 }, direction: 'left' }), 'left');
  assert.ok(leftEast.every(([, y]) => y <= 100));
  assert.ok(leftEast.some(([, y]) => y < 100));
});

test('legacy previews highlight both sides and selected markers never capture map input', () => {
  const html = marker(base);
  assert.equal((html.match(/data-blocked-side=/g) ?? []).length, 2);
  assert.match(html, /aria-hidden="true" pointer-events="none"/);
  assert.match(html, />A<\/text>/);
  assert.match(html, />B<\/text>/);
  const invalid = marker({ ...base, a: base.b });
  assert.doesNotMatch(invalid, /NaN|Infinity|data-wall-orientation/);
});

test('the diagram normalizes wall length without changing the direction of its endpoints', () => {
  const html = renderToStaticMarkup(createElement(WallDirectionPreview, { wall: { ...base, direction: 'left' } }));
  assert.match(html, /x1="130" y1="22" x2="130" y2="118"/);
  assert.ok(sidePoints(html, 'left').every(([x]) => x >= 130));
  assert.match(html, /viewBox="0 0 260 140" role="img"/);
});

test('map direction markers are limited to the selected GM wall while labels retain door state and endpoints', () => {
  const wall: Wall = { ...base, direction: 'left', kind: 'door', state: 'open' };
  const scene = makeScene('Direction test'); scene.walls = [wall]; scene.tokens = []; scene.lights = [];
  scene.activeLevelId = wall.levelId;
  const render = (self: Member, selected: boolean) => renderToStaticMarkup(createElement(Tabletop, {
    scene, self, actors: [], selection: selected ? { kind: 'wall', id: wall.id } : null,
    setSelection: () => {}, command, onCreateToken: () => {}, online: true,
  }));
  const selected = render(gm, true);
  assert.match(selected, /data-wall-orientation="left"/);
  assert.ok(selected.includes(t('Door: open')));
  assert.ok(selected.includes(`${t('Door: open')}. ${t('Configured blocking side: left of A → B')}.`));
  assert.doesNotMatch(selected, /Door: open\. Blocks from/);
  assert.ok(selected.includes('A (100, 100) → B (100, 300).'));
  assert.doesNotMatch(render(gm, false), /data-wall-orientation/);
  assert.doesNotMatch(render({ ...gm, role: 'player' }, true), /data-wall-orientation/);
});

test('player wall properties expose neither direction editing nor the GM diagram', () => {
  const html = markup({ ...base, direction: 'left' }, { ...gm, role: 'player' });
  assert.doesNotMatch(html, /name="direction"|data-wall-orientation|<form/);
});
