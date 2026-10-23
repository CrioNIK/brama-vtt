import type { Actor, ActorAction, ActorSpell, ActionCostSnapshot, ActionResolution, ActionTargetSnapshot, Campaign, HpPoolReference, Member, OutcomePart, OutcomeRollReceipt, RecoveryEvent, ResourceRecoveryChange, Token } from './model.ts';
import { DAMAGE_TYPES } from './model.ts';
import { abilityBreakdown } from './abilities.ts';

export const ACTION_LIMITS = { actions: 200, costs: 20, receipts: 1000, amount: 100000, outcomeParts: 20, outcomeDice: 100 } as const;
export interface AvailabilityReason { code: string; message: string }
export interface OutcomeRollPreview { available: boolean; reasons: AvailabilityReason[]; diceCount: number; parts: { definition: OutcomePart; number: number }[] }
export interface HpApplicationPreview {
  available: boolean; reasons: AvailabilityReason[]; target?: ActionTargetSnapshot; hpPool?: HpPoolReference;
  before?: number; after?: number; max?: number; requestedAmount?: number; appliedAmount?: number;
}
export interface ActionPreviewContext {
  memberId: string; role: Member['role']; actionVersion?: number; targetTokenId?: string;
  /** Already visible tokens of the active scene AND active level. Never an authority supplied to the server. */
  visibleTokens: readonly Token[];
}
export interface ActionPreview {
  available: boolean; reasons: { code: string; message: string }[]; costs: ActionCostSnapshot[];
}
function boundSpell(actor: Actor, action: ActorAction): ActorSpell | undefined {
  if (action.spellId === undefined || actor.spellcasting?.profile !== 'foundry-dnd5e-6.0.6-base-cast-v1') return undefined;
  const matches = actor.spellcasting.spells.filter(spell => spell.id === action.spellId);
  const spell = matches.length === 1 ? matches[0] : undefined;
  return spell && spell.method === 'spell' && Number.isSafeInteger(spell.version) && spell.version >= 1
    && Number.isInteger(spell.level) && spell.level >= 0 && spell.level <= 9
    && ['unprepared', 'prepared', 'always'].includes(spell.preparation) ? spell : undefined;
}
/** Bound activities use one spell group's preparation; their legacy booleans are not authoritative. */
export function actionPreparation(actor: Actor, action: ActorAction): { known: boolean; prepared: boolean; requiresPreparation: boolean } {
  if (action.spellId === undefined) return { known: action.known, prepared: action.prepared, requiresPreparation: action.requiresPreparation };
  const spell = boundSpell(actor, action);
  return { known: !!spell, prepared: !!spell && (spell.preparation === 'prepared' || spell.preparation === 'always'),
    requiresPreparation: !!spell && spell.level > 0 && spell.preparation !== 'always' };
}
function spellActivityReasons(actor: Actor, action: ActorAction): AvailabilityReason[] {
  const reasons: AvailabilityReason[] = [];
  const deny = (message: string) => reasons.push({ code: 'SPELL_UNSUPPORTED', message });
  const spell = boundSpell(actor, action);
  if (!spell) return [{ code: 'SPELL_UNAVAILABLE', message: "The spell group is missing or unsupported." }];
  const casting = action.casting, inheritance = action.inheritance;
  if (!casting || casting.activation?.type !== 'action' || casting.duration?.type !== 'instantaneous'
    || !casting.range || !['distance', 'self'].includes(casting.range.type)
    || casting.range.type === 'distance' && (casting.range.unit !== 'ft' || !Number.isFinite(casting.range.value) || casting.range.value <= 0 || casting.range.value > 100000)
    || casting.target?.type !== 'creature' || casting.target.count !== 1 || typeof casting.target.prompt !== 'boolean'
    || !inheritance || (['activation', 'range', 'target', 'duration'] as const).some(key => !['item-merge', 'activity'].includes(inheritance[key]))) {
    deny("The Activity context exceeds the supported base-casting profile.");
  }
  if (spell.level === 0) {
    if (action.costs.length) deny("Cantrips in this profile do not consume a spell slot.");
  } else {
    const cost = action.costs.length === 1 ? action.costs[0] : undefined;
    const slot = cost && actor.resources.find(resource => resource.id === cost.resourceId);
    if (!cost || cost.amount !== 1 || slot?.kind !== 'spell-slot' || slot.level !== spell.level
      || slot.max === null || !Number.isInteger(slot.max) || slot.max < 0 || slot.max > 100000
      || slot.value !== null && (!Number.isInteger(slot.value) || slot.value < 0 || slot.value > slot.max)) {
      deny("Base casting requires one slot of the exact spell level with a known maximum.");
    }
  }
  return reasons;
}
/** Informational only. Server reconstructs visibility and checks every command independently. */
export function previewAction(actor: Actor, action: ActorAction, context: ActionPreviewContext): ActionPreview {
  const reasons: ActionPreview['reasons'] = [], costs: ActionCostSnapshot[] = [];
  const add = (code: string, message: string) => { reasons.push({ code, message }); };
  if (context.role !== 'gm' && !actor.owners.includes(context.memberId)) add('FORBIDDEN', "You cannot control this character.");
  if (context.actionVersion !== undefined && context.actionVersion !== action.version) add('ACTION_STALE', "The action changed; review the new version.");
  const preparation = actionPreparation(actor, action);
  if (action.spellId !== undefined) reasons.push(...spellActivityReasons(actor, action));
  else if (action.casting !== undefined || action.inheritance !== undefined) add('SPELL_UNAVAILABLE', "The Activity context is not linked to a spell group.");
  if (!preparation.known && action.spellId === undefined) add('UNAVAILABLE', "This action has not been learned.");
  if (!action.enabled) add('UNAVAILABLE', "This action is disabled.");
  if (preparation.requiresPreparation && !preparation.prepared) add('UNPREPARED', "Prepare the spell or action first.");
  if (action.target === 'token') {
    if (!context.targetTokenId || !context.visibleTokens.some(t => t.id === context.targetTokenId)) add('TARGET_UNAVAILABLE', "Select an available target on the current scene level.");
  } else if (context.targetTokenId !== undefined) add('VALIDATION', "This action does not accept a target token.");
  const seen = new Set<string>();
  if (action.costs.length > ACTION_LIMITS.costs) add('VALIDATION', "Too many resource costs.");
  for (const cost of action.costs) {
    if (seen.has(cost.resourceId)) { add('VALIDATION', "A resource appears more than once in the cost."); continue; }
    seen.add(cost.resourceId);
    if (!Number.isFinite(cost.amount) || cost.amount <= 0 || cost.amount > ACTION_LIMITS.amount) { add('VALIDATION', "Invalid cost."); continue; }
    const resource = actor.resources.find(r => r.id === cost.resourceId);
    if (!resource) { add('RESOURCE_MISSING', "The required resource was not found."); continue; }
    const managed = actor.progression?.bindings.find(b => b.kind === 'resource' && b.entityId === resource.id);
    if (managed && (!managed.active || !Number.isInteger(cost.amount) || resource.max === null || !Number.isInteger(resource.max) || resource.value !== null && (!Number.isInteger(resource.value) || resource.value < 0 || resource.value > resource.max))) {
      add('PROGRESSION_RESOURCE_INVALID', "A granted resource requires an active grant, integer balance and integer cost."); continue;
    }
    if (resource.value === null || !Number.isFinite(resource.value)) { add('RESOURCE_UNKNOWN', `The remaining amount of “${resource.label}” is unknown.`); continue; }
    if (resource.value < cost.amount) { add('INSUFFICIENT', `Not enough “${resource.label}”.`); continue; }
    if (!(resource.value - cost.amount < resource.value) || resource.value - cost.amount < 0) { add('PRECISION', "The cost is too small to change the current balance precisely."); continue; }
    costs.push({ resourceId: resource.id, label: resource.label, amount: cost.amount, before: resource.value, after: resource.value - cost.amount, max: resource.max });
  }
  if (action.outcome.kind === 'roll' && action.outcome.ability !== null) {
    if (actor.sheetKind !== 'dnd5e' || abilityBreakdown(actor, action.outcome.ability).effective === null) add('ABILITY_UNKNOWN', "The roll requires a known ability on a D&D character sheet.");
  }
  if (action.outcome.kind === 'damage' || action.outcome.kind === 'healing') reasons.push(...previewOutcomeRoll({ action }, false).reasons);
  return { available: reasons.length === 0, reasons, costs };
}
export function previewRecovery(actor: Actor, event: RecoveryEvent): { available: boolean; changes: ResourceRecoveryChange[] } {
  const changes = actor.resources.map((r): ResourceRecoveryChange => {
    const policy = r.recovery ?? 'manual';
    const matches = policy === event || event === 'long-rest' && policy === 'short-rest';
    const known = r.value !== null && r.max !== null && Number.isFinite(r.value) && Number.isFinite(r.max) && r.value >= 0 && r.max >= r.value;
    const applied = matches && known && r.value !== r.max;
    return { resourceId: r.id, label: r.label, before: r.value, after: applied ? r.max : r.value, max: r.max, policy, applied,
      reason: !matches ? 'policy-mismatch' : !known ? 'unknown' : applied ? 'recovered' : 'already-full' };
  });
  return { available: changes.some(c => c.applied), changes };
}

/** Inspect the committed cast snapshot, never the current editable action. This function does not roll dice. */
export function previewOutcomeRoll(resolution: Pick<ActionResolution, 'action'>, critical: boolean): OutcomeRollPreview {
  const result: OutcomeRollPreview = { available: false, reasons: [], diceCount: 0, parts: [] };
  const deny = (code: string, message: string) => { result.reasons.push({ code, message }); return result; };
  const outcome = resolution.action.outcome;
  if (outcome.kind !== 'damage' && outcome.kind !== 'healing') return deny('OUTCOME_UNAVAILABLE', "This outcome has no separate damage or healing roll.");
  if (typeof critical !== 'boolean' || typeof outcome.allowCritical !== 'boolean') return deny('VALIDATION', "Invalid critical-roll mode.");
  if (outcome.kind === 'healing' && outcome.allowCritical) return deny('VALIDATION', "Critical healing is unsupported.");
  if (critical && !outcome.allowCritical) return deny('CRITICAL_UNAVAILABLE', "Critical rolls are disabled for this action.");
  if (!Array.isArray(outcome.parts) || !outcome.parts.length || outcome.parts.length > ACTION_LIMITS.outcomeParts) return deny('VALIDATION', "Between 1 and 20 outcome parts are required.");
  for (const part of outcome.parts) {
    if (!Number.isInteger(part.number) || part.number < 1 || part.number > 100 || !Number.isInteger(part.denomination) || part.denomination < 2 || part.denomination > 1000 || !Number.isInteger(part.bonus) || Math.abs(part.bonus) > 100000
      || (outcome.kind === 'healing' ? part.type !== 'healing' : !(DAMAGE_TYPES as readonly string[]).includes(part.type))) return deny('VALIDATION', "Invalid typed outcome part.");
    const number = part.number * (critical ? 2 : 1);
    result.diceCount += number;
    result.parts.push({ definition: { ...part }, number });
  }
  if (result.diceCount > ACTION_LIMITS.outcomeDice) return deny('LIMIT', "A roll may contain at most 100 dice, including critical dice.");
  result.available = true; return result;
}

/**
 * Client passes its projected campaign. Server passes the authoritative campaign plus a separately
 * projected visibleTokens list; the optional list is never taken from a network payload.
 */
export function previewHpApplication(campaign: Campaign, member: Member, outcome: OutcomeRollReceipt, targetTokenId: string, multiplier: number, visibleTokens?: readonly Token[]): HpApplicationPreview {
  const result: HpApplicationPreview = { available: false, reasons: [] };
  const deny = (code: string, message: string) => { result.reasons.push({ code, message }); return result; };
  const caster = campaign.actors.find(a => a.id === outcome.actor.id);
  if (!caster || member.role !== 'gm' && !caster.owners.includes(member.id)) return deny('FORBIDDEN', "You cannot control the character who performed this action.");
  const cast = campaign.actionResolutions.find(r => r.id === outcome.resolutionId && r.actor.id === caster.id);
  if (!cast || cast.action.outcome.kind !== outcome.kind || !['damage', 'healing'].includes(outcome.kind)) return deny('OUTCOME_UNAVAILABLE', "The original action outcome is unavailable.");
  if (![0, 0.5, 1, 2].includes(multiplier) || outcome.kind === 'healing' && multiplier !== 1) return deny('VALIDATION', "Invalid outcome multiplier.");
  const scene = campaign.scenes.find(s => s.id === campaign.activeSceneId);
  const candidate = (visibleTokens ?? scene?.tokens ?? []).find(t => t.id === targetTokenId && t.levelId === scene?.activeLevelId);
  const token = candidate && scene?.tokens.find(t => t.id === candidate.id);
  const unavailable = () => deny('TARGET_UNAVAILABLE', "The target is unavailable on the current scene level.");
  if (!scene || !token) return unavailable();
  if (cast.target.kind === 'redacted' || cast.target.kind === 'token' && (cast.target.sceneId !== scene.id || cast.target.tokenId !== token.id)
      || cast.target.kind === 'self' && (!token.linked || token.actorId !== caster.id)) return unavailable();
  const linked = token.linked ? campaign.actors.find(a => a.id === token.actorId) : undefined;
  if (token.linked && !linked) return unavailable(); // Broken linkage is never silently changed to token-local HP.
  const pool = linked ?? token;
  if (member.role !== 'gm' && !pool.owners.includes(member.id)) return deny('FORBIDDEN', "You cannot change this target’s HP.");
  const hpPool: HpPoolReference = { kind: linked ? 'actor' : 'token', id: pool.id };
  if (campaign.hpApplications.some(r => r.outcomeId === outcome.id && r.hpPool.kind !== 'redacted' && r.hpPool.kind === hpPool.kind && r.hpPool.id === hpPool.id)) return deny('ALREADY_APPLIED', "This roll has already been applied to this HP pool.");
  if (pool.hp === null || pool.maxHp === null || !Number.isInteger(pool.hp) || !Number.isInteger(pool.maxHp) || pool.hp < 0 || pool.maxHp < pool.hp || pool.maxHp > 100000) return deny('HP_UNKNOWN', "Applying an outcome requires valid known current and maximum HP.");
  if (!Number.isSafeInteger(outcome.total) || outcome.total < 0 || outcome.total > 2100000) return deny('VALIDATION', "Invalid stored roll total.");
  const requestedAmount = Math.floor(outcome.total * multiplier);
  const after = outcome.kind === 'damage' ? Math.max(0, pool.hp - requestedAmount) : Math.min(pool.maxHp, pool.hp + requestedAmount);
  Object.assign(result, { target: { kind: 'token', sceneId: scene.id, tokenId: token.id, name: token.name }, hpPool, before: pool.hp, after, max: pool.maxHp, requestedAmount, appliedAmount: Math.abs(after - pool.hp) });
  if (after === pool.hp) return deny('NO_CHANGE', "Applying this outcome would not change HP.");
  result.available = true; return result;
}
