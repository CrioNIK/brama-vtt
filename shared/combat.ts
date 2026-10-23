import type { Actor, Combat, Combatant } from './model.ts';
import { abilityBreakdown } from './abilities.ts';

export const COMBAT_LIMITS = { entries: 200, receipts: 5000, history: 1000, counter: 1_000_000, initiative: 2_000_000, round: 1_000_000 } as const;
export function blankCombat(version = 1): Combat {
  return { active: false, round: 0, turn: 0, combatants: [], version, settings: { skipDefeated: true, allowPlayerEndTurn: false }, counterHistory: [] };
}
/** Preserve legacy order, current index and nullable initiative; add no rolls or events. */
export function normalizeCombat(value: Combat): Combat {
  const combat = { ...blankCombat(), ...value };
  combat.settings = { skipDefeated: value.settings?.skipDefeated ?? true, allowPlayerEndTurn: value.settings?.allowPlayerEndTurn ?? false };
  combat.counterHistory ??= [];
  combat.combatants = value.combatants.map((entry, i) => ({ kind: 'token', hidden: false, defeated: false, tieRank: i, ...entry }));
  return combat;
}
export function sortCombatants(entries: Combatant[]): void {
  entries.sort((a, b) => (b.initiative ?? -Infinity) - (a.initiative ?? -Infinity)
    || (a.tieRank ?? 0) - (b.tieRank ?? 0) || a.id.localeCompare(b.id));
}
export function preserveCombatCurrent(combat: Combat, id: string | undefined): void {
  combat.turn = combat.active ? Math.max(0, combat.combatants.findIndex(e => e.id === id)) : 0;
}
/** Token deletion uses the same successor policy as explicit roster removal. */
export function removeCombatEntries(combat: Combat, remove: (entry: Combatant) => boolean): boolean {
  const before = combat.combatants, index = combat.turn, current = before[index];
  const remaining = before.filter(entry => !remove(entry));
  if (remaining.length === before.length) return false;
  const ids = new Set(remaining.map(e => e.id));
  const next = current && ids.has(current.id) ? current
    : [...before.slice(index + 1), ...before.slice(0, index)].find(e => ids.has(e.id) && (!combat.settings.skipDefeated || !e.defeated));
  combat.combatants = remaining; combat.counterHistory = [];
  if (!remaining.length || combat.active && !next) { combat.active = false; combat.round = 0; combat.turn = 0; }
  else preserveCombatCurrent(combat, next?.id);
  return true;
}
export function initiativePreview(actor?: Actor): { modifier: number | null; source: 'dex' | 'base'; reason: string | null } {
  if (!actor) return { modifier: 0, source: 'base', reason: null };
  const value = abilityBreakdown(actor, 'dex').modifier;
  return { modifier: value, source: 'dex', reason: value === null ? "Dexterity is unknown. The GM can set initiative or a formula explicitly." : null };
}
