import { t as tr, getLocale, translateSystemMessage, chatMessageText } from '../shared/i18n';
import { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, ChevronRight, Dices, EyeOff, Plus, Send, Trash2, X, DoorOpen, DoorClosed, LockKeyhole, Swords } from 'lucide-react';
import type { Campaign, Light, Member, RollResult, Scene, Token, Wall, WallDirection, WallSenseMode } from '../shared/model';
import { tokenResources, WALL_THRESHOLD_MAX } from '../shared/model';
import { effectiveWallDirection, effectiveWallSenseMode } from '../shared/geometry';
import type { SendCommand } from './session';
import type { Selection } from './Tabletop';
import { WallDirectionPreview } from './Tabletop';
import { useDraft, DraftConflict } from './draft';
import { CheckBreakdown } from './CheckBreakdown';

export function TokenBadge({ token, small = false }: { token: { name: string; color: string }; small?: boolean }) { return <span className={`token-badge ${small ? 'small' : ''}`} style={{ borderColor: token.color }}>{token.name.slice(0, 1).toUpperCase()}</span>; }
export function ObjectPanel({ scene, campaign, self, selection, setSelection, command, onAddToken, onAddLevel, onOpenActor, onCombatAdd, combatPending }: {
  onCombatAdd: (id: string, sceneId: string) => void; combatPending: boolean; scene: Scene; campaign: Campaign; self: Member; selection: Selection; setSelection: (selection: Selection) => void;
  command: SendCommand; onAddToken: () => void; onAddLevel: () => void; onOpenActor: (id: string) => void;
}) {
  const gm = self.role === 'gm';
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => { if (selection) container.current?.querySelector('.inspector')?.scrollIntoView({ block: 'start' }); }, [selection?.id]);
  const token = selection?.kind === 'token' ? scene.tokens.find(t => t.id === selection.id) : undefined;
  const wall = selection?.kind === 'wall' ? scene.walls.find(w => w.id === selection.id) : undefined;
  const light = selection?.kind === 'light' ? scene.lights.find(l => l.id === selection.id) : undefined;
  return <div ref={container} className={`object-panel ${selection ? 'has-selection' : ''}`}>
    <section className="scene-details"><h2>{scene.name}</h2><div className="property-row"><span>{tr("Level")}</span><select aria-label={tr("Scene level")} disabled={!gm} value={scene.activeLevelId} onChange={event => void command('level.activate', { sceneId: scene.id, id: event.target.value })}>{scene.levels.map(level => <option key={level.id} value={level.id}>{level.name}</option>)}</select>{gm && <button className="icon-button" aria-label={tr("Add level")} onClick={onAddLevel}><Plus size={16}/></button>}</div><div className="property-row"><span>{tr("Grid")}</span><strong>{scene.grid.type === 'square' ? `${scene.grid.size} px · ${scene.grid.distance} ${scene.grid.units}` : tr("No grid")}</strong></div>{gm && <label className="check"><input type="checkbox" checked={scene.visionEnabled} onChange={event => void command('scene.update', { id: scene.id, visionEnabled: event.target.checked })}/> {tr("Player vision")}</label>}{gm && <label className="check"><input type="checkbox" checked={scene.globalLightEnabled === true} onChange={event => void command('scene.update', { id: scene.id, globalLightEnabled: event.target.checked })}/> {tr("Ambient light")}</label>}</section>
    <section className="token-directory"><div className="section-title"><h2>{tr("Scene tokens")}</h2>{gm && <button className="icon-button" aria-label={tr("Add character")} onClick={onAddToken}><Plus size={19}/></button>}</div>
      {scene.tokens.filter(t => t.levelId === scene.activeLevelId).length === 0 && <p className="empty">{tr("No tokens are available on this level.")}</p>}
      {scene.tokens.filter(t => t.levelId === scene.activeLevelId).map(t => { const hp = tokenResources(t, campaign.actors); return <button className={`token-row ${selection?.id === t.id ? 'selected' : ''}`} key={t.id} onClick={() => setSelection({ kind: 'token', id: t.id })}><TokenBadge token={t} small/><span className="token-row-name">{t.name}</span>{t.hidden && <EyeOff size={13}/>}<span>{hp.hp ?? '—'} / {hp.maxHp ?? '—'}</span><ChevronRight size={15}/></button>; })}
    </section>
    {token && <TokenInspector onCombatAdd={onCombatAdd} combatPending={combatPending} onOpenActor={onOpenActor} key={token.id} token={token} campaign={campaign} scene={scene} self={self} command={command} onClose={() => setSelection(null)}/>}
    {wall && <WallInspector key={wall.id} revision={campaign.revision} wall={wall} scene={scene} self={self} command={command} onClose={() => setSelection(null)}/>}
    {light && <LightInspector key={light.id} revision={campaign.revision} light={light} scene={scene} command={command} onClose={() => setSelection(null)}/>}
    {!selection && <div className="inspector-empty"><p>{tr("Object properties")}</p><span>{tr("Select a token, wall, or light on the map.")}</span></div>}
    {!!scene.importWarnings?.length && <details className="import-notes"><summary>{tr("Imported scene details (")}{scene.importWarnings.length})</summary><ul>{scene.importWarnings.map((w, i) => <li key={i}>{translateSystemMessage(w)}</li>)}</ul></details>}
  </div>;
}
export function TokenInspector({ token, campaign, scene, self, command, onClose, onOpenActor, onCombatAdd, combatPending }: { onCombatAdd: (id: string, sceneId: string) => void; combatPending: boolean; onOpenActor: (id: string) => void; token: Token; campaign: Campaign; scene: Scene; self: Member; command: SendCommand; onClose: () => void }) {
  const resources = tokenResources(token, campaign.actors), gm = self.role === 'gm', canEdit = gm || token.owners.includes(self.id);
  const { draft, dirty, edit, reload, baseRevision, saved, conflict } = useDraft({ ...token, hp: resources.hp, maxHp: resources.maxHp,
    conditionsText: token.conditions.join(', '), lightPerceptionRangeDraft: token.lightPerception?.range ?? 0 }, campaign.revision);
  const [saving, setSaving] = useState(false);
  const lightPerceptionEnabled = draft.lightPerception?.enabled !== false, lightPerceptionUnlimited = draft.lightPerception?.range == null;
  function editLightPerception(update: Partial<NonNullable<Token['lightPerception']>>) {
    edit({ lightPerception: { enabled: lightPerceptionEnabled, range: draft.lightPerception?.range ?? null, ...update } });
  }
  const lightPerceptionControls = <>
    <label className="check"><input name="lightPerceptionEnabled" type="checkbox" checked={lightPerceptionEnabled}
      onChange={e => editLightPerception({ enabled: e.target.checked })}/>{tr('Perceives illuminated areas')}</label>
    <label className="check"><input name="lightPerceptionUnlimited" type="checkbox" checked={lightPerceptionUnlimited} disabled={!lightPerceptionEnabled}
      onChange={e => editLightPerception({ range: e.target.checked ? null : draft.lightPerceptionRangeDraft })}/>{tr('Unlimited light perception')}</label>
    {!lightPerceptionUnlimited && <label className="field"><span>{tr('Illuminated areas range, px')}</span>
      <input name="lightPerceptionRange" type="number" min="0" max="100000" step="any" value={draft.lightPerceptionRangeDraft} disabled={!lightPerceptionEnabled}
        aria-describedby={`light-perception-${token.id}`} onChange={e => {
          const range = Number(e.target.value);
          edit({ lightPerceptionRangeDraft: range, lightPerception: { enabled: lightPerceptionEnabled, range } });
        }}/>
    </label>}
    <p className="muted small" id={`light-perception-${token.id}`}>{tr('A range of 0 disables additional vision from illuminated areas.')}</p>
  </>;
  async function save(event: React.FormEvent) { event.preventDefault(); setSaving(true); const hpChanges = { ...(draft.hp !== resources.hp ? { hp: draft.hp } : {}), ...(draft.maxHp !== resources.maxHp ? { maxHp: draft.maxHp } : {}) }; const payload = gm ? { id: token.id, sceneId: scene.id, name: draft.name, ...hpChanges, vision: draft.vision, visionEnabled: draft.visionEnabled !== false, visionUnlimited: draft.visionUnlimited === true, visionRangeOrigin: draft.visionRangeOrigin === 'token-edge' ? 'token-edge' : 'center', ...(draft.lightPerception !== undefined ? { lightPerception: draft.lightPerception } : {}), rotation: draft.rotation, hidden: draft.hidden, owners: draft.owners, color: draft.color, linked: draft.linked, width: draft.width, height: draft.height, conditions: draft.conditionsText.split(',').map(s => s.trim()).filter(Boolean) } : { id: token.id, sceneId: scene.id, ...hpChanges, conditions: draft.conditionsText.split(',').map(s => s.trim()).filter(Boolean) }; if (await command('token.update', payload, baseRevision)) saved(); setSaving(false); }
  return <section className="inspector"><div className="inspector-heading"><TokenBadge token={token}/><h2>{token.name}</h2><button className="icon-button" aria-label={tr("Close properties")} onClick={onClose}><X size={17}/></button></div>
    <>{token.actorId && campaign.actors.some(a => a.id === token.actorId && (gm || a.owners.includes(self.id))) && <button className="full-width open-actor-sheet" onClick={() => onOpenActor(token.actorId!)}><BookOpen size={16}/>{tr("Open character sheet")}</button>}</><DraftConflict show={conflict} reload={reload}/>{(resources.hp === null || resources.maxHp === null) && <p className="warning-box small">{tr("HP was not provided. An empty field means the value is unknown.")}</p>}{gm && token.source && <p className="muted small">{tr("Imported token")} · {token.linked ? tr("shared character resources") : tr("this token’s resources")}{token.source.actorResolution === 'unresolved' ? " " + tr("· character file not added") : ''}</p>}<form onSubmit={save}><fieldset disabled={!canEdit || saving}>
      <label className="field"><span>{tr("Name")}</span><input value={draft.name} disabled={!gm} onChange={e => edit({ name: e.target.value })} maxLength={80} required/></label>
      <div className="field"><span>{tr("HP")}</span><div className="double-field"><input aria-label={tr("Current HP")} type="number" min="0" max="100000" value={draft.hp ?? ''} placeholder={tr("Unknown")} onChange={e => edit({ hp: e.target.value === '' ? null : Number(e.target.value) })}/><span>/</span><input aria-label={tr("Maximum HP")} type="number" min="0" max="100000" value={draft.maxHp ?? ''} placeholder={tr("Unknown")} onChange={e => edit({ maxHp: e.target.value === '' ? null : Number(e.target.value) })}/></div></div>
      {gm && <><label className="check"><input type="checkbox" checked={draft.visionEnabled !== false} onChange={e => edit({ visionEnabled: e.target.checked })}/> {tr("Vision enabled")}</label><label className="check"><input type="checkbox" checked={draft.visionUnlimited === true} onChange={e => edit({ visionUnlimited: e.target.checked })}/> {tr("Unlimited vision without light")}</label><label className="field"><span>{tr("Unlit range, px")}</span><input type="number" min="0" max="100000" disabled={draft.visionEnabled === false || draft.visionUnlimited === true} value={draft.vision} onChange={e => edit({ vision: Number(e.target.value) })}/></label><label className="field"><span>{tr("Measure vision range from")}</span><select name="visionRangeOrigin" value={draft.visionRangeOrigin === 'token-edge' ? 'token-edge' : 'center'} onChange={e => edit({ visionRangeOrigin: e.target.value as 'center' | 'token-edge' })}><option value="center">{tr("Center")}</option><option value="token-edge">{tr("Token edge")}</option></select></label><p className="muted small">{tr("A finite unlit range of 0 grants no vision in darkness. Illuminated areas use the separate settings below.")}</p>{lightPerceptionControls}<label className="field"><span>{tr("Rotation, °")}</span><input type="number" min="-360" max="360" value={draft.rotation} onChange={e => edit({ rotation: Number(e.target.value) })}/></label><div className="field"><span>{tr("Size, cells")}</span><div className="double-field"><input aria-label={tr("Token width")} type="number" min=".25" max="20" step=".25" value={draft.width} onChange={e => edit({ width: Number(e.target.value) })}/><span>×</span><input aria-label={tr("Token height")} type="number" min=".25" max="20" step=".25" value={draft.height} onChange={e => edit({ height: Number(e.target.value) })}/></div></div><label className="check"><input type="checkbox" checked={draft.hidden} onChange={e => edit({ hidden: e.target.checked })}/> {tr("Hidden from players")}</label>{draft.actorId && <label className="check"><input type="checkbox" checked={draft.linked} onChange={e => edit({ linked: e.target.checked })}/> {tr("Resources linked to character")}</label>}<details className="ownership"><summary>{tr("Token control")}</summary>{campaign.members.map(member => <label key={member.id} className="check"><input type="checkbox" checked={draft.owners.includes(member.id)} onChange={e => edit({ owners: e.target.checked ? [...draft.owners, member.id] : draft.owners.filter(id => id !== member.id) })}/>{member.name}{member.role === 'gm' ? " " + tr("· game master") : ''}</label>)}</details></>}
      <label className="field stacked"><span>{tr("Conditions, comma-separated")}</span><input value={draft.conditionsText} onChange={e => edit({ conditionsText: e.target.value })} placeholder={tr("For example: poisoned")} maxLength={150}/></label>
      <div className="form-actions"><span className="muted small">{dirty ? tr("Unsaved changes") : tr("Saved")}</span><button type="submit" className="primary" disabled={!dirty || saving || conflict}>{saving ? tr("Saving…") : tr("Save")}</button></div>
    </fieldset></form>
    {!canEdit && <p className="empty">{tr("You cannot control this token.")}</p>}
    {gm && <div className="inspector-actions"><button disabled={combatPending} onClick={() => onCombatAdd(token.id, scene.id)}><Swords size={16}/> {tr("To combat")}</button><button className="danger icon-button" aria-label={tr("Delete token")} onClick={async () => { if (await command('token.delete', { id: token.id, sceneId: scene.id })) onClose(); }}><Trash2 size={16}/></button></div>}
  </section>;
}
const WALL_SENSE_CHANNELS = ['sight', 'light', 'sound'] as const;
const isThresholdMode = (mode: WallSenseMode) => mode === 'proximity' || mode === 'distance';
export function wallThresholdInputText(pixels: number | null | undefined, pixelsPerUnit: number): string {
  return pixels == null ? '' : String(pixels / pixelsPerUnit);
}
/** Undefined means invalid input; null is an explicit blank threshold. */
export function wallThresholdInputToPixels(input: string, originalPixels: number | null | undefined, pixelsPerUnit: number): number | null | undefined {
  if (!input.trim()) return null;
  const units = Number(input), pixels = units * pixelsPerUnit;
  if (!Number.isFinite(pixelsPerUnit) || pixelsPerUnit <= 0 || !Number.isFinite(units) || units <= 0) return undefined;
  if (originalPixels != null && Number.isFinite(originalPixels) && originalPixels > 0 && originalPixels <= WALL_THRESHOLD_MAX
    && input === wallThresholdInputText(originalPixels, pixelsPerUnit)) return originalPixels;
  // The displayed maximum may otherwise multiply back one floating-point step above the pixel limit.
  if (units === WALL_THRESHOLD_MAX / pixelsPerUnit) return WALL_THRESHOLD_MAX;
  if (!Number.isFinite(pixels) || pixels <= 0 || pixels > WALL_THRESHOLD_MAX) return undefined;
  return pixels;
}

export function WallInspector({ wall, scene, self, command, onClose, revision }: { revision: number; wall: Wall; scene: Scene; self: Member; command: SendCommand; onClose: () => void }) {
  const pixelsPerUnit = scene.grid.size / scene.grid.distance;
  const { draft, dirty, edit, reload, baseRevision, saved, conflict } = useDraft({ ...wall,
    thresholdScale: pixelsPerUnit, thresholdUnit: scene.grid.units,
    thresholdInputs: { sight: wallThresholdInputText(wall.senseThresholds?.sight, pixelsPerUnit),
      light: wallThresholdInputText(wall.senseThresholds?.light, pixelsPerUnit), sound: wallThresholdInputText(wall.senseThresholds?.sound, pixelsPerUnit) },
  }, revision); const gm = self.role === 'gm';
  const restrictionHelpId = `wall-restrictions-${wall.id}`;
  const directionHelpId = `wall-direction-${wall.id}`;
  const thresholdHelpId = `wall-threshold-modes-${wall.id}`;
  const attenuationHelpId = `wall-threshold-attenuation-${wall.id}`;
  const thresholdValues = { sight: wallThresholdInputToPixels(draft.thresholdInputs.sight, draft.senseThresholds?.sight, draft.thresholdScale),
    light: wallThresholdInputToPixels(draft.thresholdInputs.light, draft.senseThresholds?.light, draft.thresholdScale),
    sound: wallThresholdInputToPixels(draft.thresholdInputs.sound, draft.senseThresholds?.sound, draft.thresholdScale) };
  const hasThresholdMode = WALL_SENSE_CHANNELS.some(key => isThresholdMode(effectiveWallSenseMode(draft, key)));
  const invalidThreshold = WALL_SENSE_CHANNELS.some(key => isThresholdMode(effectiveWallSenseMode(draft, key)) && thresholdValues[key] === undefined);
  const channels = [
    { key: 'sight', label: 'Sight restriction' },
    { key: 'light', label: 'Light restriction' },
    { key: 'sound', label: 'Sound restriction' },
  ] as const;
  return <section className="inspector"><div className="section-title"><h2>{wall.kind === 'wall' ? tr("Wall") : tr("Door")}</h2><button className="icon-button" onClick={onClose} aria-label={tr("Close properties")}><X size={17}/></button></div><p className="muted small">{wall.a.x}, {wall.a.y} → {wall.b.x}, {wall.b.y}</p>
    {wall.kind !== 'wall' && <button className="door-action" onClick={() => void command('door.toggle', { id: wall.id, sceneId: scene.id })}>{wall.state === 'open' ? <DoorOpen size={19}/> : wall.state === 'locked' ? <LockKeyhole size={19}/> : <DoorClosed size={19}/>} {wall.state === 'open' ? tr("Close door") : wall.state === 'locked' ? tr("Door locked") : tr("Open door")}</button>}
    <DraftConflict show={conflict} reload={reload}/>{gm && <form onSubmit={async event => {
      event.preventDefault();
      if (invalidThreshold) return;
      const senseModes = { sight: effectiveWallSenseMode(draft, 'sight'), light: effectiveWallSenseMode(draft, 'light'), sound: effectiveWallSenseMode(draft, 'sound') };
      const senseThresholds = { sight: isThresholdMode(senseModes.sight) ? thresholdValues.sight ?? null : null,
        light: isThresholdMode(senseModes.light) ? thresholdValues.light ?? null : null,
        sound: isThresholdMode(senseModes.sound) ? thresholdValues.sound ?? null : null };
      if (await command('wall.update', { id: wall.id, sceneId: scene.id, kind: draft.kind, state: draft.state, movement: draft.movement,
        senseModes, senseThresholds, thresholdAttenuation: draft.thresholdAttenuation === true, direction: effectiveWallDirection(draft) }, baseRevision)) saved();
    }}>
      <label className="field"><span>{tr("Type")}</span><select value={draft.kind} onChange={e => edit({ kind: e.target.value as Wall['kind'] })}><option value="wall">{tr("Wall")}</option><option value="door">{tr("Door")}</option><option value="secret">{tr("Secret door")}</option></select></label>
      {draft.kind !== 'wall' && <label className="field"><span>{tr("State")}</span><select value={draft.state} onChange={e => edit({ state: e.target.value as Wall['state'] })}><option value="closed">{tr("Closed")}</option><option value="open">{tr("Open")}</option><option value="locked">{tr("Locked")}</option></select></label>}
      <label className="field"><span>{tr('Blocking side')}</span><select name="direction" value={effectiveWallDirection(draft)} aria-describedby={directionHelpId}
        onChange={e => edit({ direction: e.target.value as WallDirection })}>
        <option value="both">{tr('Both sides')}</option><option value="left">{tr('Block from the left')}</option><option value="right">{tr('Block from the right')}</option>
      </select></label>
      <WallDirectionPreview wall={draft}/>
      <p className="muted small" id={directionHelpId}>{tr('Left and right follow the A → B arrow. The highlighted side is the source side that the wall restricts.')}</p>
      <label className="check"><input type="checkbox" checked={draft.movement} onChange={e => edit({ movement: e.target.checked })}/>{tr("Blocks movement")}</label>
      {channels.map(({ key, label }) => {
        const threshold = isThresholdMode(effectiveWallSenseMode(draft, key)), helpId = `wall-threshold-${key}-${wall.id}`;
        const thresholdLabel = key === 'sight' ? 'Sight threshold ({unit})' : key === 'light' ? 'Light threshold ({unit})' : 'Sound threshold ({unit})';
        return <div key={key}>
          <label className="field"><span>{tr(label)}</span>
            <select name={key} value={effectiveWallSenseMode(draft, key)} aria-describedby={hasThresholdMode ? `${restrictionHelpId} ${thresholdHelpId}` : restrictionHelpId}
              onChange={e => edit({ senseModes: { ...draft.senseModes, [key]: e.target.value as WallSenseMode } })}>
              <option value="none">{tr("None")}</option><option value="normal">{tr("Normal")}</option><option value="limited">{tr("Limited")}</option>
              <option value="proximity">{tr('Proximity')}</option><option value="distance">{tr('Reverse proximity')}</option>
            </select>
          </label>
          {threshold && <>
            <label className="field"><span>{tr(thresholdLabel, { unit: draft.thresholdUnit || tr('Scene units') })}</span>
              <input name={`threshold.${key}`} type="number" min="0" max={WALL_THRESHOLD_MAX / draft.thresholdScale} step="any" value={draft.thresholdInputs[key]}
                aria-describedby={`${helpId} ${thresholdHelpId}`} aria-invalid={thresholdValues[key] === undefined || undefined}
                onChange={e => edit({ thresholdInputs: { ...draft.thresholdInputs, [key]: e.target.value } })}/>
            </label>
            <p className={thresholdValues[key] === undefined ? 'warning-box small' : 'muted small'} id={helpId}>
              {thresholdValues[key] === undefined ? tr('Enter a distance greater than 0 and no more than {max} {unit}, or leave it blank.', { max: WALL_THRESHOLD_MAX / draft.thresholdScale, unit: draft.thresholdUnit || tr('Scene units') }) : tr('Leave blank to keep normal blocking for this channel.')}
            </p>
          </>}
        </div>;
      })}
      {hasThresholdMode && <>
        <p className="muted small" id={thresholdHelpId}>{tr('Proximity allows perception past the wall from nearby sources; reverse proximity allows it from distant sources. Exactly at the cutoff, the distance exception does not apply.')} {tr('Thresholds measure distance to the wall segment, including its ends. The source’s size can affect the cutoff.')}</p>
        <label className="check"><input name="thresholdAttenuation" type="checkbox" checked={draft.thresholdAttenuation === true}
          aria-describedby={attenuationHelpId} onChange={e => edit({ thresholdAttenuation: e.target.checked })}/>{tr('Threshold attenuation')}</label>
        <p className="muted small" id={attenuationHelpId}>{tr('Threshold attenuation can limit the effective perception area beyond a wall. It changes reach, not opacity.')}</p>
        <p className="muted small">{tr('Changing modes keeps the entered distance in this draft. Saving a mode without a threshold clears that channel’s distance.')}</p>
      </>}
      <p className="muted small" id={restrictionHelpId}>{tr("None does not block. Normal blocks immediately. Limited blocks at the second distinct crossing along the same line.")}</p>
      {draft.kind !== 'wall' && <p className="muted small">{tr("Open doors do not block movement, sight, light, or sound.")}</p>}
      <p className="muted small">{tr("Sound restrictions are saved with the scene. Spatial audio playback is not available.")}</p>
      <div className="form-actions"><button type="button" className="icon-button danger" aria-label={tr("Delete wall")} onClick={async () => { if (await command('wall.delete', { id: wall.id, sceneId: scene.id })) onClose(); }}><Trash2 size={17}/></button><button className="primary" disabled={!dirty || conflict || invalidThreshold}>{tr("Save")}</button></div>
    </form>}
  </section>;
}
function LightInspector({ light, scene, command, onClose, revision }: { revision: number; light: Light; scene: Scene; command: SendCommand; onClose: () => void }) {
  const { draft, dirty, edit, reload, baseRevision, saved, conflict } = useDraft(light, revision);
  return <section className="inspector"><div className="section-title"><h2>{tr("Light source")}</h2><button className="icon-button" onClick={onClose} aria-label={tr("Close properties")}><X size={17}/></button></div><DraftConflict show={conflict} reload={reload}/><form onSubmit={async event => { event.preventDefault(); if (await command('light.update', { id: light.id, sceneId: scene.id, name: draft.name, bright: draft.bright, dim: draft.dim, color: draft.color, enabled: draft.enabled }, baseRevision)) saved(); }}><label className="field"><span>{tr("Name")}</span><input value={draft.name} onChange={e => edit({ name: e.target.value })}/></label><label className="field"><span>{tr("Bright, px")}</span><input type="number" min="0" max="10000" value={draft.bright} onChange={e => edit({ bright: Number(e.target.value) })}/></label><label className="field"><span>{tr("Dim, px")}</span><input type="number" min={draft.bright} max="10000" value={draft.dim} onChange={e => edit({ dim: Number(e.target.value) })}/></label><label className="field"><span>{tr("Color")}</span><input type="color" value={draft.color} onChange={e => edit({ color: e.target.value })}/></label><label className="check"><input type="checkbox" checked={draft.enabled} onChange={e => edit({ enabled: e.target.checked })}/> {tr("Enabled")}</label><div className="form-actions"><button type="button" className="icon-button danger" aria-label={tr("Delete light source")} onClick={async () => { if (await command('light.delete', { id: light.id, sceneId: scene.id })) onClose(); }}><Trash2 size={16}/></button><button className="primary" disabled={!dirty || conflict}>{tr("Save")}</button></div></form></section>;
}
export function ChatPanel({ campaign, self }: { campaign: Campaign; self: Member }) {
  const end = useRef<HTMLDivElement>(null); useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [campaign.chat.length]);
  return <section className="chat-log" aria-label={tr("Messages")}><h2>{tr("Campaign chat")}</h2>{!campaign.chat.length && <div className="empty-state"><Dices size={32}/><h3>{tr("The first roll is yours")}</h3><p>{tr("Write a message or dice formula. For example, /r 2d6+3.")}</p></div>}{campaign.chat.map(message => <article key={message.id} className={`chat-message ${message.authorId === self.id ? 'own' : ''}`}><div className="message-meta"><strong>{message.authorName}</strong><span>{new Date(message.createdAt).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' })}</span></div>{message.visibility !== 'public' && <span className="message-visibility">{message.visibility === 'self' ? tr("Only me") : tr("To game master")}</span>}{message.roll?.actor && <p className="roll-label">{chatMessageText(message)}</p>}{message.roll ? <div className="roll-card"><div><Dices size={17}/><strong>{message.roll.formula}</strong></div><b>{message.roll.total}</b><RollDetails roll={message.roll}/></div> : <p>{chatMessageText(message)}</p>}</article>)}<div ref={end}/></section>;
}
export function Composer({ command, online, onSent }: { command: SendCommand; online: boolean; onSent: () => void }) {
  const [text, setText] = useState(''), [visibility, setVisibility] = useState('public'), [sending, setSending] = useState(false);
  async function send(event: React.FormEvent) { event.preventDefault(); if (!text.trim() || sending || !online) return; setSending(true); const roll = /^\/r(?:oll)?\s+(.+)$/i.exec(text.trim()); if (await command(roll ? 'chat.roll' : 'chat.send', roll ? { formula: roll[1], visibility } : { text: text.trim(), visibility })) { setText(''); onSent(); } setSending(false); }
  return <form className="composer" onSubmit={send}><div className="composer-row"><input aria-label={tr("Message or roll")} placeholder={tr("Message or /r 1d20")} value={text} onChange={e => setText(e.target.value)} maxLength={2000}/><button type="button" title={tr("Prepare d20 roll")} aria-label={tr("Prepare d20 roll")} onClick={() => setText('/r 1d20')}><Dices size={21}/></button><button type="submit" aria-label={tr("Send message")} disabled={!online || sending || !text.trim()}><Send size={19}/></button></div><select className="recipient-select" aria-label={tr("Send to")} value={visibility} onChange={e => setVisibility(e.target.value)}><option value="public">{tr("All members")}</option><option value="gm">{tr("Game master only")}</option><option value="self">{tr("Only me")}</option></select></form>;
}

export function RollDetails({ roll }: { roll: RollResult }) {
  if (!roll.d20) return <small>{roll.dice.map(d => `d${d.sides}: ${d.values.join(', ')}`).join(' · ')}{roll.modifier ? ` · ${roll.modifier > 0 ? '+' : ''}${roll.modifier}` : ''}</small>;
  const snapshot = roll.abilitySnapshot;
  return <><small className="d20-results"><span>{roll.d20.mode === 'advantage' ? tr("Advantage") : roll.d20.mode === 'disadvantage' ? tr("Disadvantage") : tr("Normal")}</span><span>{roll.dice[0].values.map((value, index) => <b key={index} className={index === roll.d20!.keptIndex ? 'kept-die' : 'discarded-die'} title={index === roll.d20!.keptIndex ? tr("Selected result") : tr("Not counted")}>{value}</b>)}<span>{roll.modifier >= 0 ? '+' : ''}{roll.modifier}</span></span></small>
    {roll.checkSnapshot ? <details className="roll-provenance"><summary>{tr("Calculation at roll time")}</summary><CheckBreakdown snapshot={roll.checkSnapshot} historical/></details> : snapshot && <details className="roll-provenance"><summary>{tr("Calculation at roll time")}</summary><p>{tr("Base")} {snapshot.base ?? '—'} {tr("· effects")} {snapshot.totalBonus >= 0 ? '+' : ''}{snapshot.totalBonus} {tr("→ total")} {snapshot.effective ?? '—'} {tr("· modifier")} {roll.modifier >= 0 ? '+' : ''}{roll.modifier}</p>{snapshot.contributions.length > 0 ? <ul>{snapshot.contributions.map((part, index) => <li key={`${part.effectId}-${index}`}>{part.effectName}: {part.value >= 0 ? '+' : ''}{part.value}</li>)}</ul> : <p>{tr("No bonuses from effects.")}</p>}<p className="muted">{tr("Saved calculation; later changes do not affect it.")}</p></details>}</>;
}
