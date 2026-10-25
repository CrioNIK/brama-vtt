import type { Actor, ActorEffect, ActorItem, ActorSheet, Grid, ImportedActorSource, Level, Light, Point, Scene, Token, Wall } from './model.js';
import { ABILITY_KEYS, blankActorSheet, TOKEN_COLORS } from './model.js';
import { derivedAbilitiesWithinBounds, EFFECT_LIMITS } from './abilities.ts';
import { importSpellcasting } from './import-spellcasting.js';
import { importChecks } from './import-checks.js';
import { importAdvancementEvidence } from './advancement-evidence.js';

export class SceneImportError extends Error {
  constructor(path: string, message: string) { super(`${path}: ${message}`); this.name = 'SceneImportError'; }
}
function error(path: string, message: string): never { throw new SceneImportError(path, message); }
function isRecord(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function object(v: unknown, p: string): Record<string, unknown> { return isRecord(v) ? v : error(p, 'Expected an object'); }
function array(v: unknown, p: string, max = 2000): unknown[] {
  if (!Array.isArray(v) || v.length > max) return error(p, `Expected an array of at most ${max} items`);
  return v;
}
function text(v: unknown, p: string, max = 500): string {
  if (typeof v !== 'string' || v.length > max) return error(p, `Expected a string of at most ${max} characters`);
  return v;
}
function number(v: unknown, p: string, min = -1e9, max = 1e9): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return error(p, `Expected a finite number in [${min}, ${max}]`);
  return v;
}
function bool(v: unknown, p: string): boolean { return typeof v === 'boolean' ? v : error(p, 'Expected a boolean'); }
function choice<T extends string>(v: unknown, allowed: readonly T[], p: string): T {
  const selected = allowed.find(item => item === v);
  return selected === undefined ? error(p, `Expected one of ${allowed.join(', ')}`) : selected;
}
function rawId(v: unknown, p: string): string {
  const value = text(v, p, 256);
  return value.length ? value : error(p, 'Empty identifier');
}
function safeId(source: string, prefix: string, used: Set<string>): string {
  const base = /^[A-Za-z0-9_-]{1,80}$/.test(source) ? source : `${prefix}-${used.size + 1}`;
  let id = base, suffix = 1;
  while (used.has(id)) id = `${base}-${suffix++}`;
  used.add(id);
  return id;
}
function point(v: unknown, p: string, width: number, height: number): Point {
  const coords = array(v, p, 2);
  if (coords.length !== 2) return error(p, 'Expected exactly two coordinates');
  return { x: number(coords[0], `${p}/0`, 0, width), y: number(coords[1], `${p}/1`, 0, height) };
}
function samePoint(a: Point, b: Point): boolean { return a.x === b.x && a.y === b.y; }
function color(v: unknown, p: string): string {
  const value = text(v, p, 7);
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : error(p, 'Expected #RRGGBB');
}
function keys(value: Record<string, unknown>, allowed: readonly string[], path: string) {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown !== undefined) error(`${path}/${unknown}`, 'Unknown field in the supported sheet subset');
}
function integer(v: unknown, p: string, min: number, max: number): number {
  const value = number(v, p, min, max);
  return Number.isInteger(value) ? value : error(p, 'Expected an integer');
}
function sheetText(v: unknown, p: string, max: number, allowEmpty = false): string {
  const value = text(v, p, max);
  if ((!allowEmpty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) error(p, 'Expected text without unsupported control characters');
  return value;
}
function actorSheet(value: unknown, path: string, effectsAllowed: boolean, warnings: string[], spellsAllowed = false, checksAllowed = false): { sheet: ActorSheet; itemRefs: NonNullable<ImportedActorSource['itemRefs']>; effectRefs: NonNullable<ImportedActorSource['effectRefs']>; unsupportedEffects: number } {
  const source = object(value, path), sheet = blankActorSheet(), itemRefs: NonNullable<ImportedActorSource['itemRefs']> = [];
  keys(source, [...(effectsAllowed ? ['kind', 'abilities', 'items', 'effects', 'effectsUnsupported'] : ['kind', 'abilities', 'items']), ...(spellsAllowed ? ['spellcasting'] : []), ...(checksAllowed ? ['checks'] : [])], path);
  sheet.sheetKind = choice(source.kind, ['dnd5e'], `${path}/kind`);
  const abilities = object(source.abilities, `${path}/abilities`);
  keys(abilities, ABILITY_KEYS, `${path}/abilities`);
  for (const key of ABILITY_KEYS) sheet.abilities[key] = abilities[key] === null ? null : integer(abilities[key], `${path}/abilities/${key}`, 1, 30);
  const normalizedIds = new Set<string>(), nativeIds = new Set<string>();
  for (const [index, itemValue] of array(source.items, `${path}/items`, 200).entries()) {
    const p = `${path}/items/${index}`, item = object(itemValue, p);
    keys(item, ['id', 'sourceItemId', 'name', 'type', 'quantity', 'weight', 'weightUnit', 'description', 'equipped', 'uses'], p);
    const sourceId = rawId(item.id, `${p}/id`), nativeId = rawId(item.sourceItemId, `${p}/sourceItemId`);
    if (normalizedIds.has(sourceId)) error(`${p}/id`, 'Duplicate normalized Item ID in this Actor');
    if (nativeIds.has(nativeId)) error(`${p}/sourceItemId`, 'Duplicate source Item ID in this Actor');
    normalizedIds.add(sourceId); nativeIds.add(nativeId);
    const description = sheetText(item.description, `${p}/description`, 20000, true);
    const runtime: ActorItem = {
      id: `item-${globalThis.crypto.randomUUID()}`, name: sheetText(item.name, `${p}/name`, 120), type: sheetText(item.type, `${p}/type`, 60),
      quantity: integer(item.quantity, `${p}/quantity`, 0, 100000), weight: number(item.weight, `${p}/weight`, 0, 100000),
      weightUnit: choice(item.weightUnit, ['lb', 'kg', 'unit'], `${p}/weightUnit`), description, equipped: bool(item.equipped, `${p}/equipped`),
    };
    if (item.uses !== undefined) {
      const uses = object(item.uses, `${p}/uses`); keys(uses, ['value', 'max'], `${p}/uses`);
      const max = integer(uses.max, `${p}/uses/max`, 0, 100000), current = integer(uses.value, `${p}/uses/value`, 0, max);
      runtime.uses = { value: current, max };
    }
    sheet.items.push(runtime); itemRefs.push({ itemId: runtime.id, sourceItemId: nativeId });
  }
  const effectRefs: NonNullable<ImportedActorSource['effectRefs']> = [], effectIds = new Set<string>(), nativeEffectIds = new Set<string>();
  const effects = array(source.effects ?? [], `${path}/effects`, EFFECT_LIMITS.effects);
  const unsupported = array(source.effectsUnsupported ?? [], `${path}/effectsUnsupported`, EFFECT_LIMITS.effects);
  if (effects.length + unsupported.length > EFFECT_LIMITS.effects) error(path, 'At most100 supported and unsupported effects combined');
  for (const [index, value] of effects.entries()) {
    const p = `${path}/effects/${index}`, effect = object(value, p);
    keys(effect, ['id', 'sourceEffectId', 'name', 'description', 'disabled', 'changes', 'duration'], p);
    const normalizedId = rawId(effect.id, `${p}/id`), nativeId = rawId(effect.sourceEffectId, `${p}/sourceEffectId`);
    if (effectIds.has(normalizedId) || nativeEffectIds.has(nativeId)) error(p, 'Duplicate effect identity');
    effectIds.add(normalizedId); nativeEffectIds.add(nativeId);
    const changes = array(effect.changes, `${p}/changes`, EFFECT_LIMITS.changes);
    if (!changes.length) error(`${p}/changes`, 'At least one supported change is required');
    const runtime: ActorEffect = {
      id: `effect-${globalThis.crypto.randomUUID()}`, name: sheetText(effect.name, `${p}/name`, 120), description: sheetText(effect.description, `${p}/description`, 20000, true), disabled: bool(effect.disabled, `${p}/disabled`),
      changes: changes.map((value, i) => {
        const cp = `${p}/changes/${i}`, change = object(value, cp); keys(change, ['ability', 'mode', 'value'], cp);
        return { ability: choice(change.ability, ABILITY_KEYS, `${cp}/ability`), mode: choice(change.mode, ['add'], `${cp}/mode`), value: number(change.value, `${cp}/value`, -EFFECT_LIMITS.value, EFFECT_LIMITS.value) };
      }),
    };
    if (effect.duration !== undefined) {
      const duration = object(effect.duration, `${p}/duration`); keys(duration, ['rounds', 'seconds'], `${p}/duration`);
      const rounds = duration.rounds === null ? null : integer(duration.rounds, `${p}/duration/rounds`, 0, EFFECT_LIMITS.duration);
      const seconds = duration.seconds === null ? null : number(duration.seconds, `${p}/duration/seconds`, 0, EFFECT_LIMITS.duration);
      if (rounds !== null && seconds !== null) error(`${p}/duration`, 'Choose rounds or seconds, never both');
      runtime.duration = { rounds, seconds };
      warnings.push(`${p}/duration: duration is informational; automatic expiry, combat clocks and rest recovery are not executed.`);
    }
    sheet.effects.push(runtime); effectRefs.push({ effectId: runtime.id, sourceEffectId: nativeId });
  }
  for (const [index, value] of unsupported.entries()) {
    const p = `${path}/effectsUnsupported/${index}`, effect = object(value, p); keys(effect, ['sourceEffectId', 'name', 'disabled', 'reason'], p);
    const nativeId = effect.sourceEffectId === null ? null : rawId(effect.sourceEffectId, `${p}/sourceEffectId`);
    if (nativeId !== null) { if (nativeEffectIds.has(nativeId)) error(p, 'Duplicate effect identity'); nativeEffectIds.add(nativeId); }
    if (effect.name !== null) sheetText(effect.name, `${p}/name`, 120);
    const disabled = effect.disabled === null ? null : bool(effect.disabled, `${p}/disabled`);
    const reason = sheetText(effect.reason, `${p}/reason`, 2000);
    if (disabled !== true) error(p, 'Unsupported active or indeterminate effect would change the sheet; import rejected. ' + reason);
    warnings.push(`${p}: unsupported disabled effect retained only in the GM source archive; it cannot be enabled in this runtime. ${reason}`);
  }
  if (!derivedAbilitiesWithinBounds(sheet)) error(`${path}/effects`, 'Derived abilities must remain finite and within[-1000,1000]; no clamping is performed');
  return { sheet, itemRefs, effectRefs, unsupportedEffects: unsupported.length };
}

export interface ActorSheetImportSummary { actorSheets: number; items: number; knownAbilities: number; unknownAbilities: number; effects: number; activeEffects: number; unsupportedEffects: number; spells: number; activities: number; slotPools: number; unsupportedSpellcasting: number; checksProfiles: number; unsupportedChecks: number }

/** Strict adapter from the offline bridge envelope to the playable MVP model.
 * It never fetches assets, executes source content, or guesses blocker modes.
 */
export function importNeutralScene(document: unknown): { scene: Scene; actors: Actor[]; warnings: string[]; sheetSummary: ActorSheetImportSummary } {
  const doc = object(document, '/');
  const version = choice(doc.schemaVersion, ['0.1.0', '0.2.0', '0.3.0', '0.4.0', '0.5.0', '0.6.0', '0.7.0', '0.8.0', '0.9.0'], '/schemaVersion');
  const source = object(doc.scene, '/scene');
  const report = object(doc.report, '/report');
  const provenance = object(doc.provenance, '/provenance');
  choice(provenance.sourceFormat, ['uvtt', 'foundry-scene'], '/provenance/sourceFormat');
  choice(provenance.converterVersion, ['0.1.0', '0.2.0', '0.3.0', '0.4.0', '0.5.0', '0.6.0', '0.7.0', '0.8.0', '0.9.0'], '/provenance/converterVersion');
  if (!/^[0-9a-f]{64}$/.test(text(provenance.sourceSha256, '/provenance/sourceSha256', 64))) error('/provenance/sourceSha256', 'Expected SHA256 hex');
  text(provenance.originalUtf8Text, '/provenance/originalUtf8Text', 64 * 1024 * 1024);
  const warnings: string[] = [];
  for (const [i, value] of array(report.issues, '/report/issues', 5000).entries()) {
    const item = object(value, `/report/issues/${i}`);
    warnings.push(`${text(item.code, `/report/issues/${i}/code`, 200)} ${text(item.path, `/report/issues/${i}/path`, 1000)}: ${text(item.message, `/report/issues/${i}/message`, 4000)}`);
  }
  const sourceOnly = array(report.sourceOnlyPaths, '/report/sourceOnlyPaths', 50000);
  sourceOnly.forEach((p, i) => text(p, `/report/sourceOnlyPaths/${i}`, 2000));
  if (sourceOnly.length) warnings.push(`${sourceOnly.length} source fields remain outside the playable scene; keep the original bridge document.`);
  warnings.push('The original source archive is inert and is not copied into the playable scene. This adapter does not verify its checksum; keep the bridge document for restore-source.');
  const additionalSourceIds = new Set<string>();
  for (const [i, value] of array(provenance.additionalSources ?? [], '/provenance/additionalSources', 1000).entries()) {
    const path = `/provenance/additionalSources/${i}`, item = object(value, path), id = rawId(item.id, `${path}/id`);
    if (additionalSourceIds.has(id)) error(`${path}/id`, 'Duplicate source archive ID');
    additionalSourceIds.add(id);
    choice(item.sourceFormat, ['foundry-actor'], `${path}/sourceFormat`);
    if (!/^[0-9a-f]{64}$/.test(text(item.sourceSha256, `${path}/sourceSha256`, 64))) error(`${path}/sourceSha256`, 'Expected SHA256 hex');
    text(item.originalUtf8Text, `${path}/originalUtf8Text`, 64 * 1024 * 1024);
  }
  const width = number(source.width, '/scene/width', 1, 100000);
  const height = number(source.height, '/scene/height', 1, 100000);
  choice(source.coordinateFrame, ['image-pixels', 'foundry-document-pixels'], '/scene/coordinateFrame');
  const rawGrid = object(source.grid, '/scene/grid');
  const gridType = choice(rawGrid.type, ['square', 'gridless'], '/scene/grid/type (hex grids are not supported)');
  const grid: Grid = {
    type: gridType === 'gridless' ? 'none' : 'square',
    size: number(rawGrid.sizePixels, '/scene/grid/sizePixels', 1, 2000),
    distance: number(rawGrid.distance, '/scene/grid/distance', 0.000001, 1000000),
    units: text(rawGrid.units, '/scene/grid/units', 50),
  };
  const usedIds = new Set<string>(), levelMap = new Map<string, string>();
  const levels: Level[] = [];
  const levelMetadata = new Map<string, Record<string, unknown>>();
  for (const [i, value] of array(source.levels ?? [], '/scene/levels', 64).entries()) {
    const path = `/scene/levels/${i}`, item = object(value, path), originalId = rawId(item.id, `${path}/id`);
    if (levelMap.has(originalId)) error(`${path}/id`, 'Duplicate source level ID');
    const id = safeId(originalId, 'level', usedIds), elevation = object(item.elevation, `${path}/elevation`);
    const bottom = number(elevation.bottom, `${path}/elevation/bottom`), top = number(elevation.top, `${path}/elevation/top`);
    if (top < bottom) error(`${path}/elevation`, 'Top is below bottom');
    const levelUnits = text(item.elevationUnits, `${path}/elevationUnits`, 50);
    if (levelUnits !== grid.units) error(`${path}/elevationUnits`, 'Elevation unit conversion is not supported');
    number(item.sort, `${path}/sort`);
    text(item.sourcePath, `${path}/sourcePath`, 1000);
    const visibility = array(item.visibilityLevelIds, `${path}/visibilityLevelIds`, 64);
    if (visibility.length) error(`${path}/visibilityLevelIds`, 'Cross-level visibility is not supported; import would change visibility');
    for (const key of ['backgroundMetadata', 'foregroundMetadata', 'fogMetadata', 'textureTransformMetadata']) object(item[key], `${path}/${key}`);
    levelMap.set(originalId, id); levelMetadata.set(id, item);
    levels.push({ id, name: text(item.name, `${path}/name`, 200), bottom, top });
  }
  if (!levels.length) {
    levels.push({ id: safeId('ground', 'level', usedIds), name: 'Ground', bottom: 0, top: 20 });
    warnings.push('No level metadata: assigned one editing level with a 0–20 elevation range.');
  }
  let activeLevelId = levels[0].id;
  if (source.initialLevelId !== undefined && source.initialLevelId !== null) {
    const initial = levelMap.get(rawId(source.initialLevelId, '/scene/initialLevelId'));
    if (!initial) error('/scene/initialLevelId', 'Unknown level reference');
    activeLevelId = initial;
  }
  function membership(item: Record<string, unknown>, path: string): { levelId: string; levelIds?: string[] } {
    if (item.levelIds === undefined) {
      if (levels.length !== 1) return error(`${path}/levelIds`, 'Missing level association in a multi-level scene');
      warnings.push(`${path}: no explicit level association; assigned the only level.`);
      return { levelId: levels[0].id };
    }
    const rawIds = array(item.levelIds, `${path}/levelIds`, 64);
    if (!rawIds.length) return error(`${path}/levelIds`, 'Empty membership is ambiguous; no all-level visibility is inferred');
    const ids = rawIds.map((value, i) => {
      const original = rawId(value, `${path}/levelIds/${i}`), mapped = levelMap.get(original);
      return mapped ?? error(`${path}/levelIds/${i}`, 'Unknown level reference');
    });
    if (new Set(ids).size !== ids.length) error(`${path}/levelIds`, 'Duplicate level association');
    return { levelId: ids[0], levelIds: ids };
  }
  let globalLightEnabled = false;
  if (source.globalLightEnabled !== undefined) {
    const configured = bool(source.globalLightEnabled, '/scene/globalLightEnabled');
    const metadata = source.globalLightMetadata === undefined ? undefined : object(source.globalLightMetadata, '/scene/globalLightMetadata');
    if (metadata?.enabled !== undefined && bool(metadata.enabled, '/scene/globalLightMetadata/enabled') !== configured) error('/scene/globalLightEnabled', 'Configured global light disagrees with its metadata');
    if (configured) {
      if (!metadata) error('/scene/globalLightMetadata', 'Global lighting needs its explicit activation thresholds');
      const activation = object(metadata.darkness, '/scene/globalLightMetadata/darkness');
      const min = number(activation.min, '/scene/globalLightMetadata/darkness/min', 0, 1), max = number(activation.max, '/scene/globalLightMetadata/darkness/max', min, 1);
      const darkness = number(source.darknessLevel, '/scene/darknessLevel', 0, 1);
      globalLightEnabled = darkness >= min && darkness <= max;
      if (!globalLightEnabled) warnings.push('Configured global lighting is inactive at the exported darkness level.');
      warnings.push('Global illumination is a basic boolean lighting model; native shader/coloration and level-dependent behavior are not reproduced.');
    }
  }
  function resources(value: unknown, path: string): { hp: number | null; maxHp: number | null } {
    if (value === null) return { hp: null, maxHp: null };
    const hp = object(value, path), current = number(hp.value, `${path}/value`, 0, 100000), maximum = number(hp.max, `${path}/max`, 0, 100000);
    if (!Number.isInteger(current) || !Number.isInteger(maximum) || current > maximum) error(path, 'Expected integer HP value <= max');
    const temp = hp.temp === null ? null : number(hp.temp, `${path}/temp`, 0, 100000);
    const tempMax = hp.tempMax === null ? null : number(hp.tempMax, `${path}/tempMax`, -100000, 100000);
    if (tempMax !== null && tempMax !== 0) error(`${path}/tempMax`, 'Temporary maximum HP adjustments need a system adapter');
    if (temp) warnings.push(`${path}: temporary HP ${temp} remains in the source archive; this runtime exposes base HP only.`);
    return { hp: current, maxHp: maximum };
  }
  const actors: Actor[] = [], actorMap = new Map<string, Actor>(), actorBySource = new Map<string, Actor>();
  let unsupportedEffects = 0;
  for (const [i, value] of array(doc.actors ?? [], '/actors', 1000).entries()) {
    const path = `/actors/${i}`, item = object(value, path), originalId = rawId(item.id, `${path}/id`), sourceActorRef = rawId(item.sourceActorRef, `${path}/sourceActorRef`);
    if (actorMap.has(originalId) || actorBySource.has(sourceActorRef)) error(path, 'Duplicate actor ID or source identity');
    choice(item.permissionPolicy, ['gm-only'], `${path}/permissionPolicy`);
    const sourceId = rawId(item.sourceId, `${path}/sourceId`);
    if (!additionalSourceIds.has(sourceId)) error(`${path}/sourceId`, 'Missing original Actor archive');
    const systemId = item.systemId === null ? null : text(item.systemId, `${path}/systemId`, 100);
    const systemVersion = item.systemVersion === null ? null : text(item.systemVersion, `${path}/systemVersion`, 100);
    text(item.type, `${path}/type`, 100);
    if (item.hp !== null && (systemId !== 'dnd5e' || systemVersion !== '6.0.6')) error(`${path}/hp`, 'Explicit HP mapping is supported only for dnd5e 6.0.6');
    let mappedSheet = { sheet: blankActorSheet(), itemRefs: [] as NonNullable<ImportedActorSource['itemRefs']>, effectRefs: [] as NonNullable<ImportedActorSource['effectRefs']>, unsupportedEffects: 0 };
    if (item.sheet !== undefined) {
      if (!['0.4.0', '0.5.0', '0.6.0', '0.7.0', '0.8.0', '0.9.0'].includes(version)) error(`${path}/sheet`, 'Actor sheets require schema 0.4.0 through 0.9.0');
      if (systemId !== 'dnd5e' || systemVersion !== '6.0.6') error(`${path}/sheet`, 'This sheet subset is supported only for dnd5e 6.0.6');
      mappedSheet = actorSheet(item.sheet, `${path}/sheet`, ['0.5.0', '0.6.0', '0.7.0', '0.8.0', '0.9.0'].includes(version), warnings, ['0.6.0', '0.7.0', '0.8.0', '0.9.0'].includes(version), ['0.7.0', '0.8.0', '0.9.0'].includes(version));
      unsupportedEffects += mappedSheet.unsupportedEffects;
      warnings.push(`${path}/sheet: base scores, inventory and explicit constant additive ability effects are supported; other effects, expiry and source formulas are not executed.`);
    }
    const actor: Actor = { id: `actor-${globalThis.crypto.randomUUID()}`, name: text(item.name, `${path}/name`, 120), color: TOKEN_COLORS[i % TOKEN_COLORS.length], owners: [], ...resources(item.hp, `${path}/hp`), notes: '', gmNotes: '', ...mappedSheet.sheet, source: { sourceActorRef, resolution: 'resolved', systemId, systemVersion, ...(item.sheet === undefined ? {} : { itemRefs: mappedSheet.itemRefs }), ...(['0.5.0', '0.6.0', '0.7.0', '0.8.0', '0.9.0'].includes(version) ? { effectRefs: mappedSheet.effectRefs } : {}) } };
    const rawSheet = item.sheet === undefined ? undefined : object(item.sheet, `${path}/sheet`);
    if (rawSheet?.checks !== undefined) {
      const mapped = importChecks(rawSheet.checks, `${path}/sheet/checks`, error);
      actor.checks = mapped.checks; actor.source!.checkRefs = mapped.checkRefs;
      warnings.push(`${path}/sheet/checks: numeric proficiency profile. World settings are not included; the proficiency-die variant is not executed. Unsupported formulas and conditions block affected checks.`);
    }
    if (rawSheet?.spellcasting !== undefined) {
      const mapped = importSpellcasting(rawSheet.spellcasting, `${path}/sheet/spellcasting`, error);
      if (mapped.spellRefs.some(spell => mappedSheet.itemRefs.some(ref => ref.sourceItemId === spell.sourceItemId))) error(`${path}/sheet/spellcasting`, 'Spell cannot also be an inventory Item');
      actor.spellcasting = mapped.spellcasting; actor.resources = mapped.resources; actor.actions = mapped.actions;
      Object.assign(actor.source!, { spellRefs: mapped.spellRefs, activityRefs: mapped.activityRefs, resourceRefs: mapped.resourceRefs });
      warnings.push(`${path}/sheet/spellcasting: base-level static damage/healing only. Shared Spell preparation and explicit slot costs are executable. Range, target and activation are informational; check legality manually. Upcast, pact, rituals, conditions and automatic action economy are not implemented.`);
      if (mapped.spellcasting.unsupported.length) warnings.push(`${path}/sheet/spellcasting: ${mapped.spellcasting.unsupported.length} unsupported definitions remain blocked; inspect the compatibility list and original archive.`);
    } else if (rawSheet) warnings.push(`${path}/sheet: native Spell activities are not included in this document; manual actions may be created separately.`);
    if (item.advancementEvidence !== undefined) {
      if (!['0.8.0', '0.9.0'].includes(version) || systemId !== 'dnd5e' || systemVersion !== '6.0.6' || !rawSheet) error(`${path}/advancementEvidence`, 'Observed advancement requires schema 0.8 or 0.9 and a dnd5e 6.0.6 sheet');
      const ids = (entries: unknown) => new Set(array(entries ?? [], `${path}/advancementEvidence/targets`).map(entry => rawId(object(entry, path).id, path)));
      const spells = rawSheet.spellcasting === undefined ? {} : object(rawSheet.spellcasting, `${path}/sheet/spellcasting`);
      const mapped = importAdvancementEvidence(item.advancementEvidence, `${path}/advancementEvidence`, { item: ids(rawSheet.items), spell: ids(spells.spells), activity: ids(spells.activities) }, error);
      actor.source!.advancementEvidence = mapped.evidence; actor.observedAdvancement = mapped.summary;
      warnings.push(`${path}/advancementEvidence: source choices and grants are observations, not a completed build or event history. Existing scores/items are not granted again. Raw source references remain GM-only.`);
    }
    actorMap.set(originalId, actor); actorBySource.set(sourceActorRef, actor); actors.push(actor);
    if (actor.hp === null) warnings.push(`${path}: HP is unknown; no numeric default was invented.`);
  }
  const tokens: Token[] = [], sourceTokenIds = new Set<string>(), tokenIds = new Set<string>();
  for (const [i, value] of array(source.tokens ?? [], '/scene/tokens', 1000).entries()) {
    const path = `/scene/tokens/${i}`, item = object(value, path), originalId = rawId(item.id, `${path}/id`);
    if (tokenIds.has(originalId)) error(`${path}/id`, 'Duplicate token ID'); tokenIds.add(originalId);
    const sourceTokenId = item.sourceTokenId === null ? null : rawId(item.sourceTokenId, `${path}/sourceTokenId`);
    if (sourceTokenId !== null) { if (sourceTokenIds.has(sourceTokenId)) error(`${path}/sourceTokenId`, 'Duplicate native token identity'); sourceTokenIds.add(sourceTokenId); }
    text(item.sourcePath, `${path}/sourcePath`, 1000);
    choice(item.permissionPolicy, ['gm-only'], `${path}/permissionPolicy`);
    choice(item.positionAnchor, ['center'], `${path}/positionAnchor`);
    choice(item.rotationConvention, ['foundry-zero-south'], `${path}/rotationConvention`);
    const position = point(item.position, `${path}/position`, width, height);
    const widthCells = number(item.widthCells, `${path}/widthCells`, 0.25, 20), heightCells = number(item.heightCells, `${path}/heightCells`, 0.25, 20);
    if (position.x < widthCells * grid.size / 2 || position.x > width - widthCells * grid.size / 2 || position.y < heightCells * grid.size / 2 || position.y > height - heightCells * grid.size / 2) error(`${path}/position`, 'Token footprint is outside scene bounds');
    if (item.levelId === null) error(`${path}/levelId`, 'Token level is unknown; no level membership is inferred');
    const levelId = levelMap.get(rawId(item.levelId, `${path}/levelId`));
    if (!levelId) error(`${path}/levelId`, 'Unknown token level reference');
    const linked = bool(item.actorLink, `${path}/actorLink`), sourceActorRef = item.sourceActorRef === null ? null : rawId(item.sourceActorRef, `${path}/sourceActorRef`);
    const actorResolution = choice(item.actorResolution, ['resolved', 'unresolved', 'unlinked', 'none'], `${path}/actorResolution`);
    let actor: Actor | undefined;
    if (item.actorId !== null) {
      actor = actorMap.get(rawId(item.actorId, `${path}/actorId`));
      if (!actor) error(`${path}/actorId`, 'Unknown normalized Actor reference');
      if (actor.source?.sourceActorRef !== sourceActorRef) error(`${path}/sourceActorRef`, 'Token and Actor source identities disagree');
      if (actorResolution !== (linked ? 'resolved' : 'unlinked')) error(`${path}/actorResolution`, 'Resolution does not match the explicit actor link');
    } else {
      if (actorResolution !== (sourceActorRef || linked ? 'unresolved' : 'none')) error(`${path}/actorResolution`, 'Resolution contradicts the missing Actor reference');
      if (sourceActorRef && actorBySource.get(sourceActorRef)?.source?.resolution === 'resolved') error(`${path}/actorId`, 'Actor source is present but normalized reference was not resolved');
    }
    if (linked && !actor) {
      if (!sourceActorRef) error(`${path}/sourceActorRef`, 'A linked token without source Actor identity cannot preserve shared resources');
      actor = actorBySource.get(sourceActorRef);
      if (!actor) {
        actor = { id: `actor-${globalThis.crypto.randomUUID()}`, name: `Unknown character ${actors.length + 1}`, color: TOKEN_COLORS[actors.length % TOKEN_COLORS.length], owners: [], hp: null, maxHp: null, notes: '', gmNotes: '', ...blankActorSheet(), source: { sourceActorRef, resolution: 'unresolved', systemId: null, systemVersion: null } };
        actorBySource.set(sourceActorRef, actor); actors.push(actor);
      }
      warnings.push(`${path}: linked Actor export is missing; a shared placeholder preserves identity with unknown HP.`);
    }
    if (linked && item.hp !== null) error(`${path}/hp`, 'Linked token resources must be null and owned by the Actor');
    const hp = linked ? { hp: null, maxHp: null } : resources(item.hp, `${path}/hp`);
    if (!linked && hp.hp === null) warnings.push(`${path}: independent HP is unresolved; base Actor HP was not copied.`);
    if (!linked && actor?.sheetKind === 'dnd5e') warnings.push(`${path}: the referenced sheet is the base Actor sheet; synthetic Item, ability and effect deltas are not applied. Only explicitly normalized token HP is independent.`);
    const sight = object(item.sight, `${path}/sight (explicit basic sight required)`);
    const sightMetadata = object(item.sightMetadata, `${path}/sightMetadata`);
    const detection = object(item.detectionModesMetadata, `${path}/detectionModesMetadata`);
    if (Object.keys(detection).some(key => key !== 'basicSight')) error(`${path}/detectionModesMetadata`, 'Additional detection modes are not supported');
    choice(sight.mode, ['basic'], `${path}/sight/mode (non-basic vision unsupported)`);
    if (number(sight.angle, `${path}/sight/angle`, 0, 360) !== 360) error(`${path}/sight/angle`, 'Sight sectors are not supported');
    const visionEnabled = bool(sight.enabled, `${path}/sight/enabled`), visionUnlimited = sight.rangePixels === null;
    const vision = visionUnlimited ? 0 : number(sight.rangePixels, `${path}/sight/rangePixels`, 0, 100000);
    // Copy only the explicit basic profile. Other native sight fields stay in the source archive.
    const safeSightMetadata = { enabled: visionEnabled, range: sightMetadata.range === null ? null : number(sightMetadata.range, `${path}/sightMetadata/range`, 0, 1000000), angle: 360, visionMode: 'basic' };
    if (sightMetadata.enabled !== visionEnabled || sightMetadata.angle !== 360 || sightMetadata.visionMode !== 'basic') error(`${path}/sightMetadata`, 'Normalized sight disagrees with native basic metadata');
    if ((safeSightMetadata.range === null) !== visionUnlimited || (safeSightMetadata.range !== null && Math.abs(safeSightMetadata.range * grid.size / grid.distance - vision) > 0.00001)) error(`${path}/sight`, 'Sight range differs from native distance conversion');
    // A redundant basic detection record is safe only when it exactly describes the supported sight profile.
    if (Object.hasOwn(detection, 'basicSight')) {
      const basic = object(detection.basicSight, `${path}/detectionModesMetadata/basicSight`);
      if (Object.keys(basic).some(key => key !== 'enabled' && key !== 'range')) error(`${path}/detectionModesMetadata`, 'Additional detection modes are not supported');
      const enabled = bool(basic.enabled, `${path}/detectionModesMetadata/basicSight/enabled`);
      const range = basic.range === null ? null : number(basic.range, `${path}/detectionModesMetadata/basicSight/range`, 0, 1000000);
      if (!visionEnabled || !enabled || range !== safeSightMetadata.range) error(`${path}/detectionModesMetadata/basicSight`, 'Normalized sight disagrees with native basic metadata');
    }
    object(item.textureMetadata, `${path}/textureMetadata`); object(item.barsMetadata, `${path}/barsMetadata`);
    tokens.push({ id: `token-${globalThis.crypto.randomUUID()}`, name: text(item.name, `${path}/name`, 120), color: actor?.color ?? TOKEN_COLORS[i % TOKEN_COLORS.length], ...position, width: widthCells, height: heightCells, rotation: number(item.rotationDegrees, `${path}/rotationDegrees`, -360, 360), levelId, owners: [], hidden: bool(item.hidden, `${path}/hidden`), actorId: actor?.id ?? null, linked, ...hp, vision, visionEnabled, visionUnlimited, conditions: [], source: { sourceTokenId, sourceActorRef, actorResolution, rotationConvention: 'foundry-zero-south', elevation: number(item.elevation, `${path}/elevation`, -10000, 10000), sightMetadata: safeSightMetadata } });
  }
  if (tokens.length) warnings.push('Imported token textures and native bar visibility are archived; runtime uses local markers and explicit ownership. Basic sight depends on intrinsic range plus external light. System rules, statuses and token effects are not evaluated.');
  const walls: Wall[] = [], wallMap = new Map<string, Wall>();
  for (const [i, value] of array(source.walls, '/scene/walls').entries()) {
    const path = `/scene/walls/${i}`, item = object(value, path), originalId = rawId(item.id, `${path}/id`);
    if (wallMap.has(originalId)) error(`${path}/id`, 'Duplicate source wall ID');
    const segment = array(item.segment, `${path}/segment`, 2);
    if (segment.length !== 2) error(`${path}/segment`, 'Expected two endpoints');
    const a = point(segment[0], `${path}/segment/0`, width, height), b = point(segment[1], `${path}/segment/1`, width, height);
    if (samePoint(a, b)) error(`${path}/segment`, 'Zero-length wall');
    choice(item.kind, ['wall', 'object'], `${path}/kind`);
    choice(item.direction, ['both'], `${path}/direction (directional walls unsupported)`);
    text(item.sourcePath, `${path}/sourcePath`, 1000);
    const restrictions = object(item.restrictions, `${path}/restrictions`);
    const restriction = (key: 'movement' | 'sight' | 'light' | 'sound') => choice(restrictions[key], key !== 'movement' && version === '0.9.0' ? ['none', 'block', 'limited'] : ['none', 'block'], `${path}/restrictions/${key} (unspecified modes cannot be inferred)`);
    const movement = restriction('movement'), sight = restriction('sight'), light = restriction('light'), sound = restriction('sound');
    const wall: Wall = {
      id: safeId(originalId, 'wall', usedIds), a, b, ...membership(item, path),
      kind: 'wall', state: 'closed', movement: movement === 'block', sight: sight !== 'none', light: light !== 'none', sound: sound !== 'none',
    };
    for (const [channel, mode] of [['sight', sight], ['light', light], ['sound', sound]] as const) if (mode === 'limited') (wall.senseModes ??= {})[channel] = 'limited';
    if (wall.senseModes) warnings.push('Limited wall senses use one pass-through crossing and block at the second distinct crossing. Coincident crossings count once; directional, proximity and distance rules are not reproduced.');
    walls.push(wall); wallMap.set(originalId, wall);
  }
  const portalIds = new Set<string>(), portalWalls = new Set<string>();
  for (const [i, value] of array(source.portals, '/scene/portals').entries()) {
    const path = `/scene/portals/${i}`, item = object(value, path), id = rawId(item.id, `${path}/id`);
    if (portalIds.has(id)) error(`${path}/id`, 'Duplicate portal ID');
    portalIds.add(id);
    const kind = choice(item.kind, ['door', 'secret-door'], `${path}/kind (ambiguous portals unsupported)`);
    const state = choice(item.state, ['closed', 'open', 'locked'], `${path}/state`);
    const wallId = rawId(item.wallId, `${path}/wallId (standalone portals unsupported)`), wall = wallMap.get(wallId);
    if (!wall) error(`${path}/wallId`, 'Referenced wall does not exist');
    if (portalWalls.has(wallId)) error(`${path}/wallId`, 'Multiple portal definitions for one wall');
    portalWalls.add(wallId);
    const segment = array(item.segment, `${path}/segment`, 2);
    if (segment.length !== 2) error(`${path}/segment`, 'Expected two endpoints');
    const a = point(segment[0], `${path}/segment/0`, width, height), b = point(segment[1], `${path}/segment/1`, width, height);
    if (!(samePoint(a, wall.a) && samePoint(b, wall.b)) && !(samePoint(a, wall.b) && samePoint(b, wall.a))) error(`${path}/segment`, 'Portal geometry differs from its wall');
    if (item.levelIds !== undefined) {
      const association = membership(item, path), expected = wall.levelIds ?? [wall.levelId], actual = association.levelIds ?? [association.levelId];
      if (expected.length !== actual.length || actual.some(id => !expected.includes(id))) error(`${path}/levelIds`, 'Portal membership differs from its wall');
    }
    text(item.sourcePath, `${path}/sourcePath`, 1000);
    wall.kind = kind === 'secret-door' ? 'secret' : 'door'; wall.state = state;
  }
  const lights: Light[] = [], lightIds = new Set<string>();
  for (const [i, value] of array(source.lights, '/scene/lights', 500).entries()) {
    const path = `/scene/lights/${i}`, item = object(value, path), originalId = rawId(item.id, `${path}/id`);
    if (lightIds.has(originalId)) error(`${path}/id`, 'Duplicate light ID');
    lightIds.add(originalId);
    const p = point(item.position, `${path}/position`, width, height), dim = number(item.radiusPixels, `${path}/radiusPixels`, 0, 100000);
    const bright = item.brightRadiusPixels === null ? 0 : number(item.brightRadiusPixels, `${path}/brightRadiusPixels`, 0, dim);
    if (item.brightRadiusPixels === null) warnings.push(`${path}: no bright radius; imported as dim-only light.`);
    choice(item.colorEncoding, ['rgb-hex'], `${path}/colorEncoding (raw UVTT colors unsupported)`);
    if (item.intensity !== null) error(`${path}/intensity`, 'Explicit light intensity cannot be reproduced by this renderer');
    text(item.sourcePath, `${path}/sourcePath`, 1000);
    lights.push({ id: safeId(originalId, 'light', usedIds), name: `Imported light ${i + 1}`, ...p,
      ...membership(item, path), bright, dim, color: item.color === null ? '#ffffff' : color(item.color, `${path}/color`), enabled: bool(item.enabled, `${path}/enabled`) });
  }
  for (const [i, value] of array(source.assets, '/scene/assets', 5000).entries()) {
    const path = `/scene/assets/${i}`, item = object(value, path);
    const kind = choice(item.kind, ['external-reference', 'embedded-base64'], `${path}/kind`);
    text(item.sourcePath, `${path}/sourcePath`, 2000);
    if (kind === 'external-reference') text(item.uri, `${path}/uri`, 10000);
    else if (!/^[0-9a-f]{64}$/.test(text(item.sha256, `${path}/sha256`, 64))) error(`${path}/sha256`, 'Expected SHA256 hex');
    warnings.push(`${path}: asset retained only in the original bridge file; not requested or rendered.`);
  }
  let background = '#172126';
  const activeMetadata = levelMetadata.get(activeLevelId);
  if (activeMetadata) {
    const metadata = object(activeMetadata.backgroundMetadata, '/scene/levels/backgroundMetadata');
    if (typeof metadata.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(metadata.color)) background = metadata.color;
    warnings.push('Level texture transforms, fog and per-level background images are not rendered; keep the original bridge document.');
  }
  const uniqueWarnings = [...new Set(warnings)];
  const scene: Scene = {
    id: `scene-${globalThis.crypto.randomUUID()}`, name: text(source.name, '/scene/name', 200), width, height, grid,
    levels, activeLevelId, background, visionEnabled: true, globalLightEnabled, tokens, walls, lights, importWarnings: uniqueWarnings,
  };
  const mappedActors = actors.filter(actor => actor.sheetKind === 'dnd5e');
  const knownAbilities = mappedActors.reduce((count, actor) => count + ABILITY_KEYS.filter(key => actor.abilities[key] !== null).length, 0);
  const sheetSummary = { actorSheets: mappedActors.length, items: mappedActors.reduce((count, actor) => count + actor.items.length, 0), knownAbilities, unknownAbilities: mappedActors.length * ABILITY_KEYS.length - knownAbilities, effects: mappedActors.reduce((count, actor) => count + actor.effects.length, 0), activeEffects: mappedActors.reduce((count, actor) => count + actor.effects.filter(effect => !effect.disabled).length, 0), unsupportedEffects, spells: actors.reduce((n, a) => n + (a.spellcasting?.spells.length ?? 0), 0), activities: actors.reduce((n, a) => n + a.actions.filter(action => action.spellId).length, 0), slotPools: actors.reduce((n, a) => n + a.resources.filter(resource => resource.kind === 'spell-slot').length, 0), unsupportedSpellcasting: actors.reduce((n, a) => n + (a.spellcasting?.unsupported.length ?? 0), 0), checksProfiles: actors.filter(a => a.checks).length, unsupportedChecks: actors.reduce((n, a) => n + (a.checks?.unsupported.length ?? 0), 0) };
  return { scene, actors, warnings: uniqueWarnings, sheetSummary };
}
