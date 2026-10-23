import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCALES, setLocale, t, translateSystemMessage } from '../shared/i18n.ts';
import { progressionDiffLabel } from '../client/progression-ui.ts';
import { progressionOperationLabel, recoveryOperationLabel } from '../client/operation-labels.ts';

test('progression diff localizes fixed labels while preserving authored object names', () => {
  try {
    for (const locale of LOCALES) {
      setLocale(locale);
      for (const [kind, label] of [
        ['ability', 'Ability bonuses'], ['hp', 'Health'], ['proficiency', 'Proficiency bonus'],
        ['skill', 'Skill proficiencies'], ['save', 'Saving throw proficiencies'],
      ] as const) assert.equal(progressionDiffLabel({ kind, label }), t(label));
      for (const kind of ['action', 'item', 'resource', 'grant'] as const) {
        assert.equal(progressionDiffLabel({ kind, label: 'Health' }), 'Health');
        assert.equal(progressionDiffLabel({ kind, label: 'Ярило / Brána {name}' }), 'Ярило / Brána {name}');
      }
    }
  } finally { setLocale('en'); }
});

test('Czech character levels remain distinct from scene floors', () => {
  try {
    setLocale('cs');
    assert.equal(t('New level'), 'Nová úroveň');
    assert.equal(t('levels'), 'úrovní');
    assert.equal(t('New floor'), 'Nové podlaží');
    assert.equal(t('floors'), 'podlaží');
  } finally { setLocale('en'); }
});

test('pending recovery labels are canonical and translate the complete event after switching locale', () => {
  try {
    for (const sourceLocale of LOCALES) {
      setLocale(sourceLocale);
      const labels = (['turn', 'short-rest', 'long-rest'] as const).map(recoveryOperationLabel);
      assert.deepEqual(labels, ['Recovery: New turn', 'Recovery: Short rest', 'Recovery: Long rest']);
      for (const locale of LOCALES) {
        setLocale(locale);
        for (const label of labels) assert.equal(translateSystemMessage(label), t(label));
      }
    }
    setLocale('en');
    assert.equal(translateSystemMessage('Відновлення: Короткий відпочинок'), 'Recovery: Short rest');
  } finally { setLocale('en'); }
});

test('pending progression labels switch language without translating character names', () => {
  const name = 'Health / Ярило / Brána {name}';
  try {
    for (const sourceLocale of LOCALES) {
      setLocale(sourceLocale);
      const cases = [
        ['create', 'Creation: {name}'], ['adopt', 'Start tracking progression: {name}'],
        ['level-up', 'Level up: {name}'], ['respec', 'Rebuild: {name}'],
      ] as const;
      for (const [operation, key] of cases) {
        const label = progressionOperationLabel(operation, name);
        assert.equal(label, key.replace('{name}', name));
        for (const locale of LOCALES) {
          setLocale(locale);
          assert.equal(translateSystemMessage(label), t(key, { name }));
          assert.ok(translateSystemMessage(label).includes(name));
        }
      }
    }
    setLocale('en');
    assert.equal(translateSystemMessage('Створення: Test character'), 'Creation: Test character');
    setLocale('uk');
    assert.equal(translateSystemMessage('Creation: Health'), t('Creation: {name}', { name: 'Health' }));
  } finally { setLocale('en'); }
});
