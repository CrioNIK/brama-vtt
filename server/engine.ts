import { randomInt, randomUUID } from 'node:crypto';
import type { Actor, ActorEffect, ActorItem, ActorResource, Campaign, ChatMessage, Command, Light, Member, Point, RollResult, Scene, Snapshot, Token, Wall } from '../shared/model.ts';
import { ABILITY_KEYS, blankActorSheet, normalizeActorResource, TOKEN_COLORS, WALL_THRESHOLD_MAX } from '../shared/model.ts';
import { abilityBreakdown, derivedAbilitiesWithinBounds, EFFECT_LIMITS } from '../shared/abilities.ts';
import { blocksMovement, inLevel, prepareSceneLightSources, prepareTokenVision } from '../shared/geometry.ts';
import { importNeutralScene } from '../shared/import.ts';
import { applyActionCommand } from './actions.ts';
import { applyCheckCommand } from './checks.ts';
import { applyProgressionCommand } from './progression.ts';
import { applyCombatCommand } from './combat.ts';
import { blankCombat, removeCombatEntries } from '../shared/combat.ts';
import { managedBinding, syncManagedResource, syncManagedItemUses } from '../shared/progression.ts';
import { applyJournalCommand, normalizeJournals, projectJournals } from './journals.ts';
import { domainMessages } from '../shared/catalog-domain.ts';
import type { Locale } from '../shared/locale.ts';

export class DomainError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export const fail = (code: string, message: string): never => { throw new DomainError(code, message); };
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('VALIDATION', "Expected an object.");
  return value as Record<string, unknown>;
}
export function str(value: unknown, name: string, max = 120, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) return fail('VALIDATION', `Invalid field ${name}.`);
  return value;
}
function num(value: unknown, name: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) return fail('VALIDATION', `Invalid number ${name}.`);
  return value;
}
function bool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') return fail('VALIDATION', `Invalid field ${name}.`);
  return value;
}
function color(value: unknown): string {
  if (typeof value !== 'string' || !/^#[a-f\d]{6}$/i.test(value)) return fail('VALIDATION', "The color must use #RRGGBB.");
  return value;
}
function background(value: unknown): string { return value === '/assets/observatory.svg' ? value : color(value); }
function choice<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (!values.includes(value as T)) return fail('VALIDATION', `Invalid value for ${name}.`);
  return value as T;
}
function point(value: unknown): Point {
  const p = object(value);
  return { x: num(p.x, 'x', 0, 10000), y: num(p.y, 'y', 0, 10000) };
}
const uid = () => randomUUID();
const now = () => new Date().toISOString();
const own = (member: Member, entity: { owners: string[] }) => member.role === 'gm' || entity.owners.includes(member.id);
const requireGM = (member: Member) => { if (member.role !== 'gm') fail('FORBIDDEN', "This action is available to the GM."); };
const requireOwner = (member: Member, entity: { owners: string[] }) => { if (!own(member, entity)) fail('FORBIDDEN', "You cannot control this object."); };
function owners(value: unknown, campaign: Campaign): string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some(v => typeof v !== 'string' || !campaign.members.some(m => m.id === v))) return fail('VALIDATION', "Invalid owners list.");
  return [...new Set(value as string[])];
}
function conditions(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20) return fail('VALIDATION', "At most 20 conditions are allowed.");
  return [...new Set(value.map(v => str(v, 'condition', 40)))];
}
function validateHP(hp: number | null, maxHp: number | null) { if (hp !== null && maxHp !== null && hp > maxHp) fail('VALIDATION', "HP cannot exceed the maximum."); }
function hpValue(value: unknown, name: string): number | null { return value === null ? null : num(value, name, 0, 100000, true); }
function checkLimit(items: unknown[], max: number, label: string) { if (items.length >= max) fail('LIMIT', `Limit reached: ${label}.`); }
export function makeScene(name: string, locale: Locale = 'en'): Scene {
  return { id: uid(), name, width: 1600, height: 1000, grid: { size: 50, distance: 5, units: 'ft', type: 'square' }, levels: [{ id: 'ground', name: domainMessages['Ground floor'][locale], bottom: 0, top: 20 }], activeLevelId: 'ground', background: '#202a32', visionEnabled: false, tokens: [], walls: [], lights: [] };
}
function makeActor(name: string, index: number, actorOwners: string[] = []): Actor {
  return { id: uid(), name, color: TOKEN_COLORS[index % TOKEN_COLORS.length], owners: actorOwners, hp: 12, maxHp: 12, notes: '', gmNotes: '', ...blankActorSheet() };
}
function makeToken(actor: Actor, scene: Scene, x: number, y: number): Token {
  return { id: uid(), name: actor.name, color: actor.color, levelId: scene.activeLevelId, x, y, width: 1, height: 1, rotation: 0, owners: [...actor.owners], hidden: false, actorId: actor.id, linked: true, hp: actor.hp, maxHp: actor.maxHp, vision: 500, conditions: [] };
}
export function seedCampaign(name: string, gmName: string, locale: Locale = 'en'): Campaign {
  const seed = (key: string) => domainMessages[key]?.[locale] ?? key;
  const gm: Member = { id: uid(), name: gmName, role: 'gm', color: TOKEN_COLORS[0] };
  const scene = makeScene(seed('Observatory hall'), locale);
  const actors = [makeActor(seed('Astra'), 0, [gm.id]), makeActor(seed('Lyra'), 1, [gm.id]), makeActor(seed('Guardian'), 2, [gm.id])];
  actors[0].hp = 18; actors[0].maxHp = 24; actors[1].hp = 16; actors[1].maxHp = 16;
  scene.background = '/assets/observatory.svg';
  actors[2].gmNotes = seed('A hidden guardian watches the eastern room.');
  scene.tokens = actors.map((a, i) => makeToken(a, scene, [400, 1100, 1150][i], [300, 370, 650][i]));
  scene.tokens[2].hidden = true;
  const addWall = (a: Point, b: Point, kind: Wall['kind'] = 'wall') => scene.walls.push({ id: uid(), a, b, levelId: 'ground', kind, state: 'closed', movement: true, sight: true, light: true, sound: true });
  addWall({ x: 156, y: 138 }, { x: 758, y: 138 }); addWall({ x: 156, y: 138 }, { x: 156, y: 834 });
  addWall({ x: 156, y: 834 }, { x: 758, y: 834 }); addWall({ x: 758, y: 138 }, { x: 758, y: 410 });
  addWall({ x: 758, y: 410 }, { x: 758, y: 560 }, 'door'); addWall({ x: 758, y: 560 }, { x: 758, y: 834 });
  addWall({ x: 758, y: 242 }, { x: 1438, y: 242 }); addWall({ x: 1438, y: 242 }, { x: 1438, y: 724 }); addWall({ x: 1438, y: 724 }, { x: 758, y: 724 });
  scene.lights = [{ id: uid(), name: seed('Observatory lamp'), levelId: 'ground', x: 400, y: 450, bright: 150, dim: 350, color: '#efc879', enabled: true }];
  const campaign: Campaign = { id: uid(), name, revision: 1, activeSceneId: scene.id, members: [gm], scenes: [scene], actors, chat: [], actionResolutions: [], resourceRecoveries: [], outcomeRolls: [], hpApplications: [], progressionProfiles: [], progressionCommits: [], combatReceipts: [], combat: blankCombat(), journalFolders: [], journalPresentations: [], journalReceipts: [],
    journals: [{ id: uid(), name: seed('Welcome to BRAMA'), revision: 1, folderId: null, archived: false, gmNotes: '', permissions: { default: 'view', members: {} },
      pages: [{ id: uid(), name: seed('Page 1'), revision: 1, permissions: null, kind: 'text', html: seed('<p>A door connects the observatory’s two rooms. Explore the map, control characters and try rolling dice.</p>') }] }], createdAt: now() };
  normalizeJournals(campaign);
  return campaign;
}
export function addPlayer(campaign: Campaign, name: string): Member {
  checkLimit(campaign.members, 32, "participants");
  const member: Member = { id: uid(), name, role: 'player', color: TOKEN_COLORS[campaign.members.length % TOKEN_COLORS.length] };
  campaign.members.push(member);
  campaign.revision++;
  return member;
}

export function rollDice(input: unknown): RollResult {
  const formula = str(input, 'formula', 128).replace(/\s+/g, '').toLowerCase();
  if (!/^[+-]?(?:\d*d\d+|\d+)(?:[+-](?:\d*d\d+|\d+))*$/.test(formula)) return fail('VALIDATION', "Formula: NdM with + or − a number or dice group.");
  const parts = formula.match(/[+-]?(?:\d*d\d+|\d+)/g)!;
  if (parts.length > 12) return fail('LIMIT', "Too many formula parts.");
  let count = 0, modifier = 0, total = 0;
  const dice: RollResult['dice'] = [];
  for (const part of parts) {
    const sign = part.startsWith('-') ? -1 : 1;
    const body = part.replace(/^[+-]/, '');
    if (body.includes('d')) {
      const [n, s] = body.split('d'); const quantity = n ? Number(n) : 1; const sides = Number(s);
      num(quantity, 'dice count', 1, 100, true); num(sides, 'dice sides', 2, 1000, true);
      count += quantity; if (count > 100) return fail('LIMIT', "At most 100 dice are allowed per roll.");
      const values = Array.from({ length: quantity }, () => randomInt(1, sides + 1) * sign);
      total += values.reduce((a, b) => a + b, 0); dice.push({ sides, values });
    } else { const value = sign * num(Number(body), 'modifier', 0, 100000, true); modifier += value; total += value; }
  }
  return { formula, dice, modifier, total };
}
function postChat(campaign: Campaign, member: Member, text: string, visibility: ChatMessage['visibility'], roll?: RollResult, system?: ChatMessage['system']) {
  campaign.chat.push({ id: uid(), authorId: member.id, authorName: member.name, text, visibility, createdAt: now(), ...(roll ? { roll } : {}), ...(system ? { system } : {}) });
  if (campaign.chat.length > 1000) campaign.chat.splice(0, campaign.chat.length - 1000);
}
function getScene(campaign: Campaign, p: Record<string, unknown>): Scene {
  const id = p.sceneId === undefined ? campaign.activeSceneId : str(p.sceneId, 'sceneId');
  return campaign.scenes.find(s => s.id === id) ?? fail('NOT_FOUND', "Scene not found.");
}
function target<T extends { id: string }>(list: T[], p: Record<string, unknown>): T {
  const id = str(p.id, 'id'); return list.find(x => x.id === id) ?? fail('NOT_FOUND', "Object not found.");
}
function validLevel(scene: Scene, value: unknown): string {
  const id = value === undefined ? scene.activeLevelId : str(value, 'levelId');
  if (!scene.levels.some(l => l.id === id)) return fail('VALIDATION', "Level not found.");
  return id;
}
function tokenWithin(scene: Scene, token: Token) {
  const rx = token.width * scene.grid.size / 2, ry = token.height * scene.grid.size / 2;
  if (token.x < rx || token.y < ry || token.x > scene.width - rx || token.y > scene.height - ry) fail('VALIDATION', "The token is outside the scene boundary.");
}
function patchActor(actor: Actor, p: Record<string, unknown>, member: Member, campaign: Campaign) {
  requireOwner(member, actor);
  if (member.role !== 'gm' && ['owners', 'gmNotes', 'sheetKind'].some(k => p[k] !== undefined)) fail('FORBIDDEN', "Permissions, sheet type and GM notes cannot be changed.");
  if (['items', 'resources', 'effects', 'actions', 'spellcasting', 'checks', 'progression', 'observedAdvancement', 'source'].some(k => p[k] !== undefined)) fail('VALIDATION', "Use dedicated item, resource, effect, action, preparation, check and progression commands.");
  if (actor.progression && p.sheetKind !== undefined && p.sheetKind !== 'dnd5e') fail('PROGRESSION_MANAGED', "A sheet with progression uses the D&D profile.");
  let baselineMax = actor.progression?.baseline.maxHp;
  if (actor.progression && p.maxHp !== undefined) {
    const nextMax = hpValue(p.maxHp, 'maxHp');
    const grants = [...new Map(actor.progression.grants.filter(g => g.active).map(g => [g.spec.key, g])).values()];
    const bonus = grants.reduce((sum, g) => sum + (g.spec.kind === 'hp' ? g.spec.value : 0), 0);
    baselineMax = nextMax === null ? null : nextMax - bonus;
    if (baselineMax !== null && baselineMax < 0) fail('PROGRESSION_MANAGED', "Maximum HP cannot be lower than active HP grants.");
  }
  if (p.name !== undefined) actor.name = str(p.name, 'name');
  if (p.color !== undefined) actor.color = color(p.color);
  if (p.hp !== undefined) actor.hp = hpValue(p.hp, 'hp');
  if (p.maxHp !== undefined) actor.maxHp = hpValue(p.maxHp, 'maxHp');
  if (p.notes !== undefined) actor.notes = str(p.notes, 'notes', 20000, true);
  if (p.gmNotes !== undefined) actor.gmNotes = str(p.gmNotes, 'gmNotes', 20000, true);
  if (p.owners !== undefined) actor.owners = owners(p.owners, campaign);
  if (p.sheetKind !== undefined) actor.sheetKind = choice(p.sheetKind, ['generic', 'dnd5e'], 'sheetKind');
  if (p.abilities !== undefined) {
    const scores = object(p.abilities);
    if (Object.keys(scores).some(k => !ABILITY_KEYS.includes(k as typeof ABILITY_KEYS[number]))) fail('VALIDATION', "Unknown ability.");
    for (const key of ABILITY_KEYS) if (scores[key] !== undefined) actor.abilities[key] = scores[key] === null ? null : num(scores[key], key, 1, 30, true);
  }
  validateHP(actor.hp, actor.maxHp);
  validateDerivedAbilities(actor);
  if (actor.progression && p.maxHp !== undefined) actor.progression.baseline.maxHp = baselineMax!;
}

function validateDerivedAbilities(actor: Actor) {
  if (!derivedAbilitiesWithinBounds(actor)) fail('VALIDATION', "The effective ability must be a finite number from −1000 to 1000.");
}
function patchEffect(effect: ActorEffect, p: Record<string, unknown>) {
  if (Object.keys(p).some(key => !['id', 'sceneId', 'effectId', 'name', 'description', 'disabled', 'changes', 'duration'].includes(key))) fail('VALIDATION', "Unknown effect field.");
  if (p.name !== undefined) effect.name = str(p.name, 'name');
  if (p.description !== undefined) effect.description = str(p.description, 'description', 20000, true);
  if (p.disabled !== undefined) effect.disabled = bool(p.disabled, 'disabled');
  if (p.changes !== undefined) {
    if (!Array.isArray(p.changes) || p.changes.length < 1 || p.changes.length > EFFECT_LIMITS.changes) fail('VALIDATION', "An effect must contain 1 to 20 changes.");
    effect.changes = (p.changes as unknown[]).map(value => {
      const change = object(value);
      if (Object.keys(change).some(key => !['ability', 'mode', 'value'].includes(key))) fail('VALIDATION', "Unknown change field.");
      return { ability: choice(change.ability, ABILITY_KEYS, 'ability'), mode: choice(change.mode, ['add'], 'mode'), value: num(change.value, 'value', -EFFECT_LIMITS.value, EFFECT_LIMITS.value) };
    });
  }
  if (p.duration !== undefined) {
    if (p.duration === null) delete effect.duration;
    else {
      const duration = object(p.duration);
      if (Object.keys(duration).some(key => !['rounds', 'seconds'].includes(key))) fail('VALIDATION', "Unknown duration field.");
      const rounds = duration.rounds === null ? null : num(duration.rounds, 'rounds', 0, EFFECT_LIMITS.duration, true);
      const seconds = duration.seconds === null ? null : num(duration.seconds, 'seconds', 0, EFFECT_LIMITS.duration);
      if (rounds !== null && seconds !== null) fail('VALIDATION', "Choose rounds or seconds.");
      effect.duration = { rounds, seconds };
    }
  }
  if (!effect.changes.length) fail('VALIDATION', "Add at least one change.");
}

function patchItem(item: ActorItem, p: Record<string, unknown>) {
  if (p.name !== undefined) item.name = str(p.name, 'name');
  if (p.type !== undefined) item.type = str(p.type, 'type', 60);
  if (p.quantity !== undefined) item.quantity = num(p.quantity, 'quantity', 0, 100000, true);
  if (p.weight !== undefined) item.weight = num(p.weight, 'weight', 0, 100000);
  if (p.weightUnit !== undefined) item.weightUnit = choice(p.weightUnit, ['lb', 'kg', 'unit'], 'weightUnit');
  if (p.description !== undefined) item.description = str(p.description, 'description', 20000, true);
  if (p.equipped !== undefined) item.equipped = bool(p.equipped, 'equipped');
  if (p.uses !== undefined) {
    if (p.uses === null) delete item.uses;
    else {
      const uses = object(p.uses), value = num(uses.value, 'uses.value', 0, 100000, true), max = num(uses.max, 'uses.max', 0, 100000, true);
      if (value > max) fail('VALIDATION', "Charges cannot exceed the maximum.");
      item.uses = { value, max };
    }
  }
}
function patchResource(resource: ActorResource, p: Record<string, unknown>, member: Member, creating = false) {
  if (Object.keys(p).some(k => !['id', 'sceneId', 'resourceId', 'label', 'value', 'max', 'kind', 'level', 'unit', 'recovery'].includes(k))) fail('VALIDATION', "Unknown resource field.");
  const neutral = { kind: 'custom', level: null, unit: '', recovery: 'manual' };
  if (member.role !== 'gm' && (['kind', 'level', 'unit', 'recovery'] as const).some(k => p[k] !== undefined && (!creating || p[k] !== neutral[k]))) fail('FORBIDDEN', "The GM sets the resource type and recovery policy.");
  if (p.label !== undefined) resource.label = str(p.label, 'label');
  if (p.value !== undefined) resource.value = p.value === null ? null : num(p.value, 'value', 0, 100000);
  if (p.max !== undefined) resource.max = p.max === null ? null : num(p.max, 'max', 0, 100000);
  if (p.kind !== undefined) resource.kind = choice(p.kind, ['custom', 'action', 'bonus-action', 'reaction', 'spell-slot', 'charge'] as const, 'kind');
  if (p.level !== undefined) resource.level = p.level === null ? null : num(p.level, 'level', 0, 9, true);
  if (p.unit !== undefined) resource.unit = str(p.unit, 'unit', 40, true);
  if (p.recovery !== undefined) resource.recovery = choice(p.recovery, ['manual', 'turn', 'short-rest', 'long-rest'] as const, 'recovery');
  if (resource.value !== null && resource.max !== null && resource.value > resource.max) fail('VALIDATION', "A resource cannot exceed its maximum.");
}
const abilityLabels = { str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" };
export function rollActorCheck(actor: Actor, p: Record<string, unknown>, draw: () => number = () => randomInt(1, 21)): RollResult {
  const mode = choice(p.mode ?? 'normal', ['normal', 'advantage', 'disadvantage'], 'mode');
  const ability = p.ability === undefined ? undefined : choice(p.ability, ABILITY_KEYS, 'ability');
  if (ability && p.modifier !== undefined) fail('VALIDATION', "Choose an ability or a manual modifier.");
  let modifier: number;
  if (ability) {
    if (actor.sheetKind !== 'dnd5e') fail('VALIDATION', "An ability check requires a D&D character sheet.");
    validateDerivedAbilities(actor);
    const score = abilityBreakdown(actor, ability).effective;
    if (score === null) fail('VALIDATION', "The ability score is unknown.");
    modifier = Math.floor((score! - 10) / 2);
  } else modifier = num(p.modifier ?? 0, 'modifier', -1000, 1000, true);
  const values = Array.from({ length: mode === 'normal' ? 1 : 2 }, () => num(draw(), 'd20', 1, 20, true));
  const keptIndex = mode === 'advantage' && values[1] > values[0] || mode === 'disadvantage' && values[1] < values[0] ? 1 : 0;
  const formula = `${mode === 'normal' ? '1d20' : mode === 'advantage' ? '2d20kh1' : '2d20kl1'}${modifier >= 0 ? '+' : ''}${modifier}`;
  return { formula, dice: [{ sides: 20, values }], modifier, total: values[keptIndex] + modifier, d20: { mode, keptIndex }, actor: { id: actor.id, name: actor.name }, ...(ability ? { ability, abilitySnapshot: abilityBreakdown(actor, ability) } : {}) };
}
function patchToken(token: Token, p: Record<string, unknown>, scene: Scene, member: Member, campaign: Campaign) {
  requireOwner(member, token);
  if (member.role !== 'gm' && Object.keys(p).some(k => !['id', 'sceneId', 'hp', 'maxHp', 'conditions', 'rotation'].includes(k))) fail('FORBIDDEN', "Players can change their token’s resources, conditions and rotation.");
  if (member.role === 'gm') {
    if (p.linked === false && token.linked) {
      const previousActor = campaign.actors.find(a => a.id === token.actorId);
      if (previousActor) { token.hp = previousActor.hp; token.maxHp = previousActor.maxHp; }
    }
    if (p.linked !== undefined) token.linked = bool(p.linked, 'linked');
    if (p.actorId !== undefined) {
      if (p.actorId !== null && !campaign.actors.some(a => a.id === p.actorId)) fail('VALIDATION', "Character not found.");
      token.actorId = p.actorId as string | null;
    }
  }
  if (p.hp !== undefined || p.maxHp !== undefined) {
    const actor = token.linked ? campaign.actors.find(a => a.id === token.actorId) : undefined;
    const resource = actor ?? token;
    if (p.hp !== undefined) resource.hp = hpValue(p.hp, 'hp');
    if (p.maxHp !== undefined) resource.maxHp = hpValue(p.maxHp, 'maxHp');
    validateHP(resource.hp, resource.maxHp);
  }
  if (p.conditions !== undefined) token.conditions = conditions(p.conditions);
  if (p.rotation !== undefined) token.rotation = num(p.rotation, 'rotation', -360, 360);
  if (member.role === 'gm') {
    if (p.name !== undefined) token.name = str(p.name, 'name');
    if (p.color !== undefined) token.color = color(p.color);
    if (p.owners !== undefined) token.owners = owners(p.owners, campaign);
    if (p.hidden !== undefined) token.hidden = bool(p.hidden, 'hidden');
    if (p.width !== undefined) token.width = num(p.width, 'width', 0.25, 20);
    if (p.height !== undefined) token.height = num(p.height, 'height', 0.25, 20);
    if (p.vision !== undefined) token.vision = num(p.vision, 'vision', 0, 100000);
    if (p.visionEnabled !== undefined) token.visionEnabled = bool(p.visionEnabled, 'visionEnabled');
    if (p.visionUnlimited !== undefined) token.visionUnlimited = bool(p.visionUnlimited, 'visionUnlimited');
    if (p.visionRangeOrigin !== undefined) token.visionRangeOrigin = choice(p.visionRangeOrigin, ['center', 'token-edge'] as const, 'visionRangeOrigin');
    if (p.lightPerception !== undefined) {
      const perception = object(p.lightPerception);
      if (Object.keys(perception).some(key => key !== 'enabled' && key !== 'range')) fail('VALIDATION', 'Invalid field lightPerception.');
      token.lightPerception = { enabled: bool(perception.enabled, 'lightPerception.enabled'),
        range: perception.range === null ? null : num(perception.range, 'lightPerception.range', 0, 100000) };
    }
    if (p.levelId !== undefined) token.levelId = validLevel(scene, p.levelId);
    if (p.x !== undefined) token.x = num(p.x, 'x', 0, scene.width);
    if (p.y !== undefined) token.y = num(p.y, 'y', 0, scene.height);
  }
  if (token.linked && !token.actorId) fail('VALIDATION', "A linked token requires a character.");
  tokenWithin(scene, token);
}
function patchWall(wall: Wall, p: Record<string, unknown>, scene: Scene) {
  if (p.direction !== undefined) wall.direction = choice(p.direction, ['both', 'left', 'right'] as const, 'direction');
  const senseChannels = ['sight', 'light', 'sound'] as const;
  const allowedModes = ['none', 'normal', 'limited', 'proximity', 'distance'] as const;
  const modes = p.senseModes === undefined ? undefined : object(p.senseModes);
  if (modes && Object.keys(modes).some(key => !senseChannels.includes(key as typeof senseChannels[number]))) fail('VALIDATION', 'Invalid field senseModes.');
  const thresholds = p.senseThresholds === undefined ? undefined : object(p.senseThresholds);
  if (thresholds && Object.keys(thresholds).some(key => !senseChannels.includes(key as typeof senseChannels[number]))) fail('VALIDATION', 'Invalid field senseThresholds.');
  const thresholdPatch: NonNullable<Wall['senseThresholds']> = {};
  for (const channel of senseChannels) if (thresholds && Object.hasOwn(thresholds, channel)) {
    const value = thresholds[channel];
    if (value === null) thresholdPatch[channel] = null;
    else {
      const distance = num(value, `senseThresholds.${channel}`, 0, WALL_THRESHOLD_MAX);
      if (distance === 0) fail('VALIDATION', `Invalid number senseThresholds.${channel}.`);
      thresholdPatch[channel] = distance;
    }
  }
  for (const channel of senseChannels) if (modes && Object.hasOwn(modes, channel)) {
    const mode = choice(modes[channel], allowedModes, `senseModes.${channel}`);
    if (p[channel] !== undefined && bool(p[channel], channel) !== (mode !== 'none')) fail('VALIDATION', `Invalid field senseModes.${channel}.`);
  }
  if (p.a !== undefined) wall.a = point(p.a);
  if (p.b !== undefined) wall.b = point(p.b);
  for (const key of ['movement', 'sight', 'light', 'sound'] as const) if (p[key] !== undefined) wall[key] = bool(p[key], key);
  for (const channel of senseChannels) {
    if (modes && Object.hasOwn(modes, channel)) {
      const mode = choice(modes[channel], allowedModes, `senseModes.${channel}`);
      (wall.senseModes ??= {})[channel] = mode; wall[channel] = mode !== 'none';
    } else if (p[channel] !== undefined) delete wall.senseModes?.[channel];
    if (Object.hasOwn(thresholdPatch, channel)) (wall.senseThresholds ??= {})[channel] = thresholdPatch[channel];
  }
  if (wall.senseModes && !Object.keys(wall.senseModes).length) delete wall.senseModes;
  if (p.thresholdAttenuation !== undefined) wall.thresholdAttenuation = bool(p.thresholdAttenuation, 'thresholdAttenuation');
  if (p.kind !== undefined) wall.kind = choice(p.kind, ['wall', 'door', 'secret'], 'kind');
  if (p.state !== undefined) wall.state = choice(p.state, ['closed', 'open', 'locked'], 'state');
  if (p.levelId !== undefined) { wall.levelId = validLevel(scene, p.levelId); delete wall.levelIds; }
  if (wall.a.x > scene.width || wall.b.x > scene.width || wall.a.y > scene.height || wall.b.y > scene.height || Math.hypot(wall.a.x - wall.b.x, wall.a.y - wall.b.y) < 1) fail('VALIDATION', "Invalid wall bounds.");
}
function patchLight(light: Light, p: Record<string, unknown>, scene: Scene) {
  if (p.name !== undefined) light.name = str(p.name, 'name');
  if (p.x !== undefined) light.x = num(p.x, 'x', 0, scene.width);
  if (p.y !== undefined) light.y = num(p.y, 'y', 0, scene.height);
  if (p.bright !== undefined) light.bright = num(p.bright, 'bright', 0, 10000);
  if (p.dim !== undefined) light.dim = num(p.dim, 'dim', 0, 10000);
  if (p.color !== undefined) light.color = color(p.color);
  if (p.enabled !== undefined) light.enabled = bool(p.enabled, 'enabled');
  if (p.levelId !== undefined) { light.levelId = validLevel(scene, p.levelId); delete light.levelIds; }
  if (light.bright > light.dim) fail('VALIDATION', "The bright radius cannot exceed the dim radius.");
}
const playerCommands = new Set(['token.move', 'token.update', 'actor.update', 'actor.item.create', 'actor.item.update', 'actor.item.delete', 'actor.item.consume', 'actor.resource.create', 'actor.resource.update', 'actor.resource.delete', 'actor.effect.create', 'actor.effect.update', 'actor.effect.delete', 'actor.action.prepare', 'actor.action.execute', 'actor.action.rollOutcome', 'actor.action.applyOutcome', 'actor.spell.prepare', 'actor.roll', 'actor.checks.update', 'actor.check.roll', 'actor.progression.create', 'actor.progression.commit', 'chat.send', 'chat.roll', 'combat.roll', 'door.toggle']);
export function applyCommand(campaign: Campaign, member: Member, command: Command): void {
  const p = object(command.payload);
  if (applyJournalCommand(campaign, member, command)) return;
  if (applyCombatCommand(campaign, member, command)) return;
  if (!playerCommands.has(command.type)) requireGM(member);
  const scene = getScene(campaign, p);
  if (member.role !== 'gm' && scene.id !== campaign.activeSceneId) fail('FORBIDDEN', "The scene is unavailable to this player.");
  if (applyActionCommand(campaign, member, command)) return;
  if (applyCheckCommand(campaign, member, command)) return;
  if (applyProgressionCommand(campaign, member, command)) return;
  switch (command.type) {
    case 'scene.create': {
      checkLimit(campaign.scenes, 40, "scenes");
      const created = makeScene(str(p.name ?? "New scene", 'name'));
      if (p.width !== undefined) created.width = num(p.width, 'width', 200, 10000, true);
      if (p.height !== undefined) created.height = num(p.height, 'height', 200, 10000, true);
      campaign.scenes.push(created); campaign.activeSceneId = created.id; break;
    }
    case 'scene.activate': campaign.activeSceneId = target(campaign.scenes, p).id; break;
    case 'scene.update': {
      const edited = p.id === undefined ? scene : target(campaign.scenes, p);
      if (p.name !== undefined) edited.name = str(p.name, 'name');
      if (p.width !== undefined) edited.width = num(p.width, 'width', 200, 10000, true);
      if (p.height !== undefined) edited.height = num(p.height, 'height', 200, 10000, true);
      if (p.background !== undefined) edited.background = background(p.background);
      if (p.visionEnabled !== undefined) edited.visionEnabled = bool(p.visionEnabled, 'visionEnabled');
      if (p.globalLightEnabled !== undefined) edited.globalLightEnabled = bool(p.globalLightEnabled, 'globalLightEnabled');
      if (p.grid !== undefined) {
        const grid = object(p.grid);
        if (grid.size !== undefined) edited.grid.size = num(grid.size, 'grid.size', 10, 300);
        if (grid.distance !== undefined) edited.grid.distance = num(grid.distance, 'grid.distance', 0.1, 10000);
        if (grid.units !== undefined) edited.grid.units = str(grid.units, 'grid.units', 20);
        if (grid.type !== undefined) edited.grid.type = choice(grid.type, ['square', 'none'], 'grid.type');
      }
      edited.tokens.forEach(t => tokenWithin(edited, t)); break;
    }
    case 'scene.import': {
      checkLimit(campaign.scenes, 40, "scenes");
      const { scene: imported, actors } = importNeutralScene(p.document);
      if (campaign.actors.length + actors.length > 1000) fail('LIMIT', "The import exceeds the character limit.");
      for (const actor of actors) actor.owners = [member.id];
      for (const token of imported.tokens) token.owners = [member.id];
      imported.id = uid(); campaign.actors.push(...actors); campaign.scenes.push(imported); campaign.activeSceneId = imported.id; break;
    }
    case 'level.create': {
      checkLimit(scene.levels, 20, "floors");
      const bottom = num(p.bottom ?? 0, 'bottom', -10000, 10000), top = num(p.top ?? 20, 'top', -10000, 10000);
      if (top <= bottom) fail('VALIDATION', "The upper bound must be above the lower bound.");
      const level = { id: uid(), name: str(p.name ?? "New floor", 'name'), bottom, top };
      scene.levels.push(level); scene.activeLevelId = level.id; break;
    }
    case 'level.activate': scene.activeLevelId = validLevel(scene, p.id); break;
    case 'actor.create': {
      checkLimit(campaign.actors, 1000, "characters");
      const actor = makeActor(str(p.name ?? "Character", 'name'), campaign.actors.length, [member.id]);
      patchActor(actor, p, member, campaign); campaign.actors.push(actor); break;
    }
    case 'actor.update': patchActor(target(campaign.actors, p), p, member, campaign); break;
    case 'actor.effect.create': case 'actor.effect.update': case 'actor.effect.delete': {
      const actor = target(campaign.actors, p); requireOwner(member, actor);
      if (command.type === 'actor.effect.create') {
        checkLimit(actor.effects, EFFECT_LIMITS.effects, "character effects");
        const effect: ActorEffect = { id: uid(), name: "Effect", description: '', disabled: false, changes: [] };
        patchEffect(effect, p); actor.effects.push(effect);
      } else {
        const effect = target(actor.effects, { id: p.effectId });
        if (managedBinding(actor, 'effect', effect.id)) fail('PROGRESSION_MANAGED', "The profile grants this effect; update the progression plan.");
        if (command.type === 'actor.effect.update') patchEffect(effect, p);
        else actor.effects = actor.effects.filter(e => e.id !== effect.id);
      }
      validateDerivedAbilities(actor); break;
    }
    case 'actor.item.create': case 'actor.item.update': case 'actor.item.delete': case 'actor.item.consume': {
      const actor = target(campaign.actors, p); requireOwner(member, actor);
      if (command.type === 'actor.item.create') {
        checkLimit(actor.items, 200, "character items");
        const item: ActorItem = { id: uid(), name: "Item", type: 'custom', quantity: 1, weight: 0, weightUnit: 'unit', description: '', equipped: false };
        patchItem(item, p); actor.items.push(item);
      } else {
        const item = target(actor.items, { id: p.itemId });
        if (managedBinding(actor, 'item', item.id)) {
          if (command.type === 'actor.item.delete' || command.type === 'actor.item.update' && Object.keys(p).some(k => !['id', 'itemId', 'quantity', 'equipped', 'uses'].includes(k))) fail('PROGRESSION_MANAGED', "Change a granted item’s definition through its profile; quantity and charges remain editable.");
          if (p.uses !== undefined && (!item.uses || object(p.uses).max !== item.uses.max)) fail('PROGRESSION_MANAGED', "The profile sets a granted item’s maximum charges.");
        }
        if (command.type === 'actor.item.update') { const beforeUses = item.uses?.value; patchItem(item, p); if (p.uses !== undefined && item.uses?.value !== beforeUses) syncManagedItemUses(actor, item.id, 'set'); }
        else if (command.type === 'actor.item.delete') actor.items = actor.items.filter(i => i.id !== item.id);
        else {
          const from = choice(p.from, ['quantity', 'uses'], 'from'), amount = num(p.amount ?? 1, 'amount', 1, 100000, true);
          if (from === 'quantity') { if (item.quantity < amount) fail('INSUFFICIENT', "Not enough items."); item.quantity -= amount; }
          else { const uses = item.uses; if (!uses || uses.value < amount) return fail('INSUFFICIENT', "Not enough charges."); const before = uses.value; uses.value -= amount; syncManagedItemUses(actor, item.id, 'spend', before); }
        }
      }
      break;
    }
    case 'actor.resource.create': case 'actor.resource.update': case 'actor.resource.delete': {
      const actor = target(campaign.actors, p); requireOwner(member, actor);
      if (command.type === 'actor.resource.create') {
        checkLimit(actor.resources, 50, "character resources");
        const resource: ActorResource = normalizeActorResource({ id: uid(), label: "Resource", value: null, max: null });
        patchResource(resource, p, member, true); actor.resources.push(resource);
      } else {
        const resource = target(actor.resources, { id: p.resourceId });
        const binding = managedBinding(actor, 'resource', resource.id);
        if (binding && (command.type === 'actor.resource.delete' || Object.keys(p).some(k => !['id', 'resourceId', 'value'].includes(k)) || !binding.active)) fail('PROGRESSION_MANAGED', "The progression plan defines the resource and its availability.");
        if (binding && p.value !== undefined && p.value !== null) num(p.value, 'value', 0, resource.max ?? 0, true);
        if (command.type === 'actor.resource.update') { const edited = structuredClone(resource); patchResource(edited, p, member); actor.resources[actor.resources.indexOf(resource)] = edited; if (p.value !== undefined && edited.value !== resource.value) syncManagedResource(actor, resource.id, 'set'); }
        else { if (actor.actions.some(a => a.costs.some(c => c.resourceId === resource.id))) fail('RESOURCE_IN_USE', "An action uses this resource. Change its cost first."); actor.resources = actor.resources.filter(r => r.id !== resource.id); }
      }
      break;
    }
    case 'actor.roll': {
      const actor = target(campaign.actors, p); requireOwner(member, actor);
      const visibility = choice(p.visibility ?? 'public', ['public', 'gm', 'self'], 'visibility');
      const roll = rollActorCheck(actor, p), label = roll.ability ? abilityLabels[roll.ability] : 'd20';
      postChat(campaign, member, `${actor.name} · ${label}`, visibility, roll, { key: '{actor} · {label}', parameters: { actor: actor.name, label }, localizedParameters: roll.ability ? ['label'] : [] }); break;
    }
    case 'actor.place': {
      checkLimit(scene.tokens, 1000, "tokens");
      const actor = target(campaign.actors, p);
      const token = makeToken(actor, scene, num(p.x ?? 250, 'x', 0, scene.width), num(p.y ?? 250, 'y', 0, scene.height));
      if (p.linked !== undefined) token.linked = bool(p.linked, 'linked');
      if (p.levelId !== undefined) token.levelId = validLevel(scene, p.levelId);
      tokenWithin(scene, token); scene.tokens.push(token); break;
    }
    case 'token.create': {
      checkLimit(scene.tokens, 1000, "tokens");
      const token: Token = { id: uid(), name: str(p.name ?? "Token", 'name'), color: TOKEN_COLORS[0], levelId: scene.activeLevelId, x: 250, y: 250, width: 1, height: 1, rotation: 0, owners: [member.id], hidden: false, actorId: null, linked: false, hp: 10, maxHp: 10, vision: 500, conditions: [] };
      patchToken(token, p, scene, member, campaign); scene.tokens.push(token); break;
    }
    case 'token.update': patchToken(target(scene.tokens, p), p, scene, member, campaign); break;
    case 'token.move': {
      const token = target(scene.tokens, p); requireOwner(member, token);
      if (member.role !== 'gm' && token.hidden) fail('FORBIDDEN', "The token is hidden.");
      const to = { x: num(p.x, 'x', 0, scene.width), y: num(p.y, 'y', 0, scene.height) };
      tokenWithin(scene, { ...token, ...to });
      if (p.bypass !== undefined && typeof p.bypass !== 'boolean') fail('VALIDATION', "bypass must be a boolean.");
      if (p.bypass === true && member.role !== 'gm') fail('FORBIDDEN', "Only the GM can bypass walls.");
      if (p.bypass !== true && blocksMovement(scene, token, to)) fail('BLOCKED', "A wall or door blocks the path.");
      token.x = to.x; token.y = to.y; break;
    }
    case 'token.delete': {
      const token = target(scene.tokens, p); scene.tokens = scene.tokens.filter(t => t.id !== token.id);
      if (removeCombatEntries(campaign.combat, c => c.kind !== 'custom' && c.tokenId === token.id && c.sceneId === scene.id)) campaign.combat.version++;
      break;
    }
    case 'wall.create': {
      checkLimit(scene.walls, 5000, "walls");
      const wall: Wall = { id: uid(), a: point(p.a), b: point(p.b), levelId: scene.activeLevelId, kind: 'wall', state: 'closed', movement: true, sight: true, light: true, sound: true };
      patchWall(wall, p, scene); scene.walls.push(wall); break;
    }
    case 'wall.update': patchWall(target(scene.walls, p), p, scene); break;
    case 'wall.delete': { const wall = target(scene.walls, p); scene.walls = scene.walls.filter(w => w.id !== wall.id); break; }
    case 'door.toggle': {
      const door = target(scene.walls, p); if (door.kind === 'wall') fail('VALIDATION', "This object is not a door.");
      if (member.role !== 'gm') {
        if (door.kind === 'secret' || door.state === 'locked') fail('FORBIDDEN', "The door is unavailable.");
        if (!scene.tokens.some(t => !t.hidden && own(member, t) && inLevel(door, t.levelId) && distanceToSegment(t, door.a, door.b) <= scene.grid.size * 1.5)) fail('FORBIDDEN', "Move your token closer to the door.");
      }
      door.state = door.state === 'open' ? 'closed' : 'open'; break;
    }
    case 'light.create': {
      checkLimit(scene.lights, 500, "lights");
      const light: Light = { id: uid(), name: "Light", x: 250, y: 250, levelId: scene.activeLevelId, bright: 100, dim: 200, color: '#f2ce8b', enabled: true };
      patchLight(light, p, scene); scene.lights.push(light); break;
    }
    case 'light.update': patchLight(target(scene.lights, p), p, scene); break;
    case 'light.delete': { const light = target(scene.lights, p); scene.lights = scene.lights.filter(l => l.id !== light.id); break; }
    case 'chat.send': postChat(campaign, member, str(p.text, 'text', 4000), choice(p.visibility ?? 'public', ['public', 'gm', 'self'], 'visibility')); break;
    case 'chat.roll': { const roll = rollDice(p.formula); postChat(campaign, member, roll.formula, choice(p.visibility ?? 'public', ['public', 'gm', 'self'], 'visibility'), roll); break; }
    default: fail('UNKNOWN_COMMAND', "Unknown command.");
  }
}
function distanceToSegment(p: Point, a: Point, b: Point) {
  const d = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = d === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / d));
  return Math.hypot(p.x - a.x - t * (b.x - a.x), p.y - a.y - t * (b.y - a.y));
}
export function projectSnapshot(campaign: Campaign, self: Member, inviteCode: string): Snapshot {
  const copy = structuredClone(campaign);
  for (const entry of copy.combat.combatants) if (entry.kind !== 'custom') {
    const token = copy.scenes.find(s => s.id === entry.sceneId)?.tokens.find(t => t.id === entry.tokenId);
    if (token) entry.name = token.name;
  }
  copy.chat = copy.chat.filter(m => m.visibility === 'public' || m.authorId === self.id || (m.visibility === 'gm' && self.role === 'gm'));
  projectJournals(copy, self);
  if (self.role === 'gm') { copy.actors.forEach(a => { a.sheetAccess = 'full'; }); return { campaign: copy, self: structuredClone(self), inviteCode }; }
  for (const message of copy.chat) {
    const actor = campaign.actors.find(a => a.id === message.roll?.actor?.id);
    if (message.roll?.abilitySnapshot && message.authorId !== self.id && !actor?.owners.includes(self.id)) delete message.roll.abilitySnapshot;
    if (message.roll?.checkSnapshot && message.authorId !== self.id && !actor?.owners.includes(self.id)) delete message.roll.checkSnapshot;
  }
  const visibleIds = new Set<string>();
  copy.scenes = copy.scenes.filter(s => s.id === copy.activeSceneId).map(scene => {
    const full = campaign.scenes.find(s => s.id === scene.id)!;
    const observers = full.tokens.filter(t => !t.hidden && t.owners.includes(self.id));
    const lightSources = new Map<string, ReturnType<typeof prepareSceneLightSources>>();
    const vision = full.visionEnabled ? observers.map(observer => {
      if (!lightSources.has(observer.levelId)) lightSources.set(observer.levelId, prepareSceneLightSources(full, observer.levelId));
      return prepareTokenVision(full, observer, lightSources.get(observer.levelId)!);
    }) : [];
    scene.tokens = scene.tokens.filter(t => !t.hidden && (!full.visionEnabled || t.owners.includes(self.id) || vision.some(source => source.canSeeToken(t))));
    scene.tokens.forEach(t => { delete t.source; });
    delete scene.importWarnings; // Compatibility reports may contain native references; only GM receives them.
    scene.tokens.forEach(t => visibleIds.add(t.id));
    // A closed secret door must still occlude the player renderer, without exposing its door identity.
    scene.walls = scene.walls.flatMap(w => w.kind !== 'secret' ? [w] : w.state === 'open' ? [] : [{ ...w, kind: 'wall' as const, state: 'closed' as const }]);
    return scene;
  });
  const actorIds = new Set(copy.scenes.flatMap(s => s.tokens.flatMap(t => t.actorId ? [t.actorId] : [])));
  copy.actors = copy.actors.filter(a => a.owners.includes(self.id) || actorIds.has(a.id)).map(a => {
    delete a.source;
    if (a.owners.includes(self.id)) return { ...a, gmNotes: '', sheetAccess: 'full' as const };
    delete a.spellcasting;
    delete a.checks;
    delete a.progression;
    delete a.observedAdvancement;
    return { ...a, ...blankActorSheet(), gmNotes: '', notes: '', sheetAccess: 'summary' as const };
  });
  const receiptAllowed = (r: { actor: { id: string }; author: { id: string } }) => r.author.id === self.id || campaign.actors.some(a => a.id === r.actor.id && a.owners.includes(self.id));
  copy.actionResolutions = copy.actionResolutions.filter(receiptAllowed);
  const active = copy.scenes.find(s => s.id === copy.activeSceneId);
  const targetIds = new Set(active?.tokens.filter(t => t.levelId === active.activeLevelId).map(t => t.id) ?? []);
  for (const receipt of copy.actionResolutions) if (receipt.target.kind === 'token' && (receipt.target.sceneId !== active?.id || !targetIds.has(receipt.target.tokenId))) receipt.target = { kind: 'redacted' };
  copy.resourceRecoveries = copy.resourceRecoveries.filter(receiptAllowed);
  copy.progressionCommits = copy.progressionCommits.filter(receiptAllowed);
  const allowedCastIds = new Set(copy.actionResolutions.map(r => r.id));
  copy.outcomeRolls = copy.outcomeRolls.filter(r => allowedCastIds.has(r.resolutionId));
  const ownsHpPool = (pool: Campaign['hpApplications'][number]['hpPool']) => {
    if (pool.kind === 'actor') return campaign.actors.some(a => a.id === pool.id && a.owners.includes(self.id));
    if (pool.kind === 'token') return campaign.scenes.some(s => s.tokens.some(t => t.id === pool.id && t.owners.includes(self.id)));
    return false;
  };
  copy.hpApplications = copy.hpApplications.filter(r => receiptAllowed(r) || ownsHpPool(r.hpPool));
  for (const receipt of copy.hpApplications) {
    const targetVisible = receipt.target.kind === 'token' && receipt.target.sceneId === active?.id && targetIds.has(receipt.target.tokenId);
    const hpVisible = targetVisible && ownsHpPool(receipt.hpPool);
    if (!targetVisible) receipt.target = { kind: 'redacted' };
    if (!hpVisible) { receipt.hpPool = { kind: 'redacted' }; receipt.before = null; receipt.after = null; receipt.max = null; receipt.appliedAmount = null; }
  }
  const current = campaign.combat.combatants[campaign.combat.turn]?.id;
  copy.combat.combatants = copy.combat.combatants.filter(c => !c.hidden && (c.kind === 'custom' || visibleIds.has(c.tokenId)));
  copy.combat.turn = current ? copy.combat.combatants.findIndex(c => c.id === current) : -1;
  delete copy.combat.counterHistory;
  copy.combatReceipts = copy.combatReceipts.filter(r => r.authorId === self.id);
  return { campaign: copy, self: structuredClone(self) };
}
