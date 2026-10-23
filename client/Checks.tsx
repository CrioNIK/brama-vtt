import { t, getLocale, translateSystemMessage } from '../shared/i18n';
import { useEffect, useState } from 'react';
import { Check, Dices, Search, Settings2 } from 'lucide-react';
import { ABILITY_KEYS, SKILL_KEYS } from '../shared/model';
import type { AbilityKey, Actor, ActorChecks, Campaign, CheckKind, CheckRollMode, RollMode, SkillKey } from '../shared/model';
import { blankActorChecks, previewCheck, validActorChecks } from '../shared/checks';
import type { SendCommand } from './session';
import { DraftConflict, useDraft } from './draft';
import { ABILITY_NAMES, signed } from './ability-ui';
import { CheckBreakdown } from './CheckBreakdown';
import { checkName, CHECK_MODE_NAMES, PROFICIENCY_NAMES, proficiencySource, SKILL_NAMES } from './checks-ui';
import { RollDetails } from './Panels';

type Props = { actor: Actor; campaign: Campaign; command: SendCommand; online: boolean; hasDraft: boolean; markDirty: (section: string, dirty: boolean) => void };
const modeOptions = () => Object.entries(CHECK_MODE_NAMES).map(([value, name]) => <option value={value} key={value}>{name}</option>);
const int = (value: string) => value === '' ? NaN : Number(value);
const validBonus = (value: number) => Number.isInteger(value) && Math.abs(value) <= 1000;
const labelFor = (kind: CheckKind, key: string) => kind === 'skill' ? SKILL_NAMES[key as SkillKey] : ABILITY_NAMES[key as AbilityKey];
function BonusInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label className="field stacked"><span>{label}</span><input type="number" step="1" min="-1000" max="1000" value={Number.isNaN(value) ? '' : value} aria-invalid={!validBonus(value)} onChange={e => onChange(int(e.target.value))}/></label>;
}
function ModeInput({ label, value, onChange }: { label: string; value: RollMode; onChange: (value: RollMode) => void }) {
  return <label className="field stacked"><span>{label}</span><select value={value} onChange={e => onChange(e.target.value as RollMode)}>{modeOptions()}</select></label>;
}

export function Checks({ actor, campaign, command, online, hasDraft, markDirty }: Props) {
  const { draft, dirty, edit, reload, baseRevision, saved, conflict } = useDraft(actor.checks ?? blankActorChecks(), campaign.revision);
  const [kind, setKind] = useState<CheckKind>('skill'), [key, setKey] = useState<string>('prc'), [query, setQuery] = useState('');
  const [override, setOverride] = useState<AbilityKey | ''>(''), [mode, setMode] = useState<CheckRollMode>('default'), [situational, setSituational] = useState(0);
  const [visibility, setVisibility] = useState('public'), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  useEffect(() => { markDirty('checks', dirty); return () => markDirty('checks', false); }, [dirty, markDirty]);
  const previewActor = { ...actor, checks: draft };
  const request = { kind, key, ...(kind === 'skill' && override ? { abilityOverride: override } : {}), mode, situationalBonus: situational };
  const preview = previewCheck(previewActor, request);
  const keys = kind === 'skill' ? [...SKILL_KEYS].sort((a, b) => SKILL_NAMES[a].localeCompare(SKILL_NAMES[b], getLocale())) : ABILITY_KEYS;
  const valid = validActorChecks(draft);
  const last = [...campaign.chat].reverse().find(message => message.roll?.actor?.id === actor.id && message.roll.checkSnapshot);
  const selectedName = labelFor(kind, key);
  function select(nextKind: CheckKind, nextKey: string) { setKind(nextKind); setKey(nextKey); setOverride(''); setNotice(''); }
  function updateSkill(update: Partial<ActorChecks['skills'][SkillKey]>) { edit({ skills: { ...draft.skills, [key]: { ...draft.skills[key as SkillKey], ...update } } }); }
  function updateSave(update: Partial<ActorChecks['saves'][AbilityKey]>) { edit({ saves: { ...draft.saves, [key]: { ...draft.saves[key as AbilityKey], ...update } } }); }
  function updateAbility(ability: AbilityKey, update: Partial<ActorChecks['abilities'][AbilityKey]['check']>) {
    edit({ abilities: { ...draft.abilities, [ability]: { check: { ...draft.abilities[ability].check, ...update } } } });
  }
  async function save() {
    if (busy || !online || !valid || conflict) return;
    setBusy(true);
    try {
      const { version, ...checks } = draft;
      if (await command('actor.checks.update', { id: actor.id, checksVersion: actor.checks?.version ?? 0, checks }, dirty ? baseRevision : campaign.revision)) {
        saved(); setNotice(t("Check settings saved."));
      }
    } finally { setBusy(false); }
  }
  async function roll() {
    if (!actor.checks || busy || hasDraft || !online || preview.modifier === null || !validBonus(situational)) return;
    setBusy(true);
    try { if (await command('actor.check.roll', { id: actor.id, ...request, visibility }, campaign.revision)) setNotice(t("The roll and its calculation are saved in chat.")); }
    finally { setBusy(false); }
  }
  if (actor.sheetKind !== 'dnd5e') return <p className="empty">{t("Skills and saving throws require a D&D sheet. The GM can select it in Character.")}</p>;
  if (!actor.checks) return <section className="checks-intro"><Dices size={30}/><h3>{t("Skills and saving throws")}</h3><p>{t("Add 18 skills, 6 saving throws and ability checks. Defaults have no proficiency and an unknown proficiency bonus. Complete them for your character.")}</p><p className="muted small">{t("Uses a numeric proficiency bonus. Proficiency dice are not enabled.")}</p><button className="primary" disabled={!online || busy || hasDraft} onClick={() => void save()}>{t("Set up checks")}</button></section>;
  return <section className="checks-sheet"><fieldset disabled={busy}>
    <div className="checks-proficiency"><div><span>{t("Proficiency bonus")}</span><strong>{preview.snapshot.proficiency.bonus === null ? '—' : signed(preview.snapshot.proficiency.bonus)}</strong><small>{actor.progression?.proficiencyPolicy === 'profile' ? `${actor.progression.profileName} v${actor.progression.profile.version}` : proficiencySource({ ...draft.proficiency, multiplier: 1, contribution: draft.proficiency.bonus })}</small></div><p>{t("18 skills · 6 saving throws")}<br/><span className="muted">{t("Numeric proficiency bonus")}</span></p></div>
    <details className="checks-settings"><summary><Settings2 size={16}/> {t("Proficiency and global bonuses")}</summary><div className="checks-settings-body">
      {actor.progression && <p className="muted small">{t("Edit the sheet’s base settings here. Progression grants are added on top; the highest proficiency rank applies.")}{actor.progression.proficiencyPolicy === "profile" && t(" The proficiency bonus currently comes from the profile. Select the sheet policy when rebuilding to use its setting instead.")}</p>}
      <div className="checks-two-columns"><label className="field stacked"><span>{t("Proficiency bonus source")}</span><select value={draft.proficiency.mode} onChange={e => { const source = e.target.value as ActorChecks['proficiency']['mode']; edit({ proficiency: source === 'unknown' ? { mode: source, bonus: null, level: null } : source === 'manual' ? { mode: source, bonus: draft.proficiency.bonus ?? 0, level: null } : { mode: source, level: draft.proficiency.level ?? 1, bonus: Math.floor(((draft.proficiency.level ?? 1) + 7) / 4) } }); }}><option value="unknown">{t("Unknown")}</option><option value="manual">{t("Set manually")}</option><option value="class-level">{t("From total level")}</option></select></label>
      {draft.proficiency.mode === 'manual' && <label className="field stacked"><span>{t("Manual proficiency bonus")}</span><input type="number" min="0" max="1000" step="1" value={Number.isFinite(draft.proficiency.bonus) ? draft.proficiency.bonus! : ''} onChange={e => edit({ proficiency: { mode: 'manual', bonus: int(e.target.value), level: null } })}/></label>}
      {draft.proficiency.mode === 'class-level' && <label className="field stacked"><span>{t("Total level")}</span><input type="number" min="0" max="1000" step="1" value={Number.isFinite(draft.proficiency.level) ? draft.proficiency.level! : ''} onChange={e => { const level = int(e.target.value); edit({ proficiency: { mode: 'class-level', level, bonus: Math.floor((level + 7) / 4) } }); }}/></label>}</div>
      {draft.proficiency.mode === 'class-level' && <p className="muted small">{t("⌊(level + 7) / 4⌋. Set the total level here; classes and their features are chosen separately.")}</p>}
      {(['check', 'skill', 'save'] as const).map(group => <div className="checks-two-columns" key={group}><BonusInput label={t("Global bonus: {value0}", { value0: { check: t("ability checks"), skill: t("skills"), save: t("saving throws") }[group] })} value={draft.global[group].bonus} onChange={bonus => edit({ global: { ...draft.global, [group]: { ...draft.global[group], bonus } } })}/><ModeInput label={t("Mode: {value0}", { value0: { check: t("ability checks"), skill: t("skills"), save: t("saving throws") }[group] })} value={draft.global[group].mode} onChange={value => edit({ global: { ...draft.global, [group]: { ...draft.global[group], mode: value } } })}/></div>)}
      <p className="muted small">{t("The global check bonus also applies to skills. Saving throws use separate bonuses. Advantage and disadvantage from different sources cancel each other.")}</p>
    </div></details>
    {dirty && <p className="checks-draft" role="status">{t("Draft preview. Save settings before rolling.")}</p>}
    <nav className="check-kinds" aria-label={t("Check types")}>{(['skill', 'save', 'ability'] as const).map(value => <button key={value} aria-pressed={kind === value} onClick={() => { select(value, value === 'skill' ? 'prc' : 'str'); setQuery(''); }}>{value === 'skill' ? t("Skills · 18") : value === 'save' ? t("Saving throws · 6") : t("Abilities · 6")}</button>)}</nav>
    <div className="checks-workspace"><div className="checks-directory">
      <label className="directory-search"><Search size={16}/><input aria-label={t("Find check")} placeholder={t("Find check")} value={query} onChange={e => setQuery(e.target.value)}/></label>
      <div className="check-rows">{keys.filter(value => labelFor(kind, value).toLocaleLowerCase(getLocale()).includes(query.toLocaleLowerCase(getLocale()))).map(value => {
        const result = previewCheck(previewActor, { kind, key: value }), rank = result.snapshot.proficiency.multiplier;
        return <button className="check-row" aria-pressed={key === value} key={value} onClick={() => select(kind, value)} aria-label={t("Select: {value0}", { value0: checkName(kind, value) })}><span><strong>{labelFor(kind, value)}</strong><small>{result.snapshot.ability ? ABILITY_NAMES[result.snapshot.ability] : '—'}{kind !== 'ability' ? ` · ${PROFICIENCY_NAMES[rank]}` : ''}</small>{kind === 'skill' && <small>{t("Passive")} {result.passive ?? '—'}</small>}</span><b>{result.modifier === null ? '—' : signed(result.modifier)}</b></button>;
      })}</div>
    </div><div className="check-detail" aria-label={t("Check: {value0}", { value0: selectedName })}>
      <div className="section-title"><h3>{checkName(kind, key)}</h3><span className="check-modifier">{preview.modifier === null ? '—' : signed(preview.modifier)}</span></div>
      {kind === 'skill' && <label className="field stacked"><span>{t("Ability for this roll")}</span><select value={override} onChange={e => setOverride(e.target.value as AbilityKey | '')}><option value="">{t("From sheet (")}{ABILITY_NAMES[draft.skills[key as SkillKey].ability]})</option>{ABILITY_KEYS.map(ability => <option value={ability} key={ability}>{ABILITY_NAMES[ability]}</option>)}</select></label>}
      <div className="checks-two-columns"><label className="field stacked"><span>{t("Roll mode")}</span><select value={mode} onChange={e => setMode(e.target.value as CheckRollMode)}><option value="default">{t("From sheet (")}{CHECK_MODE_NAMES[preview.snapshot.configuredMode]})</option>{modeOptions()}</select></label><BonusInput label={t("Bonus for this roll")} value={situational} onChange={setSituational}/></div>
      <label className="field stacked"><span>{t("Check result visibility")}</span><select value={visibility} onChange={e => setVisibility(e.target.value)}><option value="public">{t("All participants")}</option><option value="gm">{t("GM only")}</option><option value="self">{t("Only me")}</option></select></label>
      {preview.blockedReasons.length > 0 && <div className="error" role="status"><strong>{t("Calculation unavailable")}</strong><ul>{preview.blockedReasons.map((reason, i) => <li key={`${reason.code}-${i}`}>{translateSystemMessage(reason.reason)}</li>)}</ul></div>}
      <button className="primary full-width" disabled={!online || busy || hasDraft || preview.modifier === null || !validBonus(situational)} onClick={() => void roll()}><Dices size={18}/>{t("Roll:")} {selectedName}</button>
      <details className="check-calculation" open><summary>{t("Result breakdown")}</summary><CheckBreakdown snapshot={preview.snapshot}/></details>
      <details className="checks-settings"><summary><Settings2 size={16}/> {t("Configure:")} {selectedName}</summary><div className="checks-settings-body">
        {kind === 'skill' && <><label className="field stacked"><span>{t("Default skill ability")}</span><select value={draft.skills[key as SkillKey].ability} onChange={e => updateSkill({ ability: e.target.value as AbilityKey })}>{ABILITY_KEYS.map(ability => <option value={ability} key={ability}>{ABILITY_NAMES[ability]}</option>)}</select></label><label className="field stacked"><span>{t("Base skill proficiency")}</span><select value={draft.skills[key as SkillKey].proficiency} onChange={e => updateSkill({ proficiency: Number(e.target.value) as 0 | 0.5 | 1 | 2 })}>{[0, 0.5, 1, 2].map(value => <option value={value} key={value}>{PROFICIENCY_NAMES[value]}</option>)}</select></label><BonusInput label={t("Skill bonus")} value={draft.skills[key as SkillKey].bonus} onChange={bonus => updateSkill({ bonus })}/><BonusInput label={t("Passive skill bonus")} value={draft.skills[key as SkillKey].passiveBonus} onChange={passiveBonus => updateSkill({ passiveBonus })}/><ModeInput label={t("Skill mode")} value={draft.skills[key as SkillKey].mode} onChange={mode => updateSkill({ mode })}/></>}
        {kind === 'save' && <><label className="field stacked"><span>{t("Base saving throw proficiency")}</span><select value={draft.saves[key as AbilityKey].proficiency} onChange={e => updateSave({ proficiency: Number(e.target.value) as 0 | 1 })}><option value="0">{t("Not proficient")}</option><option value="1">{t("Proficient")}</option></select></label><BonusInput label={t("Saving throw bonus")} value={draft.saves[key as AbilityKey].bonus} onChange={bonus => updateSave({ bonus })}/><ModeInput label={t("Saving throw mode")} value={draft.saves[key as AbilityKey].mode} onChange={mode => updateSave({ mode })}/></>}
        {kind === 'ability' && <><BonusInput label={t("Ability check bonus")} value={draft.abilities[key as AbilityKey].check.bonus} onChange={bonus => updateAbility(key as AbilityKey, { bonus })}/><ModeInput label={t("Ability check mode")} value={draft.abilities[key as AbilityKey].check.mode} onChange={mode => updateAbility(key as AbilityKey, { mode })}/><p className="muted small">{t("Also applies to skills using this ability.")}</p></>}
      </div></details>
    </div></div>
    {draft.unsupported.length > 0 && <details className="checks-unsupported"><summary>{t("Unsupported conditions (")}{draft.unsupported.length})</summary><p>{t("Affected checks are blocked to avoid incomplete calculations. Original data is preserved in the archive.")}</p><ul>{draft.unsupported.map((entry, i) => <li key={i}>{translateSystemMessage(entry.reason)}</li>)}</ul></details>}
    <DraftConflict show={conflict} reload={reload}/>
    {dirty && <div className="checks-save"><button onClick={reload}>{t("Discard changes")}</button><button className="primary" disabled={!online || busy || !valid || conflict} onClick={() => void save()}><Check size={17}/>{t("Save settings")}</button>{!valid && <p className="error" role="status">{t("Bonuses must be integers from −1000 to 1000. Proficiency bonus and level cannot be negative.")}</p>}</div>}
    {notice && <p className="sheet-success small" role="status">{translateSystemMessage(notice)}</p>}
    {last?.roll && <section className="sheet-last-roll" aria-label={t("Latest character check")}><h4>{last.text}</h4><div className="roll-card"><strong>{last.roll.formula}</strong><b>{last.roll.total}</b><RollDetails roll={last.roll}/></div></section>}
  </fieldset></section>;
}
