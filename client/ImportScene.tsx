import { t as tr, getLocale, translateSystemMessage } from '../shared/i18n';
import { useRef, useState } from 'react';
import { FileUp, Package, Sparkles } from 'lucide-react';
import { importNeutralScene } from '../shared/import';
import { ABILITY_KEYS } from '../shared/model';
import type { Actor } from '../shared/model';
import { abilityBreakdown } from '../shared/abilities';
import { ABILITY_NAMES, signed } from './ability-ui';
import { effectDuration } from './Effects';
import { preparationLabel, UnsupportedSpells } from './Spellcasting';

export function ImportScene({ onImport, online }: { onImport: (document: unknown) => Promise<boolean>; online: boolean }) {
  const [document, setDocument] = useState<unknown>(null);
  const [preview, setPreview] = useState<ReturnType<typeof importNeutralScene> | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [reading, setReading] = useState(false);
  const selection = useRef(0);

  async function selectFile(file?: File) {
    const version = ++selection.current;
    setError(''); setPreview(null); setDocument(null); setReading(!!file);
    try {
      if (!file) return;
      if (file.size > 1_800_000) throw new Error(tr("File too large: maximum 1.8 MB."));
      const parsed: unknown = JSON.parse(await file.text());
      if (version !== selection.current) return;
      const result = importNeutralScene(parsed);
      setDocument(parsed); setPreview(result);
    } catch (e) {
      if (version === selection.current) setError(e instanceof Error ? translateSystemMessage(e.message) : tr("Could not read the file"));
    } finally {
      if (version === selection.current) setReading(false);
    }
  }

  return <div className="modal-content import-content">
    <p>{tr("Choose a Neutral Scene JSON file. We will validate its data and preview the imported content.")}</p>
    <label className="file-picker"><FileUp size={24}/><span>{reading ? tr("Checking file…") : tr("Choose scene file")}</span><input type="file" accept="application/json,.json" aria-label={tr("Neutral scene file")} disabled={busy} onChange={event => void selectFile(event.target.files?.[0])}/></label>
    {error && <p className="error" role="alert">{translateSystemMessage(error)}</p>}
    {preview && <>
      <h3>{preview.scene.name}</h3>
      <dl className="import-summary">
        <div><dt>{tr("Size")}</dt><dd>{preview.scene.width} × {preview.scene.height} px</dd></div>
        <div><dt>{tr("Levels")}</dt><dd>{preview.scene.levels.length}</dd></div>
        <div><dt>{tr("Walls / doors")}</dt><dd>{preview.scene.walls.length}</dd></div>
        <div><dt>{tr("Light")}</dt><dd>{preview.scene.lights.length}</dd></div>
        <div><dt>{tr("Tokens")}</dt><dd>{preview.scene.tokens.length}</dd></div>
        <div><dt>{tr("Characters")}</dt><dd>{preview.actors.length}</dd></div>
        <div><dt>{tr("Items")}</dt><dd>{preview.actors.reduce((total, actor) => total + actor.items.length, 0)}</dd></div>
        <div><dt>{tr("Known ability scores")}</dt><dd>{preview.actors.reduce((total, actor) => total + ABILITY_KEYS.filter(key => actor.abilities[key] !== null).length, 0)}</dd></div>
        <div><dt>{tr("Effects / enabled")}</dt><dd>{preview.sheetSummary.effects} / {preview.sheetSummary.activeEffects}</dd></div>
        {preview.sheetSummary.unsupportedEffects > 0 && <div><dt>{tr("Disabled effects retained only in archive")}</dt><dd>{preview.sheetSummary.unsupportedEffects}</dd></div>}
        {preview.sheetSummary.spells > 0 && <><div><dt>{tr("Spells / actions")}</dt><dd>{preview.sheetSummary.spells} / {preview.sheetSummary.activities}</dd></div><div><dt>{tr("Slot pools")}</dt><dd>{preview.sheetSummary.slotPools}</dd></div></>}
        {preview.sheetSummary.unsupportedSpellcasting > 0 && <div><dt>{tr("Spellcasting records without execution")}</dt><dd>{preview.sheetSummary.unsupportedSpellcasting}</dd></div>}
        {preview.sheetSummary.checksProfiles > 0 && <div><dt>{tr("Sheets with skills / saves")}</dt><dd>{preview.sheetSummary.checksProfiles}</dd></div>}
        {preview.sheetSummary.unsupportedChecks > 0 && <div><dt>{tr("Conditions blocking checks")}</dt><dd>{preview.sheetSummary.unsupportedChecks}</dd></div>}
        {preview.actors.some(a => a.observedAdvancement) && <div><dt>{tr("Imported progression records")}</dt><dd>{preview.actors.filter(a => a.observedAdvancement).length} {tr("sheets")}</dd></div>}
      </dl>
      {preview.actors.length > 0 && <details className="import-actors"><summary>{tr("Sheet contents (")}{preview.actors.length})</summary>{preview.actors.map(actor => <ActorPreview key={actor.id} actor={actor}/>)}</details>}
      {preview.warnings.length > 0 && <div className="warning-box"><strong>{tr("What to check after import")}</strong>
        <p>{tr("The game master receives access to imported sheets and tokens. The map uses simple markers; original images remain in the archive.")}</p>
        {preview.actors.some(a => a.sheetKind === 'dnd5e') && <p>{tr("Base abilities, items, and numeric charges are imported. Only the listed numeric ability bonuses are supported for effects.")}</p>}
        {preview.sheetSummary.checksProfiles > 0 && <p>{tr("Skills and saves support numeric proficiency, proficiency ranks, expertise, fixed bonuses, and passive scores. Proficiency dice are unavailable. Unsupported formulas and conditions block affected checks.")}</p>}
        {preview.actors.some(a => a.observedAdvancement) && <p>{tr("Classes, step definitions, and grant links are retained for reference. They are not a history of completed choices: levels may have unfinished steps. Bonuses and items are not granted again.")}</p>}
        {preview.actors.some(a => a.spellcasting) ? <p>{tr("Spells support preparation, explicit slots, simple damage, and healing at base level. Range, targets, and action costs require manual checks. Upcasting, rituals, pact slots, and complex conditions are unavailable. An unknown slot maximum prevents automatic recovery.")}</p> : <p>{tr("This file contains no supported spells. The game master can define actions and costs separately.")}</p>}
        {preview.sheetSummary.effects > 0 && <p>{tr("Effect duration is informational; disable effects manually. Base abilities are stored separately from totals.")}</p>}
        {preview.sheetSummary.unsupportedEffects > 0 && <p>{tr("Unsupported disabled effects are retained only in the archive and cannot be enabled here. Active or ambiguous unsupported effects block import.")}</p>}
        {preview.actors.some(a => a.hp === null || a.maxHp === null) && <p>{tr("Some characters have unknown HP. These fields stay empty until filled in.")}</p>}
        <details><summary>{tr("Compatibility details (")}{preview.warnings.length})</summary><ul>{preview.warnings.map((warning, i) => <li key={i}>{translateSystemMessage(warning)}</li>)}</ul></details>
      </div>}
      {!online && <p className="error" role="status">{tr("Offline. Wait for a connection before importing.")}</p>}
      <button className="primary" disabled={busy || reading || !online} onClick={async () => { setBusy(true); try { await onImport(document); } finally { setBusy(false); } }}>{busy ? tr("Importing…") : tr("Import this scene")}</button>
    </>}
  </div>;
}

function ActorPreview({ actor }: { actor: Actor }) {
  const known = ABILITY_KEYS.filter(key => actor.abilities[key] !== null).length;
  return <article className="import-actor">
    <h4>{actor.name}</h4>
    <p>{actor.hp ?? '—'} / {actor.maxHp ?? '—'} {tr("HP")} · {actor.sheetKind === 'dnd5e' ? tr("{p0} of 6 abilities", { p0: known }) : tr("Manual sheet")}</p>
    {actor.observedAdvancement && <p>{tr("Imported:")} {actor.observedAdvancement.classes.map(c => `${c.name} ${c.levels ?? '?'}`).join(', ') || tr("no classes defined")} · {actor.observedAdvancement.steps.length} {tr("step definitions ·")} {actor.observedAdvancement.grantCount} {tr("grant links. Reference only; not reapplied.")}</p>}
    {actor.checks && <p>{tr("18 skills · 6 saves · proficiency bonus")} {actor.checks.proficiency.bonus === null ? tr("not known") : signed(actor.checks.proficiency.bonus)}{actor.checks.proficiency.mode === 'class-level' ? " " + tr("from total level {p0}", { p0: actor.checks.proficiency.level }) : actor.checks.proficiency.mode === 'manual' ? " " + tr("set manually") : ''}{actor.checks.unsupported.length ? " " + tr("· unsupported conditions: {p0}", { p0: actor.checks.unsupported.length }) : ''}</p>}
    {!actor.items.length ? <p className="muted">{tr("No items imported.")}</p> : <ul>{actor.items.map(item => <li key={item.id}><Package size={16}/><div><strong>{item.name}</strong><span>{item.quantity} {tr("pcs. ·")} {item.weight.toLocaleString(getLocale())} {item.weightUnit === 'unit' ? tr("units") : item.weightUnit}{tr("/each")}{item.uses ? " " + tr("· charges {p0}/{p1}", { p0: item.uses.value, p1: item.uses.max }) : ''}</span></div></li>)}</ul>}
    {actor.effects.length > 0 && <><h5>{tr("Effects")}</h5><ul>{actor.effects.map(effect => <li key={effect.id}><Sparkles size={16}/><div><strong>{effect.name} · {effect.disabled ? tr("disabled") : tr("enabled")}</strong><span>{effect.changes.map(change => `${ABILITY_NAMES[change.ability]} ${signed(change.value)}`).join(' · ')}</span><span>{effectDuration(effect)}</span></div></li>)}</ul><p>{ABILITY_KEYS.filter(key => abilityBreakdown(actor, key).contributions.length > 0).map(key => { const value = abilityBreakdown(actor, key); return tr("{p0}: base {p1} → total {p2}", { p0: ABILITY_NAMES[key], p1: value.base ?? '—', p2: value.effective ?? '—' }); }).join(' · ') || tr("All effects are disabled; base values apply.")}</p></>}
    {actor.spellcasting && <><h5>{tr("Spells and slots")}</h5><ul>{actor.spellcasting.spells.map(spell => <li key={spell.id}><Sparkles size={16}/><div><strong>{spell.name}</strong><span>{preparationLabel(spell)} · {tr("Level {p0}", { p0: spell.level })}</span><span>{actor.actions.filter(action => action.spellId === spell.id).map(action => action.name).join(' · ') || tr("No supported actions")}</span></div></li>)}</ul><p className="small">{actor.resources.map(resource => `${resource.label}: ${resource.value ?? '?'} / ${resource.max ?? '?'}`).join(' · ')}</p><UnsupportedSpells actor={actor}/></>}
  </article>;
}
