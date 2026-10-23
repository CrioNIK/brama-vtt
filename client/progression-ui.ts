import { t } from '../shared/i18n';
import { ABILITY_KEYS } from '../shared/model';
import type { BaselineClass, GrantSpec, ProgressionDefinition, ProgressionDiffEntry, ProgressionPlan, ProgressionProfile } from '../shared/progression';
import { progressionChoices } from '../shared/progression';
import { ABILITY_NAMES, signed } from './ability-ui';
import { SKILL_NAMES } from './checks-ui';

export const operationName = { get create() { return t("Creation"); }, get adopt() { return t("Start tracking progression"); }, get 'level-up'() { return t("Level up"); }, get respec() { return t("Rebuild"); } };
export const changeName = { get add() { return t("Will be added"); }, get keep() { return t("Will be kept"); }, get update() { return t("Will change"); }, get revoke() { return t("Will be revoked"); }, get retain() { return t("Will remain with the character"); } };
export function progressionDiffLabel(entry: Pick<ProgressionDiffEntry, 'kind' | 'label'>): string {
  const fixedLabels: Partial<Record<ProgressionDiffEntry['kind'], string>> = {
    ability: 'Ability bonuses', hp: 'Health', proficiency: 'Proficiency bonus',
    skill: 'Skill proficiencies', save: 'Saving throw proficiencies',
  };
  return fixedLabels[entry.kind] ? t(fixedLabels[entry.kind]!) : entry.label;
}
export function reconcileProgressionChoices(profile: ProgressionProfile, plan: ProgressionPlan, baselineClasses: BaselineClass[] = plan.baselineClasses ?? []): ProgressionPlan {
  const next = { ...plan, backgroundKey: profile.backgrounds.some(b => b.key === plan.backgroundKey) ? plan.backgroundKey : null,
    steps: plan.steps.map(step => ({ ...step, classKey: profile.classes.some(c => c.key === step.classKey) ? step.classKey : '' })) };
  const required = progressionChoices(profile, next, baselineClasses);
  return { ...next, steps: next.steps.map(step => ({ ...step, choices: required.filter(c => c.stepId === step.id).map(c => ({ choiceKey: c.key,
    optionKeys: [...new Set(step.choices.find(old => old.choiceKey === c.key)?.optionKeys ?? [])].filter(key => c.options.some(o => o.key === key)).slice(0, c.count) })) })) };
}
export function grantLabel(grant: GrantSpec, profile: ProgressionDefinition): string {
  if (grant.kind === 'ability') return `${ABILITY_NAMES[grant.ability]} ${signed(grant.value)}`;
  if (grant.kind === 'skill') return `${SKILL_NAMES[grant.skill]} · ${grant.rank === 2 ? t("expertise") : grant.rank === 0.5 ? t("half proficiency") : t("proficiency")}`;
  if (grant.kind === 'save') return t("Saving throw: {value0}", { value0: ABILITY_NAMES[grant.ability] });
  if (grant.kind === 'hp') return t("Maximum HP {value0}", { value0: signed(grant.value) });
  if (grant.kind === 'resource') return t("{value0} · maximum {value1}", { value0: profile.resources.find(r => r.key === grant.definitionKey)?.label ?? t("Resource"), value1: grant.capacity });
  return (grant.kind === 'action' ? profile.actions : profile.items).find(d => d.key === grant.definitionKey)?.name ?? t("Definition missing");
}
export function valueLabel(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  if (typeof value === 'boolean') return value ? t("Yes") : t("No");
  if (Array.isArray(value)) return value.map(valueLabel).join(', ');
  const record = value as Record<string, unknown>;
  if ('value' in record && 'max' in record) return `${valueLabel(record.value)} / ${valueLabel(record.max)}`;
  if ('name' in record) return String(record.name);
  if ('label' in record) return String(record.label);
  return Object.entries(record).map(([key, item]) => `${({ hp: 'HP', maxHp: t("Max HP"), bonus: t("Bonus"), level: t("Level"), capacity: t("Capacity"), spent: t("Spent"), active: t("Active"), proficiency: t("Proficient"), rank: t("Proficient"), value: t("Value"), max: t("Maximum") } as Record<string, string>)[key] ?? key}: ${valueLabel(item)}`).join(' · ');
}
export const latestProfiles = (profiles: ProgressionProfile[]) => profiles.filter(p => !profiles.some(other => other.id === p.id && other.version > p.version));
export const newKey = () => crypto.randomUUID();

/** Editable example rules for a new progression profile. */
export function expeditionProfile(): ProgressionDefinition {
  const abilityChoice = { key: 'focus', name: t("Strong point"), count: 1, options: ABILITY_KEYS.map(ability => ({ key: ability, name: ABILITY_NAMES[ability], grants: [{ key: `focus-${ability}`, kind: 'ability' as const, ability, value: 2 }] })) };
  const skills = (values: ('ath' | 'prc' | 'sur' | 'ins' | 'arc' | 'his')[]) => ({ key: 'training', name: t("Two training skills"), count: 2, options: values.map(skill => ({ key: skill, name: SKILL_NAMES[skill], grants: [{ key: `training-${skill}`, kind: 'skill' as const, skill, rank: 1 as const }] })) });
  const basic: GrantSpec[] = [{ key: 'observe', kind: 'action', definitionKey: 'observe' }, { key: 'turn-action', kind: 'resource', definitionKey: 'turn-action', capacity: 1 }];
  return {
    name: t("Expedition"), description: t("An editable rules example with two progression paths, skill and strength choices, actions and resources."),
    maxLevel: 5, abilityArray: [15, 14, 13, 12, 10, 8], baseHp: 0, proficiencyByLevel: [2, 2, 2, 2, 3],
    backgrounds: [
      { key: 'guide', name: t("Guide"), grants: [{ key: 'observe', kind: 'action', definitionKey: 'observe' }, { key: 'training-sur', kind: 'skill', skill: 'sur', rank: 1 }] },
      { key: 'archivist', name: t("Archivist"), grants: [{ key: 'training-his', kind: 'skill', skill: 'his', rank: 1 }] },
    ],
    classes: [
      { key: 'warden', name: t("Warden"), levels: Array.from({ length: 5 }, (_, i) => ({ level: i + 1, grants: [{ key: `warden-hp-${i + 1}`, kind: 'hp', value: i === 0 ? 10 : 4 }, ...(i === 0 ? [...basic, { key: 'save-str', kind: 'save' as const, ability: 'str' as const }] : []), ...(i === 1 ? [{ key: 'field-heal', kind: 'action' as const, definitionKey: 'field-heal' }, { key: 'supply', kind: 'resource' as const, definitionKey: 'supply', capacity: 2 }] : []), ...(i === 3 ? [{ key: 'supply', kind: 'resource' as const, definitionKey: 'supply', capacity: 3 }] : [])], choices: i === 0 ? [skills(['ath', 'prc', 'sur', 'ins']), abilityChoice] : [] })) },
      { key: 'researcher', name: t("Researcher"), levels: Array.from({ length: 5 }, (_, i) => ({ level: i + 1, grants: [{ key: `researcher-hp-${i + 1}`, kind: 'hp', value: i === 0 ? 8 : 3 }, ...(i === 0 ? [...basic, { key: 'save-int', kind: 'save' as const, ability: 'int' as const }] : []), ...(i === 1 ? [{ key: 'field-heal', kind: 'action' as const, definitionKey: 'field-heal' }, { key: 'supply', kind: 'resource' as const, definitionKey: 'supply', capacity: 1 }] : [])], choices: i === 0 ? [skills(['arc', 'his', 'prc', 'ins']), abilityChoice] : [] })) },
    ],
    resources: [{ key: 'turn-action', label: t("Action"), kind: 'action', level: null, unit: t("action"), recovery: 'turn' }, { key: 'supply', label: t("Field supplies"), kind: 'charge', level: null, unit: t("charge"), recovery: 'long-rest' }],
    actions: [
      { key: 'observe', name: t("Observe"), description: t("A Wisdom check to observe the surroundings."), sourceLabel: t("Expedition training"), category: t("Exploration"), known: true, prepared: true, requiresPreparation: false, enabled: true, target: 'none', costs: [{ resourceKey: 'turn-action', amount: 1 }], outcome: { kind: 'roll', ability: 'wis', modifier: 0, mode: 'normal' } },
      { key: 'field-heal', name: t("Field aid"), description: t("Spend an action and one supply charge. Roll healing and apply HP as separate steps."), sourceLabel: t("Expedition progression"), category: t("Aid"), known: true, prepared: true, requiresPreparation: false, enabled: true, target: 'self', costs: [{ resourceKey: 'turn-action', amount: 1 }, { resourceKey: 'supply', amount: 1 }], outcome: { kind: 'healing', parts: [{ number: 1, denomination: 4, bonus: 1, type: 'healing' }], allowCritical: false } },
    ], items: [],
  };
}
