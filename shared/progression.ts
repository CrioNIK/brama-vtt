import type { AbilityKey, AbilityScores, Actor, ActorAction, ActorChecks, ActorItem, ActorResource, SkillKey } from './model.ts';
import { ABILITY_KEYS, SKILL_KEYS, DAMAGE_TYPES, blankActorSheet } from './model.ts';
import { blankActorChecks } from './checks.ts';
import { derivedAbilitiesWithinBounds } from './abilities.ts';

export interface ProfileRef { id: string; version: number }
/** key identifies one capability even when several sources grant it. */
export type GrantSpec =
  | { key: string; kind: 'ability'; ability: AbilityKey; value: number }
  | { key: string; kind: 'skill'; skill: SkillKey; rank: 0.5 | 1 | 2 }
  | { key: string; kind: 'save'; ability: AbilityKey }
  | { key: string; kind: 'hp'; value: number }
  | { key: string; kind: 'action'; definitionKey: string }
  | { key: string; kind: 'item'; definitionKey: string }
  | { key: string; kind: 'resource'; definitionKey: string; capacity: number };
export interface ProgressionOption { key: string; name: string; grants: GrantSpec[] }
export interface ProgressionChoice { key: string; name: string; count: number; options: ProgressionOption[] }
export interface ProgressionClass { key: string; name: string; levels: { level: number; grants: GrantSpec[]; choices: ProgressionChoice[] }[] }
export type ProfileAction = Omit<ActorAction, 'id' | 'version' | 'costs' | 'spellId' | 'casting' | 'inheritance'> & { key: string; costs: { resourceKey: string; amount: number }[] };
export type ProfileResource = Omit<ActorResource, 'id' | 'value' | 'max'> & { key: string };
export type ProfileItem = Omit<ActorItem, 'id'> & { key: string };
export interface ProgressionDefinition {
  name: string; description: string; maxLevel: number; abilityArray: number[]; baseHp: number;
  /** Index zero is total level one. No implicit rule-system progression. */
  proficiencyByLevel: number[];
  backgrounds: ProgressionOption[]; classes: ProgressionClass[];
  actions: ProfileAction[]; resources: ProfileResource[]; items: ProfileItem[];
}
export interface ProgressionProfile extends ProgressionDefinition, ProfileRef {}
export interface ProgressionStep { id: string; classKey: string; choices: { choiceKey: string; optionKeys: string[] }[] }
export interface BaselineClass { classKey: string; level: number }
export interface ProgressionPlan {
  operation: 'create' | 'adopt' | 'level-up' | 'respec'; backgroundKey: string | null;
  steps: ProgressionStep[]; proficiencyPolicy: 'profile' | 'preserve';
  baseAbilities?: AbilityScores; baselineClasses?: BaselineClass[];
}
export interface CharacterGrant { id: string; originKey: string; sourceLabel: string; spec: GrantSpec; active: boolean }
export interface GrantBinding {
  kind: 'effect' | 'action' | 'resource' | 'item'; definitionKey: string; entityId: string;
  grantIds: string[]; active: boolean; spent?: number | null;
}
export interface ProgressionBaseline {
  abilities: AbilityScores; hp: number | null; maxHp: number | null; checks?: ActorChecks;
  entityIds: { items: string[]; actions: string[]; resources: string[]; effects: string[] };
  classes: BaselineClass[];
}
export interface ActorProgression {
  version: number; profile: ProfileRef; profileName: string; origin: 'created' | 'adopted'; baseline: ProgressionBaseline;
  backgroundKey: string | null; steps: ProgressionStep[]; grants: CharacterGrant[]; bindings: GrantBinding[];
  proficiencyPolicy: 'profile' | 'preserve';
  checkOverlay: { skills: Partial<Record<SkillKey, 0.5 | 1 | 2>>; saves: Partial<Record<AbilityKey, 1>>; proficiency: number | null };
}
export interface ProgressionRequiredChoice { stepId: string; classKey: string; classLevel: number; key: string; name: string; count: number; options: ProgressionOption[]; selected: string[] }
export interface ProgressionDiffEntry { kind: 'ability' | 'skill' | 'save' | 'hp' | 'proficiency' | 'action' | 'resource' | 'item' | 'grant'; key: string; label: string; operation: 'add' | 'keep' | 'update' | 'revoke' | 'retain'; before: unknown; after: unknown }
export interface ProgressionPreview {
  ready: boolean; blockedReasons: { code: string; reason: string }[]; requiredChoices: ProgressionRequiredChoice[];
  diff: ProgressionDiffEntry[]; grants: CharacterGrant[]; summary: { totalLevel: number; classLevels: BaselineClass[]; hp: number | null; maxHp: number | null };
  previewKey: string; actor: Actor;
}
export interface ProgressionCommitReceipt {
  id: string; commandId: string; actor: { id: string; name: string }; author: { id: string; name: string }; createdAt: string;
  operation: ProgressionPlan['operation']; profile: ProgressionProfile; plan: ProgressionPlan; previewKey: string;
  before: { progression: ActorProgression | null; hp: number | null; maxHp: number | null };
  after: { progression: ActorProgression; hp: number | null; maxHp: number | null };
  diff: ProgressionDiffEntry[];
}

export const PROGRESSION_LIMITS = { levels: 20, classes: 20, definitions: 200, choices: 10, options: 50, grants: 2000, receipts: 1000, profiles: 200 } as const;
const rec = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, any> => rec(v) && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const integer = (v: unknown, min = 0, max = 100000): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const text = (v: unknown, max = 120, empty = false): v is string => typeof v === 'string' && v.length <= max && (empty || !!v.trim()) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
const key = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(v);
const array = (v: unknown, max: number): v is any[] => Array.isArray(v) && v.length <= max;
const unique = (a: { key: string }[]) => new Set(a.map(v => v.key)).size === a.length;
export function progressionCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(progressionCanonical).join(',')}]`;
  if (rec(value)) return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${progressionCanonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function digest(value: unknown): string {
  let h = 14695981039346656037n;
  for (const char of progressionCanonical(value)) h = BigInt.asUintN(64, (h ^ BigInt(char.codePointAt(0)!)) * 1099511628211n);
  return h.toString(16).padStart(16, '0');
}
function outcomeValid(v: unknown): boolean {
  if (!rec(v)) return false;
  if (v.kind === 'manual') return fields(v, ['kind', 'text']) && text(v.text, 20000, true);
  if (v.kind === 'roll') return fields(v, ['kind', 'ability', 'modifier', 'mode']) && (v.ability === null || ABILITY_KEYS.includes(v.ability)) && integer(v.modifier, -1000, 1000) && (v.ability === null || v.modifier === 0) && ['normal', 'advantage', 'disadvantage'].includes(v.mode);
  return ['damage', 'healing'].includes(v.kind) && fields(v, ['kind', 'parts', 'allowCritical']) && typeof v.allowCritical === 'boolean' && (v.kind !== 'healing' || !v.allowCritical) && array(v.parts, 20) && v.parts.length > 0 && v.parts.every(p => fields(p, ['number', 'denomination', 'bonus', 'type']) && integer(p.number, 1, 100) && integer(p.denomination, 2, 1000) && integer(p.bonus, -100000, 100000) && (v.kind === 'healing' ? p.type === 'healing' : DAMAGE_TYPES.includes(p.type))) && v.parts.reduce((s: number, p: any) => s + p.number, 0) <= 100;
}
/** Validates definitions, not published metadata; messages are safe to show in the structured editor. */
export function validateProgressionProfile(input: unknown): string[] {
  const errors: string[] = [], bad = (message: string) => { errors.push(message); };
  if (!fields(input, ['name', 'description', 'maxLevel', 'abilityArray', 'baseHp', 'proficiencyByLevel', 'backgrounds', 'classes', 'actions', 'resources', 'items'], ['id', 'version'])) return ["Invalid progression profile fields."];
  const p = input;
  if (!text(p.name) || !text(p.description, 20000, true) || !integer(p.maxLevel, 1, 20) || !integer(p.baseHp)) bad("A name, description, level limit from 1 to 20 and integer base HP are required.");
  if (!array(p.abilityArray, 6) || p.abilityArray.length !== 6 || !p.abilityArray.every(v => integer(v, 1, 30))) bad("The ability array must contain exactly six integers from 1 to 30.");
  if (!array(p.proficiencyByLevel, 20) || p.proficiencyByLevel.length !== p.maxLevel || !p.proficiencyByLevel.every(v => integer(v, 0, 1000))) bad("The proficiency table must specify an integer for every level.");
  if (!array(p.classes, 20) || !p.classes.length || !array(p.backgrounds, 50) || !array(p.actions, 200) || !array(p.resources, 200) || !array(p.items, 200)) return [...errors, "The class, option or definition catalog exceeds its limits."];
  const identity = (list: any[], label: string) => { if (!list.every(v => rec(v) && key(v.key)) || !unique(list)) bad(`Unique keys are required: ${label}.`); };
  identity(p.classes, "classes"); identity(p.backgrounds, "backgrounds"); identity(p.actions, "actions"); identity(p.resources, "resources"); identity(p.items, "items");
  for (const a of p.actions) if (!fields(a, ['key', 'name', 'description', 'sourceLabel', 'category', 'known', 'prepared', 'requiresPreparation', 'enabled', 'target', 'costs', 'outcome']) || !text(a.name) || !text(a.description, 20000, true) || !text(a.sourceLabel, 120, true) || !text(a.category, 60) || !['known', 'prepared', 'requiresPreparation', 'enabled'].every(k => typeof a[k] === 'boolean') || !['none', 'self', 'token'].includes(a.target) || !array(a.costs, 20) || !a.costs.every((c: unknown) => fields(c, ['resourceKey', 'amount']) && key(c.resourceKey) && integer(c.amount, 1) && p.resources.some((r: any) => r?.key === c.resourceKey)) || new Set(a.costs.map((c: any) => c.resourceKey)).size !== a.costs.length || !outcomeValid(a.outcome)) bad("Invalid action definition or cost reference.");
  for (const r of p.resources) if (!fields(r, ['key', 'label'], ['kind', 'level', 'unit', 'recovery']) || !text(r.label) || r.kind !== undefined && !['custom', 'action', 'bonus-action', 'reaction', 'spell-slot', 'charge'].includes(r.kind) || r.level !== undefined && r.level !== null && !integer(r.level, 0, 9) || r.unit !== undefined && !text(r.unit, 40, true) || r.recovery !== undefined && !['manual', 'turn', 'short-rest', 'long-rest'].includes(r.recovery)) bad("Invalid resource definition.");
  for (const i of p.items) if (!fields(i, ['key', 'name', 'type', 'quantity', 'weight', 'weightUnit', 'description', 'equipped'], ['uses']) || !text(i.name) || !text(i.type, 60) || !integer(i.quantity) || typeof i.weight !== 'number' || !Number.isFinite(i.weight) || i.weight < 0 || i.weight > 100000 || !['lb', 'kg', 'unit'].includes(i.weightUnit) || !text(i.description, 20000, true) || typeof i.equipped !== 'boolean' || i.uses !== undefined && (!fields(i.uses, ['value', 'max']) || !integer(i.uses.max) || !integer(i.uses.value, 0, i.uses.max))) bad("Invalid item definition.");
  let grants = 0; const features = new Map<string, string>();
  const grantList = (list: unknown) => {
    if (!array(list, 200)) { bad("At most 200 grants are allowed per source."); return; }
    const local = new Set<string>();
    for (const g of list) {
      grants++;
      if (!rec(g) || !key(g.key) || local.has(g.key)) { bad("Grant keys must be unique within a source."); continue; }
      local.add(g.key);
      const valid = g.kind === 'ability' ? fields(g, ['key', 'kind', 'ability', 'value']) && ABILITY_KEYS.includes(g.ability) && integer(g.value, -100, 100)
        : g.kind === 'skill' ? fields(g, ['key', 'kind', 'skill', 'rank']) && SKILL_KEYS.includes(g.skill) && [0.5, 1, 2].includes(g.rank)
        : g.kind === 'save' ? fields(g, ['key', 'kind', 'ability']) && ABILITY_KEYS.includes(g.ability)
        : g.kind === 'hp' ? fields(g, ['key', 'kind', 'value']) && integer(g.value)
        : ['action', 'resource', 'item'].includes(g.kind) && fields(g, ['key', 'kind', 'definitionKey', ...(g.kind === 'resource' ? ['capacity'] : [])]) && key(g.definitionKey) && p[g.kind === 'action' ? 'actions' : g.kind === 'resource' ? 'resources' : 'items'].some((d: any) => d?.key === g.definitionKey) && (g.kind !== 'resource' || integer(g.capacity));
      if (!valid) { bad("Invalid grant or missing definition."); continue; }
      const spec = { ...g }; if (g.kind === 'resource') delete spec.capacity;
      const prior = features.get(g.key), signature = progressionCanonical(spec);
      if (prior !== undefined && prior !== signature) bad("One feature key cannot identify different effects.");
      features.set(g.key, signature);
    }
  };
  const option = (o: unknown) => { if (!fields(o, ['key', 'name', 'grants']) || !key(o.key) || !text(o.name)) { bad("Invalid choice option."); return; } grantList(o.grants); };
  p.backgrounds.forEach(option);
  for (const c of p.classes) {
    if (!fields(c, ['key', 'name', 'levels']) || !key(c.key) || !text(c.name) || !array(c.levels, 20) || !c.levels.length) { bad("Invalid class."); continue; }
    if (new Set(c.levels.map((v: any) => v?.level)).size !== c.levels.length) bad("A class level appears more than once.");
    for (const l of c.levels) {
      if (!fields(l, ['level', 'grants', 'choices']) || !integer(l.level, 1, p.maxLevel) || !array(l.choices, 10)) { bad("Invalid class level."); continue; }
      grantList(l.grants); identity(l.choices, "level choices");
      for (const ch of l.choices) {
        if (!fields(ch, ['key', 'name', 'count', 'options']) || !key(ch.key) || !text(ch.name) || !array(ch.options, 50) || !integer(ch.count, 1, ch.options.length)) { bad("A choice requires the exact number of available options."); continue; }
        identity(ch.options, "choice options"); ch.options.forEach(option);
      }
    }
  }
  if (grants > PROGRESSION_LIMITS.grants) bad("At most 2000 grants are allowed per profile.");
  return [...new Set(errors)];
}

export function draftProgressionActor(id: string, name: string, owners: string[] = []): Actor {
  return { ...blankActorSheet(), sheetKind: 'dnd5e', id, name, owners: [...owners], color: '#d5b270', hp: 0, maxHp: 0, notes: '', gmNotes: '' };
}
function classCounts(plan: ProgressionPlan, baseline: BaselineClass[] = []): BaselineClass[] {
  const counts = new Map(baseline.map(c => [c.classKey, c.level]));
  for (const step of plan.steps) counts.set(step.classKey, (counts.get(step.classKey) ?? 0) + 1);
  return [...counts].map(([classKey, level]) => ({ classKey, level }));
}
export function progressionChoices(profile: ProgressionProfile, plan: ProgressionPlan, baseline: BaselineClass[] = plan.baselineClasses ?? []): ProgressionRequiredChoice[] {
  if (!Array.isArray(plan?.steps) || !Array.isArray(profile?.classes)) return [];
  const counts = new Map(baseline.map(c => [c.classKey, c.level])), result: ProgressionRequiredChoice[] = [];
  for (const s of plan.steps) {
    const level = (counts.get(s.classKey) ?? 0) + 1; counts.set(s.classKey, level);
    for (const ch of profile.classes.find(c => c.key === s.classKey)?.levels.find(l => l.level === level)?.choices ?? []) {
      result.push({ stepId: s.id, classKey: s.classKey, classLevel: level, key: ch.key, name: ch.name, count: ch.count, options: structuredClone(ch.options), selected: s.choices?.find(c => c.choiceKey === ch.key)?.optionKeys ?? [] });
    }
  }
  return result;
}
export function managedBinding(actor: Pick<Actor, 'progression'>, kind: GrantBinding['kind'], entityId: string): GrantBinding | undefined {
  return actor.progression?.bindings.find(b => b.kind === kind && b.entityId === entityId);
}
export function syncManagedResource(actor: Actor, resourceId: string, operation: 'spend' | 'set' | 'recover', before?: number | null): void {
  const b = managedBinding(actor, 'resource', resourceId), r = actor.resources.find(r => r.id === resourceId);
  if (!b || !r) return;
  if (operation === 'recover') b.spent = 0;
  else if (operation === 'set') b.spent = r.value === null || r.max === null ? null : r.max - r.value;
  else if (b.spent === null || r.value === null || before === null || before === undefined) b.spent = null;
  else b.spent = (b.spent ?? 0) + before - r.value;
}
export function syncManagedItemUses(actor: Actor, itemId: string, operation: 'spend' | 'set', before?: number): void {
  const b = managedBinding(actor, 'item', itemId), i = actor.items.find(i => i.id === itemId);
  if (!b || !i?.uses) return;
  b.spent = operation === 'set' ? i.uses.max - i.uses.value : (b.spent ?? 0) + (before ?? i.uses.value) - i.uses.value;
}

/** Pure complete transition. No RNG, source inference, or writes; server recomputes this exact result. */
export function previewProgression(actor: Actor, profile: ProgressionProfile, plan: ProgressionPlan): ProgressionPreview {
  const next = structuredClone(actor), blockedReasons: ProgressionPreview['blockedReasons'] = [], diff: ProgressionDiffEntry[] = [];
  const result: ProgressionPreview = { ready: false, blockedReasons, requiredChoices: [], diff, grants: [], summary: { totalLevel: 0, classLevels: [], hp: actor.hp, maxHp: actor.maxHp }, previewKey: '', actor: next };
  const block = (code: string, reason: string) => blockedReasons.push({ code, reason });
  for (const reason of validateProgressionProfile(profile)) block('PROFILE_INVALID', reason);
  if (!uuid(profile?.id) || !integer(profile?.version, 1, Number.MAX_SAFE_INTEGER)) block('PROFILE_INVALID', "The profile must have a published version.");
  if (!fields(plan, ['operation', 'backgroundKey', 'steps', 'proficiencyPolicy'], ['baseAbilities', 'baselineClasses']) || !['create', 'adopt', 'level-up', 'respec'].includes(plan.operation) || !['profile', 'preserve'].includes(plan.proficiencyPolicy) || plan.backgroundKey !== null && !key(plan.backgroundKey) || !array(plan.steps, 20)) { block('PLAN_INVALID', "Invalid progression plan."); return result; }
  const p = plan as ProgressionPlan;
  if (p.steps.some(s => !fields(s, ['id', 'classKey', 'choices']) || !uuid(s.id) || !key(s.classKey) || !array(s.choices, 10) || s.choices.some(c => !fields(c, ['choiceKey', 'optionKeys']) || !key(c.choiceKey) || !array(c.optionKeys, 50) || !c.optionKeys.every(key) || new Set(c.optionKeys).size !== c.optionKeys.length) || new Set(s.choices.map(c => c.choiceKey)).size !== s.choices.length) || new Set(p.steps.map(s => s.id)).size !== p.steps.length) { block('PLAN_INVALID', "Steps and choices must have unique valid IDs."); return result; }
  if (p.baselineClasses !== undefined && (!array(p.baselineClasses, 20) || p.baselineClasses.some(c => !fields(c, ['classKey', 'level']) || !key(c.classKey) || !integer(c.level, 1, 20)) || new Set(p.baselineClasses.map(c => c.classKey)).size !== p.baselineClasses.length)) { block('PLAN_INVALID', "Invalid baseline class levels."); return result; }
  if (blockedReasons.length) return result;
  const old = actor.progression;
  if (['create', 'adopt'].includes(p.operation) === !!old) block('PROGRESSION_STATE', "The operation does not match the current progression state.");
  if (p.operation === 'create') {
    if (!fields(p.baseAbilities, [...ABILITY_KEYS]) || !ABILITY_KEYS.every(k => integer(p.baseAbilities![k], 1, 30)) || progressionCanonical(ABILITY_KEYS.map(k => p.baseAbilities![k]).sort((a, b) => a! - b!)) !== progressionCanonical([...profile.abilityArray].sort((a, b) => a - b))) block('ABILITIES_REQUIRED', "Assign all six ability-array values.");
    if (!p.steps.length || p.baselineClasses !== undefined) block('PLAN_INVALID', "Creation requires at least one level and does not accept baseline levels.");
  } else if (p.baseAbilities !== undefined) block('PLAN_INVALID', "The creation wizard sets base abilities; existing manual sheet values are preserved.");
  if (p.operation === 'adopt' && (p.steps.length || p.backgroundKey !== null || p.baselineClasses === undefined)) block('PLAN_INVALID', "Adoption records baseline classes without granting past features.");
  if (old && p.baselineClasses !== undefined && progressionCanonical(p.baselineClasses) !== progressionCanonical(old.baseline.classes)) block('BASELINE_IMMUTABLE', "Baseline levels cannot change after adoption.");
  if (old && old.profile.id !== profile.id) block('PROFILE_UNAVAILABLE', "Rebuilding selects a version of the current profile series.");
  if (old?.origin === 'adopted' && p.backgroundKey !== null) block('BASELINE_IMMUTABLE', "An adopted sheet keeps its original background.");
  if (p.operation === 'level-up' && old && (p.steps.length !== old.steps.length + 1 || progressionCanonical(p.steps.slice(0, -1)) !== progressionCanonical(old.steps) || p.backgroundKey !== old.backgroundKey || p.proficiencyPolicy !== old.proficiencyPolicy || profile.id !== old.profile.id || profile.version !== old.profile.version)) block('PLAN_INVALID', "Leveling up adds exactly one step to the current published version.");
  const baselineClasses = old?.baseline.classes ?? p.baselineClasses ?? [];
  if (baselineClasses.some(c => !profile.classes.some(d => d.key === c.classKey))) block('CLASS_UNAVAILABLE', "A baseline class is missing from the selected profile.");
  const counts = classCounts(p, baselineClasses), totalLevel = counts.reduce((s, c) => s + c.level, 0);
  result.summary = { ...result.summary, totalLevel, classLevels: counts };
  if (totalLevel > profile.maxLevel || totalLevel < (p.operation === 'adopt' ? 0 : 1)) block('LEVEL_LIMIT', "The total level is outside the profile limits.");
  if (p.operation !== 'adopt' && old?.origin !== 'adopted' && (profile.backgrounds.length ? !profile.backgrounds.some(b => b.key === p.backgroundKey) : p.backgroundKey !== null)) block('BACKGROUND_REQUIRED', "Select an available background.");
  result.requiredChoices = progressionChoices(profile, p, baselineClasses);
  const newGrants: CharacterGrant[] = [];
  const grant = (spec: GrantSpec, originKey: string, sourceLabel: string) => newGrants.push({ id: `grant-${digest([actor.id, originKey])}`, originKey, sourceLabel, spec: structuredClone(spec), active: true });
  if (p.operation !== 'adopt' && old?.origin !== 'adopted') {
    const bg = profile.backgrounds.find(b => b.key === p.backgroundKey);
    bg?.grants.forEach(g => grant(g, `background:${bg.key}:${g.key}`, bg.name));
  }
  const currentCounts = new Map(baselineClasses.map(c => [c.classKey, c.level]));
  for (const s of p.steps) {
    const level = (currentCounts.get(s.classKey) ?? 0) + 1; currentCounts.set(s.classKey, level);
    const cls = profile.classes.find(c => c.key === s.classKey), entry = cls?.levels.find(l => l.level === level);
    if (!cls || !entry) { block('CLASS_UNAVAILABLE', "The class or its next level is missing from the profile."); continue; }
    entry.grants.forEach(g => grant(g, `step:${s.id}:${g.key}`, `${cls.name} · ${level}`));
    if (s.choices.some(c => !entry.choices.some(ch => ch.key === c.choiceKey))) block('CHOICE_INVALID', "The plan contains a choice unavailable at this level.");
    for (const ch of entry.choices) {
      const selected = s.choices.find(c => c.choiceKey === ch.key)?.optionKeys ?? [];
      if (selected.length !== ch.count || selected.some(k => !ch.options.some(o => o.key === k))) { block('CHOICE_REQUIRED', `${ch.name}: select exactly ${ch.count}.`); continue; }
      for (const id of selected) { const option = ch.options.find(o => o.key === id)!; option.grants.forEach(g => grant(g, `step:${s.id}:${ch.key}:${id}:${g.key}`, `${cls.name} · ${level} · ${option.name}`)); }
    }
  }
  if (blockedReasons.length) return result;
  const baseline: ProgressionBaseline = old ? structuredClone(old.baseline) : {
    abilities: structuredClone(actor.abilities), hp: actor.hp, maxHp: p.operation === 'create' ? profile.baseHp : actor.maxHp,
    ...(actor.checks ? { checks: structuredClone(actor.checks) } : {}), classes: structuredClone(baselineClasses),
    entityIds: { items: actor.items.map(v => v.id), actions: actor.actions.map(v => v.id), resources: actor.resources.map(v => v.id), effects: actor.effects.map(v => v.id) },
  };
  if (p.operation === 'create') { next.abilities = structuredClone(p.baseAbilities!); baseline.abilities = structuredClone(next.abilities); }
  const history = new Map((old?.grants ?? []).map(g => [g.originKey, { ...structuredClone(g), active: false }]));
  newGrants.forEach(g => history.set(g.originKey, g));
  if (history.size > 4000) { block('LIMIT', "The character’s grant-history limit has been reached."); return result; }
  const bindings = structuredClone(old?.bindings ?? []), uniqueGrants = [...new Map(newGrants.map(g => [g.spec.key, g])).values()];
  const overlay: ActorProgression['checkOverlay'] = { skills: {}, saves: {}, proficiency: p.proficiencyPolicy === 'profile' && totalLevel > 0 ? profile.proficiencyByLevel[totalLevel - 1] : null };
  for (const g of uniqueGrants) { if (g.spec.kind === 'skill') overlay.skills[g.spec.skill] = Math.max(overlay.skills[g.spec.skill] ?? 0, g.spec.rank) as 0.5 | 1 | 2; if (g.spec.kind === 'save') overlay.saves[g.spec.ability] = 1; }
  const pg: ActorProgression = { version: (old?.version ?? 0) + 1, profile: { id: profile.id, version: profile.version }, profileName: profile.name, origin: old?.origin ?? (p.operation === 'create' ? 'created' : 'adopted'), baseline, backgroundKey: p.backgroundKey, steps: structuredClone(p.steps), grants: [...history.values()], bindings, proficiencyPolicy: p.proficiencyPolicy, checkOverlay: overlay };
  next.progression = pg; next.sheetKind = 'dnd5e';
  if (!next.checks) { next.checks = blankActorChecks(); next.checks.version = 1; }
  const binding = (kind: GrantBinding['kind'], definitionKey: string, sources: CharacterGrant[]) => {
    let b = bindings.find(v => v.kind === kind && v.definitionKey === definitionKey);
    if (!b) {
      b = { kind, definitionKey, entityId: `pg-${digest([actor.id, kind, definitionKey])}`, grantIds: [], active: false };
      if ([...actor.actions, ...actor.resources, ...actor.items, ...actor.effects].some(v => v.id === b!.entityId)) block('IDENTITY_CONFLICT', "An existing manual object uses the grant identifier.");
      bindings.push(b);
    }
    b.grantIds = sources.map(g => g.id); b.active = sources.length > 0; return b;
  };
  const activeAbilities = uniqueGrants.filter(g => g.spec.kind === 'ability');
  if (activeAbilities.length || bindings.some(b => b.kind === 'effect')) {
    const b = binding('effect', 'abilities', newGrants.filter(g => g.spec.kind === 'ability'));
    const changes = ABILITY_KEYS.map(ability => ({ ability, mode: 'add' as const, value: activeAbilities.reduce((s, g) => s + (g.spec.kind === 'ability' && g.spec.ability === ability ? g.spec.value : 0), 0) })).filter(c => c.value !== 0);
    const effect = { id: b.entityId, name: "Character progression", description: "Managed by active profile grants.", disabled: !b.active, changes };
    next.effects = [...next.effects.filter(e => e.id !== b.entityId), effect];
  }
  const hpBonus = uniqueGrants.reduce((s, g) => s + (g.spec.kind === 'hp' ? g.spec.value : 0), 0);
  next.maxHp = baseline.maxHp === null ? null : baseline.maxHp + hpBonus;
  next.hp = p.operation === 'create' ? next.maxHp : actor.hp === null || next.maxHp === null ? actor.hp : Math.min(actor.hp, next.maxHp);
  const definitionKeys = (kind: 'action' | 'resource' | 'item') => [...new Set([...newGrants.flatMap(g => g.spec.kind === kind ? [(g.spec as { definitionKey: string }).definitionKey] : []), ...bindings.filter(b => b.kind === kind).map(b => b.definitionKey)])];
  for (const k of definitionKeys('resource')) {
    const sources = newGrants.filter(g => g.spec.kind === 'resource' && g.spec.definitionKey === k), b = binding('resource', k, sources), prior = next.resources.find(r => r.id === b.entityId), d = profile.resources.find(r => r.key === k);
    if (!sources.length) { if (prior) { prior.max = 0; prior.value = prior.value === null ? null : 0; } continue; }
    const capacity = Math.max(...sources.map(g => (g.spec as Extract<GrantSpec, { kind: 'resource' }>).capacity));
    if (b.spent === undefined) b.spent = prior ? prior.value === null || prior.max === null ? null : prior.max - prior.value : 0;
    const { key: ignored, ...definition } = d!;
    const r: ActorResource = { ...definition, id: b.entityId, max: capacity, value: b.spent === null ? null : Math.max(0, capacity - b.spent), kind: d!.kind ?? 'custom', level: d!.level ?? null, unit: d!.unit ?? '', recovery: d!.recovery ?? 'manual' };
    next.resources = [...next.resources.filter(v => v.id !== b.entityId), r];
  }
  for (const k of definitionKeys('action')) {
    const sources = newGrants.filter(g => g.spec.kind === 'action' && g.spec.definitionKey === k), b = binding('action', k, sources), prior = next.actions.find(a => a.id === b.entityId), d = profile.actions.find(a => a.key === k);
    if (!sources.length) { if (prior && (prior.known || prior.enabled)) { prior.known = false; prior.enabled = false; prior.version++; } continue; }
    const { key: ignored, costs, ...definition } = d!;
    const mappedCosts = costs.map(c => { const rb = bindings.find(v => v.kind === 'resource' && v.definitionKey === c.resourceKey && v.active); if (!rb) block('GRANT_DEPENDENCY', `“${d!.name}” requires an active grant of resource ${c.resourceKey}.`); return { resourceId: rb?.entityId ?? '', amount: c.amount }; });
    const a: ActorAction = { ...structuredClone(definition), id: b.entityId, version: prior?.version ?? 1, prepared: prior?.prepared ?? d!.prepared, costs: mappedCosts };
    if (prior && progressionCanonical({ ...prior, version: 0 }) !== progressionCanonical({ ...a, version: 0 })) a.version++;
    next.actions = [...next.actions.filter(v => v.id !== b.entityId), a];
  }
  for (const k of definitionKeys('item')) {
    const sources = newGrants.filter(g => g.spec.kind === 'item' && g.spec.definitionKey === k), b = binding('item', k, sources), prior = next.items.find(i => i.id === b.entityId), d = profile.items.find(i => i.key === k);
    // Issued equipment remains physical inventory after entitlement revocation. Regrant never refills it.
    if (!sources.length) continue;
    const { key: ignored, ...definition } = d!;
    const i: ActorItem = { ...structuredClone(definition), id: b.entityId, quantity: prior?.quantity ?? d!.quantity, equipped: prior?.equipped ?? d!.equipped };
    if (i.uses) { b.spent ??= prior?.uses ? prior.uses.max - prior.uses.value : i.uses.max - i.uses.value; i.uses.value = Math.max(0, i.uses.max - b.spent); }
    if (prior?.uses && !i.uses || prior && !prior.uses && i.uses) block('ITEM_DEFINITION_CONFLICT', "A published version cannot change whether a granted item has a counter.");
    next.items = [...next.items.filter(v => v.id !== b.entityId), i];
  }
  if (!derivedAbilitiesWithinBounds(next) || next.maxHp !== null && !integer(next.maxHp) || next.actions.length > 200 || next.resources.length > 50 || next.items.length > 200 || next.effects.length > 100 || bindings.length > 500) block('LIMIT', "The result exceeds character-sheet limits.");
  const ownedIds = bindings.map(b => b.entityId), allEntities = [...next.actions, ...next.resources, ...next.items, ...next.effects];
  if (new Set(ownedIds).size !== ownedIds.length || ownedIds.some(id => allEntities.filter(v => v.id === id).length !== 1)) block('IDENTITY_CONFLICT', "Granted object identifiers conflict.");
  const addDiff = (kind: ProgressionDiffEntry['kind'], k: string, label: string, before: unknown, after: unknown, forced?: ProgressionDiffEntry['operation']) => diff.push({ kind, key: k, label, operation: forced ?? (before === undefined ? 'add' : after === undefined ? 'revoke' : progressionCanonical(before) === progressionCanonical(after) ? 'keep' : 'update'), before: before ?? null, after: after ?? null });
  for (const b of bindings) {
    if (b.kind === 'effect') continue;
    const list = b.kind === 'action' ? 'actions' : b.kind === 'resource' ? 'resources' : 'items';
    const before = actor[list].find(v => v.id === b.entityId), after = next[list].find(v => v.id === b.entityId);
    addDiff(b.kind, b.definitionKey, (after as ActorItem | undefined)?.name ?? (after as ActorResource | undefined)?.label ?? b.definitionKey, before, after, !b.active ? b.kind === 'item' ? 'retain' : 'revoke' : undefined);
  }
  addDiff('ability', 'abilities', "Ability bonuses", actor.effects.filter(e => old?.bindings.some(b => b.kind === 'effect' && b.entityId === e.id)), next.effects.filter(e => bindings.some(b => b.kind === 'effect' && b.entityId === e.id)));
  addDiff('hp', 'hp', "Health", { hp: actor.hp, maxHp: actor.maxHp }, { hp: next.hp, maxHp: next.maxHp });
  addDiff('proficiency', 'proficiency', "Proficiency bonus", old?.checkOverlay.proficiency ?? null, overlay.proficiency);
  addDiff('skill', 'skills', "Skill proficiencies", old?.checkOverlay.skills ?? {}, overlay.skills);
  addDiff('save', 'saves', "Saving throw proficiencies", old?.checkOverlay.saves ?? {}, overlay.saves);
  for (const g of history.values()) { const prior = old?.grants.find(v => v.originKey === g.originKey); if (g.active || prior?.active) addDiff('grant', g.id, g.sourceLabel, prior, g, !g.active ? 'revoke' : undefined); }
  result.grants = pg.grants; result.summary.hp = next.hp; result.summary.maxHp = next.maxHp;
  result.previewKey = digest({ actor: { id: actor.id, abilities: actor.abilities, hp: actor.hp, maxHp: actor.maxHp, checks: actor.checks, effects: actor.effects, items: actor.items, resources: actor.resources, actions: actor.actions, progression: actor.progression }, profile, plan });
  result.ready = blockedReasons.length === 0;
  return result;
}
