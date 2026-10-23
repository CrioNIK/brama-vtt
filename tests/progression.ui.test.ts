import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expeditionProfile, reconcileProgressionChoices } from '../client/progression-ui.ts';
import { draftProgressionActor, previewProgression, progressionChoices, validateProgressionProfile } from '../shared/progression.ts';
import type { ProgressionChoice, ProgressionPlan, ProgressionProfile } from '../shared/progression.ts';
import { abilityBreakdown } from '../shared/abilities.ts';
import { previewAction } from '../shared/actions.ts';
import { previewCheck } from '../shared/checks.ts';

const choice = (options: string[], count = 1, key = 'choice'): ProgressionChoice => ({ key, name: key, count, options: options.map(key => ({ key, name: key, grants: [] })) });
function profile(): ProgressionProfile {
  return { id: randomUUID(), version: 2, name: 'Reconciliation fixture', description: '', maxLevel: 3, baseHp: 1, abilityArray: [15, 14, 13, 12, 10, 8], proficiencyByLevel: [2, 2, 3],
    backgrounds: [{ key: 'bg', name: 'Background', grants: [] }], classes: [{ key: 'a', name: 'A', levels: [
      { level: 1, grants: [], choices: [choice(['one', 'three', 'four'], 2)] }, { level: 2, grants: [], choices: [choice(['second'])] }, { level: 3, grants: [], choices: [choice(['third'])] },
    ] }], resources: [], actions: [], items: [] };
}
const step = (optionKeys: string[], id = randomUUID()) => ({ id, classKey: 'a', choices: [{ choiceKey: 'choice', optionKeys }] });
const plan = (steps: ProgressionPlan['steps']): ProgressionPlan => ({ operation: 'respec', backgroundKey: 'bg', steps, proficiencyPolicy: 'preserve' });

test('version reconciliation removes invisible selected options that previously filled a required count', () => {
  const p = profile(), draft = plan([step(['one', 'removed'])]);
  draft.steps[0].choices.push({ choiceKey: 'deleted-choice', optionKeys: ['ghost'] });
  const before = structuredClone(draft), originalProfile = structuredClone(p), reconciled = reconcileProgressionChoices(p, draft);
  assert.deepEqual(reconciled.steps[0].choices, [{ choiceKey: 'choice', optionKeys: ['one'] }]);
  const required = progressionChoices(p, reconciled)[0]; assert.equal(required.count, 2); assert.equal(required.selected.length, 1);
  assert.ok(required.options.some(o => o.key === 'three')); // UI now has a free slot for the new visible option.
  assert.equal(reconciled.steps[0].id, draft.steps[0].id); assert.deepEqual(draft, before); assert.deepEqual(p, originalProfile);
});

test('reordering class steps resolves choices against new ordinal class levels instead of stale step IDs', () => {
  const p = profile(), first = step(['one', 'three']), second = step(['second']);
  const unchanged = reconcileProgressionChoices(p, plan([first, second]));
  assert.deepEqual(unchanged.steps.map(s => s.choices[0].optionKeys), [['one', 'three'], ['second']]);
  const reordered = reconcileProgressionChoices(p, plan([second, first]));
  assert.deepEqual(reordered.steps.map(s => s.id), [second.id, first.id]);
  assert.deepEqual(reordered.steps.map(s => s.choices[0].optionKeys), [[], []]);
  assert.deepEqual(progressionChoices(p, reordered).map(c => c.classLevel), [1, 2]);
});

test('adopted baseline offsets choice lookup while missing prior events remain absent', () => {
  const p = profile(), draft = plan([step(['third'])]), baseline = [{ classKey: 'a', level: 2 }];
  const reconciled = reconcileProgressionChoices(p, draft, baseline);
  assert.deepEqual(reconciled.steps[0].choices, [{ choiceKey: 'choice', optionKeys: ['third'] }]);
  assert.equal(progressionChoices(p, reconciled, baseline)[0].classLevel, 3); assert.equal(reconciled.steps.length, 1);
  assert.deepEqual(reconcileProgressionChoices(p, draft).steps[0].choices[0].optionKeys, []);
  assert.deepEqual(reconcileProgressionChoices(p, { ...draft, baselineClasses: baseline }).steps[0].choices[0].optionKeys, ['third']);
});

test('deleted classes/backgrounds are cleared and lowered counts retain only distinct permitted selections', () => {
  const p = profile(); p.classes[0].levels[0].choices[0].count = 1;
  const draft = { ...plan([step(['one', 'one', 'three']), { ...step(['third']), classKey: 'deleted-class' }]), backgroundKey: 'deleted-bg' };
  const reconciled = reconcileProgressionChoices(p, draft);
  assert.equal(reconciled.backgroundKey, null); assert.deepEqual(reconciled.steps[0].choices[0].optionKeys, ['one']);
  assert.equal(reconciled.steps[1].classKey, ''); assert.deepEqual(reconciled.steps[1].choices, []);
  assert.equal(reconciled.proficiencyPolicy, 'preserve'); assert.equal(reconciled.operation, 'respec');
});

test('the shipped authored example creates a real sheet and level two grants executable resource-linked healing', () => {
  const p = { ...expeditionProfile(), id: randomUUID(), version: 1 }; assert.deepEqual(validateProgressionProfile(p), []);
  const owner = randomUUID(), draft = draftProgressionActor(randomUUID(), 'Example hero', [owner]);
  const first = { id: randomUUID(), classKey: 'warden', choices: [{ choiceKey: 'training', optionKeys: ['ath', 'sur'] }, { choiceKey: 'focus', optionKeys: ['str'] }] };
  const creation: ProgressionPlan = { operation: 'create', backgroundKey: 'guide', steps: [first], proficiencyPolicy: 'profile', baseAbilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 } };
  const initial = previewProgression(draft, p, creation); assert.deepEqual(initial.blockedReasons, []); assert.equal(initial.actor.hp, 10);
  assert.equal(abilityBreakdown(initial.actor, 'str').effective, 17); assert.equal(initial.actor.actions.filter(a => a.name === 'Observe').length, 1);
  assert.equal(previewCheck(initial.actor, { kind: 'skill', key: 'sur' }).snapshot.proficiency.multiplier, 1);
  const levelUp: ProgressionPlan = { operation: 'level-up', backgroundKey: 'guide', steps: [first, { id: randomUUID(), classKey: 'warden', choices: [] }], proficiencyPolicy: 'profile' };
  const advanced = previewProgression(initial.actor, p, levelUp); assert.deepEqual(advanced.blockedReasons, []); assert.equal(advanced.actor.hp, 10); assert.equal(advanced.actor.maxHp, 14);
  const healing = advanced.actor.actions.find(a => a.name === 'Field aid')!;
  const action = previewAction(advanced.actor, healing, { role: 'player', memberId: owner, visibleTokens: [] });
  assert.equal(action.available, true); assert.equal(action.costs.length, 2); assert.deepEqual(action.costs.map(c => c.amount), [1, 1]);
  assert.equal(healing.outcome.kind, 'healing'); assert.equal(advanced.actor.resources.find(r => r.label === 'Field supplies')!.max, 2);
});
