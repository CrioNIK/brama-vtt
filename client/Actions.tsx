import { t, getLocale, translateSystemMessage } from '../shared/i18n';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Check, Dices, History, Pencil, Plus, Search, Trash2, X, Zap } from 'lucide-react';
import { ABILITY_KEYS, activeScene } from '../shared/model';
import { managedBinding } from '../shared/progression';
import type { AbilityKey, Actor, ActorAction, ActionOutcome, ActionResolution, Campaign, Member, RollMode } from '../shared/model';
import { ACTION_LIMITS, actionPreparation, previewAction } from '../shared/actions';
import { abilityBreakdown } from '../shared/abilities';
import { ABILITY_NAMES, signed } from './ability-ui';
import { DraftConflict, useDraft } from './draft';
import { RollDetails } from './Panels';
import type { SendCommand } from './session';
import type { ReliableController, ReliableResult } from './reliable';
import { invalidParts, OutcomePartsEditor, OutcomeStages, stagedDefinition, stagedDraft, StagedOutcomeSummary } from './ActionOutcomes';
import type { OutcomeDraft } from './ActionOutcomes';
import { Spellbook, SpellContext, preparationLabel } from './Spellcasting';

export type SheetMarkDirty = (section: string, value: boolean) => void;
export type ActionProps = { actor: Actor; campaign: Campaign; self: Member; command: SendCommand; reliable: ReliableController; online: boolean; hasDraft: boolean; markDirty: SheetMarkDirty };
export const resultMessage = (result: ReliableResult) => result.status === 'ack'
  ? result.ack.ok ? t("Operation confirmed. The result is saved in history.") : result.ack.error || t("The server rejected the operation.")
  : result.error;
const count = (value: number | null) => value === null ? t("unknown") : value.toLocaleString(getLocale());

export function PendingOperationNotice({ actorId, reliable, online }: { actorId: string; reliable: ReliableController; online: boolean }) {
  const [notice, setNotice] = useState('');
  const operation = reliable.operations.find(item => item.actorId === actorId);
  if (reliable.storageError) return <div className="warning-box" role="alert"><strong>{t("Operations paused")}</strong><p>{translateSystemMessage(reliable.storageError)}</p></div>;
  if (!operation) return notice ? <p className="muted small" role="status">{translateSystemMessage(notice)}</p> : null;
  const sending = reliable.sending.includes(operation.command.id);
  return <div className="pending-operation" role="status"><strong>{sending ? t("Awaiting confirmation") : t("The operation result is not yet known")}</strong>
    <p>{translateSystemMessage(operation.label)}{t(". New operations on this object are blocked. Checking retries the original command with the same identifier and parameters.")}</p>
    <button disabled={!online || sending} onClick={async () => setNotice(resultMessage(await reliable.retry(actorId)))}>{sending ? t("Checking…") : t("Check result")}</button>
    {notice && <p>{translateSystemMessage(notice)}</p>}
  </div>;
}

export function ActionList(props: ActionProps) {
  const { actor, campaign, self, command, reliable, online, hasDraft, markDirty } = props;
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null), [retained, setRetained] = useState<ActorAction>(), [editorDirty, setEditorDirty] = useState(false), [notice, setNotice] = useState('');
  const editingAction = actor.actions.find(action => action.id === editing), selected = actor.actions.find(action => action.id === selectedId);
  useEffect(() => { if (editingAction) setRetained(editingAction); }, [editingAction]);
  const mark = useCallback<SheetMarkDirty>((section, dirty) => { setEditorDirty(dirty); markDirty(section, dirty); }, [markDirty]);
  const scene = activeScene(campaign), tokens = scene.tokens.filter(token => token.levelId === scene.activeLevelId);
  const availableToBegin = (action: ActorAction) => previewAction(actor, action, { memberId: self.id, role: self.role, visibleTokens: tokens }).reasons.every(reason => reason.code === 'TARGET_UNAVAILABLE');
  const actions = actor.actions.filter(action => `${action.name} ${action.sourceLabel}`.toLocaleLowerCase(getLocale()).includes(query.toLocaleLowerCase(getLocale())) &&
    (filter === 'all' || filter === 'known' && actionPreparation(actor, action).known || filter === 'prepared' && actionPreparation(actor, action).prepared || filter === 'available' && availableToBegin(action)));
  const groupId = (action: ActorAction) => action.spellId ? `spell:${action.spellId}` : `source:${action.sourceLabel}`;
  const groups = [...new Map(actions.map(action => [groupId(action), action.sourceLabel || t("No source specified")])).entries()];
  function openEditor(id: string) {
    if (editorDirty) { setNotice(t("Save or explicitly close the action draft first.")); return; }
    setRetained(actor.actions.find(action => action.id === id)); setEditing(id); setNotice('');
  }
  const receipts = campaign.actionResolutions.filter(receipt => receipt.actor.id === actor.id).toReversed();
  return <>
    <div className="section-title"><h3>{t("Actions")} <span className="muted">· {actor.actions.length}/{ACTION_LIMITS.actions}</span></h3>{self.role === 'gm' && <button disabled={!online || editorDirty || actor.actions.length >= ACTION_LIMITS.actions} onClick={() => openEditor('new')}><Plus size={17}/>{t("Add action")}</button>}</div>
    <p className="muted small action-scope">{t("Starting saves the cost and result. Roll damage or healing separately, then confirm the HP change in history. Resolve hits and saving throws separately.")}</p>
    <PendingOperationNotice actorId={actor.id} reliable={reliable} online={online}/>
    <Spellbook {...props}/>
    <div className="action-filters"><label className="directory-search"><Search size={16}/><input aria-label={t("Find action")} placeholder={t("Find action")} value={query} onChange={e => setQuery(e.target.value)}/></label><select aria-label={t("Action filter")} value={filter} onChange={e => setFilter(e.target.value)}><option value="all">{t("All actions")}</option><option value="known">{t("Known")}</option><option value="prepared">{t("Prepared")}</option><option value="available">{t("Ready to start")}</option></select></div>
    <div className="action-workspace"><div className="action-catalog">
      {!actions.length && <p className="empty">{actor.actions.length ? t("No actions match this filter.") : self.role === 'gm' ? t("Add a custom action and set its cost.") : t("The GM has not added character actions yet.")}</p>}
      {groups.map(([id, group]) => <section className="action-source-group" key={id}><h4>{group}</h4>{actions.filter(action => groupId(action) === id).map(action => {
        const reasons = previewAction(actor, action, { memberId: self.id, role: self.role, visibleTokens: tokens }).reasons.filter(reason => reason.code !== 'TARGET_UNAVAILABLE');
        const preparation = actionPreparation(actor, action);
        return <div key={action.id} className={`action-row ${selectedId === action.id ? 'selected' : ''}`}><button className="action-open" onClick={() => setSelectedId(action.id)}><span><strong>{action.name}</strong><small>{action.category || t("Action")} · {preparation.known ? t("Known") : t("Not learned")}{preparation.requiresPreparation ? preparation.prepared ? t(" · prepared") : t(" · not prepared") : ''}</small><small>{action.costs.length ? action.costs.map(cost => `${actor.resources.find(resource => resource.id === cost.resourceId)?.label || t("Deleted resource")} −${count(cost.amount)}`).join(' · ') : t("No resource cost")}</small>{reasons.length > 0 && <span className="action-blocked">{translateSystemMessage(reasons[0].message)}</span>}</span><Zap size={17}/></button>{self.role === 'gm' && !action.spellId && !managedBinding(actor, 'action', action.id) && <button className="icon-button" aria-label={t("Edit action: {value0}", { value0: action.name })} disabled={editorDirty} onClick={() => openEditor(action.id)}><Pencil size={15}/></button>}</div>;
      })}</section>)}
    </div><div className="action-detail">{selected ? <ActionComposer key={selected.id} {...props} action={selected}/> : <div className="action-placeholder"><Zap size={26}/><p>{t("Select an action to review its target and cost.")}</p></div>}</div></div>
    {selectedId && !selected && <p className="warning-box" role="status">{t("The selected action was deleted. Saved history remains available.")}</p>}
    {notice && <p role="status" className="warning-box">{translateSystemMessage(notice)}</p>}
    {editing && <ActionEditor key={editing} {...props} action={editingAction ?? retained} removed={editing !== 'new' && !editingAction} markDirty={mark} onClose={() => { setEditing(null); setRetained(undefined); }}/>}
    <section className="action-history"><h3><History size={18}/>{t("Action history")}</h3><p className="muted small">{t("Saved action versions, costs and rolls. Only records you can access are shown.")}</p>{!receipts.length && <p className="empty">{t("No actions have been applied yet.")}</p>}{receipts.map(receipt => <ActionReceipt key={receipt.id} {...props} receipt={receipt}/>)}</section>
  </>;
}

function ActionComposer({ actor, action, campaign, self, command, reliable, online, hasDraft }: ActionProps & { action: ActorAction }) {
  const [target, setTarget] = useState(''), [visibility, setVisibility] = useState<'public'|'gm'|'self'>('public'), [reviewed, setReviewed] = useState({ revision: campaign.revision, version: action.version });
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const scene = activeScene(campaign), tokens = scene.tokens.filter(token => token.levelId === scene.activeLevelId);
  const preview = previewAction(actor, action, { memberId: self.id, role: self.role, actionVersion: reviewed.version, visibleTokens: tokens, ...(action.target === 'token' && target ? { targetTokenId: target } : {}) });
  const stale = reviewed.revision !== campaign.revision || reviewed.version !== action.version;
  const unresolved = reliable.operations.some(operation => operation.actorId === actor.id) || !!reliable.storageError;
  const outcome = action.outcome, breakdown = outcome.kind === 'roll' && outcome.ability ? abilityBreakdown(actor, outcome.ability) : null;
  async function prepare() {
    if (!online || busy || hasDraft || unresolved) return;
    setBusy(true); try { if (await command('actor.action.prepare', { id: actor.id, actionId: action.id, actionVersion: action.version, prepared: !action.prepared }, true)) setNotice(t("Preparation changed. Review the updated preview.")); } finally { setBusy(false); }
  }
  async function execute() {
    if (!online || busy || hasDraft || stale || unresolved || !preview.available) return;
    setBusy(true); try { setNotice(resultMessage(await reliable.execute(actor.id, 'actor.action.execute', { id: actor.id, actionId: action.id, actionVersion: reviewed.version, ...(action.target === 'token' ? { targetTokenId: target } : {}), visibility }, reviewed.revision, t("Apply “{value0}”", { value0: action.name })))); } finally { setBusy(false); }
  }
  return <section className="action-composer" aria-label={t("Action preview: {value0}", { value0: action.name })}><h3>{action.name}</h3><p className="muted small">{t("Version")} {action.version} · {action.sourceLabel || t("No source specified")}</p>{action.description && <p className="plain-text action-description">{action.description}</p>}
    <SpellContext action={action}/>
    {!action.spellId && action.requiresPreparation && <div className="action-preparation"><span>{action.prepared ? t("Prepared") : t("Not prepared")}</span><button disabled={!online || busy || hasDraft || unresolved || !action.known} onClick={() => void prepare()}>{action.prepared ? t("Unprepare") : t("Prepare")}</button></div>}
    {action.spellId ? <p className="muted small">{t("Starting saves without a selected target")}{action.costs.length > 0 ? t(" and spends a slot") : ''}{t(". Choose the HP target after rolling in history.")}</p> : action.target === 'token' ? <label className="field stacked"><span>{t("Target · current scene and level")}</span><select aria-label={t("Action target")} value={target} disabled={busy || unresolved} onChange={e => setTarget(e.target.value)}><option value="">{t("Select a visible token")}</option>{target && !tokens.some(token => token.id === target) && <option value={target}>{t("Target is no longer available")}</option>}{tokens.map(token => <option key={token.id} value={token.id}>{token.name}</option>)}</select></label> : <p className="muted small">{t("Target:")} {action.target === 'self' ? actor.name : t("not required")}.</p>}
    <h4>{t("Cost")}</h4>{action.costs.length ? <ul className="cost-preview">{action.costs.map(cost => { const resource = actor.resources.find(item => item.id === cost.resourceId); const after = resource?.value != null ? resource.value - cost.amount : null; return <li key={cost.resourceId}><span>{resource?.label || t("Resource deleted")} <small>−{count(cost.amount)}</small></span><strong>{count(resource?.value ?? null)} → {after !== null && after < 0 ? t("insufficient") : count(after)}</strong></li>; })}</ul> : <p className="muted small">{t("No resource cost.")}</p>}
    <h4>{t("Result")}</h4>{outcome.kind === 'manual' ? <p className="plain-text">{outcome.text || t("Manual resolution without automatic consequences.")}</p> : outcome.kind === 'roll' ? <p>{outcome.mode === 'advantage' ? t("Advantage") : outcome.mode === 'disadvantage' ? t("Disadvantage") : t("Normal roll")} · d20 {outcome.ability ? `${ABILITY_NAMES[outcome.ability]} ${breakdown?.modifier == null ? '—' : signed(breakdown.modifier)}` : signed(outcome.modifier)}</p> : <StagedOutcomeSummary outcome={outcome}/>}
    <label className="field stacked"><span>{t("Chat summary visibility")}</span><select value={visibility} disabled={busy || unresolved} onChange={e => setVisibility(e.target.value as typeof visibility)}><option value="public">{t("All participants")}</option><option value="gm">{t("GM")}</option><option value="self">{t("Only me")}</option></select></label><p className="muted small">{t("Detailed history is available to the GM, sheet owner and author.")}</p>
    {preview.reasons.length > 0 && <ul className="action-reasons" role="status">{preview.reasons.map((reason,index) => <li key={`${reason.code}-${index}`}>{translateSystemMessage(reason.message)}</li>)}</ul>}
    {stale && <div className="draft-conflict" role="status"><p>{t("Data changed. Review the current cost again before applying.")}</p><button disabled={busy || unresolved} onClick={() => { setReviewed({ revision: campaign.revision, version: action.version }); setNotice(t("Preview updated.")); }}>{t("Confirm updated preview")}</button></div>}
    {hasDraft && <p className="warning-box">{t("Save or close sheet drafts before applying.")}</p>}
    <button className="primary full-width" disabled={!online || busy || hasDraft || stale || unresolved || !preview.available} onClick={() => void execute()}><Zap size={17}/>{busy ? t("Sending…") : t("Apply action")}</button>
    {notice && <p className="action-notice" role="status">{translateSystemMessage(notice)}</p>}
  </section>;
}

type ActionDraft = Omit<ActorAction, 'id'|'version'|'outcome'|'costs'> & OutcomeDraft & { costs: { resourceId: string; amount: string }[]; outcomeKind: ActionOutcome['kind']; manualText: string; ability: AbilityKey | ''; modifier: string; mode: RollMode };
function actionDraft(action?: ActorAction): ActionDraft {
  return { name: action?.name ?? '', description: action?.description ?? '', sourceLabel: action?.sourceLabel ?? '', category: action?.category ?? t("Action"), known: action?.known ?? true, prepared: action?.prepared ?? false, requiresPreparation: action?.requiresPreparation ?? false, enabled: action?.enabled ?? true, target: action?.target ?? 'none', costs: action?.costs.map(cost => ({ ...cost, amount: String(cost.amount) })) ?? [], outcomeKind: action?.outcome.kind ?? 'manual', manualText: action?.outcome.kind === 'manual' ? action.outcome.text : '', ability: action?.outcome.kind === 'roll' ? action.outcome.ability ?? '' : '', modifier: action?.outcome.kind === 'roll' ? String(action.outcome.modifier) : '0', mode: action?.outcome.kind === 'roll' ? action.outcome.mode : 'normal', ...stagedDraft(action?.outcome) };
}
function ActionEditor({ actor, action, removed, campaign, command, online, markDirty, onClose }: ActionProps & { action?: ActorAction; removed: boolean; onClose: () => void }) {
  const { draft, dirty, edit, reload, baseRevision, conflict } = useDraft(actionDraft(action), campaign.revision);
  const [busy, setBusy] = useState(false), [deleting, setDeleting] = useState(false);
  useEffect(() => { markDirty('action', dirty); return () => markDirty('action', false); }, [dirty, markDirty]);
  const invalidCost = draft.costs.some(cost => !cost.resourceId || !actor.resources.some(resource => resource.id === cost.resourceId) || !cost.amount.trim() || !Number.isFinite(Number(cost.amount)) || Number(cost.amount) <= 0 || Number(cost.amount) > ACTION_LIMITS.amount) || new Set(draft.costs.map(cost => cost.resourceId)).size !== draft.costs.length;
  const invalidModifier = draft.outcomeKind === 'roll' && !draft.ability && (!draft.modifier.trim() || !Number.isInteger(Number(draft.modifier)) || Math.abs(Number(draft.modifier)) > 1000);
  const invalid = invalidCost || invalidModifier || (draft.outcomeKind === 'damage' || draft.outcomeKind === 'healing') && invalidParts(draft);
  async function save(e: FormEvent) {
    e.preventDefault(); if (!online || busy || !dirty || removed || conflict || invalid) return;
    const { outcomeKind, manualText, ability, modifier, mode, costs, parts, allowCritical, ...definition } = draft;
    const outcome = outcomeKind === 'manual' ? { kind: 'manual', text: manualText } : outcomeKind === 'roll' ? { kind: 'roll', ability: ability || null, modifier: ability ? 0 : Number(modifier), mode } : stagedDefinition(outcomeKind, { parts, allowCritical });
    setBusy(true); try { if (await command(action ? 'actor.action.update' : 'actor.action.create', { id: actor.id, ...(action ? { actionId: action.id, actionVersion: action.version } : {}), ...definition, costs: costs.map(cost => ({ resourceId: cost.resourceId, amount: Number(cost.amount) })), outcome }, baseRevision)) onClose(); } finally { setBusy(false); }
  }
  return <form className="sheet-editor action-editor" onSubmit={save}><div className="section-title"><h3>{action ? t("Edit action") : t("New action")}</h3><button type="button" className="icon-button" aria-label={t("Close action draft")} disabled={busy} onClick={onClose}><X size={18}/></button></div>
    {removed && <p role="alert" className="warning-box">{t("Another participant deleted this action. Your draft is retained; copy it or explicitly close the editor.")}</p>}<DraftConflict show={conflict && !removed} reload={reload}/><fieldset disabled={busy}>
    <div className="sheet-two-columns"><label className="field stacked"><span>{t("Action name")}</span><input required maxLength={120} value={draft.name} onChange={e => edit({ name: e.target.value })}/></label><label className="field stacked"><span>{t("Source")}</span><input maxLength={120} placeholder={t("For example: campaign rules")} value={draft.sourceLabel} onChange={e => edit({ sourceLabel: e.target.value })}/></label><label className="field stacked"><span>{t("Category")}</span><input maxLength={60} value={draft.category} onChange={e => edit({ category: e.target.value })}/></label><label className="field stacked"><span>{t("Target type")}</span><select value={draft.target} onChange={e => edit({ target: e.target.value as ActorAction['target'] })}><option value="none">{t("No target")}</option><option value="self">{t("Self")}</option><option value="token">{t("Visible token")}</option></select></label></div>
    <div className="action-checks">{([['known',t("Known")],['requiresPreparation',t("Requires preparation")],['prepared',t("Prepared")],['enabled',t("Enabled")]] as const).map(([key,label]) => <label className="check" key={key}><input type="checkbox" checked={draft[key]} onChange={e => edit({ [key]: e.target.checked })}/>{label}</label>)}</div>
    <label className="field stacked"><span>{t("Action description")}</span><textarea rows={3} maxLength={20000} value={draft.description} onChange={e => edit({ description: e.target.value })}/></label>
    <div className="section-title"><h4>{t("Cost ·")} {draft.costs.length}/{ACTION_LIMITS.costs}</h4><button type="button" disabled={draft.costs.length >= ACTION_LIMITS.costs || !actor.resources.length} onClick={() => edit({ costs: [...draft.costs, { resourceId: actor.resources.find(resource => !draft.costs.some(cost => cost.resourceId === resource.id))?.id || '', amount: '1' }] })}><Plus size={15}/>{t("Add cost")}</button></div>
    {!actor.resources.length && <p className="muted small">{t("Create a resource in the Resources tab before adding a cost.")}</p>}
    {draft.costs.map((cost,index) => <div className="action-cost-editor" key={index}><label className="field stacked"><span>{t("Resource")} {index + 1}</span><select value={cost.resourceId} onChange={e => edit({ costs: draft.costs.map((current,i) => i === index ? { ...current, resourceId: e.target.value } : current) })}><option value="">{t("Select resource")}</option>{cost.resourceId && !actor.resources.some(resource => resource.id === cost.resourceId) && <option value={cost.resourceId}>{t("Resource deleted")}</option>}{actor.resources.map(resource => <option key={resource.id} value={resource.id}>{resource.label}</option>)}</select></label><label className="field stacked"><span>{t("Amount spent")}</span><input type="number" min="0" max={ACTION_LIMITS.amount} step="any" value={cost.amount} onChange={e => edit({ costs: draft.costs.map((current,i) => i === index ? { ...current, amount: e.target.value } : current) })}/></label><button type="button" className="icon-button" aria-label={t("Remove cost {value0}", { value0: index + 1 })} onClick={() => edit({ costs: draft.costs.filter((_,i) => i !== index) })}><X size={17}/></button></div>)}
    {invalidCost && <p className="error small" role="status">{t("Use different existing resources and costs greater than 0, up to 100000.")}</p>}
    <label className="field stacked"><span>{t("Result type")}</span><select value={draft.outcomeKind} onChange={e => edit({ outcomeKind: e.target.value as ActionOutcome['kind'], parts: e.target.value === 'damage' ? draft.parts.map(p => ({ ...p, type: p.type === 'healing' ? 'force' : p.type })) : draft.parts })}><option value="manual">{t("Manual resolution")}</option><option value="roll">{t("d20 check")}</option><option value="damage">{t("Damage · separate roll and HP")}</option><option value="healing">{t("Healing · separate roll and HP")}</option></select></label>
    {draft.outcomeKind === 'manual' ? <label className="field stacked"><span>{t("Manual result text")}</span><textarea rows={3} maxLength={20000} value={draft.manualText} onChange={e => edit({ manualText: e.target.value })}/></label> : draft.outcomeKind === 'roll' ? <div className="sheet-two-columns"><label className="field stacked"><span>{t("Roll basis")}</span><select value={draft.ability} onChange={e => edit({ ability: e.target.value as AbilityKey | '' })}><option value="">{t("Manual modifier")}</option>{ABILITY_KEYS.map(key => <option key={key} value={key}>{ABILITY_NAMES[key]}</option>)}</select></label>{!draft.ability && <label className="field stacked"><span>{t("d20 modifier")}</span><input type="number" min="-1000" max="1000" step="1" value={draft.modifier} onChange={e => edit({ modifier: e.target.value })}/></label>}<label className="field stacked"><span>{t("d20 mode")}</span><select value={draft.mode} onChange={e => edit({ mode: e.target.value as RollMode })}><option value="normal">{t("Normal")}</option><option value="advantage">{t("Advantage")}</option><option value="disadvantage">{t("Disadvantage")}</option></select></label></div> : <OutcomePartsEditor kind={draft.outcomeKind} value={draft} onChange={edit}/>}
    {invalidModifier && <p className="error small">{t("The modifier must be an integer from −1000 to 1000.")}</p>}{draft.outcomeKind === 'roll' && <p className="muted small">{t("Ability rolls use the current total including effects. A d20 check does not determine a hit or change HP by itself.")}</p>}
    <div className="form-actions">{action && <button type="button" className="danger" disabled={!online || removed || conflict} onClick={() => setDeleting(true)}><Trash2 size={15}/>{t("Delete")}</button>}<button className="primary" disabled={!online || busy || !dirty || conflict || invalid || removed || !draft.name.trim()}><Check size={16}/>{t("Save action")}</button></div>
    {deleting && <div className="sheet-delete-confirm"><span>{t("Delete this action? Previous results will remain in history.")}</span><button type="button" onClick={() => setDeleting(false)}>{t("Keep")}</button><button type="button" className="danger" disabled={!online || removed || conflict || busy} onClick={async () => { if (!action) return; setBusy(true); try { if (await command('actor.action.delete', { id: actor.id, actionId: action.id, actionVersion: action.version }, baseRevision)) onClose(); } finally { setBusy(false); } }}>{t("Delete action")}</button></div>}
    </fieldset></form>;
}

export function ActionReceipt({ receipt, ...props }: ActionProps & { receipt: ActionResolution }) {
  const target = receipt.target;
  return <details className="action-receipt"><summary><span><strong>{receipt.action.name}</strong><small>{receipt.actor.name} · {receipt.author.name} · {new Date(receipt.createdAt).toLocaleString(getLocale())}</small></span><b>{receipt.roll ? receipt.roll.total : receipt.action.outcome.kind === 'damage' || receipt.action.outcome.kind === 'healing' ? t("Start saved") : t("Applied")}</b></summary>
    <p className="muted small">{t("Saved version")} {receipt.action.version} · {receipt.action.sourceLabel || t("No source specified")}</p><p>{t("Target:")} {target.kind === 'none' ? receipt.spell ? t("not selected when casting") : t("not required") : target.kind === 'redacted' ? t("hidden") : target.name}</p>
    {receipt.progression && <p className="muted small">{t("Source when applied:")} {receipt.progression.sourceLabels.join(" · ")} {t("· profile version")} {receipt.progression.profile.version}{t(", progression revision")} {receipt.progression.version}.</p>}
    {receipt.spell && <p className="muted small">{receipt.spell.name} {t("· preparation version")} {receipt.spell.version} · {preparationLabel(receipt.spell)} · {receipt.spell.level === 0 ? t("cantrip") : t("level {value0} casting", { value0: receipt.spell.level })}</p>}
    {receipt.costs.length > 0 ? <ul className="cost-preview">{receipt.costs.map(cost => <li key={cost.resourceId}><span>{cost.label} · −{count(cost.amount)}</span><strong>{count(cost.before)} → {count(cost.after)}</strong></li>)}</ul> : <p className="muted small">{t("No resource cost.")}</p>}
    {receipt.roll && <div className="roll-card"><div><Dices size={17}/><strong>{receipt.roll.formula}</strong></div><b>{receipt.roll.total}</b><RollDetails roll={receipt.roll}/></div>}{receipt.manualOutcome !== undefined && <p className="plain-text">{receipt.manualOutcome || t("Manual resolution.")}</p>}<p className="muted small">{t("Historical record. Editing actions or resources does not change this result.")}</p>
    <OutcomeStages {...props} receipt={receipt}/>
  </details>;
}
