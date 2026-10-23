import { ABILITY_KEYS } from './model.ts';
import type { AbilityBreakdown, AbilityKey, AbilityScores, ActorEffect } from './model.ts';

export const EFFECT_LIMITS = { effects: 100, changes: 20, value: 100, derivedMin: -1000, derivedMax: 1000, duration: 100000 } as const;
type AbilitySource = { abilities: AbilityScores; effects?: ActorEffect[] };

/** Pure derived view. Neither the stored scores nor the effect definitions are modified. */
export function abilityBreakdown(actor: AbilitySource, ability: AbilityKey): AbilityBreakdown {
  const contributions = (actor.effects ?? []).filter(effect => !effect.disabled).flatMap(effect =>
    effect.changes.filter(change => change.ability === ability).map(change => ({ effectId: effect.id, effectName: effect.name, value: change.value })));
  const totalBonus = contributions.reduce((sum, change) => sum + change.value, 0);
  const base = actor.abilities[ability], effective = base === null ? null : base + totalBonus;
  return { ability, base, effective, modifier: effective === null ? null : Math.floor((effective - 10) / 2), totalBonus, contributions };
}

export function effectiveAbilityScores(actor: AbilitySource): AbilityScores {
  return Object.fromEntries(ABILITY_KEYS.map(key => [key, abilityBreakdown(actor, key).effective])) as AbilityScores;
}

/** The supported domain is bounded explicitly; values are never silently clamped. */
export function derivedAbilitiesWithinBounds(actor: AbilitySource): boolean {
  return ABILITY_KEYS.every(key => {
    const score = abilityBreakdown(actor, key).effective;
    return score === null || Number.isFinite(score) && score >= EFFECT_LIMITS.derivedMin && score <= EFFECT_LIMITS.derivedMax;
  });
}
