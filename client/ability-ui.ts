import { t as tr } from '../shared/i18n';
import type { AbilityKey } from '../shared/model';
export const ABILITY_NAMES: Record<AbilityKey, string> = { get str() { return tr("Strength"); }, get dex() { return tr("Dexterity"); }, get con() { return tr("Constitution"); }, get int() { return tr("Intelligence"); }, get wis() { return tr("Wisdom"); }, get cha() { return tr("Charisma"); } };
export const signed = (value: number) => `${value >= 0 ? '+' : ''}${value}`;
