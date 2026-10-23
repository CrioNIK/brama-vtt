import { t } from '../shared/i18n';
import type { CheckSnapshot, SkillKey } from '../shared/model';
import { ABILITY_NAMES } from './ability-ui';

export const SKILL_NAMES: Record<SkillKey, string> = {
  get acr() { return t("Acrobatics"); }, get ani() { return t("Animal Handling"); }, get arc() { return t("Arcana"); }, get ath() { return t("Athletics"); },
  get dec() { return t("Deception"); }, get his() { return t("History"); }, get ins() { return t("Insight"); }, get itm() { return t("Intimidation"); },
  get inv() { return t("Investigation"); }, get med() { return t("Medicine"); }, get nat() { return t("Nature"); }, get prc() { return t("Perception"); },
  get prf() { return t("Performance"); }, get per() { return t("Persuasion"); }, get rel() { return t("Religion"); }, get slt() { return t("Sleight of Hand"); },
  get ste() { return t("Stealth"); }, get sur() { return t("Survival"); },
};
export const CHECK_MODE_NAMES = { get normal() { return t("Normal"); }, get advantage() { return t("Advantage"); }, get disadvantage() { return t("Disadvantage"); } };
export const PROFICIENCY_NAMES: Record<number, string> = { get 0() { return t("Not proficient"); }, get 0.5() { return t("Half proficiency"); }, get 1() { return t("Proficient"); }, get 2() { return t("Expertise"); } };
export function checkName(kind: string, key: string) {
  return kind === 'skill' ? SKILL_NAMES[key as SkillKey] : `${kind === 'save' ? t("Saving throw: ") : t("Check: ")}${ABILITY_NAMES[key as keyof typeof ABILITY_NAMES]}`;
}
export function proficiencySource(value: CheckSnapshot['proficiency']) {
  return value.mode === 'class-level' ? t("From total level {value0}", { value0: value.level }) : value.mode === 'manual' ? t("Set manually") : t("Unknown");
}
