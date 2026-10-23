import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCALES, messages, getLocale, isLocale, setLocale, subscribeLocale, t, translate, translateSystemMessage, chatMessageText } from '../shared/i18n.ts';
import { coreMessages } from '../client/catalog-core.ts';
import { advancedMessages } from '../client/catalog-advanced.ts';
import { domainMessages } from '../shared/catalog-domain.ts';
import { Store } from '../server/store.ts';

const slots = (text: string) => [...new Set([...text.matchAll(/\{([A-Za-z][\w]*)\}/g)].map(match => match[1]))].sort();

test('every catalogue has five complete translations with matching interpolation slots', () => {
  assert.deepEqual(LOCALES, ['en', 'es', 'uk', 'pl', 'cs']);
  assert.equal(isLocale('ru'), false); assert.equal(isLocale(null), false);
  for (const catalogue of [coreMessages, advancedMessages, domainMessages]) {
    for (const [key, entry] of Object.entries(catalogue)) {
      for (const locale of LOCALES) {
        assert.ok(entry[locale]?.trim(), `${locale}: ${key}`);
        assert.deepEqual(slots(entry[locale]), slots(key), `${locale}: ${key}`);
      }
    }
  }
});

test('language changes notify subscribers and preserve interpolated user text verbatim', () => {
  assert.equal(getLocale(), 'en');
  let changes = 0; const unsubscribe = subscribeLocale(() => changes++);
  try {
    for (const locale of LOCALES) {
      setLocale(locale);
      assert.equal(t('Language'), messages.Language[locale]);
      const userText = 'Mira {spell} <em>north</em>';
      assert.ok(translate('Invalid field {name}.', { name: userText }, locale).includes(userText));
    }
    assert.equal(changes, 4); setLocale('cs'); assert.equal(changes, 4);
    assert.throws(() => setLocale('xx' as 'en'), /Unsupported language/);
    assert.equal(getLocale(), 'cs');
  } finally { unsubscribe(); setLocale('en'); }
});

test('system errors are translated without changing unknown or captured content', () => {
  try {
    for (const locale of LOCALES) {
      setLocale(locale);
      assert.equal(translateSystemMessage('Only the GM can export.'), translate('Only the GM can export.', {}, locale));
      assert.equal(translateSystemMessage('Invalid field heroName.'), translate('Invalid field {name}.', { name: 'heroName' }, locale));
      assert.equal(translateSystemMessage('/actors/0: Invalid field heroName.'), '/actors/0: ' + translate('Invalid field {name}.', { name: 'heroName' }, locale));
      assert.equal(translateSystemMessage('A completely custom campaign note'), 'A completely custom campaign note');
    }
  } finally { setLocale('en'); }
});

test('generated chat localizes controlled terms but keeps character names and player messages', () => {
  const generated = { text: 'Mira · Heal · healing: 8', system: { key: '{actor} · {action} · {kind}: {total}', parameters: { actor: 'Mira', action: 'Heal', kind: 'healing', total: 8 }, localizedParameters: ['kind'] } };
  try {
    for (const locale of LOCALES) {
      setLocale(locale);
      assert.equal(chatMessageText(generated), translate(generated.system.key, { ...generated.system.parameters, kind: t('healing') }, locale));
      assert.equal(chatMessageText({ text: generated.text }), generated.text);
    }
  } finally { setLocale('en'); }
});

test('new campaign examples use the requested language while entered names and existing campaigns stay intact', () => {
  const store = new Store(':memory:');
  try {
    for (const locale of LOCALES) {
      const auth = store.create('My campaign', 'My GM', locale), session = store.authenticate(auth.token);
      const before = store.snapshot(session);
      assert.equal(before.campaign.name, 'My campaign'); assert.equal(before.self.name, 'My GM');
      assert.equal(before.campaign.scenes[0].name, domainMessages['Observatory hall'][locale]);
      assert.equal(before.campaign.journals[0].name, domainMessages['Welcome to BRAMA'][locale]);
      setLocale(locale === 'uk' ? 'es' : 'uk');
      assert.deepEqual(store.snapshot(session), before);
    }
    assert.throws(() => store.create('Invalid', 'GM', 'ru'), /Unsupported locale/);
    const auth = store.create('English default', 'GM');
    assert.equal(store.snapshot(store.authenticate(auth.token)).campaign.scenes[0].name, 'Observatory hall');
  } finally { store.close(); setLocale('en'); }
});
