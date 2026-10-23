import { t, getLocale, translateSystemMessage } from '../shared/i18n';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { History, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import type { ActorResource, RecoveryEvent, RecoveryPolicy, ResourceKind, ResourceRecoveryReceipt } from '../shared/model';
import { previewRecovery } from '../shared/actions';
import { managedBinding } from '../shared/progression';
import { DraftConflict, useDraft } from './draft';
import { PendingOperationNotice, resultMessage } from './Actions';
import type { ActionProps, SheetMarkDirty } from './Actions';
import { recoveryOperationLabel } from './operation-labels';

const KIND_NAMES: Record<ResourceKind, string> = { get custom() { return t("Custom counter"); }, get action() { return t("Action"); }, get 'bonus-action'() { return t("Bonus action"); }, get reaction() { return t("Reaction"); }, get 'spell-slot'() { return t("Spell slot"); }, get charge() { return t("Charge"); } };
const RECOVERY_NAMES: Record<RecoveryPolicy, string> = { get manual() { return t("Manual only"); }, get turn() { return t("New turn"); }, get 'short-rest'() { return t("Short rest"); }, get 'long-rest'() { return t("Long rest"); } };
const REASON_NAMES = { get recovered() { return t("recovery"); }, get unknown() { return t("unknown value — unchanged"); }, get 'policy-mismatch'() { return t("different policy — unchanged"); }, get 'already-full'() { return t("already full"); } };
const num = (value: number | null) => value === null ? '—' : value.toLocaleString(getLocale());
const nullable = (value: string) => value === '' ? null : Number(value);

export function Resources(props: ActionProps) {
  const { actor, self, campaign, reliable, online, markDirty } = props;
  const [editing, setEditing] = useState<string|null>(null), [retained, setRetained] = useState<ActorResource>(), [editorDirty, setEditorDirty] = useState(false);
  const selected = actor.resources.find(resource => resource.id === editing);
  useEffect(() => { if (selected) setRetained(selected); }, [selected]);
  const mark = useCallback<SheetMarkDirty>((section, value) => { setEditorDirty(value); markDirty(section, value); }, [markDirty]);
  const open = (id: string) => { if (editorDirty && editing !== id) return; setRetained(actor.resources.find(resource => resource.id === id)); setEditing(id); };
  const receipts = campaign.resourceRecoveries.filter(receipt => receipt.actor.id === actor.id).toReversed();
  return <><div className="section-title"><h3>{t("Character resources")}</h3><button disabled={!online || editorDirty} onClick={() => open('new')}><Plus size={17}/>{t("Add resource")}</button></div>
    <p className="muted small">{t("An empty value means unknown. Recovery rules do not change resources automatically; the GM triggers recovery explicitly.")}</p>
    <PendingOperationNotice actorId={actor.id} reliable={reliable} online={online}/>
    <div className="resource-list">{actor.resources.map(resource => <button key={resource.id} disabled={editorDirty && editing !== resource.id} className="resource-row" onClick={() => open(resource.id)}><div><strong>{resource.label}</strong><small>{KIND_NAMES[resource.kind ?? 'custom']}{resource.level != null ? t(" · level {value0}", { value0: resource.level }) : ''}{resource.unit ? ` · ${resource.unit}` : ''} · {RECOVERY_NAMES[resource.recovery ?? 'manual']}</small></div><span>{num(resource.value)} / {num(resource.max)}</span></button>)}</div>
    {!actor.resources.length && <p className="empty">{t("No additional resources yet.")}</p>}
    {editing && <ResourceEditor key={editing} {...props} resource={selected ?? retained} removed={editing !== 'new' && !selected} markDirty={mark} onClose={() => { setEditing(null); setRetained(undefined); }}/>}
    {self.role === 'gm' && <RecoveryPreview {...props}/>}
    <section className="action-history"><h3><History size={18}/>{t("Recovery history")}</h3>{!receipts.length && <p className="empty">{t("No recovery has been applied yet.")}</p>}{receipts.map(receipt => <RecoveryReceipt key={receipt.id} receipt={receipt}/>)}</section>
  </>;
}

function ResourceEditor({ resource, removed, actor, self, campaign, command, online, markDirty, onClose }: ActionProps & { resource?: ActorResource; removed: boolean; onClose: () => void }) {
  const gm = self.role === 'gm', binding = resource ? managedBinding(actor, 'resource', resource.id) : undefined;
  const { draft, dirty, edit, reload, baseRevision, conflict } = useDraft({ label: resource?.label ?? '', value: resource?.value ?? null, max: resource?.max ?? null, kind: resource?.kind ?? 'custom', level: resource?.level ?? null, unit: resource?.unit ?? '', recovery: resource?.recovery ?? 'manual' }, campaign.revision);
  const [busy, setBusy] = useState(false), [deleting, setDeleting] = useState(false);
  useEffect(() => { markDirty('resource', dirty); return () => markDirty('resource', false); }, [dirty, markDirty]);
  const usedBy = resource ? actor.actions.filter(action => action.costs.some(cost => cost.resourceId === resource.id)) : [];
  const invalid = !!binding && draft.value !== null && !Number.isInteger(draft.value) || [draft.value, draft.max].some(value => value !== null && (!Number.isFinite(value) || value < 0 || value > 100000)) || draft.value !== null && draft.max !== null && draft.value > draft.max || draft.level !== null && (!Number.isInteger(draft.level) || draft.level < 0 || draft.level > 9);
  async function save(event: FormEvent) {
    event.preventDefault(); if (removed || conflict || invalid || busy || !online || !dirty) return;
    setBusy(true); try { if (await command(resource ? 'actor.resource.update' : 'actor.resource.create', binding ? { id: actor.id, resourceId: resource!.id, value: draft.value } : { id: actor.id, ...(resource ? { resourceId: resource.id } : {}), label: draft.label, value: draft.value, max: draft.max, ...(gm ? { kind: draft.kind, level: draft.level, unit: draft.unit, recovery: draft.recovery } : {}) }, baseRevision)) onClose(); } finally { setBusy(false); }
  }
  return <form className="sheet-editor" onSubmit={save}><div className="section-title"><h3>{resource ? t("Edit resource") : t("New resource")}</h3><button type="button" className="icon-button" aria-label={t("Close resource draft")} disabled={busy} onClick={onClose}><X size={18}/></button></div>
    {removed && <p className="warning-box" role="alert">{t("Another participant deleted this resource. Your draft is retained; copy it or explicitly close the editor.")}</p>}<DraftConflict show={conflict && !removed} reload={reload}/><fieldset disabled={busy || !!binding && !binding.active}>
    <label className="field stacked"><span>{t("Resource name")}</span><input autoFocus required readOnly={!!binding} maxLength={120} value={draft.label} onChange={e => edit({ label: e.target.value })}/></label>
    <div className="sheet-two-columns"><label className="field stacked"><span>{t("Current value")}</span><input type="number" min="0" max="100000" step={binding ? "1" : "any"} placeholder={t("Unknown")} value={draft.value ?? ''} onChange={e => edit({ value: nullable(e.target.value) })}/></label><label className="field stacked"><span>{t("Resource maximum")}</span><input type="number" min="0" max="100000" step="any" placeholder={t("Unknown")} disabled={!!binding} value={draft.max ?? ''} onChange={e => edit({ max: nullable(e.target.value) })}/></label></div>
    {invalid && <p className="error small" role="status">{t("Values: 0–100000; current cannot exceed maximum. Level: integer 0–9 or empty.")}{binding && t(" Profile resource balance must be an integer.")}</p>}
    {binding ? <p className="muted small">{t("This resource comes from a progression profile. Only its balance is editable here; the profile controls capacity and recovery.")}{!binding.active && t(" Source revoked; resource unavailable.")}</p> : gm ? <div className="sheet-two-columns"><label className="field stacked"><span>{t("Resource type")}</span><select value={draft.kind} onChange={e => edit({ kind: e.target.value as ResourceKind })}>{Object.entries(KIND_NAMES).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="field stacked"><span>{t("Level · optional")}</span><input type="number" min="0" max="9" step="1" placeholder={t("Not specified")} value={draft.level ?? ''} onChange={e => edit({ level: nullable(e.target.value) })}/></label><label className="field stacked"><span>{t("Unit · optional")}</span><input maxLength={40} value={draft.unit} onChange={e => edit({ unit: e.target.value })}/></label><label className="field stacked"><span>{t("Recovery policy")}</span><select value={draft.recovery} onChange={e => edit({ recovery: e.target.value as RecoveryPolicy })}>{Object.entries(RECOVERY_NAMES).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label></div> : <p className="muted small">{t("The GM sets type and recovery. You can change the name and values.")}</p>}
    {usedBy.length > 0 && <p className="muted small">{t("Used in costs:")} {usedBy.map(action => action.name).join(', ')}{t(". Update these actions before deleting.")}</p>}
    <div className="form-actions">{resource && !binding && <button type="button" className="danger" disabled={!online || removed || conflict || usedBy.length > 0} onClick={() => setDeleting(true)}><Trash2 size={16}/>{t("Delete resource")}</button>}<button className="primary" disabled={!online || busy || !dirty || conflict || removed || invalid || !draft.label.trim()}>{t("Save resource")}</button></div>
    {deleting && <div className="sheet-delete-confirm"><span>{t("Delete this resource? Saved results will remain.")}</span><button type="button" onClick={() => setDeleting(false)}>{t("Keep")}</button><button type="button" className="danger" disabled={!online || removed || conflict || usedBy.length > 0} onClick={async () => { if (!resource) return; setBusy(true); try { if (await command('actor.resource.delete', { id: actor.id, resourceId: resource.id }, baseRevision)) onClose(); } finally { setBusy(false); } }}>{t("Confirm deletion")}</button></div>}
    </fieldset></form>;
}

function RecoveryPreview({ actor, campaign, reliable, online, hasDraft }: ActionProps) {
  const [event, setEvent] = useState<RecoveryEvent>('turn'), [revision, setRevision] = useState(campaign.revision), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const preview = previewRecovery(actor, event), stale = revision !== campaign.revision;
  const unresolved = reliable.operations.some(operation => operation.actorId === actor.id) || !!reliable.storageError;
  return <section className="recovery-preview"><h3><RotateCcw size={18}/>{t("Explicit recovery")}</h3><p className="muted small">{t("This is a GM command. Combat turns and page reloads do not trigger it. A long rest includes both short-rest and long-rest policies.")}</p>
    <label className="field stacked"><span>{t("Recovery event")}</span><select value={event} disabled={busy || unresolved} onChange={e => setEvent(e.target.value as RecoveryEvent)}>{(['turn','short-rest','long-rest'] as const).map(value => <option value={value} key={value}>{RECOVERY_NAMES[value]}</option>)}</select></label>
    <ul className="recovery-changes">{preview.changes.map(change => <li key={change.resourceId} className={change.applied ? 'will-recover' : ''}><span><strong>{change.label}</strong><small>{REASON_NAMES[change.reason]}</small></span><b>{num(change.before)} → {num(change.after)}</b></li>)}</ul>
    {!preview.available && <p className="muted small" role="status">{t("No resources can recover for this event.")}</p>}
    {stale && <div className="draft-conflict" role="status"><p>{t("Resources changed. Review the displayed values before recovering.")}</p><button disabled={busy || unresolved} onClick={() => setRevision(campaign.revision)}>{t("Confirm updated recovery")}</button></div>}
    {hasDraft && <p className="warning-box">{t("Save or close sheet drafts before recovering.")}</p>}
    <button className="primary" disabled={!online || busy || hasDraft || unresolved || stale || !preview.available} onClick={async () => { if (!online || busy || unresolved || stale || hasDraft || !preview.available) return; setBusy(true); try { setNotice(resultMessage(await reliable.execute(actor.id, 'actor.resource.recover', { id: actor.id, event }, revision, recoveryOperationLabel(event)))); } finally { setBusy(false); } }}><RotateCcw size={16}/>{busy ? t("Sending…") : t("Apply recovery")}</button>
    {notice && <p role="status" className="action-notice">{translateSystemMessage(notice)}</p>}
  </section>;
}

export function RecoveryReceipt({ receipt }: { receipt: ResourceRecoveryReceipt }) {
  return <details className="action-receipt"><summary><span><strong>{RECOVERY_NAMES[receipt.event]}</strong><small>{receipt.actor.name} · {receipt.author.name} · {new Date(receipt.createdAt).toLocaleString(getLocale())}</small></span><b>{t("Recovered")}</b></summary><ul className="recovery-changes">{receipt.changes.map(change => <li key={change.resourceId}><span><strong>{change.label}</strong><small>{REASON_NAMES[change.reason]}</small></span><b>{num(change.before)} → {num(change.after)}</b></li>)}</ul><p className="muted small">{t("Values saved at the time of the operation.")}</p></details>;
}
