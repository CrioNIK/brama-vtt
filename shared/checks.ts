import { ABILITY_KEYS, SKILL_ABILITIES, SKILL_KEYS } from './model.ts';
import type { AbilityKey, ActorChecks, ActorSheet, CheckBlockedReason, CheckPreview, CheckRequest, CheckSnapshot, RollMode, SkillKey } from './model.ts';
import { abilityBreakdown, EFFECT_LIMITS } from './abilities.ts';

const modes = ['normal', 'advantage', 'disadvantage'] as const;
const integer = (value: unknown, min = -1000, max = 1000): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const mode = (value: unknown): value is RollMode => modes.includes(value as RollMode);
const bonus = (value: unknown) => exact(value, ['bonus', 'mode']) && integer(value.bonus) && mode(value.mode);

/** Explicit manual initialization; legacy Actors never acquire this profile implicitly. */
export function blankActorChecks(): ActorChecks {
  return { profile: 'dnd5e-checks-v1', version: 0, proficiency: { mode: 'unknown', bonus: null, level: null },
    global: { check: { bonus: 0, mode: 'normal' }, skill: { bonus: 0, mode: 'normal' }, save: { bonus: 0, mode: 'normal' } },
    abilities: Object.fromEntries(ABILITY_KEYS.map(key => [key, { check: { bonus: 0, mode: 'normal' } }])) as ActorChecks['abilities'],
    skills: Object.fromEntries(SKILL_KEYS.map(key => [key, { ability: SKILL_ABILITIES[key], proficiency: 0, bonus: 0, passiveBonus: 0, mode: 'normal' }])) as ActorChecks['skills'],
    saves: Object.fromEntries(ABILITY_KEYS.map(key => [key, { proficiency: 0, bonus: 0, mode: 'normal' }])) as ActorChecks['saves'], unsupported: [] };
}

/** Strict shared boundary: no formula strings, foreign keys, or silent numeric coercion. */
export function validActorChecks(value: unknown): value is ActorChecks {
  if (!exact(value, ['profile', 'version', 'proficiency', 'global', 'abilities', 'skills', 'saves', 'unsupported']) || value.profile !== 'dnd5e-checks-v1' || !Number.isSafeInteger(value.version) || (value.version as number) < 0) return false;
  const p = value.proficiency;
  if (!exact(p, ['mode', 'bonus', 'level'])) return false;
  if (p.mode === 'unknown') { if (p.bonus !== null || p.level !== null) return false; }
  else if (p.mode === 'manual') { if (!integer(p.bonus, 0) || p.level !== null) return false; }
  else if (p.mode === 'class-level') { if (!integer(p.level, 0) || p.bonus !== Math.floor((p.level + 7) / 4)) return false; }
  else return false;
  if (!exact(value.global, ['check', 'skill', 'save']) || !Object.values(value.global).every(bonus)) return false;
  if (!exact(value.abilities, ABILITY_KEYS) || !Object.values(value.abilities).every(v => exact(v, ['check']) && bonus(v.check))) return false;
  if (!exact(value.skills, SKILL_KEYS) || !Object.values(value.skills).every(v => exact(v, ['ability', 'proficiency', 'bonus', 'passiveBonus', 'mode']) && ABILITY_KEYS.includes(v.ability as AbilityKey) && [0, 0.5, 1, 2].includes(v.proficiency as number) && integer(v.bonus) && integer(v.passiveBonus) && mode(v.mode))) return false;
  if (!exact(value.saves, ABILITY_KEYS) || !Object.values(value.saves).every(v => exact(v, ['proficiency', 'bonus', 'mode']) && [0, 1].includes(v.proficiency as number) && integer(v.bonus) && mode(v.mode))) return false;
  if (!Array.isArray(value.unsupported) || value.unsupported.length > 512) return false;
  return value.unsupported.every(v => exact(v, ['scope', 'key', 'code', 'reason']) && ['all', 'skill', 'save', 'ability'].includes(v.scope as string) &&
    (v.key === null || (v.scope === 'skill' ? SKILL_KEYS : v.scope === 'all' ? [] : ABILITY_KEYS).includes(v.key as never)) &&
    typeof v.code === 'string' && v.code.length > 0 && v.code.length <= 120 && typeof v.reason === 'string' && v.reason.length > 0 && v.reason.length <= 2000);
}

export function combinedCheckMode(values: RollMode[]): RollMode {
  const advantage = values.includes('advantage'), disadvantage = values.includes('disadvantage');
  return advantage === disadvantage ? 'normal' : advantage ? 'advantage' : 'disadvantage';
}

/** Pure preview; the server uses the same arithmetic before it draws any dice. */
export function previewCheck(actor: Pick<ActorSheet, 'sheetKind' | 'abilities' | 'effects' | 'checks' | 'progression'>, request: CheckRequest): CheckPreview {
  const blockedReasons: CheckBlockedReason[] = [];
  const block = (code: string, reason: string) => blockedReasons.push({ code, reason });
  const snapshot: CheckSnapshot = { kind: request.kind, key: request.key, checksVersion: actor.checks?.version ?? null,
    ability: null, defaultAbility: null, abilityOverride: request.abilityOverride ?? null, abilityBreakdown: null,
    proficiency: { mode: 'unknown', bonus: null, level: null, multiplier: 0, contribution: 0 }, bonusContributions: [], modeContributions: [],
    configuredMode: 'normal', requestedMode: request.mode ?? 'default', mode: 'normal', modifier: null, passive: null, passiveBonus: 0 };
  const result = (): CheckPreview => ({ modifier: snapshot.modifier, passive: snapshot.passive, mode: snapshot.mode, blockedReasons, snapshot });
  if (!['ability', 'skill', 'save'].includes(request.kind) || !(request.kind === 'skill' ? SKILL_KEYS : ABILITY_KEYS).includes(request.key as never) ||
    request.abilityOverride !== undefined && (request.kind !== 'skill' || !ABILITY_KEYS.includes(request.abilityOverride)) ||
    request.situationalBonus !== undefined && !integer(request.situationalBonus) || !['default', ...modes].includes(request.mode ?? 'default')) {
    block('VALIDATION', "Invalid check, ability, mode or situational bonus."); return result();
  }
  if (actor.sheetKind !== 'dnd5e') block('CHECKS_UNAVAILABLE', "Checks require a D&D 5e character sheet.");
  if (actor.checks === undefined) { block('CHECKS_UNAVAILABLE', "The checks profile has not been configured."); return result(); }
  if (!validActorChecks(actor.checks)) { block('CHECKS_INVALID', "The checks profile contains unsupported or invalid data."); return result(); }
  const checks = structuredClone(actor.checks);
  if (actor.progression) {
    const pg = actor.progression;
    snapshot.progression = { version: pg.version, profile: { ...pg.profile }, profileName: pg.profileName, proficiencyPolicy: pg.proficiencyPolicy, baseProficiency: { ...checks.proficiency },
      baseMultiplier: request.kind === 'skill' ? checks.skills[request.key as SkillKey].proficiency : request.kind === 'save' ? checks.saves[request.key as AbilityKey].proficiency : 0,
      grantIds: pg.grants.filter(g => g.active && (g.spec.kind === 'skill' && request.kind === 'skill' && g.spec.skill === request.key || g.spec.kind === 'save' && request.kind === 'save' && g.spec.ability === request.key)).map(g => g.id) };
    for (const k of SKILL_KEYS) checks.skills[k].proficiency = Math.max(checks.skills[k].proficiency, pg.checkOverlay.skills[k] ?? 0) as 0 | 0.5 | 1 | 2;
    for (const k of ABILITY_KEYS) checks.saves[k].proficiency = Math.max(checks.saves[k].proficiency, pg.checkOverlay.saves[k] ?? 0) as 0 | 1;
    if (pg.proficiencyPolicy === 'profile' && pg.checkOverlay.proficiency !== null) checks.proficiency = { mode: 'manual', bonus: pg.checkOverlay.proficiency, level: null };
  }
  const skill = request.kind === 'skill' ? checks.skills[request.key as SkillKey] : null;
  const save = request.kind === 'save' ? checks.saves[request.key as AbilityKey] : null;
  const defaultAbility = skill?.ability ?? request.key as AbilityKey, ability = request.abilityOverride ?? defaultAbility;
  snapshot.defaultAbility = defaultAbility; snapshot.ability = ability;
  snapshot.abilityBreakdown = abilityBreakdown(actor, ability);
  const score = snapshot.abilityBreakdown.effective, abilityModifier = snapshot.abilityBreakdown.modifier;
  if (score === null) block('ABILITY_UNKNOWN', "The ability score is unknown.");
  else if (!Number.isFinite(score) || score < EFFECT_LIMITS.derivedMin || score > EFFECT_LIMITS.derivedMax || !Number.isInteger(abilityModifier)) block('ABILITY_INVALID', "The effective ability score is outside supported limits.");
  const multiplier = skill?.proficiency ?? save?.proficiency ?? 0;
  const contribution = multiplier === 0 ? 0 : checks.proficiency.bonus === null ? null : Math.floor(checks.proficiency.bonus * multiplier);
  snapshot.proficiency = { ...checks.proficiency, multiplier, contribution };
  if (contribution === null) block('PROFICIENCY_UNKNOWN', "The proficiency bonus is unknown for the selected proficiency.");
  const add = (key: string, value: { bonus: number; mode: RollMode }) => { snapshot.bonusContributions.push({ key, value: value.bonus }); snapshot.modeContributions.push({ key, mode: value.mode }); };
  if (save) { add('global.save', checks.global.save); add('save', save); }
  else {
    add('global.check', checks.global.check);
    if (skill) add('global.skill', checks.global.skill);
    add('ability', checks.abilities[ability].check);
    if (skill) add('skill', skill);
  }
  snapshot.bonusContributions.push({ key: 'situational', value: request.situationalBonus ?? 0 });
  snapshot.configuredMode = combinedCheckMode(snapshot.modeContributions.map(value => value.mode));
  snapshot.mode = snapshot.requestedMode === 'default' ? snapshot.configuredMode : snapshot.requestedMode;
  snapshot.passiveBonus = skill?.passiveBonus ?? 0;
  for (const entry of checks.unsupported) {
    const applies = entry.scope === 'all' || entry.scope === 'ability' && request.kind !== 'save' && (entry.key === null || entry.key === ability) ||
      entry.scope === request.kind && (entry.key === null || entry.key === request.key);
    if (applies) block('CHECK_UNSUPPORTED', `${entry.code}: ${entry.reason}`);
  }
  if (!blockedReasons.length && abilityModifier !== null && contribution !== null) {
    snapshot.modifier = abilityModifier + contribution + snapshot.bonusContributions.reduce((sum, entry) => sum + entry.value, 0);
    if (skill) snapshot.passive = 10 + snapshot.modifier - (request.situationalBonus ?? 0) + snapshot.passiveBonus + (snapshot.configuredMode === 'advantage' ? 5 : snapshot.configuredMode === 'disadvantage' ? -5 : 0);
  }
  return result();
}
