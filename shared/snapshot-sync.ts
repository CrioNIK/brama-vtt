import type { Snapshot } from './model.ts';

export const SNAPSHOT_SYNC_PROTOCOL = 'snapshot-delta-v1' as const;
export const SNAPSHOT_BASELINE_MAX_BYTES = 4 * 1024 * 1024;
export const SNAPSHOT_MAX_OPERATIONS = 4096;
const MAX_DEPTH = 48;
const MAX_NODES = 500_000;
type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type SnapshotPath = (string | number)[];
export type SnapshotOperation = { op: 'set'; path: SnapshotPath; value: JsonValue } | { op: 'delete'; path: SnapshotPath };
export interface SnapshotDelta { campaignId: string; baseRevision: number; revision: number; operations: SnapshotOperation[] }

const INVALID = Symbol('invalid snapshot patch');
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const own = (object: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(object, key);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function dataFields(value: Record<string, unknown>, keys: string[]): boolean {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.keys(descriptors).length === keys.length && keys.every(key => {
    const descriptor = descriptors[key]; return descriptor?.enumerable === true && own(descriptor, 'value');
  });
}
interface Budget { nodes: number; characters: number }
function spend(budget: Budget, characters = 0): boolean { return ++budget.nodes <= MAX_NODES && (budget.characters += characters) <= SNAPSHOT_BASELINE_MAX_BYTES; }

/** Clone only valid JSON data, never executing accessors or accepting prototype keys. */
function cloneValue(value: unknown, budget: Budget, depth = 0): JsonValue | typeof INVALID {
  if (depth > MAX_DEPTH || !spend(budget, typeof value === 'string' ? value.length : 0)) return INVALID;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID;
  if (!Array.isArray(value) && !record(value)) return INVALID;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    if (value.length > MAX_NODES || Object.keys(descriptors).length !== value.length + 1) return INVALID;
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptors[index];
      if (!descriptor || !own(descriptor, 'value')) return INVALID;
      const next = cloneValue(descriptor.value, budget, depth + 1); if (next === INVALID) return INVALID;
      result.push(next);
    }
    return result;
  }
  const result: Record<string, JsonValue> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (forbidden.has(key) || !descriptor.enumerable || !own(descriptor, 'value') || !spend(budget, key.length)) return INVALID;
    const next = cloneValue(descriptor.value, budget, depth + 1); if (next === INVALID) return INVALID;
    result[key] = next;
  }
  return result;
}

function sameAudience(previous: Snapshot, next: Snapshot): boolean {
  return previous.campaign.id === next.campaign.id && previous.self.id === next.self.id && previous.self.role === next.self.role
    && previous.self.name === next.self.name && previous.self.color === next.self.color;
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const textFields = (value: Record<string, unknown>, keys: string[]) => keys.every(key => own(value, key) && typeof value[key] === 'string');
const numberFields = (value: Record<string, unknown>, keys: string[]) => keys.every(key => own(value, key) && typeof value[key] === 'number' && Number.isFinite(value[key]));
const nullableNumber = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value));
const point = (value: unknown) => record(value) && numberFields(value, ['x', 'y']);
const member = (value: unknown) => record(value) && textFields(value, ['id', 'name', 'color']) && (value.role === 'gm' || value.role === 'player');
function records(value: unknown, before?: unknown, check: (value: Record<string, unknown>, before?: unknown) => boolean = () => true): boolean {
  if (!Array.isArray(value)) return false;
  if (value === before) return true;
  return value.every((item, index) => record(item) && (Array.isArray(before) && item === before[index] || check(item, Array.isArray(before) ? before[index] : undefined)));
}
function sceneStructure(scene: Record<string, unknown>, before?: unknown): boolean {
  const old = record(before) ? before : {};
  if (!textFields(scene, ['id', 'name', 'activeLevelId', 'background']) || !numberFields(scene, ['width', 'height']) || typeof scene.visionEnabled !== 'boolean') return false;
  const grid = scene.grid;
  if (!record(grid) || !numberFields(grid, ['size', 'distance']) || (grid.size as number) <= 0 || typeof grid.units !== 'string' || !['square', 'none'].includes(grid.type as string)) return false;
  return records(scene.levels, old.levels, level => textFields(level, ['id', 'name']) && numberFields(level, ['bottom', 'top']))
    && records(scene.tokens, old.tokens, token => textFields(token, ['id', 'name', 'color', 'levelId'])
      && numberFields(token, ['x', 'y', 'width', 'height', 'rotation', 'vision']) && strings(token.owners) && strings(token.conditions)
      && typeof token.hidden === 'boolean' && typeof token.linked === 'boolean' && (token.actorId === null || typeof token.actorId === 'string')
      && nullableNumber(token.hp) && nullableNumber(token.maxHp))
    && records(scene.walls, old.walls, wall => textFields(wall, ['id', 'levelId']) && point(wall.a) && point(wall.b)
      && ['wall', 'door', 'secret'].includes(wall.kind as string) && ['closed', 'open', 'locked'].includes(wall.state as string)
      && ['movement', 'sight', 'light', 'sound'].every(key => typeof wall[key] === 'boolean') && (wall.levelIds === undefined || strings(wall.levelIds)))
    && records(scene.lights, old.lights, light => textFields(light, ['id', 'name', 'levelId', 'color'])
      && numberFields(light, ['x', 'y', 'bright', 'dim']) && typeof light.enabled === 'boolean' && (light.levelIds === undefined || strings(light.levelIds)));
}

/** Required transport/container structure, not a replacement for the server's domain validation.
 * A previously validated baseline lets unchanged branches retain their validation result. */
export function hasSnapshotStructure(input: unknown, previous?: Snapshot): input is Snapshot {
  if (!record(input) || !record(input.campaign) || !member(input.self) || (input.inviteCode !== undefined && typeof input.inviteCode !== 'string')) return false;
  const campaign = input.campaign, before = previous?.campaign;
  if (!textFields(campaign, ['id', 'name', 'activeSceneId', 'createdAt']) || !revision(campaign.revision)) return false;
  const collections = ['chat', 'journals', 'actionResolutions', 'resourceRecoveries', 'outcomeRolls', 'hpApplications', 'progressionProfiles', 'progressionCommits', 'combatReceipts', 'journalFolders', 'journalPresentations', 'journalReceipts'] as const;
  if (!collections.every(key => records(campaign[key], before?.[key]))) return false;
  if (!records(campaign.members, before?.members, member) || !records(campaign.scenes, before?.scenes, sceneStructure)) return false;
  if (!records(campaign.actors, before?.actors, (actor, prior) => {
    const old = record(prior) ? prior : {};
    return textFields(actor, ['id', 'name', 'color', 'notes', 'gmNotes']) && strings(actor.owners) && nullableNumber(actor.hp) && nullableNumber(actor.maxHp)
      && ['generic', 'dnd5e'].includes(actor.sheetKind as string) && record(actor.abilities)
      && ['str', 'dex', 'con', 'int', 'wis', 'cha'].every(key => nullableNumber((actor.abilities as Record<string, unknown>)[key]))
      && ['items', 'resources', 'effects', 'actions'].every(key => records(actor[key], old[key]));
  })) return false;
  const combat = campaign.combat;
  return record(combat) && typeof combat.active === 'boolean' && numberFields(combat, ['round', 'turn', 'version'])
    && records(combat.combatants, before?.combat.combatants) && record(combat.settings)
    && typeof combat.settings.skipDefeated === 'boolean' && typeof combat.settings.allowPlayerEndTurn === 'boolean';
}

/** Inputs must be the JSON wire representations of independently projected snapshots. */
export function createSnapshotDelta(previous: Snapshot, next: Snapshot): SnapshotDelta | null {
  if (!sameAudience(previous, next) || !revision(previous.campaign.revision) || !revision(next.campaign.revision) || next.campaign.revision <= previous.campaign.revision) return null;
  const operations: SnapshotOperation[] = [], budget: Budget = { nodes: 0, characters: 0 };
  function replace(path: SnapshotPath, value: unknown): boolean {
    if (!safePath(path)) return false;
    const copy = cloneValue(value, budget); if (copy === INVALID) return false;
    operations.push({ op: 'set', path, value: copy }); return operations.length <= SNAPSHOT_MAX_OPERATIONS;
  }
  function visit(before: unknown, after: unknown, path: SnapshotPath): boolean {
    if (path.length > MAX_DEPTH || !spend(budget)) return false;
    if (before === after) return true;
    if (Array.isArray(before) && Array.isArray(after)) {
      if (before.length !== after.length) return replace(path, after);
      return after.every((item, index) => visit(before[index], item, [...path, index]));
    }
    if (record(before) && record(after)) {
      const beforeKeys = Object.keys(before), afterKeys = Object.keys(after);
      if (beforeKeys.some(key => forbidden.has(key)) || afterKeys.some(key => forbidden.has(key))) return false;
      for (const key of beforeKeys) if (!own(after, key)) {
        const target = [...path, key]; if (!safePath(target)) return false;
        operations.push({ op: 'delete', path: target });
        if (operations.length > SNAPSHOT_MAX_OPERATIONS) return false;
      }
      for (const key of afterKeys) {
        if (!own(before, key)) { if (!replace([...path, key], after[key])) return false; }
        else if (!visit(before[key], after[key], [...path, key])) return false;
      }
      return true;
    }
    return replace(path, after);
  }
  if (!visit(previous, next, []) || !operations.length) return null;
  return { campaignId: next.campaign.id, baseRevision: previous.campaign.revision, revision: next.campaign.revision, operations };
}

function safePath(value: unknown): value is SnapshotPath {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_DEPTH && value.every(part =>
    typeof part === 'string' ? part.length > 0 && part.length <= 256 && !forbidden.has(part) : Number.isSafeInteger(part) && part >= 0);
}

/** Copy ancestors on the modified path. A failure never mutates the previous snapshot. */
function updateAt(current: unknown, path: SnapshotPath, operation: SnapshotOperation, value: JsonValue | undefined, offset = 0): unknown | typeof INVALID {
  const key = path[offset], last = offset === path.length - 1;
  if (Array.isArray(current)) {
    if (typeof key !== 'number' || key >= current.length || !own(current, key) || (last && operation.op === 'delete')) return INVALID;
    const next = last ? value : updateAt(current[key], path, operation, value, offset + 1); if (next === INVALID) return INVALID;
    const result = current.slice(); result[key] = next; return result;
  }
  if (!record(current) || typeof key !== 'string') return INVALID;
  const descriptor = Object.getOwnPropertyDescriptor(current, key);
  if (descriptor && !own(descriptor, 'value')) return INVALID;
  if (!last && !descriptor) return INVALID;
  if (last && operation.op === 'delete' && !descriptor) return INVALID;
  const next = last ? value : updateAt(descriptor!.value, path, operation, value, offset + 1); if (next === INVALID) return INVALID;
  const result = { ...current };
  if (last && operation.op === 'delete') delete result[key]; else result[key] = next;
  return result;
}

/** Invalid, stale, missed or malformed deltas request a full resynchronization. */
export function applySnapshotDelta(previous: Snapshot, input: unknown): Snapshot | null {
  try {
    if (!record(input) || !dataFields(input, ['campaignId', 'baseRevision', 'revision', 'operations'])) return null;
    if (input.campaignId !== previous.campaign.id || input.baseRevision !== previous.campaign.revision || !revision(input.baseRevision) || !revision(input.revision) || input.revision <= input.baseRevision) return null;
    if (!Array.isArray(input.operations) || input.operations.length === 0 || input.operations.length > SNAPSHOT_MAX_OPERATIONS) return null;
    const budget: Budget = { nodes: 0, characters: 0 };
    let candidate: unknown = previous;
    for (const raw of input.operations) {
      if (!record(raw)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(raw, 'op');
      if (!descriptor || !own(descriptor, 'value') || (descriptor.value !== 'set' && descriptor.value !== 'delete')) return null;
      const kind = descriptor.value;
      const expectedKeys = kind === 'set' ? ['op', 'path', 'value'] : ['op', 'path'];
      if (!dataFields(raw, expectedKeys) || !safePath(raw.path)) return null;
      const value = raw.op === 'set' ? cloneValue(raw.value, budget) : undefined; if (value === INVALID) return null;
      candidate = updateAt(candidate, raw.path, raw as SnapshotOperation, value); if (candidate === INVALID) return null;
    }
    if (!hasSnapshotStructure(candidate, previous)) return null;
    const next = candidate;
    return sameAudience(previous, next) && next.campaign.revision === input.revision ? next : null;
  } catch { return null; }
}
