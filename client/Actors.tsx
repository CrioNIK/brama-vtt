import { t as tr, getLocale, translateSystemMessage } from '../shared/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Check, Dices, LockKeyhole, Package, Plus, Search, Trash2, UserRound, X } from 'lucide-react';
import { ABILITY_KEYS, TOKEN_COLORS } from '../shared/model';
import type { AbilityKey, Actor, ActorItem, ActorResource, Campaign, ChatMessage, Member, RollMode, Scene } from '../shared/model';
import type { SendCommand } from './session';
import { RollDetails, TokenBadge } from './Panels';
import { DraftConflict, useDraft } from './draft';
import { abilityBreakdown, derivedAbilitiesWithinBounds, effectiveAbilityScores } from '../shared/abilities';
import { EffectList } from './Effects';
import { ABILITY_NAMES, signed } from './ability-ui';
import { ActionList } from './Actions';
import { Resources } from './Resources';
import { Checks } from './Checks';
import { Progression, ProgressionDirectoryTools } from './Progression';
import { managedBinding } from '../shared/progression';
import type { ReliableController } from './reliable';

export { ABILITY_NAMES } from './ability-ui';
const nullable = (value: string) => value === '' ? null : Number(value);
const progressionLabel = (actor: Actor) => actor.progression ? tr("{p0} · version {p1}", { p0: actor.progression.profileName, p1: actor.progression.profile.version }) : null;
export const canOpenSheet = (actor: Actor, member: Member) => member.role === 'gm' || actor.owners.includes(member.id);
type MarkDirty = (section: string, value: boolean) => void;
function useDirtyMark(section: string, dirty: boolean, mark: MarkDirty) {
  useEffect(() => { mark(section, dirty); return () => mark(section, false); }, [section, dirty, mark]);
}
type EditorProps = { actor: Actor; campaign: Campaign; self: Member; command: SendCommand; online: boolean; markDirty: MarkDirty };

export function ActorDirectory({ campaign, scene, self, command, reliable, online, onOpen }: { campaign: Campaign; scene: Scene; self: Member; command: SendCommand; reliable: ReliableController; online: boolean; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState(''), [creating, setCreating] = useState(false), [notice, setNotice] = useState('');
  const actors = campaign.actors.filter(a => canOpenSheet(a, self) && a.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <section className="actor-directory"><div className="section-title"><h2>{tr("Characters")}</h2>{self.role === 'gm' && <button className="icon-button" aria-label={tr("Create character without a token")} disabled={!online} onClick={() => setCreating(!creating)}><Plus size={19}/></button>}</div>
    <ProgressionDirectoryTools campaign={campaign} self={self} command={command} reliable={reliable} online={online} onOpen={onOpen}/>
    <label className="directory-search"><Search size={16}/><input aria-label={tr("Find character")} placeholder={tr("Find character")} value={query} onChange={e => setQuery(e.target.value)}/></label>
    {creating && <CreateActor command={command} online={online} onDone={() => setCreating(false)}/>}
    {!actors.length && <div className="empty-state"><UserRound size={30}/><p>{query ? tr("No characters found.") : self.role === 'gm' ? tr("Create a character. You can place a token later.") : tr("The game master has not granted you sheet access yet.")}</p></div>}
    {actors.map(actor => <div className="actor-directory-row" key={actor.id}><button className="actor-open" onClick={() => onOpen(actor.id)}><TokenBadge token={actor} small/><span><strong>{actor.name}</strong><small>{actor.hp ?? '—'} / {actor.maxHp ?? '—'} {tr("HP")} · {progressionLabel(actor) ?? (actor.sheetKind === 'dnd5e' ? tr("D&D: abilities") : tr("Manual sheet"))}</small></span></button>{self.role === 'gm' && <button className="icon-button" aria-label={tr("Place on scene: {p0}", { p0: actor.name })} title={tr("Place on scene")} disabled={!online} onClick={async () => {
      const x = Math.max(scene.grid.size / 2, Math.min(scene.width - scene.grid.size / 2, scene.grid.size * 5.5));
      const y = Math.max(scene.grid.size / 2, Math.min(scene.height - scene.grid.size / 2, scene.grid.size * 5.5));
      if (await command('actor.place', { id: actor.id, sceneId: scene.id, levelId: scene.activeLevelId, x, y, linked: true })) setNotice(tr("Token “{p0}” added to the scene.", { p0: actor.name }));
    }}><Plus size={17}/></button>}</div>)}
    {notice && <p className="muted small directory-notice" role="status">{translateSystemMessage(notice)}</p>}
  </section>;
}
function CreateActor({ command, online, onDone }: { command: SendCommand; online: boolean; onDone: () => void }) {
  const [name, setName] = useState(''), [sheetKind, setKind] = useState('generic'), [busy, setBusy] = useState(false);
  return <form className="actor-create" onSubmit={async e => { e.preventDefault(); setBusy(true); if (await command('actor.create', { name, sheetKind })) onDone(); setBusy(false); }}><label className="field stacked"><span>{tr("Character name")}</span><input autoFocus required value={name} maxLength={120} onChange={e => setName(e.target.value)}/></label><label className="field stacked"><span>{tr("Sheet")}</span><select value={sheetKind} onChange={e => setKind(e.target.value)}><option value="generic">{tr("Manual sheet")}</option><option value="dnd5e">{tr("D&D: six abilities")}</option></select></label><div className="form-actions"><button type="button" onClick={onDone}>{tr("Cancel")}</button><button className="primary" disabled={!online || busy || !name.trim()}>{tr("Create character")}</button></div></form>;
}

export function ActorSheet({ actor, campaign, self, command, reliable, online, onClose }: Omit<EditorProps, 'markDirty'> & { reliable: ReliableController; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null), [tab, setTab] = useState('character'), [dirty, setDirty] = useState<Record<string, boolean>>({}), [closing, setClosing] = useState(false);
  const markDirty = useCallback<MarkDirty>((key, value) => setDirty(previous => previous[key] === value ? previous : { ...previous, [key]: value }), []);
  const hasDraft = Object.values(dirty).some(Boolean);
  const close = () => hasDraft ? setClosing(true) : onClose();
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  const context = { actor, campaign, self, command, online, markDirty, reliable, hasDraft, openChecks: () => setTab('checks') };
  return <dialog ref={ref} className="modal actor-modal" aria-labelledby="actor-sheet-title" onCancel={e => { e.preventDefault(); close(); }}>
    <header className="actor-sheet-header"><TokenBadge token={actor}/><div><h2 id="actor-sheet-title">{actor.name}</h2><p>{progressionLabel(actor) ?? (actor.sheetKind === 'dnd5e' ? tr("D&D · abilities and inventory") : tr("Character sheet"))}{hasDraft ? " " + tr("· draft present") : ''}</p></div><button className="icon-button" onClick={close} aria-label={tr("Close character sheet")}><X size={20}/></button></header>
    {closing && <div className="sheet-close-notice" role="alert"><p>{tr("The sheet has unsaved changes.")}</p><button onClick={() => setClosing(false)}>{tr("Continue editing")}</button><button className="danger" onClick={onClose}>{tr("Close without saving")}</button></div>}
    <nav className="sheet-tabs" aria-label={tr("Sheet sections")}>{[['character',tr("Character")],['progression',tr("Progression")],['checks',tr("Checks")],['actions',tr("Actions")],['inventory',tr("Inventory")],['resources',tr("Resources")],['effects',tr("Effects")],['notes',tr("Notes")]].map(([id,label]) => <button key={id} aria-pressed={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</nav>
    {!online && <p className="sheet-offline" role="status">{tr("Offline. Your draft stays in the sheet; saving and rolls are temporarily unavailable.")}</p>}
    <div className="actor-sheet-body"><div hidden={tab !== 'character'}><ActorBasics {...context}/></div><div hidden={tab !== 'progression'}><Progression {...context} hasOtherDraft={Object.entries(dirty).some(([key, value]) => key !== 'progression' && value)}/></div><div hidden={tab !== 'checks'}><Checks {...context}/></div><div hidden={tab !== 'actions'}><ActionList {...context}/></div><div hidden={tab !== 'inventory'}><Inventory {...context}/></div><div hidden={tab !== 'resources'}><Resources {...context}/></div><div hidden={tab !== 'effects'}><EffectList {...context}/></div><div hidden={tab !== 'notes'}><ActorNotes {...context}/></div></div>
  </dialog>;
}

function ActorBasics({ actor, campaign, self, command, online, markDirty, hasDraft, openChecks }: EditorProps & { hasDraft: boolean; openChecks: () => void }) {
  const gm = self.role === 'gm';
  const { draft, dirty, edit, reload, baseRevision, saved, conflict } = useDraft({ name: actor.name, color: actor.color, hp: actor.hp, maxHp: actor.maxHp, owners: actor.owners, sheetKind: actor.sheetKind, abilities: actor.abilities }, campaign.revision);
  const [busy, setBusy] = useState(false); useDirtyMark('character', dirty, markDirty);
  const previewActor = { abilities: draft.abilities, effects: actor.effects };
  const validDerived = derivedAbilitiesWithinBounds(previewActor);
  const contributions = ABILITY_KEYS.map(key => abilityBreakdown(previewActor, key)).filter(value => value.contributions.length > 0);
  return <div className="sheet-character-grid"><form onSubmit={async e => { e.preventDefault(); if (!online || busy || !dirty || conflict || !validDerived) return; setBusy(true); try { if (await command('actor.update', { id: actor.id, name: draft.name, color: draft.color, hp: draft.hp, maxHp: draft.maxHp, abilities: draft.abilities, ...(gm ? { owners: draft.owners, sheetKind: draft.sheetKind } : {}) }, baseRevision)) saved(); } finally { setBusy(false); } }}>
    <DraftConflict show={conflict} reload={reload}/><fieldset disabled={busy}>
    <label className="field"><span>{tr("Name")}</span><input required value={draft.name} maxLength={120} onChange={e => edit({ name: e.target.value })}/></label>
    <div className="field"><span>{tr("HP")}</span><div className="double-field"><input aria-label={tr("Character HP")} type="number" min="0" max="100000" value={draft.hp ?? ''} placeholder={tr("Unknown")} onChange={e => edit({ hp: nullable(e.target.value) })}/><span>/</span><input aria-label={tr("Character maximum HP")} type="number" min="0" max="100000" value={draft.maxHp ?? ''} placeholder={tr("Unknown")} onChange={e => edit({ maxHp: nullable(e.target.value) })}/></div></div>
    <label className="field"><span>{tr("Color")}</span><input type="color" value={draft.color} onChange={e => edit({ color: e.target.value })}/></label>
    {gm && <label className="field"><span>{tr("Sheet")}</span><select aria-label={actor.progression ? tr("Character sheet profile") : tr("Character sheet type")} disabled={!!actor.progression} value={draft.sheetKind} onChange={e => edit({ sheetKind: e.target.value as Actor['sheetKind'] })}><option value="generic">{tr("Manual sheet")}</option><option value="dnd5e">{progressionLabel(actor) ?? tr("D&D: abilities")}</option></select></label>}
    {draft.sheetKind === 'dnd5e' && <><h3 className="sheet-subtitle">{tr("Base abilities")}</h3><div className="ability-inputs">{ABILITY_KEYS.map(key => { const breakdown = abilityBreakdown(previewActor, key); return <label key={key}><span>{ABILITY_NAMES[key]}</span><input aria-label={tr("Base ability: {p0}", { p0: ABILITY_NAMES[key] })} type="number" min="1" max="30" step="1" placeholder="—" value={draft.abilities[key] ?? ''} onChange={e => edit({ abilities: { ...draft.abilities, [key]: nullable(e.target.value) } })}/><small>{breakdown.effective === null ? tr("Total unknown") : tr("Total {p0} · {p1}", { p0: breakdown.effective, p1: signed(breakdown.modifier!) })}</small>{breakdown.contributions.length > 0 && <span className="ability-effect-total">{tr("Effects")} {signed(breakdown.totalBonus)}</span>}</label>; })}</div>
    <p className="muted small">{tr("Edit the base value. The total includes enabled effects; an unknown base stays unknown.")} {dirty && tr("You are viewing a draft preview.")} {tr("Skills, saving throws, and proficiency bonus are in Checks.")}</p>
    {!validDerived && <p className="error small" role="status">{tr("The final ability score must be between −1000 and 1000.")}</p>}
    {contributions.length > 0 && <details className="ability-breakdown"><summary>{tr("Ability bonus sources")}</summary>{contributions.map(value => <div key={value.ability}><strong>{ABILITY_NAMES[value.ability]} · {signed(value.totalBonus)}</strong><ul>{value.contributions.map((part,index) => <li key={`${part.effectId}-${index}`}>{part.effectName}: {signed(part.value)}</li>)}</ul></div>)}</details>}</>}
    {gm && <details className="sheet-ownership"><summary>{tr("Sheet access")}</summary><p className="muted small">{tr("Owners can edit the sheet, inventory, and effects. Token control is assigned separately.")}</p>{campaign.members.map(member => <label className="check" key={member.id}><input type="checkbox" checked={draft.owners.includes(member.id)} onChange={e => edit({ owners: e.target.checked ? [...draft.owners, member.id] : draft.owners.filter(id => id !== member.id) })}/>{member.name}{member.role === 'gm' ? " " + tr("· game master") : ''}</label>)}</details>}
    <div className="form-actions"><span className="muted small">{dirty ? tr("Changes present") : tr("Saved")}</span><button className="primary" disabled={!online || !dirty || conflict || busy || !validDerived}><Check size={16}/>{tr("Save character")}</button></div></fieldset>
    </form>{actor.checks && actor.sheetKind === 'dnd5e' ? <section className="sheet-roll"><h3><Dices size={19}/>{tr("Skills and saving throws")}</h3><p className="muted small">{tr("Checks use bonuses, proficiency, and modes from the sheet.")}</p><button className="full-width" onClick={openChecks}>{tr("Open checks")}</button></section> : <ActorRoll actor={actor} campaign={campaign} command={command} disabled={!online || hasDraft}/>}</div>;
}
function ActorRoll({ actor, campaign, command, disabled }: { actor: Actor; campaign: Campaign; command: SendCommand; disabled: boolean }) {
  const [mode, setMode] = useState<RollMode>('normal'), [visibility, setVisibility] = useState('public'), [modifier, setModifier] = useState(0), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const effective = effectiveAbilityScores(actor);
  const invalidModifier = !Number.isInteger(modifier) || Math.abs(modifier) > 1000;
  let last: ChatMessage | undefined;
  for (let i = campaign.chat.length - 1; i >= 0; i--) {
    if (campaign.chat[i].roll?.actor?.id === actor.id) { last = campaign.chat[i]; break; }
  }
  async function roll(ability?: AbilityKey) { setBusy(true); if (await command('actor.roll', { id: actor.id, ...(ability ? { ability } : { modifier }), mode, visibility })) setNotice(tr("Roll saved in campaign chat.")); setBusy(false); }
  return <section className="sheet-roll"><h3><Dices size={19}/> {tr("d20 check")}</h3><label className="field stacked"><span>{tr("Roll mode")}</span><select value={mode} onChange={e => setMode(e.target.value as RollMode)}><option value="normal">{tr("Normal")}</option><option value="advantage">{tr("Advantage")}</option><option value="disadvantage">{tr("Disadvantage")}</option></select></label><label className="field stacked"><span>{tr("Result visibility")}</span><select value={visibility} onChange={e => setVisibility(e.target.value)}><option value="public">{tr("All members")}</option><option value="gm">{tr("Game master only")}</option><option value="self">{tr("Only me")}</option></select></label>
    {actor.sheetKind === 'dnd5e' ? <div className="ability-rolls">{ABILITY_KEYS.map(key => <button key={key} disabled={disabled || busy || effective[key] === null} onClick={() => void roll(key)}><span>{ABILITY_NAMES[key]}</span><b>{effective[key] === null ? '—' : signed(Math.floor((effective[key]! - 10) / 2))}</b><Dices size={17}/></button>)}</div> : <><label className="field stacked"><span>{tr("Modifier")}</span><input type="number" min="-1000" max="1000" step="1" aria-invalid={invalidModifier} value={modifier} onChange={e => setModifier(Number(e.target.value))}/></label>{invalidModifier && <p className="error small" role="status">{tr("Enter an integer between −1000 and 1000.")}</p>}<button className="full-width" disabled={disabled || busy || invalidModifier} onClick={() => void roll()}><Dices size={17}/>{tr("Roll d20")} {signed(modifier)}</button></>}
    {disabled && <p className="muted small">{tr("Save your draft and wait for a connection before rolling.")}</p>}{notice && <p className="sheet-success small" role="status">{translateSystemMessage(notice)}</p>}
    {last?.roll && <div className="sheet-last-roll" role="status" aria-label={tr("Latest available character result")}><h4>{tr("Latest result")}</h4><p>{last.roll.ability ? ABILITY_NAMES[last.roll.ability] : 'd20'} · {last.authorName}</p><div className="roll-card"><div><Dices size={17}/><strong>{last.roll.formula}</strong></div><b>{last.roll.total}</b><RollDetails roll={last.roll}/></div><small>{last.visibility === 'self' ? tr("Author only") : last.visibility === 'gm' ? tr("Author and game master") : tr("All members")}</small></div>}
  </section>;
}

const emptyItem = (): ActorItem => ({ id: '', name: '', type: 'equipment', quantity: 1, weight: 0, weightUnit: 'unit', description: '', equipped: false });
function Inventory(context: EditorProps) {
  const { actor, command, online } = context;
  const [query, setQuery] = useState(''), [editing, setEditing] = useState<string | null>(null), [editorDirty, setEditorDirty] = useState(false), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [retainedItem, setRetainedItem] = useState<ActorItem | undefined>();
  const selected = actor.items.find(item => item.id === editing);
  useEffect(() => { if (selected) setRetainedItem(selected); }, [selected]);
  const mark = useCallback<MarkDirty>((section, value) => { setEditorDirty(value); context.markDirty(section, value); }, [context.markDirty]);
  const open = (id: string) => { if (editorDirty) { setNotice(tr("Save or discard item changes first.")); return; } setNotice(''); setRetainedItem(actor.items.find(item => item.id === id)); setEditing(id); };
  const weights = actor.items.reduce<Record<string, number>>((s,item) => ({ ...s, [item.weightUnit]: (s[item.weightUnit] || 0) + item.quantity * item.weight }), {});
  async function consume(item: ActorItem, from: 'quantity'|'uses') { setBusy(true); await command('actor.item.consume', { id: actor.id, itemId: item.id, from, amount: 1 }, true); setBusy(false); }
  return <><div className="section-title"><h3>{tr("Inventory")} <span className="muted">· {actor.items.length}</span></h3><button onClick={() => open('new')} disabled={!online || editorDirty}><Plus size={17}/>{tr("Add item")}</button></div>
    <label className="directory-search"><Search size={16}/><input aria-label={tr("Find item")} value={query} placeholder={tr("Find item")} onChange={e => setQuery(e.target.value)}/></label>
    <div className="inventory-list">{actor.items.filter(item => item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(item => <div className={`inventory-row ${editing === item.id ? 'selected' : ''}`} key={item.id}>
      <button className="inventory-open" aria-label={tr("Open item: {p0}", { p0: item.name })} onClick={() => open(item.id)}><Package size={20}/><span><strong>{item.name}</strong><small>{item.type}{item.equipped ? " " + tr("· equipped") : ''}</small></span></button>
      <div className="item-quantity"><span>{item.quantity} {tr("pcs.")}</span><small><span>{item.weight.toLocaleString(getLocale(), { maximumFractionDigits: 3 })} {item.weightUnit === 'unit' ? tr("weight units") : item.weightUnit}{tr("/each")}</span> · <span>{(item.quantity * item.weight).toLocaleString(getLocale(), { maximumFractionDigits: 3 })} {item.weightUnit === 'unit' ? tr("weight units") : item.weightUnit} {tr("total")}</span></small></div>
      <div className="item-use-actions">{item.uses && <span className="small">{tr("Charges")} {item.uses.value}/{item.uses.max}</span>}<button aria-label={tr("Consume one item: {p0}", { p0: item.name })} title={tr("Consume one")} disabled={!online || busy || editorDirty || item.quantity < 1} onClick={() => void consume(item, 'quantity')}>{tr("−1 item")}</button>{item.uses && <button aria-label={tr("Spend charge: {p0}", { p0: item.name })} disabled={!online || busy || editorDirty || item.uses.value < 1} onClick={() => void consume(item, 'uses')}>{tr("−1 charge")}</button>}</div>
    </div>)}</div>
    {!actor.items.length && <p className="empty">{tr("Add equipment, consumables, or your own items.")}</p>}
    <p className="muted small inventory-weight">{tr("Total weight:")} {Object.entries(weights).map(([unit,value]) => `${value.toLocaleString(getLocale(),{ maximumFractionDigits: 3 })} ${unit === 'unit' ? tr("units") : unit}`).join(' · ') || '0'}{tr(". Units are not mixed.")}</p>
    {notice && <p className="warning-box small" role="status">{translateSystemMessage(notice)}</p>}
    {editing && <ItemEditor key={editing} {...context} item={selected ?? retainedItem} removed={editing !== 'new' && !selected} markDirty={mark} onClose={() => { setEditing(null); setRetainedItem(undefined); setNotice(''); }}/>}</>;
}
function ItemEditor({ item, removed, actor, campaign, command, online, markDirty, onClose }: EditorProps & { item?: ActorItem; removed: boolean; onClose: () => void }) {
  const initial = item ?? emptyItem(), binding = item ? managedBinding(actor, 'item', item.id) : undefined;
  const { draft, dirty, edit, reload, baseRevision, conflict } = useDraft({ ...initial, hasUses: !!initial.uses, usesValue: initial.uses?.value ?? 0, usesMax: initial.uses?.max ?? 0 }, campaign.revision);
  const [busy, setBusy] = useState(false), [deleting, setDeleting] = useState(false); useDirtyMark('item', dirty, markDirty);
  return <form className="sheet-editor" onSubmit={async e => { e.preventDefault(); if (removed) return; setBusy(true); if (await command(item ? 'actor.item.update' : 'actor.item.create', binding ? { id: actor.id, itemId: item!.id, quantity: draft.quantity, equipped: draft.equipped, ...(item!.uses ? { uses: { value: draft.usesValue, max: item!.uses.max } } : {}) } : { id: actor.id, ...(item ? { itemId: item.id } : {}), name: draft.name, type: draft.type, quantity: draft.quantity, weight: draft.weight, weightUnit: draft.weightUnit, description: draft.description, equipped: draft.equipped, uses: draft.hasUses ? { value: draft.usesValue, max: draft.usesMax } : null }, baseRevision)) onClose(); setBusy(false); }}>
    <div className="section-title"><h3>{item ? tr("Edit item") : tr("New item")}</h3><button type="button" className="icon-button" aria-label={tr("Discard item changes")} onClick={onClose}><X size={18}/></button></div>{removed && <p className="warning-box" role="alert">{tr("Another member deleted this item. Its text is preserved in this draft. You can copy it or close the editor.")}</p>}<DraftConflict show={conflict && !removed} reload={reload}/><fieldset disabled={busy}>
    <div className="sheet-two-columns"><label className="field stacked"><span>{tr("Item name")}</span><input autoFocus required readOnly={!!binding} value={draft.name} maxLength={120} onChange={e => edit({ name: e.target.value })}/></label><label className="field stacked"><span>{tr("Item type")}</span><input readOnly={!!binding} value={draft.type} maxLength={60} onChange={e => edit({ type: e.target.value })}/></label><label className="field stacked"><span>{tr("Quantity")}</span><input type="number" min="0" max="100000" step="1" value={draft.quantity} onChange={e => edit({ quantity: Number(e.target.value) })}/></label><label className="field stacked"><span>{tr("Weight per item")}</span><input type="number" min="0" max="100000" step="any" readOnly={!!binding} value={draft.weight} onChange={e => edit({ weight: Number(e.target.value) })}/></label><label className="field stacked"><span>{tr("Weight unit")}</span><select disabled={!!binding} value={draft.weightUnit} onChange={e => edit({ weightUnit: e.target.value as ActorItem['weightUnit'] })}><option value="unit">{tr("Custom unit")}</option><option value="lb">lb</option><option value="kg">kg</option></select></label><label className="check"><input type="checkbox" checked={draft.equipped} onChange={e => edit({ equipped: e.target.checked })}/> {tr("Equipped")}</label></div>
    {binding && <p className="muted small">{tr("Granted by a profile. Edit quantity, equipment status, and remaining charges here; change its definition in the profile. Removing the source keeps granted equipment.")}</p>}<label className="check"><input type="checkbox" disabled={!!binding} checked={draft.hasUses} onChange={e => edit({ hasUses: e.target.checked })}/> {tr("Has charges / uses")}</label>{draft.hasUses && <div className="sheet-two-columns"><label className="field stacked"><span>{tr("Charges remaining")}</span><input type="number" min="0" max="100000" value={draft.usesValue} onChange={e => edit({ usesValue: Number(e.target.value) })}/></label><label className="field stacked"><span>{tr("Maximum charges")}</span><input type="number" min="0" max="100000" readOnly={!!binding} value={draft.usesMax} onChange={e => edit({ usesMax: Number(e.target.value) })}/></label></div>}
    <label className="field stacked"><span>{tr("Item description")}</span><textarea rows={4} readOnly={!!binding} value={draft.description} maxLength={20000} onChange={e => edit({ description: e.target.value })}/></label><div className="form-actions">{item && !binding ? <button type="button" className="danger" disabled={!online || removed} onClick={() => setDeleting(true)}><Trash2 size={16}/>{tr("Delete")}</button> : <button type="button" onClick={onClose}>{tr("Cancel")}</button>}<button className="primary" disabled={!online || busy || conflict || removed || !dirty || !draft.name.trim()}>{tr("Save item")}</button></div>
    {deleting && <div className="sheet-delete-confirm"><span>{tr("Remove “")}{item?.name}{tr("” from inventory?")}</span><button type="button" onClick={() => setDeleting(false)}>{tr("Keep")}</button><button type="button" className="danger" disabled={!online || conflict || removed} onClick={async () => { if (removed) return; if (await command('actor.item.delete', { id: actor.id, itemId: item!.id }, baseRevision)) onClose(); }}>{tr("Delete item")}</button></div>}
    </fieldset></form>;
}

function ActorNotes({ actor, campaign, self, command, online, markDirty }: EditorProps) {
  const { draft, dirty, edit, reload, baseRevision, saved, conflict } = useDraft({ notes: actor.notes, gmNotes: actor.gmNotes }, campaign.revision); const [busy,setBusy] = useState(false); useDirtyMark('notes',dirty,markDirty);
  return <form onSubmit={async e => { e.preventDefault(); setBusy(true); if (await command('actor.update', { id: actor.id, notes: draft.notes, ...(self.role === 'gm' ? { gmNotes: draft.gmNotes } : {}) }, baseRevision)) saved(); setBusy(false); }}><DraftConflict show={conflict} reload={reload}/><fieldset disabled={busy}><label className="field stacked"><span>{tr("Character notes · visible to sheet owners")}</span><textarea rows={9} value={draft.notes} maxLength={20000} onChange={e => edit({ notes: e.target.value })}/></label>{self.role === 'gm' && <label className="field stacked"><span><LockKeyhole size={14}/> {tr("Game master only")}</span><textarea rows={5} aria-label={tr("Game master’s character notes")} value={draft.gmNotes} maxLength={20000} onChange={e => edit({ gmNotes: e.target.value })}/></label>}<div className="form-actions"><span className="muted small">{tr("Plain text")}</span><button className="primary" disabled={!online || busy || !dirty || conflict}><BookOpen size={16}/>{tr("Save notes")}</button></div></fieldset></form>;
}
