import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WallInspector, TokenInspector, wallThresholdInputText, wallThresholdInputToPixels } from '../client/Panels.tsx';
import { makeScene, seedCampaign } from '../server/engine.ts';
import { WALL_THRESHOLD_MAX, type Member, type Wall } from '../shared/model.ts';
import { LOCALES, setLocale, t } from '../shared/i18n.ts';

const gm: Member = { id: 'gm', name: 'GM', role: 'gm', color: '#ffffff' };
const wall: Wall = { id: 'threshold-wall', a: { x: 100, y: 100 }, b: { x: 100, y: 300 }, levelId: 'ground',
  kind: 'wall', state: 'closed', movement: true, sight: true, light: true, sound: true, direction: 'left' };
const command = async () => { throw new Error('Rendering must not send commands'); };
function inspector(value: Wall, self = gm, units = 'ft') {
  const scene = makeScene('Threshold test'); scene.grid = { ...scene.grid, size: 100, distance: 5, units };
  return renderToStaticMarkup(createElement(WallInspector, { wall: value, scene, self, revision: 1, command, onClose: () => {} }));
}
function input(html: string, channel: 'sight' | 'light' | 'sound') {
  const match = html.match(new RegExp(`<input[^>]*name="threshold\\.${channel}"[^>]*>`));
  assert.ok(match, `missing ${channel} threshold input`);
  return match[0];
}

test('legacy wall editor offers five sense modes without showing inactive threshold controls', () => {
  const html = inspector(wall);
  for (const channel of ['sight', 'light', 'sound']) {
    const select = html.match(new RegExp(`<select[^>]*name="${channel}"[^>]*>(.*?)</select>`, 's'));
    assert.ok(select);
    for (const mode of ['none', 'normal', 'limited', 'proximity', 'distance']) assert.ok(select[1].includes(`value="${mode}"`));
  }
  assert.doesNotMatch(html, /name="threshold\.|name="thresholdAttenuation"/);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 1);
});

test('active channels expose independently labeled distances in scene units and one shared attenuation checkbox', () => {
  const value: Wall = { ...wall, senseModes: { sight: 'proximity', light: 'distance', sound: 'limited' },
    senseThresholds: { sight: 200, light: 50, sound: 17 }, thresholdAttenuation: true };
  const before = JSON.stringify(value), html = inspector(value);
  assert.match(input(html, 'sight'), /value="10"/);
  assert.match(input(html, 'light'), /value="2.5"/);
  assert.match(input(html, 'sight'), /max="5000"/);
  assert.match(input(html, 'light'), /aria-describedby="wall-threshold-light-threshold-wall wall-threshold-modes-threshold-wall"/);
  assert.doesNotMatch(html, /name="threshold\.sound"/);
  assert.equal((html.match(/name="thresholdAttenuation"/g) ?? []).length, 1);
  assert.match(html.match(/<input[^>]*name="thresholdAttenuation"[^>]*>/)?.[0] ?? '', /checked=""/);
  assert.ok(html.includes(t('Sight threshold ({unit})', { unit: 'ft' })));
  assert.ok(html.includes(t('Light threshold ({unit})', { unit: 'ft' })));
  assert.match(html, /value="left" selected=""/);
  assert.equal(JSON.stringify(value), before);
});

test('null and missing distances display blank while attenuation is initially off', () => {
  const html = inspector({ ...wall, senseModes: { sight: 'proximity', sound: 'distance' }, senseThresholds: { sight: null } });
  assert.match(input(html, 'sight'), /value=""/);
  assert.match(input(html, 'sound'), /value=""/);
  assert.doesNotMatch(input(html, 'sight'), /aria-invalid/);
  const attenuation = html.match(/<input[^>]*name="thresholdAttenuation"[^>]*>/)?.[0];
  assert.ok(attenuation);
  assert.doesNotMatch(attenuation, /checked/);
  assert.ok(html.includes(t('Leave blank to keep normal blocking for this channel.')));
});

test('inactive channel data and shared attenuation are not mutated by hiding their controls', () => {
  const value: Wall = { ...wall, senseModes: { sight: 'normal' }, senseThresholds: { sight: 123.25 }, thresholdAttenuation: true };
  const html = inspector(value);
  assert.doesNotMatch(html, /name="threshold\.|name="thresholdAttenuation"/);
  assert.equal(value.senseThresholds?.sight, 123.25);
  assert.equal(value.thresholdAttenuation, true);
});

test('threshold conversion distinguishes blank, zero, negative, overflow and exact maximum', () => {
  assert.equal(wallThresholdInputToPixels('', 200, 20), null);
  assert.equal(wallThresholdInputToPixels('  ', undefined, 20), null);
  assert.equal(wallThresholdInputToPixels('2.5', null, 20), 50);
  assert.equal(wallThresholdInputToPixels('0.0001', null, 20), 0.002);
  assert.equal(wallThresholdInputToPixels(String(WALL_THRESHOLD_MAX / 20), null, 20), WALL_THRESHOLD_MAX);
  assert.equal(wallThresholdInputToPixels(String(WALL_THRESHOLD_MAX / (19 / 17)), null, 19 / 17), WALL_THRESHOLD_MAX, 'the visible maximum remains valid despite floating-point multiplication');
  for (const value of ['0', '-1', 'NaN', 'Infinity', '1e309', String(WALL_THRESHOLD_MAX / 20 + 0.1)]) {
    assert.equal(wallThresholdInputToPixels(value, null, 20), undefined, value);
  }
  assert.equal(wallThresholdInputToPixels('1', null, 0), undefined);
});

test('unchanged scene-unit text preserves original pixel values without repeated conversion drift', () => {
  for (const original of [0.1, 1 / 3, 123.45678901234567, 99999.999999, WALL_THRESHOLD_MAX]) {
    for (const scale of [20, 7 / 3, 0.17, 19 / 17]) {
      let stored = original;
      for (let cycle = 0; cycle < 100; cycle++) {
        const next = wallThresholdInputToPixels(wallThresholdInputText(stored, scale), stored, scale);
        assert.equal(next, original);
        stored = next!;
      }
    }
  }
});

test('invalid active distances expose an accessible localized limit error', () => {
  const html = inspector({ ...wall, senseModes: { sight: 'proximity' }, senseThresholds: { sight: 0 } });
  assert.match(input(html, 'sight'), /aria-invalid="true"/);
  assert.ok(html.includes(t('Enter a distance greater than 0 and no more than {max} {unit}, or leave it blank.', { max: 5000, unit: 'ft' })));
  assert.match(html, /class="primary" disabled=""/);
});

test('threshold controls and units render in five languages without translating authored unit names', () => {
  try {
    for (const locale of LOCALES) {
      setLocale(locale);
      const html = inspector({ ...wall, senseModes: { sight: 'proximity', light: 'distance', sound: 'proximity' } }, gm, 'custom-unit');
      for (const key of ['Proximity', 'Reverse proximity', 'Threshold attenuation', 'Leave blank to keep normal blocking for this channel.',
        'Proximity allows perception past the wall from nearby sources; reverse proximity allows it from distant sources. Exactly at the cutoff, the distance exception does not apply.',
        'Thresholds measure distance to the wall segment, including its ends. The source’s size can affect the cutoff.',
        'Threshold attenuation can limit the effective perception area beyond a wall. It changes reach, not opacity.']) assert.ok(html.includes(t(key)), `${locale}: ${key}`);
      assert.match(namedInput(html, 'thresholdAttenuation'), /aria-describedby="wall-threshold-attenuation-threshold-wall"/);
      for (const label of ['Sight threshold ({unit})', 'Light threshold ({unit})', 'Sound threshold ({unit})']) assert.ok(html.includes(t(label, { unit: 'custom-unit' })));
      const blankUnits = inspector({ ...wall, senseModes: { sight: 'proximity' } }, gm, '');
      assert.ok(blankUnits.includes(t('Sight threshold ({unit})', { unit: t('Scene units') })));
    }
  } finally { setLocale('en'); }
});

test('players do not receive wall threshold editing controls', () => {
  const html = inspector({ ...wall, senseModes: { sight: 'proximity' } }, { ...gm, role: 'player' });
  assert.doesNotMatch(html, /name="threshold\.|name="thresholdAttenuation"|<form/);
});

test('GM token vision origin is localized and distinguishes legacy center from explicit token edge', () => {
  const campaign = seedCampaign('Origin test', 'GM'), scene = campaign.scenes[0], token = scene.tokens[0];
  const render = (self = campaign.members[0]) => renderToStaticMarkup(createElement(TokenInspector, {
    token, scene, campaign, self, command, onClose: () => {}, onOpenActor: () => {}, onCombatAdd: () => {}, combatPending: false,
  }));
  assert.match(render(), /name="visionRangeOrigin"[^>]*><option value="center" selected=""/);
  token.visionRangeOrigin = 'token-edge';
  try {
    for (const locale of LOCALES) {
      setLocale(locale);
      const html = render();
      assert.match(html, /value="token-edge" selected=""/);
      for (const key of ['Measure vision range from', 'Center', 'Token edge',
        'A finite unlit range of 0 grants no vision in darkness. Illuminated areas use the separate settings below.']) assert.ok(html.includes(t(key)));
      assert.equal(token.visionRangeOrigin, 'token-edge');
    }
    assert.doesNotMatch(render({ ...campaign.members[0], role: 'player' }), /name="visionRangeOrigin"/);
  } finally { setLocale('en'); }
});

function tokenPerceptionInspector(profile: { enabled: boolean; range: number | null } | undefined, player = false) {
  const campaign = seedCampaign('Light perception test', 'GM'), scene = campaign.scenes[0], token = scene.tokens[0];
  if (profile !== undefined) token.lightPerception = profile;
  token.visionRangeOrigin = 'token-edge';
  const html = renderToStaticMarkup(createElement(TokenInspector, { token, scene, campaign,
    self: player ? { ...campaign.members[0], role: 'player' } : campaign.members[0], command,
    onClose: () => {}, onOpenActor: () => {}, onCombatAdd: () => {}, combatPending: false }));
  return { html, token };
}
function namedInput(html: string, name: string) {
  const match = html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`));
  assert.ok(match, name);
  return match[0];
}

test('absent light-perception metadata displays legacy enabled/unlimited without creating a profile', () => {
  const { html, token } = tokenPerceptionInspector(undefined);
  assert.match(namedInput(html, 'lightPerceptionEnabled'), /checked=""/);
  assert.match(namedInput(html, 'lightPerceptionUnlimited'), /checked=""/);
  assert.doesNotMatch(html, /name="lightPerceptionRange"/);
  assert.equal(token.lightPerception, undefined);
});

test('finite zero and disabled illuminated-area perception remain distinct from unlimited', () => {
  const zero = tokenPerceptionInspector({ enabled: true, range: 0 });
  assert.doesNotMatch(namedInput(zero.html, 'lightPerceptionUnlimited'), /checked/);
  assert.match(namedInput(zero.html, 'lightPerceptionRange'), /value="0"/);
  assert.match(namedInput(zero.html, 'lightPerceptionRange'), /min="0" max="100000"/);
  const disabled = tokenPerceptionInspector({ enabled: false, range: 250 });
  assert.doesNotMatch(namedInput(disabled.html, 'lightPerceptionEnabled'), /checked/);
  assert.match(namedInput(disabled.html, 'lightPerceptionUnlimited'), /disabled=""/);
  assert.match(namedInput(disabled.html, 'lightPerceptionRange'), /disabled=""/);
  assert.match(namedInput(disabled.html, 'lightPerceptionRange'), /value="250"/);
  assert.deepEqual(disabled.token.lightPerception, { enabled: false, range: 250 });
});

test('illuminated-area controls have five complete translations and preserve the source profile', () => {
  try {
    for (const locale of LOCALES) {
      setLocale(locale);
      const { html, token } = tokenPerceptionInspector({ enabled: true, range: 123.25 });
      for (const key of ['Perceives illuminated areas', 'Unlimited light perception', 'Illuminated areas range, px',
        'A range of 0 disables additional vision from illuminated areas.']) assert.ok(html.includes(t(key)), `${locale}: ${key}`);
      assert.match(namedInput(html, 'lightPerceptionRange'), /aria-describedby="light-perception-/);
      assert.match(namedInput(html, 'lightPerceptionRange'), /value="123.25"/);
      assert.equal(token.visionRangeOrigin, 'token-edge');
      assert.deepEqual(token.lightPerception, { enabled: true, range: 123.25 });
    }
  } finally { setLocale('en'); }
});

test('players do not receive illuminated-area perception editors', () => {
  const { html } = tokenPerceptionInspector({ enabled: true, range: 250 }, true);
  assert.doesNotMatch(html, /name="lightPerception(?:Enabled|Unlimited|Range)"/);
});
