import { t, getLocale, translateSystemMessage } from '../shared/i18n';
import { useState } from 'react';
import { Check, Dices, HeartPulse, Plus, X } from 'lucide-react';
import type { ActionOutcome, ActionResolution, OutcomeRollReceipt } from '../shared/model';
import { activeScene } from '../shared/model';
import { previewHpApplication, previewOutcomeRoll } from '../shared/actions';
import type { ActionProps } from './Actions';
import type { ReliableResult } from './reliable';

const DAMAGE_NAMES: Record<string, string> = { get acid() { return t("Acid"); }, get bludgeoning() { return t("Bludgeoning"); }, get cold() { return t("Cold"); }, get fire() { return t("Fire"); }, get force() { return t("Force"); }, get lightning() { return t("Lightning"); }, get necrotic() { return t("Necrotic"); }, get piercing() { return t("Piercing"); }, get poison() { return t("Poison"); }, get psychic() { return t("Psychic"); }, get radiant() { return t("Radiant"); }, get slashing() { return t("Slashing"); }, get thunder() { return t("Thunder"); }, get healing() { return t("HP healing"); } };
export interface OutcomeDraft { parts: { number: string; denomination: string; bonus: string; type: string }[]; allowCritical: boolean }
export function stagedDraft(outcome?: ActionOutcome): OutcomeDraft {
  return outcome?.kind === 'damage' || outcome?.kind === 'healing'
    ? { parts: outcome.parts.map(p => ({ number: String(p.number), denomination: String(p.denomination), bonus: String(p.bonus), type: p.type })), allowCritical: outcome.allowCritical }
    : { parts: [{ number: '1', denomination: '4', bonus: '0', type: 'force' }], allowCritical: false };
}
export function invalidParts(draft: OutcomeDraft): boolean {
  const integer = (v: string, min: number, max: number) => !!v.trim() && Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max;
  return !draft.parts.length || draft.parts.length > 20 || draft.parts.reduce((n, p) => n + Number(p.number), 0) > 100 || draft.parts.some(p => !integer(p.number, 1, 100) || !integer(p.denomination, 2, 1000) || !integer(p.bonus, -100000, 100000));
}
export function stagedDefinition(kind: 'damage' | 'healing', draft: OutcomeDraft): ActionOutcome {
  return { kind, allowCritical: kind === 'damage' && draft.allowCritical, parts: draft.parts.map(p => ({ number: Number(p.number), denomination: Number(p.denomination), bonus: Number(p.bonus), type: kind === 'healing' ? 'healing' : p.type })) };
}
function formula(part: { number: number; denomination: number; bonus: number }) { return `${part.number}d${part.denomination}${part.bonus ? `${part.bonus > 0 ? '+' : ''}${part.bonus}` : ''}`; }
const message = (result: ReliableResult) => result.status === 'ack' ? result.ack.ok ? t("Result saved.") : result.ack.error || t("Operation rejected.") : result.error;

export function OutcomePartsEditor({ kind, value, onChange }: { kind: 'damage' | 'healing'; value: OutcomeDraft; onChange: (patch: Partial<OutcomeDraft>) => void }) {
  const update = (index: number, patch: Partial<OutcomeDraft['parts'][number]>) => onChange({ parts: value.parts.map((part, i) => i === index ? { ...part, ...patch } : part) });
  return <section className="outcome-definition"><div className="section-title"><h4>{t("Components")} {kind === 'damage' ? t("damage") : t("healing")} · {value.parts.length}/20</h4><button type="button" disabled={value.parts.length >= 20} onClick={() => onChange({ parts: [...value.parts, { number: '1', denomination: '4', bonus: '0', type: kind === 'healing' ? 'healing' : 'force' }] })}><Plus size={15}/>{t("Add component")}</button></div>
    {value.parts.map((part, index) => <div className="outcome-part-editor" key={index}>
      <label className="field stacked"><span>{t("Dice")} {index + 1}</span><input aria-label={t("Component {value0}: dice count", { value0: index + 1 })} type="number" min="1" max="100" step="1" value={part.number} onChange={e => update(index, { number: e.target.value })}/></label>
      <label className="field stacked"><span>{t("Sides")}</span><input aria-label={t("Component {value0}: sides", { value0: index + 1 })} type="number" min="2" max="1000" step="1" value={part.denomination} onChange={e => update(index, { denomination: e.target.value })}/></label>
      <label className="field stacked"><span>{t("Bonus")}</span><input aria-label={t("Component {value0}: bonus", { value0: index + 1 })} type="number" min="-100000" max="100000" step="1" value={part.bonus} onChange={e => update(index, { bonus: e.target.value })}/></label>
      <label className="field stacked"><span>{t("Type")}</span><select aria-label={t("Component {value0}: type", { value0: index + 1 })} value={kind === 'healing' ? 'healing' : part.type} disabled={kind === 'healing'} onChange={e => update(index, { type: e.target.value })}>{Object.entries(DAMAGE_NAMES).filter(([key]) => kind === 'healing' ? key === 'healing' : key !== 'healing').map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      <button type="button" className="icon-button" aria-label={t("Remove component {value0}", { value0: index + 1 })} disabled={value.parts.length === 1} onClick={() => onChange({ parts: value.parts.filter((_, i) => i !== index) })}><X size={16}/></button>
    </div>)}
    {kind === 'damage' && <label className="check"><input type="checkbox" checked={value.allowCritical} onChange={e => onChange({ allowCritical: e.target.checked })}/>{t("Allow critical rolls: twice the dice, unchanged bonus")}</label>}
    {invalidParts(value) && <p className="error" role="status">{t("Use integers: 1–100 dice, 2–1000 sides, bonus −100000 to 100000. Maximum 100 dice in total.")}</p>}
    <p className="muted small">{t("Starting spends resources. Roll dice separately in history; HP changes require a target and explicit confirmation. Resistances, saving throws and temporary HP are not calculated here.")}</p>
  </section>;
}

export function StagedOutcomeSummary({ outcome }: { outcome: Extract<ActionOutcome, { kind: 'damage' | 'healing' }> }) {
  return <><p>{outcome.kind === 'damage' ? t("Damage") : t("HP healing")}: {outcome.parts.map(p => `${formula(p)} · ${DAMAGE_NAMES[p.type] || p.type}`).join(' + ')}</p><p className="muted small">{t("After starting, open the history record to roll dice without spending again. Then apply the result to HP separately.")}</p></>;
}

export function OutcomeStages({ receipt, ...props }: ActionProps & { receipt: ActionResolution }) {
  const { actor, campaign, self, reliable, online, hasDraft } = props;
  const [critical, setCritical] = useState(false), [repeat, setRepeat] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [reviewed, setReviewed] = useState(campaign.revision);
  const outcome = receipt.action.outcome;
  if (outcome.kind !== 'damage' && outcome.kind !== 'healing') return null;
  const rolls = campaign.outcomeRolls.filter(r => r.resolutionId === receipt.id).toReversed();
  const preview = previewOutcomeRoll(receipt, critical);
  const canRoll = self.role === 'gm' || actor.owners.includes(self.id);
  const pending = !!reliable.storageError || reliable.operations.some(o => o.actorId === actor.id);
  const stale = reviewed !== campaign.revision;
  async function roll() {
    if (busy || pending || !online || hasDraft || stale || !canRoll || !preview.available || rolls.length > 0 && !repeat) return;
    setBusy(true);
    try { setNotice(message(await reliable.execute(actor.id, 'actor.action.rollOutcome', { id: actor.id, resolutionId: receipt.id, critical }, reviewed, t("Roll: {value0}", { value0: receipt.action.name })))); setRepeat(false); }
    finally { setBusy(false); }
  }
  return <section className="outcome-stages" aria-label={t("Roll and apply: {value0}", { value0: receipt.action.name })}>
    <ol className="outcome-steps"><li className="done"><Check size={15}/>{t("Start saved")}</li><li className={rolls.length ? 'done' : ''}><Dices size={15}/>{t("Roll:")} {rolls.length || t("pending")}</li><li><HeartPulse size={15}/>{t("HP separately")}</li></ol>
    <StagedOutcomeSummary outcome={outcome}/>
    {canRoll && <div className="outcome-roll-controls">
      {outcome.allowCritical && <label className="check"><input type="checkbox" checked={critical} disabled={busy || pending} onChange={e => setCritical(e.target.checked)}/>{t("Critical roll")}</label>}
      {rolls.length > 0 && <label className="check"><input type="checkbox" checked={repeat} disabled={busy || pending} onChange={e => setRepeat(e.target.checked)}/>{t("Create another result without spending again")}</label>}
      {preview.reasons.length > 0 && <p className="error" role="status">{preview.reasons.map(r => translateSystemMessage(r.message)).join(' ')}</p>}
      {stale && <div className="draft-conflict"><p>{t("The campaign changed. Review the saved action before rolling.")}</p><button disabled={busy || pending} onClick={() => setReviewed(campaign.revision)}>{t("Confirm roll using current state")}</button></div>}
      <button disabled={!online || busy || pending || hasDraft || stale || !preview.available || rolls.length > 0 && !repeat} onClick={() => void roll()}><Dices size={16}/>{busy ? t("Rolling…") : rolls.length ? t("Create another roll") : outcome.kind === 'damage' ? t("Roll damage") : t("Roll healing")}</button>
    </div>}
    {notice && <p role="status">{translateSystemMessage(notice)}</p>}
    {rolls.map((r, i) => <OutcomeRollView key={r.id} {...props} receipt={receipt} roll={r} ordinal={rolls.length - i}/>)}
  </section>;
}

function OutcomeRollView({ receipt, roll, ordinal, ...props }: ActionProps & { receipt: ActionResolution; roll: OutcomeRollReceipt; ordinal: number }) {
  const { actor, campaign, self, reliable, online, hasDraft } = props;
  const [target, setTarget] = useState(''), [multiplier, setMultiplier] = useState(1), [reviewed, setReviewed] = useState(campaign.revision), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const scene = activeScene(campaign), tokens = scene.tokens.filter(t => t.levelId === scene.activeLevelId);
  const preview = previewHpApplication(campaign, self, roll, target, multiplier);
  const pending = !!reliable.storageError || reliable.operations.some(o => o.actorId === actor.id), stale = reviewed !== campaign.revision;
  const applications = campaign.hpApplications.filter(a => a.outcomeId === roll.id);
  async function apply() {
    if (!online || busy || pending || hasDraft || stale || !preview.available) return;
    setBusy(true);
    try { setNotice(message(await reliable.execute(actor.id, 'actor.action.applyOutcome', { id: actor.id, outcomeId: roll.id, targetTokenId: target, multiplier }, reviewed, `HP: ${receipt.action.name}`))); }
    finally { setBusy(false); }
  }
  return <article className="outcome-roll"><div className="section-title"><h4>{roll.kind === 'damage' ? t("Damage") : t("Healing")} {t("· roll")} {ordinal}{roll.critical ? t(" · critical") : ''}</h4><strong className="outcome-total">{roll.total}</strong></div>
    <p className="muted small">{roll.author.name} · {new Date(roll.createdAt).toLocaleString(getLocale())}</p>
    <ul className="outcome-part-results">{roll.parts.map((part, i) => <li key={i}><span>{DAMAGE_NAMES[part.definition.type] || part.definition.type} · {part.roll.formula}</span><span className="outcome-dice">{part.roll.dice.flatMap(d => d.values).join(', ')}{part.roll.modifier ? t("; bonus {value0}{value1}", { value0: part.roll.modifier > 0 ? '+' : '', value1: part.roll.modifier }) : ''}</span><b>{part.amount}</b>{part.roll.total < 0 && <small>{t("Original total")} {part.roll.total}{t("; HP uses 0.")}</small>}</li>)}</ul>
    <details className="outcome-apply"><summary>{t("Apply this result to HP")}</summary>
      <p className="muted small">{t("The GM can change an accessible target’s HP. Players need access to the source character and target HP. Each roll applies to each HP pool only once.")}</p>
      <label className="field stacked"><span>{t("HP target")}</span><select aria-label={t("HP target · roll {value0}", { value0: ordinal })} value={target} disabled={busy || pending} onChange={e => setTarget(e.target.value)}><option value="">{t("Select token")}</option>{target && !tokens.some(t => t.id === target) && <option value={target}>{t("Target unavailable")}</option>}{tokens.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      {roll.kind === 'damage' && <label className="field stacked"><span>{t("Damage fraction · manual selection")}</span><select aria-label={t("Damage multiplier · roll {value0}", { value0: ordinal })} value={multiplier} disabled={busy || pending} onChange={e => setMultiplier(Number(e.target.value))}><option value="1">{t("Full ×1")}</option><option value="0.5">{t("Half ×½")}</option><option value="2">{t("Double ×2")}</option><option value="0">{t("Zero ×0")}</option></select></label>}
      {preview.before !== undefined && <div className="hp-diff"><span>{t("Target HP")}</span><strong>{preview.before} → {preview.after ?? '—'} / {preview.max}</strong><small>{t("Change")} {preview.appliedAmount ?? '—'}{preview.requestedAmount !== preview.appliedAmount ? t(" of {value0}, limited by HP bounds", { value0: preview.requestedAmount ?? '—' }) : ''}</small></div>}
      {preview.reasons.length > 0 && <p className="action-blocked" role="status">{preview.reasons.map(r => translateSystemMessage(r.message)).join(' ')}</p>}
      {stale && <div className="draft-conflict"><p>{t("Data changed. Check current HP before confirming.")}</p><button disabled={busy || pending} onClick={() => setReviewed(campaign.revision)}>{t("Confirm updated HP")}</button></div>}
      <button className="primary" disabled={!online || busy || pending || hasDraft || stale || !preview.available} onClick={() => void apply()}><HeartPulse size={16}/>{busy ? t("Applying…") : roll.kind === 'damage' ? t("Apply damage to HP") : t("Apply healing to HP")}</button>
      {notice && <p role="status">{translateSystemMessage(notice)}</p>}
    </details>
    {applications.length > 0 && <section className="hp-history"><h5>{t("HP application")}</h5>{applications.map(a => <p key={a.id}><strong>{a.target.kind === 'redacted' || a.target.kind === 'none' ? t("Target hidden") : a.target.name}</strong> · {a.before === null || a.after === null ? t("HP values hidden") : `${a.before} → ${a.after} / ${a.max}`}<small>{a.author.name} · {new Date(a.createdAt).toLocaleString(getLocale())}</small></p>)}</section>}
  </article>;
}
