import { t, translateSystemMessage } from '../shared/i18n';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Plus, Sparkles, Trash2, X } from 'lucide-react';
import { ABILITY_KEYS } from '../shared/model';
import type { AbilityKey, Actor, ActorEffect, Campaign } from '../shared/model';
import { derivedAbilitiesWithinBounds, EFFECT_LIMITS } from '../shared/abilities';
import type { SendCommand } from './session';
import { DraftConflict, useDraft } from './draft';
import { ABILITY_NAMES, signed } from './ability-ui';
import { managedBinding } from '../shared/progression';

type MarkDirty = (section: string, value: boolean) => void;
type Props = { actor: Actor; campaign: Campaign; command: SendCommand; online: boolean; markDirty: MarkDirty };
export function effectDuration(effect: ActorEffect): string {
  if (effect.duration?.rounds !== null && effect.duration?.rounds !== undefined) return t("{value0} rounds · reference only", { value0: effect.duration.rounds });
  if (effect.duration?.seconds !== null && effect.duration?.seconds !== undefined) return t("{value0} sec · reference only", { value0: effect.duration.seconds });
  return t("No duration specified");
}
export function EffectList(props: Props) {
  const { actor, command, online, markDirty } = props;
  const [editing, setEditing] = useState<string | null>(null), [retained, setRetained] = useState<ActorEffect>(), [editorDirty, setEditorDirty] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const selected = actor.effects.find(effect => effect.id === editing);
  useEffect(() => { if (selected) setRetained(selected); }, [selected]);
  const mark = useCallback<MarkDirty>((section, value) => { setEditorDirty(value); markDirty(section, value); }, [markDirty]);
  function open(id: string) {
    if (managedBinding(actor, 'effect', id)) { setNotice(t("This bonus comes from a profile. Review its sources and edit it in Progression.")); return; }
    if (editorDirty) { setNotice(t("Save or explicitly close the effect draft first.")); return; }
    setNotice(''); setRetained(actor.effects.find(effect => effect.id === id)); setEditing(id);
  }
  async function toggle(effect: ActorEffect) {
    if (!online || busy || editorDirty || managedBinding(actor, 'effect', effect.id)) return;
    const candidate = { ...actor, effects: actor.effects.map(current => current.id === effect.id ? { ...current, disabled: !current.disabled } : current) };
    if (!derivedAbilitiesWithinBounds(candidate)) { setNotice(t("This change exceeds the final ability range: −1000 to 1000.")); return; }
    setBusy(true); try { await command('actor.effect.update', { id: actor.id, effectId: effect.id, disabled: !effect.disabled }, true); } finally { setBusy(false); }
  }
  return <>
    <div className="section-title"><h3>{t("Effects")} <span className="muted">· {actor.effects.length}/{EFFECT_LIMITS.effects}</span></h3><button disabled={!online || busy || editorDirty || actor.effects.length >= EFFECT_LIMITS.effects} onClick={() => open('new')}><Plus size={17}/>{t("Add effect")}</button></div>
    <p className="muted small effect-scope">{t("Numeric ability bonuses are supported. Duration is informational: disable effects manually, even when rounds or seconds are specified.")}</p>
    {[false, true].map(disabled => <section className="effect-group" key={String(disabled)} aria-label={disabled ? t("Disabled effects") : t("Enabled effects")}><h4>{disabled ? t("Disabled") : t("Enabled")}</h4>
      {!actor.effects.some(effect => effect.disabled === disabled) && <p className="empty">{disabled ? t("No disabled effects.") : t("No enabled effects.")}</p>}
      {actor.effects.filter(effect => effect.disabled === disabled).map(effect => <div className={`effect-row ${editing === effect.id ? 'selected' : ''}`} key={effect.id}>
        <button className="effect-open" aria-label={t("Open effect: {value0}", { value0: effect.name })} disabled={busy} onClick={() => open(effect.id)}><Sparkles size={19}/><span><strong>{effect.name}</strong><small>{effect.changes.map(change => `${ABILITY_NAMES[change.ability]} ${signed(change.value)}`).join(' · ')}</small><small>{managedBinding(actor, 'effect', effect.id) ? t("Source: character progression") : effectDuration(effect)}</small></span></button>
        <div className="effect-actions"><span className={disabled ? 'muted' : 'effect-active'}>{disabled ? t("Disabled") : t("Enabled")}</span><button disabled={!online || busy || editorDirty || !!managedBinding(actor, 'effect', effect.id)} aria-label={t("{value0} effect: {value1}", { value0: disabled ? t("Enable") : t("Disable"), value1: effect.name })} onClick={() => void toggle(effect)}>{disabled ? t("Enable") : t("Disable")}</button></div>
      </div>)}
    </section>)}
    {notice && <p className="warning-box" role="status">{translateSystemMessage(notice)}</p>}
    {editing && <EffectEditor key={editing} {...props} effect={selected ?? retained} removed={editing !== 'new' && !selected} markDirty={mark} onClose={() => { setEditing(null); setRetained(undefined); setNotice(''); }}/>}
  </>;
}

type EffectDraft = { name: string; description: string; disabled: boolean; changes: { ability: AbilityKey; mode: 'add'; value: string }[]; durationMode: 'none' | 'rounds' | 'seconds'; durationValue: string };
function initialDraft(effect?: ActorEffect): EffectDraft {
  const rounds = effect?.duration?.rounds, seconds = effect?.duration?.seconds;
  return { name: effect?.name ?? '', description: effect?.description ?? '', disabled: effect?.disabled ?? false,
    changes: effect ? effect.changes.map(change => ({ ...change, value: String(change.value) })) : [{ ability: 'str', mode: 'add', value: '2' }],
    durationMode: rounds != null ? 'rounds' : seconds != null ? 'seconds' : 'none', durationValue: rounds != null ? String(rounds) : seconds != null ? String(seconds) : '' };
}
function EffectEditor({ actor, effect, removed, campaign, command, online, markDirty, onClose }: Props & { effect?: ActorEffect; removed: boolean; onClose: () => void }) {
  const { draft, dirty, edit, reload, baseRevision, conflict } = useDraft(initialDraft(effect), campaign.revision);
  const [busy, setBusy] = useState(false), [deleting, setDeleting] = useState(false);
  useEffect(() => { markDirty('effect', dirty); return () => markDirty('effect', false); }, [dirty, markDirty]);
  const changes = draft.changes.map(change => ({ ...change, value: Number(change.value) }));
  const invalidChange = draft.changes.some(change => !change.value.trim() || !Number.isFinite(Number(change.value)) || Math.abs(Number(change.value)) > EFFECT_LIMITS.value);
  const durationNumber = Number(draft.durationValue);
  const invalidDuration = draft.durationMode !== 'none' && (!draft.durationValue.trim() || !Number.isFinite(durationNumber) || durationNumber < 0 || durationNumber > EFFECT_LIMITS.duration || (draft.durationMode === 'rounds' && !Number.isInteger(durationNumber)));
  const candidate: ActorEffect = { id: effect?.id ?? 'new-effect-draft', name: draft.name, description: draft.description, disabled: draft.disabled, changes };
  const validDerived = !invalidChange && derivedAbilitiesWithinBounds({ ...actor, effects: [...actor.effects.filter(current => current.id !== effect?.id), candidate] });
  const invalid = invalidChange || invalidDuration || !validDerived || !draft.changes.length || draft.changes.length > EFFECT_LIMITS.changes;
  const duration = draft.durationMode === 'none' ? null : { rounds: draft.durationMode === 'rounds' ? durationNumber : null, seconds: draft.durationMode === 'seconds' ? durationNumber : null };
  async function save(event: FormEvent) {
    event.preventDefault(); if (removed || conflict || invalid || busy || !online || !dirty || !draft.name.trim()) return;
    setBusy(true); try { if (await command(effect ? 'actor.effect.update' : 'actor.effect.create', { id: actor.id, ...(effect ? { effectId: effect.id } : {}), name: draft.name, description: draft.description, disabled: draft.disabled, changes, duration }, baseRevision)) onClose(); } finally { setBusy(false); }
  }
  async function remove() {
    if (!effect || removed || conflict || busy || !online) return;
    setBusy(true); try { if (await command('actor.effect.delete', { id: actor.id, effectId: effect.id }, baseRevision)) onClose(); } finally { setBusy(false); }
  }
  return <form className="sheet-editor effect-editor" onSubmit={save}>
    <div className="section-title"><h3>{effect ? t("Edit effect") : t("New effect")}</h3><button type="button" className="icon-button" disabled={busy} aria-label={t("Close effect draft")} onClick={onClose}><X size={18}/></button></div>
    {removed && <p className="warning-box" role="alert">{t("Another participant deleted this effect. Your draft is retained; copy it or explicitly close the editor.")}</p>}
    <DraftConflict show={conflict && !removed} reload={reload}/><fieldset disabled={busy}>
      <label className="field stacked"><span>{t("Effect name")}</span><input autoFocus required maxLength={120} value={draft.name} onChange={event => edit({ name: event.target.value })}/></label>
      <label className="check"><input type="checkbox" checked={!draft.disabled} onChange={event => edit({ disabled: !event.target.checked })}/> {t("Effect enabled")}</label>
      <div className="effect-change-heading"><h4>{t("Ability bonuses")}</h4><span className="muted small">{draft.changes.length}/{EFFECT_LIMITS.changes}</span></div>
      {draft.changes.map((change, index) => <div className="effect-change" key={index}>
        <label className="field stacked"><span>{t("Ability")} {index + 1}</span><select value={change.ability} aria-label={t("Change {value0}: ability", { value0: index + 1 })} onChange={event => edit({ changes: draft.changes.map((current, i) => i === index ? { ...current, ability: event.target.value as AbilityKey } : current) })}>{ABILITY_KEYS.map(key => <option key={key} value={key}>{ABILITY_NAMES[key]}</option>)}</select></label>
        <label className="field stacked"><span>{t("Increase")}</span><input type="number" required min={-EFFECT_LIMITS.value} max={EFFECT_LIMITS.value} step="any" aria-label={t("Change {value0}: bonus", { value0: index + 1 })} value={change.value} onChange={event => edit({ changes: draft.changes.map((current, i) => i === index ? { ...current, value: event.target.value } : current) })}/></label>
        <button className="icon-button danger" type="button" aria-label={t("Remove change {value0}", { value0: index + 1 })} disabled={draft.changes.length <= 1} onClick={() => edit({ changes: draft.changes.filter((_, i) => i !== index) })}><Trash2 size={16}/></button>
      </div>)}
      <button type="button" disabled={draft.changes.length >= EFFECT_LIMITS.changes} onClick={() => edit({ changes: [...draft.changes, { ability: 'str', mode: 'add', value: '0' }] })}><Plus size={16}/>{t("Add change")}</button>
      {invalidChange && <p className="error small" role="status">{t("Enter a numeric bonus from −100 to 100 for each change.")}</p>}
      {!invalidChange && !validDerived && <p className="error small" role="status">{t("The final ability exceeds −1000 to 1000. Change the bonuses or disable the effect.")}</p>}
      <div className="sheet-two-columns effect-duration-fields"><label className="field stacked"><span>{t("Duration · reference only")}</span><select value={draft.durationMode} onChange={event => edit({ durationMode: event.target.value as EffectDraft['durationMode'] })}><option value="none">{t("No duration specified")}</option><option value="rounds">{t("Rounds")}</option><option value="seconds">{t("Seconds")}</option></select></label>
        {draft.durationMode !== 'none' && <label className="field stacked"><span>{draft.durationMode === 'rounds' ? t("Number of rounds") : t("Number of seconds")}</span><input required type="number" min="0" max={EFFECT_LIMITS.duration} step={draft.durationMode === 'rounds' ? 1 : 'any'} value={draft.durationValue} onChange={event => edit({ durationValue: event.target.value })}/></label>}</div>
      {invalidDuration && <p className="error small" role="status">{t("Set duration from 0 to 100000; rounds must be an integer.")}</p>}
      <p className="muted small">{t("Duration does not start a timer. Disable the effect manually.")}</p>
      <label className="field stacked"><span>{t("Effect description")}</span><textarea rows={4} value={draft.description} maxLength={20000} onChange={event => edit({ description: event.target.value })}/></label>
      <div className="form-actions">{effect ? <button type="button" className="danger" disabled={!online || conflict || removed} onClick={() => setDeleting(true)}><Trash2 size={16}/>{t("Delete effect")}</button> : <button type="button" onClick={onClose}>{t("Close draft")}</button>}<button className="primary" disabled={!online || busy || !dirty || conflict || removed || invalid || !draft.name.trim()}>{t("Save effect")}</button></div>
      {deleting && <div className="sheet-delete-confirm"><span>{t("Delete “")}{effect?.name}{t("”? Its bonuses will stop applying.")}</span><button type="button" onClick={() => setDeleting(false)}>{t("Keep")}</button><button type="button" className="danger" disabled={!online || conflict || removed} onClick={() => void remove()}>{t("Confirm deletion")}</button></div>}
    </fieldset>
  </form>;
}
