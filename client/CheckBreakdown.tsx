import { t, getLocale } from '../shared/i18n';
import type { CheckSnapshot } from '../shared/model';
import { ABILITY_NAMES, signed } from './ability-ui';
import { CHECK_MODE_NAMES, PROFICIENCY_NAMES, proficiencySource } from './checks-ui';

const bonusName = (key: string) => ({
  'global.check': t("All ability checks"), 'global.skill': t("All skills"), 'global.save': t("All saving throws"),
  ability: t("Selected ability bonus"), skill: t("Skill bonus"), save: t("Saving throw bonus"), situational: t("Situational bonus"),
}[key] ?? key);
export function CheckBreakdown({ snapshot, historical = false }: { snapshot: CheckSnapshot; historical?: boolean }) {
  const a = snapshot.abilityBreakdown, p = snapshot.proficiency;
  if (!a || !snapshot.ability) return <p className="muted small">{t("The calculation appears once valid settings are provided.")}</p>;
  return <div className="check-breakdown">
    <dl>
      <div><dt>{ABILITY_NAMES[snapshot.ability]}{snapshot.abilityOverride ? t(" · overridden for this roll") : ''}</dt><dd>{a.base ?? '—'}{a.totalBonus ? ` ${signed(a.totalBonus)}` : ''} → {a.effective ?? '—'} ({a.modifier === null ? '—' : signed(a.modifier)})</dd></div>
      <div><dt>{t("Proficiency bonus ·")} {snapshot.progression?.proficiencyPolicy === 'profile' ? `${snapshot.progression.profileName} v${snapshot.progression.profile.version}` : proficiencySource(p)}</dt><dd>{p.bonus === null ? '—' : signed(p.bonus)}</dd></div>
      <div><dt>{PROFICIENCY_NAMES[p.multiplier] ?? t("Proficiency")} · ×{p.multiplier}</dt><dd>{p.contribution === null ? '—' : signed(p.contribution)}</dd></div>
      {snapshot.bonusContributions.filter(part => part.value !== 0).map((part, index) => <div key={`${part.key}-${index}`}><dt>{bonusName(part.key)}</dt><dd>{signed(part.value)}</dd></div>)}
      <div className="check-total"><dt>{t("Total modifier")}</dt><dd>{snapshot.modifier === null ? '—' : signed(snapshot.modifier)}</dd></div>
    </dl>
    {snapshot.progression && <p className="muted small">{t("Progression:")} {snapshot.progression.profileName} {t("· profile version")} {snapshot.progression.profile.version}{t(", character revision")} {snapshot.progression.version}{t(". Base proficiency:")} {PROFICIENCY_NAMES[snapshot.progression.baseMultiplier]}{t("; with active grants:")} {PROFICIENCY_NAMES[p.multiplier]}{t(". Duplicate proficiencies do not stack.")}</p>}
    {a.contributions.length > 0 && <ul>{a.contributions.map((part, i) => <li key={`${part.effectId}-${i}`}>{part.effectName}: {signed(part.value)} {t("to ability score")}</li>)}</ul>}
    <p>{t("From sheet:")} {CHECK_MODE_NAMES[snapshot.configuredMode].toLocaleLowerCase(getLocale())}. {snapshot.requestedMode === 'default' ? t("Using the sheet’s mode.") : t("For this roll: {value0}.", { value0: CHECK_MODE_NAMES[snapshot.mode].toLocaleLowerCase(getLocale()) })}</p>
    {snapshot.kind === 'skill' && <p>{t("Passive score:")} {snapshot.passive ?? '—'} {t("· 10 + skill modifier + passive bonus")} {signed(snapshot.passiveBonus)}{t("; sheet advantage / disadvantage adds +5 / −5. Situational bonuses and one-off mode changes are excluded.")}</p>}
    {snapshot.modeContributions.some(part => part.mode !== 'normal') && <ul>{snapshot.modeContributions.filter(part => part.mode !== 'normal').map((part, i) => <li key={`${part.key}-${i}`}>{bonusName(part.key)}: {CHECK_MODE_NAMES[part.mode].toLocaleLowerCase(getLocale())}</li>)}</ul>}
    {historical && <p className="muted">{t("Saved calculation, settings version")} {snapshot.checksVersion}{t(". Later sheet changes do not affect it.")}</p>}
  </div>;
}
