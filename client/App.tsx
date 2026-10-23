import { t as tr, getLocale, translateSystemMessage } from '../shared/i18n';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Copy, Download, FileUp, LogOut, Menu, MoreHorizontal, Plus, UserRound, UsersRound, X, WifiOff } from 'lucide-react';
import { activeScene, TOKEN_COLORS } from '../shared/model';
import type { Point, Scene } from '../shared/model';
import { LanguagePicker } from './LanguagePicker';
import { ImportScene } from './ImportScene';
import { authenticate, useSession } from './session';
import { Tabletop, type Selection } from './Tabletop';
import { ChatPanel, Composer, ObjectPanel } from './Panels';
import { ActorDirectory, ActorSheet, canOpenSheet } from './Actors';
import { PendingOperationNotice } from './Actions';
import { CombatPanel } from './Combat';
import { JournalPanel, JournalPresentations } from './Journal';
import { COMBAT_SCOPE } from './reliable';

type Modal = 'invite' | 'token' | 'scene' | 'level' | 'import' | null;
type Tab = 'objects' | 'actors' | 'chat' | 'combat' | 'journal';
const TABS: { id: Tab; label: string }[] = [{ id: 'objects', label: "Objects" }, { id: 'actors', label: "Sheets" }, { id: 'chat', label: "Chat" }, { id: 'combat', label: "Combat" }, { id: 'journal', label: "Journal" }];
function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog ref={ref} className="modal" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) onClose(); } }} aria-labelledby="dialog-title"><div className="modal-heading"><h2 id="dialog-title">{title}</h2><button className="icon-button" onClick={onClose} aria-label={tr("Close window")}><X size={19}/></button></div>{children}</dialog>;
}
export function App() {
  const session = useSession(); const { snapshot, auth, status, pending, command } = session;
  const [tab, setTab] = useState<Tab>('objects'), [selection, setSelection] = useState<Selection>(null), [modal, setModal] = useState<Modal>(null), [more, setMore] = useState(false), [panelOpen, setPanelOpen] = useState(false), [tokenPoint, setTokenPoint] = useState<Point>({ x: 400, y: 300 });
  const scene = snapshot ? activeScene(snapshot.campaign) : null;
  const [actorId, setActorId] = useState<string | null>(null);
  const sheetActor = snapshot?.campaign.actors.find(a => a.id === actorId && canOpenSheet(a, snapshot.self));
  useEffect(() => { if (selection && scene && ![...scene.tokens, ...scene.walls, ...scene.lights].some(entity => entity.id === selection.id)) setSelection(null); }, [scene, selection]);
  if (!auth) return <Entry onLogin={session.login}/>;
  if (!snapshot || !scene) return <div className="entry"><div className="entry-card"><h1>BRAMA VTT</h1><LanguagePicker/><h2>{tr("Connecting to the campaign")}</h2><p className="muted">{tr("Loading your saved tabletop…")}</p>{session.error && <p className="error">{translateSystemMessage(session.error)}</p>}<button onClick={session.logout}>{tr("Back to sign in")}</button></div></div>;
  const { campaign, self } = snapshot, gm = self.role === 'gm', online = status === 'online';
  const combatPending = !online || !!session.reliable.storageError || session.reliable.operations.some(o => o.actorId === COMBAT_SCOPE);
  const addToCombat = (id: string, sceneId: string) => { void session.reliable.execute(COMBAT_SCOPE, 'combat.add', { id, sceneId }, campaign.revision, tr("Add token to combat")); setTab('combat'); };
  const activeCombatant = campaign.combat.active ? campaign.combat.combatants[campaign.combat.turn] : undefined;
  const select = (value: Selection) => { setSelection(value); if (value) setTab('objects'); };
  async function exportCampaign() {
    try { const response = await fetch('/api/export', { headers: { Authorization: `Bearer ${auth!.token}` } }); if (!response.ok) throw new Error((await response.json()).error); const blob = await response.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `brama-campaign-${campaign.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    catch (error) { session.setError(error instanceof Error ? translateSystemMessage(error.message) : tr("Could not export the campaign")); }
  }
  return <div className="app-shell">
    <header className="app-header"><h1>BRAMA VTT</h1><LanguagePicker/><div className="campaign-name"><span>{tr("Campaign:")}</span><strong>{campaign.name}</strong></div><label className="scene-picker"><span>{tr("Scene:")}</span><select aria-label={tr("Scene")} value={scene.id} disabled={!gm || !online} onChange={event => void command('scene.activate', { id: event.target.value })}>{campaign.scenes.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><div className="header-spacer"/><span className="role"><UserRound size={18}/>{gm ? tr("Game master") : self.name}</span>{gm && <button className="invite-button" onClick={() => setModal('invite')}><UsersRound size={17}/><span>{tr("Invite")}</span></button>}<div className="menu-anchor"><button className="icon-button" aria-label={tr("Campaign menu")} aria-expanded={more} onClick={() => setMore(!more)}><MoreHorizontal size={20}/></button>{more && <div className="dropdown"><button onClick={() => { setModal('scene'); setMore(false); }} disabled={!gm}><Plus size={16}/>{tr("Create scene")}</button><button onClick={() => { setModal('import'); setMore(false); }} disabled={!gm}><FileUp size={16}/>{tr("Import scene")}</button><button onClick={() => { void exportCampaign(); setMore(false); }} disabled={!gm}><Download size={16}/>{tr("Export campaign")}</button><button onClick={session.logout}><LogOut size={16}/>{tr("Switch session")}</button></div>}</div><button className="mobile-toggle icon-button" aria-label={panelOpen ? tr("Hide sidebar") : tr("Show sidebar")} aria-expanded={panelOpen} onClick={() => setPanelOpen(!panelOpen)}>{panelOpen ? <X/> : <Menu/>}</button></header>
    {(session.reliable.operations.length > 0 || session.reliable.storageError) && <details className="global-pending" open><summary>{tr("Operation review ·")} {session.reliable.operations.length || tr("storage")}</summary>{session.reliable.storageError ? <p role="alert">{translateSystemMessage(session.reliable.storageError)}</p> : session.reliable.operations.map(operation => <PendingOperationNotice key={operation.command.id} actorId={operation.actorId} reliable={session.reliable} online={online}/>)}</details>}
    <main className="workspace"><Tabletop currentCombatTokenId={activeCombatant?.sceneId === scene.id ? activeCombatant.tokenId : undefined} scene={scene} actors={campaign.actors} self={self} selection={selection} setSelection={select} command={command} online={online} onCreateToken={point => { setTokenPoint(point); setModal('token'); }}/>
      <aside className={`sidebar ${panelOpen ? 'mobile-open' : ''}`} aria-label={tr("Campaign panels")}><nav className="panel-tabs" aria-label={tr("Tabletop sections")}>{TABS.map(item => <button key={item.id} className={tab === item.id ? 'active' : ''} aria-pressed={tab === item.id} onClick={() => setTab(item.id)}>{tr(item.label)}</button>)}</nav><div className="panel-body">
        {tab === 'objects' && <ObjectPanel onCombatAdd={addToCombat} combatPending={combatPending} onOpenActor={setActorId} scene={scene} campaign={campaign} self={self} selection={selection} setSelection={select} command={command} onAddToken={() => { setTokenPoint({ x: scene.grid.size * 5.5, y: scene.grid.size * 5.5 }); setModal('token'); }} onAddLevel={() => setModal('level')}/>}
        {tab === 'chat' && <ChatPanel campaign={campaign} self={self}/>}
        {tab === 'actors' && <ActorDirectory campaign={campaign} scene={scene} self={self} command={command} reliable={session.reliable} online={online} onOpen={setActorId}/>}
        {tab === 'combat' && <CombatPanel campaign={campaign} self={self} selection={selection} reliable={session.reliable} online={online} onSelectToken={id => setSelection({ kind: 'token', id })} onOpenActor={setActorId}/>}
        {tab === 'journal' && <JournalPanel campaign={campaign} self={self} reliable={session.reliable} online={online}/>}
      </div><Composer command={command} online={online} onSent={() => setTab('chat')}/><div className={`connection ${status}`} role="status"><i/>{online ? pending ? tr("Saving changes…") : tr("Connected · saved") : status === 'connecting' ? tr("Connecting…") : tr("Offline · reconnecting")}<span title={tr("Campaign revision")}>r{campaign.revision}</span></div></aside>
    </main>
    <JournalPresentations campaign={campaign} self={self} reliable={session.reliable} online={online}/>
    {!online && <div className="offline-banner"><WifiOff size={18}/>{tr("Server unavailable. Changes cannot be sent until the connection is restored.")}</div>}
    {session.error && <div className="toast" role="alert"><p>{translateSystemMessage(session.error)}</p><button className="icon-button" aria-label={tr("Dismiss notification")} onClick={() => session.setError('')}><X size={17}/></button></div>}
    {sheetActor && <ActorSheet key={sheetActor.id} actor={sheetActor} campaign={campaign} self={self} command={command} reliable={session.reliable} online={online} onClose={() => setActorId(null)}/>}
    {modal === 'invite' && <Dialog title={tr("Invite player")} onClose={() => setModal(null)}><Invite code={snapshot.inviteCode || ''} members={campaign.members.map(m => `${m.name} · ${m.role === 'gm' ? tr("game master") : tr("player")}`)}/></Dialog>}
    {modal === 'token' && <Dialog title={tr("New character on the map")} onClose={() => setModal(null)}><CreateToken scene={scene} at={tokenPoint} onSubmit={async data => { if (await command('token.create', data)) setModal(null); }}/></Dialog>}
    {modal === 'scene' && <Dialog title={tr("New scene")} onClose={() => setModal(null)}><SimpleCreate label={tr("Scene name")} placeholder={tr("Map name")} submit={tr("Create scene")} onSubmit={async name => { if (await command('scene.create', { name })) setModal(null); }}/></Dialog>}
    {modal === 'level' && <Dialog title={tr("New floor")} onClose={() => setModal(null)}><CreateLevel onSubmit={async data => { if (await command('level.create', { ...data, sceneId: scene.id })) setModal(null); }}/></Dialog>}
    {modal === 'import' && <Dialog title={tr("Import scene")} onClose={() => setModal(null)}><ImportScene online={online} onImport={async document => { const ok = await command('scene.import', { document }); if (ok) { setModal(null); setSelection(null); setTab('objects'); } return ok; }}/></Dialog>}
  </div>;
}
function Entry({ onLogin }: { onLogin: ReturnType<typeof useSession>['login'] }) {
  const initialInvite = new URLSearchParams(location.search).get('invite') || '';
  const [mode, setMode] = useState<'create' | 'join'>(initialInvite ? 'join' : 'create'), [name, setName] = useState(tr("Observatory")), [person, setPerson] = useState(initialInvite ? '' : tr("Game master")), [invite, setInvite] = useState(initialInvite), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(event: React.FormEvent) { event.preventDefault(); setBusy(true); setError(''); try { onLogin(await authenticate(mode, mode === 'create' ? { name, gmName: person, locale: getLocale() } : { inviteCode: invite, name: person })); } catch (e) { setError(e instanceof Error ? translateSystemMessage(e.message) : tr("Could not connect")); } finally { setBusy(false); } }
  return <main className="entry"><div className="entry-card"><h1>BRAMA VTT</h1><LanguagePicker/><p className="entry-subtitle">{tr("Your table. Your story.")}</p><div className="entry-tabs"><button className={mode === 'create' ? 'active' : ''} onClick={() => { setMode('create'); setError(''); }}>{tr("Create campaign")}</button><button className={mode === 'join' ? 'active' : ''} onClick={() => { setMode('join'); setError(''); }}>{tr("Join")}</button></div><form onSubmit={submit}>{mode === 'create' ? <label className="field stacked"><span>{tr("Campaign name")}</span><input autoFocus required value={name} onChange={e => setName(e.target.value)} maxLength={120}/></label> : <label className="field stacked"><span>{tr("Invite code")}</span><input autoFocus required value={invite} onChange={e => setInvite(e.target.value)} maxLength={100} autoComplete="off"/></label>}<label className="field stacked"><span>{tr("Your name")}</span><input required value={person} onChange={e => setPerson(e.target.value)} maxLength={80} autoComplete="nickname"/></label>{error && <p className="error" role="alert">{translateSystemMessage(error)}</p>}<button className="primary entry-submit" disabled={busy}>{busy ? tr("Connecting…") : mode === 'create' ? tr("Open tabletop") : tr("Join campaign")}<ArrowRight size={18}/></button></form><p className="entry-footnote">{tr("The campaign is stored on this server. The game master session stays in this tab.")}</p></div></main>;
}
function Invite({ code, members }: { code: string; members: string[] }) {
  const [copied, setCopied] = useState(false); const url = `${location.origin}/?invite=${encodeURIComponent(code)}`;
  return <div className="modal-content"><p>{tr("Players join by invitation. Token control is assigned separately in token properties.")}</p><label className="field stacked"><span>{tr("Invite code")}</span><input readOnly value={code} onFocus={e => e.target.select()}/></label><label className="field stacked"><span>{tr("Link for this server")}</span><input readOnly value={url} onFocus={e => e.target.select()}/></label><button onClick={async () => { try { await navigator.clipboard.writeText(url); setCopied(true); } catch { setCopied(false); } }}>{copied ? <Check size={16}/> : <Copy size={16}/>} {copied ? tr("Copied") : tr("Copy link")}</button><p className="muted small">{tr("This server is running locally. The link is available in browsers on this computer.")}</p><h3>{tr("Members")}</h3><ul className="member-list">{members.map(member => <li key={member}>{member}</li>)}</ul></div>;
}
function SimpleCreate({ label, placeholder, submit, onSubmit }: { label: string; placeholder: string; submit: string; onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState(''), [busy, setBusy] = useState(false);
  return <form className="modal-content" onSubmit={async event => { event.preventDefault(); setBusy(true); await onSubmit(name); setBusy(false); }}><label className="field stacked"><span>{label}</span><input autoFocus required value={name} onChange={e => setName(e.target.value)} maxLength={120} placeholder={placeholder}/></label><button className="primary" disabled={busy}>{submit}</button></form>;
}
function CreateToken({ scene, at, onSubmit }: { scene: Scene; at: Point; onSubmit: (data: Record<string, unknown>) => Promise<void> }) {
  const [name, setName] = useState(tr("New character")), [hp, setHp] = useState(12), [color, setColor] = useState(TOKEN_COLORS[0]), [busy, setBusy] = useState(false);
  return <form className="modal-content" onSubmit={async event => { event.preventDefault(); setBusy(true); await onSubmit({ sceneId: scene.id, levelId: scene.activeLevelId, name, hp, maxHp: hp, color, ...at }); setBusy(false); }}><label className="field stacked"><span>{tr("Name")}</span><input autoFocus required value={name} onChange={e => setName(e.target.value)} maxLength={80}/></label><label className="field"><span>{tr("HP")}</span><input type="number" min="1" max="100000" required value={hp} onChange={e => setHp(Number(e.target.value))}/></label><div className="color-choices" aria-label={tr("Token color")}>{TOKEN_COLORS.map(c => <button type="button" key={c} className={c === color ? 'selected' : ''} aria-label={tr("Color {p0}", { p0: c })} aria-pressed={c === color} onClick={() => setColor(c)} style={{ background: c }}/>)}</div><button className="primary" disabled={busy}>{tr("Create token")}</button></form>;
}
function CreateLevel({ onSubmit }: { onSubmit: (data: Record<string, unknown>) => Promise<void> }) {
  const [name, setName] = useState(tr("Second floor")), [bottom, setBottom] = useState(20), [top, setTop] = useState(40);
  return <form className="modal-content" onSubmit={event => { event.preventDefault(); void onSubmit({ name, bottom, top }); }}><label className="field stacked"><span>{tr("Title")}</span><input autoFocus required value={name} onChange={e => setName(e.target.value)}/></label><label className="field"><span>{tr("Lower elevation")}</span><input type="number" value={bottom} onChange={e => setBottom(Number(e.target.value))}/></label><label className="field"><span>{tr("Upper elevation")}</span><input type="number" min={bottom + 1} value={top} onChange={e => setTop(Number(e.target.value))}/></label><button className="primary">{tr("Add level")}</button></form>;
}
