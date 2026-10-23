import type { Actor, ActorAction, ActionOutcome, ActionResolution, Campaign, Command, HpApplicationReceipt, Member, OutcomeRollReceipt, RecoveryEvent, ResourceRecoveryReceipt, RollResult, TypedActionOutcome } from '../shared/model.ts';
import { ABILITY_KEYS, DAMAGE_TYPES } from '../shared/model.ts';
import { ACTION_LIMITS, previewAction, previewHpApplication, previewOutcomeRoll, previewRecovery } from '../shared/actions.ts';
import { fail, object, projectSnapshot, rollActorCheck, str } from './engine.ts';
import { randomInt, randomUUID } from 'node:crypto';
import { managedBinding, syncManagedResource } from '../shared/progression.ts';

const definitions = ['name', 'description', 'sourceLabel', 'category', 'known', 'prepared', 'requiresPreparation', 'enabled', 'target', 'costs', 'outcome'];
const actionCommands = new Set(['actor.action.create', 'actor.action.update', 'actor.action.delete', 'actor.action.prepare', 'actor.action.execute', 'actor.action.rollOutcome', 'actor.action.applyOutcome', 'actor.resource.recover', 'actor.spell.prepare']);
function number(value: unknown, name: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) return fail('VALIDATION', `Invalid number ${name}.`);
  return value;
}
function boolean(value: unknown, name: string): boolean { return typeof value === 'boolean' ? value : fail('VALIDATION', `Invalid field ${name}.`); }
function choice<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : fail('VALIDATION', `Invalid field ${name}.`);
}
function keys(p: Record<string, unknown>, allowed: string[]) { if (Object.keys(p).some(k => !allowed.includes(k))) fail('VALIDATION', "Unknown action-command field."); }
function patchDefinition(action: ActorAction, p: Record<string, unknown>, actor: Actor) {
  for (const key of ['name', 'description', 'sourceLabel', 'category'] as const) if (p[key] !== undefined) action[key] = str(p[key], key, key === 'description' ? 20000 : key === 'category' ? 60 : 120, key === 'description' || key === 'sourceLabel');
  for (const key of ['known', 'prepared', 'requiresPreparation', 'enabled'] as const) if (p[key] !== undefined) action[key] = boolean(p[key], key);
  if (p.target !== undefined) action.target = choice(p.target, ['none', 'self', 'token'], 'target');
  if (p.costs !== undefined) {
    if (!Array.isArray(p.costs) || p.costs.length > ACTION_LIMITS.costs) fail('VALIDATION', "At most 20 resources are allowed in a cost.");
    action.costs = (p.costs as unknown[]).map(value => {
      const cost = object(value); keys(cost, ['resourceId', 'amount']);
      const amount = number(cost.amount, 'amount', Number.MIN_VALUE, ACTION_LIMITS.amount);
      return { resourceId: str(cost.resourceId, 'resourceId'), amount };
    });
  }
  if (new Set(action.costs.map(c => c.resourceId)).size !== action.costs.length) fail('VALIDATION', "A resource cannot appear twice in a cost.");
  if (action.costs.some(c => !actor.resources.some(r => r.id === c.resourceId))) fail('VALIDATION', "The required resource was not found.");
  if (p.outcome !== undefined) {
    const outcome = object(p.outcome), kind = choice(outcome.kind, ['manual', 'roll', 'damage', 'healing'], 'outcome.kind');
    if (kind === 'manual') { keys(outcome, ['kind', 'text']); action.outcome = { kind, text: str(outcome.text, 'outcome.text', 20000, true) }; }
    else if (kind === 'roll') {
      keys(outcome, ['kind', 'ability', 'modifier', 'mode']);
      const ability = outcome.ability === null ? null : choice(outcome.ability, ABILITY_KEYS, 'ability');
      const modifier = number(outcome.modifier, 'modifier', -1000, 1000, true);
      if (ability !== null && modifier !== 0) fail('VALIDATION', "The manual modifier must be 0 when using an ability.");
      action.outcome = { kind, ability, modifier, mode: choice(outcome.mode, ['normal', 'advantage', 'disadvantage'], 'mode') };
    } else {
      keys(outcome, ['kind', 'parts', 'allowCritical']);
      if (!Array.isArray(outcome.parts) || !outcome.parts.length || outcome.parts.length > ACTION_LIMITS.outcomeParts) fail('VALIDATION', "Between 1 and 20 outcome parts are required.");
      const typed: TypedActionOutcome = { kind, allowCritical: boolean(outcome.allowCritical, 'allowCritical'), parts: (outcome.parts as unknown[]).map(value => {
        const part = object(value); keys(part, ['number', 'denomination', 'bonus', 'type']);
        return { number: number(part.number, 'number', 1, 100, true), denomination: number(part.denomination, 'denomination', 2, 1000, true), bonus: number(part.bonus, 'bonus', -100000, 100000, true), type: choice(part.type, kind === 'healing' ? ['healing'] : DAMAGE_TYPES, 'type') };
      }) };
      const preview = previewOutcomeRoll({ action: { ...action, outcome: typed } }, false);
      if (!preview.available) fail(preview.reasons[0].code, preview.reasons[0].message);
      action.outcome = typed;
    }
  }
}
function assertReceiptCapacity(campaign: Campaign, command: Command, list: unknown[]) {
  if (list.length >= ACTION_LIMITS.receipts) fail('LIMIT', "The outcome log is full; old records are preserved.");
  if ([...campaign.actionResolutions, ...campaign.resourceRecoveries, ...campaign.outcomeRolls, ...campaign.hpApplications, ...campaign.progressionCommits, ...campaign.combatReceipts, ...campaign.journalReceipts].some(r => r.commandId === command.id)) fail('ID_REUSED', "This outcome ID has already been used.");
}
/** Test dependency is not accepted from a network command. Production uses the existing server d20 roller. */
export interface ActionDependencies { roll?: (actor: Actor, payload: Record<string, unknown>) => RollResult; drawDie?: (sides: number) => number; now?: () => string }
export function applyActionCommand(campaign: Campaign, member: Member, command: Command, deps: ActionDependencies = {}): boolean {
  if (!actionCommands.has(command.type)) return false;
  if (command.expectedRevision === undefined) fail('REVISION_REQUIRED', "An action requires the current expectedRevision.");
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision! < 0) fail('VALIDATION', "Invalid expectedRevision.");
  if (command.expectedRevision !== campaign.revision) fail('CONFLICT', "The campaign changed; review the action again.");
  const p = object(command.payload), actor = campaign.actors.find(a => a.id === str(p.id, 'id')) ?? fail('NOT_FOUND', "Character not found.");
  const gm = member.role === 'gm';
  if (!gm && !actor.owners.includes(member.id)) fail('FORBIDDEN', "You cannot control this character.");
  if (!gm && !['actor.action.prepare', 'actor.action.execute', 'actor.action.rollOutcome', 'actor.action.applyOutcome', 'actor.spell.prepare'].includes(command.type)) fail('FORBIDDEN', "This action is available to the GM.");
  const timestamp = () => (deps.now ?? (() => new Date().toISOString()))();
  if (command.type === 'actor.spell.prepare') {
    keys(p, ['id', 'spellId', 'spellVersion', 'prepared']);
    const spellId = str(p.spellId, 'spellId'), spellVersion = number(p.spellVersion, 'spellVersion', 1, Number.MAX_SAFE_INTEGER, true);
    const prepared = boolean(p.prepared, 'prepared');
    const spellcasting = actor.spellcasting;
    if (spellcasting?.profile !== 'foundry-dnd5e-6.0.6-base-cast-v1') return fail('SPELL_UNAVAILABLE', "The spell group is unavailable.");
    const matches = spellcasting.spells.filter(spell => spell.id === spellId);
    const spell = matches.length === 1 ? matches[0] : undefined;
    if (!spell || spell.method !== 'spell' || !Number.isInteger(spell.level) || spell.level < 0 || spell.level > 9
      || !['unprepared', 'prepared', 'always'].includes(spell.preparation)) return fail('SPELL_UNAVAILABLE', "The spell group is unavailable.");
    if (spell.version !== spellVersion) fail('SPELL_STALE', "The spell changed; review preparation again.");
    if (spell.preparation === 'always' && !prepared) fail('ALWAYS_PREPARED', "This spell is always prepared.");
    if (spell.preparation === 'always' || (spell.preparation === 'prepared') === prepared) fail('NO_CHANGE', "Preparation has not changed.");
    if (!Number.isSafeInteger(spell.version) || spell.version >= Number.MAX_SAFE_INTEGER) fail('LIMIT', "The spell-version limit has been reached.");
    const edited = { ...spell, preparation: prepared ? 'prepared' as const : 'unprepared' as const, version: spell.version + 1 };
    spellcasting.spells[spellcasting.spells.indexOf(spell)] = edited;
    return true;
  }
  if (command.type === 'actor.action.rollOutcome') {
    keys(p, ['id', 'resolutionId', 'critical']);
    const resolutionId = str(p.resolutionId, 'resolutionId');
    const resolution = campaign.actionResolutions.find(r => r.id === resolutionId && r.actor.id === actor.id) ?? fail('OUTCOME_UNAVAILABLE', "The original action outcome is unavailable.");
    const critical = boolean(p.critical, 'critical');
    assertReceiptCapacity(campaign, command, campaign.outcomeRolls);
    const preview = previewOutcomeRoll(resolution, critical);
    if (!preview.available) fail(preview.reasons[0].code, preview.reasons[0].message);
    const kind = resolution.action.outcome.kind;
    if (kind !== 'damage' && kind !== 'healing') return fail('OUTCOME_UNAVAILABLE', "A separate roll is unavailable.");
    // Every part and the aggregate critical dice limit have passed preflight before the first draw.
    const parts = preview.parts.map(({ definition, number: quantity }) => {
      const values = Array.from({ length: quantity }, () => number((deps.drawDie ?? (sides => randomInt(1, sides + 1)))(definition.denomination), 'die result', 1, definition.denomination, true));
      const total = values.reduce((sum, value) => sum + value, definition.bonus);
      const roll: RollResult = { formula: `${quantity}d${definition.denomination}${definition.bonus ? `${definition.bonus > 0 ? '+' : ''}${definition.bonus}` : ''}`, dice: [{ sides: definition.denomination, values }], modifier: definition.bonus, total };
      return { definition: { ...definition }, roll, amount: Math.max(0, total) };
    });
    const receipt: OutcomeRollReceipt = { id: command.id, commandId: command.id, resolutionId: resolution.id, actor: { ...resolution.actor }, author: { id: member.id, name: member.name }, createdAt: timestamp(), kind, critical, parts, total: parts.reduce((sum, part) => sum + part.amount, 0) };
    campaign.outcomeRolls.push(receipt);
    campaign.chat.push({ id: randomUUID(), authorId: member.id, authorName: member.name, text: `${resolution.actor.name} · ${resolution.action.name} · ${kind === 'damage' ? 'damage' : 'healing'}: ${receipt.total}`, visibility: resolution.visibility, createdAt: receipt.createdAt,
      system: { key: '{actor} · {action} · {kind}: {total}', parameters: { actor: resolution.actor.name, action: resolution.action.name, kind, total: receipt.total }, localizedParameters: ['kind'] } });
    if (campaign.chat.length > 1000) campaign.chat.splice(0, campaign.chat.length - 1000);
    return true;
  }
  if (command.type === 'actor.action.applyOutcome') {
    keys(p, ['id', 'outcomeId', 'targetTokenId', 'multiplier']);
    const outcomeId = str(p.outcomeId, 'outcomeId');
    const outcome = campaign.outcomeRolls.find(r => r.id === outcomeId && r.actor.id === actor.id) ?? fail('OUTCOME_UNAVAILABLE', "The outcome roll is unavailable.");
    const targetTokenId = str(p.targetTokenId, 'targetTokenId');
    const multiplier = number(p.multiplier, 'multiplier', 0, 2);
    assertReceiptCapacity(campaign, command, campaign.hpApplications);
    const projected = projectSnapshot(campaign, member, '').campaign;
    const visibleScene = projected.scenes.find(s => s.id === projected.activeSceneId);
    const visibleTokens = visibleScene?.tokens.filter(t => t.levelId === visibleScene.activeLevelId) ?? [];
    const preview = previewHpApplication(campaign, member, outcome, targetTokenId, multiplier, visibleTokens);
    if (!preview.available) fail(preview.reasons[0].code, preview.reasons[0].message);
    const hpPool = preview.hpPool!;
    const pool = (hpPool.kind === 'actor' ? campaign.actors.find(a => a.id === hpPool.id) : campaign.scenes.find(s => s.id === campaign.activeSceneId)?.tokens.find(t => t.id === hpPool.id)) ?? fail('TARGET_UNAVAILABLE', "The target is unavailable on the current scene level.");
    const receipt: HpApplicationReceipt = { id: command.id, commandId: command.id, outcomeId: outcome.id, resolutionId: outcome.resolutionId, actor: { ...outcome.actor }, author: { id: member.id, name: member.name }, createdAt: timestamp(), target: preview.target!, hpPool, kind: outcome.kind, multiplier: multiplier as 0 | 0.5 | 1 | 2, requestedAmount: preview.requestedAmount!, appliedAmount: preview.appliedAmount!, before: preview.before!, after: preview.after!, max: preview.max! };
    pool.hp = preview.after!;
    campaign.hpApplications.push(receipt);
    const cast = campaign.actionResolutions.find(r => r.id === outcome.resolutionId)!;
    campaign.chat.push({ id: randomUUID(), authorId: member.id, authorName: member.name, text: `${outcome.actor.name} · ${cast.action.name} · outcome applied`, visibility: cast.visibility, createdAt: receipt.createdAt,
      system: { key: '{actor} · {action} · outcome applied', parameters: { actor: outcome.actor.name, action: cast.action.name } } });
    if (campaign.chat.length > 1000) campaign.chat.splice(0, campaign.chat.length - 1000);
    return true;
  }
  if (command.type === 'actor.resource.recover') {
    keys(p, ['id', 'event']);
    const event: RecoveryEvent = choice(p.event, ['turn', 'short-rest', 'long-rest'], 'event');
    assertReceiptCapacity(campaign, command, campaign.resourceRecoveries);
    const preview = previewRecovery(actor, event);
    if (!preview.available) fail('NO_CHANGE', "No known resources can recover from this event.");
    const receipt: ResourceRecoveryReceipt = { id: command.id, commandId: command.id, actor: { id: actor.id, name: actor.name }, author: { id: member.id, name: member.name }, createdAt: timestamp(), event, changes: structuredClone(preview.changes) };
    for (const change of preview.changes) if (change.applied) { actor.resources.find(r => r.id === change.resourceId)!.value = change.after; syncManagedResource(actor, change.resourceId, 'recover'); }
    campaign.resourceRecoveries.push(receipt); return true;
  }
  if (command.type === 'actor.action.create') {
    keys(p, ['id', ...definitions]);
    if (actor.actions.length >= ACTION_LIMITS.actions) fail('LIMIT', "The limit of 200 character actions has been reached.");
    const action: ActorAction = { id: randomUUID(), version: 1, name: "Action", description: '', sourceLabel: '', category: 'custom', known: true, prepared: false, requiresPreparation: false, enabled: true, target: 'none', costs: [], outcome: { kind: 'manual', text: '' } };
    patchDefinition(action, p, actor); actor.actions.push(action); return true;
  }
  const action = actor.actions.find(a => a.id === str(p.actionId, 'actionId')) ?? fail('NOT_FOUND', "Action not found.");
  const actionVersion = number(p.actionVersion, 'actionVersion', 1, Number.MAX_SAFE_INTEGER, true);
  if (action.version !== actionVersion) fail('ACTION_STALE', "The action changed; review the new version.");
  if (managedBinding(actor, 'action', action.id) && ['actor.action.update', 'actor.action.delete'].includes(command.type)) fail('PROGRESSION_MANAGED', "The profile defines this action; update the progression plan.");
  if (action.spellId !== undefined && ['actor.action.update', 'actor.action.delete', 'actor.action.prepare'].includes(command.type)) {
    fail('SPELL_BOUND_ACTION', "An imported Activity is immutable; change preparation on its spell group.");
  }
  if (command.type === 'actor.action.delete') { keys(p, ['id', 'actionId', 'actionVersion']); actor.actions = actor.actions.filter(a => a.id !== action.id); return true; }
  if (command.type === 'actor.action.update' || command.type === 'actor.action.prepare') {
    const prepare = command.type === 'actor.action.prepare';
    keys(p, ['id', 'actionId', 'actionVersion', ...(prepare ? ['prepared'] : definitions)]);
    if (prepare && !action.known) fail('UNAVAILABLE', "An unlearned action cannot be prepared.");
    if (prepare && p.prepared === undefined) fail('VALIDATION', "A prepared value is required.");
    if (!prepare && !definitions.some(k => p[k] !== undefined)) fail('VALIDATION', "The definition has no changes.");
    const edited = structuredClone(action); patchDefinition(edited, p, actor);
    if (action.version >= Number.MAX_SAFE_INTEGER) fail('LIMIT', "The action-version limit has been reached.");
    edited.version++; actor.actions[actor.actions.indexOf(action)] = edited; return true;
  }
  keys(p, ['id', 'actionId', 'actionVersion', 'targetTokenId', 'visibility']);
  const visibility = choice(p.visibility, ['public', 'gm', 'self'], 'visibility');
  const targetTokenId = p.targetTokenId === undefined ? undefined : str(p.targetTokenId, 'targetTokenId');
  assertReceiptCapacity(campaign, command, campaign.actionResolutions);
  const projected = projectSnapshot(campaign, member, '').campaign;
  const scene = projected.scenes.find(s => s.id === projected.activeSceneId) ?? fail('TARGET_UNAVAILABLE', "The active scene is unavailable.");
  const visibleTokens = scene.tokens.filter(t => t.levelId === scene.activeLevelId);
  const preview = previewAction(actor, action, { memberId: member.id, role: member.role, actionVersion, targetTokenId, visibleTokens });
  if (!preview.available) fail(preview.reasons[0].code, preview.reasons[0].message);
  let target: ActionResolution['target'] = { kind: 'none' };
  if (action.target === 'self') target = { kind: 'self', actorId: actor.id, name: actor.name };
  if (action.target === 'token') { const token = visibleTokens.find(t => t.id === targetTokenId)!; target = { kind: 'token', sceneId: scene.id, tokenId: token.id, name: token.name }; }
  const outcome: ActionOutcome = action.outcome;
  // All validation, target/permission checks, limits and full cost preflight precede the RNG and all writes.
  const roll = outcome.kind === 'roll' ? (deps.roll ?? rollActorCheck)(actor, outcome.ability === null ? { modifier: outcome.modifier, mode: outcome.mode } : { ability: outcome.ability, mode: outcome.mode }) : undefined;
  const spell = action.spellId === undefined ? undefined : actor.spellcasting!.spells.find(group => group.id === action.spellId)!;
  const receipt: ActionResolution = structuredClone({ id: command.id, commandId: command.id, actor: { id: actor.id, name: actor.name }, action, author: { id: member.id, name: member.name }, createdAt: timestamp(), target, costs: preview.costs,
    ...(spell ? { spell: { id: spell.id, version: spell.version, name: spell.name, description: spell.description, level: spell.level, method: spell.method, preparation: spell.preparation } } : {}),
    ...(roll ? { roll } : outcome.kind === 'manual' ? { manualOutcome: outcome.text } : {}), visibility });
  const grantBinding = managedBinding(actor, 'action', action.id);
  if (grantBinding && actor.progression) receipt.progression = { profile: { ...actor.progression.profile }, version: actor.progression.version, grantIds: [...grantBinding.grantIds], sourceLabels: actor.progression.grants.filter(g => grantBinding.grantIds.includes(g.id)).map(g => g.sourceLabel) };
  for (const cost of preview.costs) { actor.resources.find(r => r.id === cost.resourceId)!.value = cost.after; syncManagedResource(actor, cost.resourceId, 'spend', cost.before); }
  campaign.actionResolutions.push(receipt);
  // Public summaries never include target names, resource details, manual text, source labels, or private roll breakdowns.
  const publicRoll: RollResult | undefined = roll ? { formula: roll.formula, dice: structuredClone(roll.dice), modifier: roll.modifier, total: roll.total, ...(roll.d20 ? { d20: { ...roll.d20 } } : {}) } : undefined;
  campaign.chat.push({ id: randomUUID(), authorId: member.id, authorName: member.name, text: `${actor.name} · ${action.name}${roll ? ` · d20: ${roll.total}` : outcome.kind === 'manual' ? ' · completed' : ' · cost saved; roll pending'}`, visibility, createdAt: receipt.createdAt, ...(publicRoll ? { roll: publicRoll } : {}),
    system: { key: roll ? '{actor} · {action} · d20: {total}' : outcome.kind === 'manual' ? '{actor} · {action} · completed' : '{actor} · {action} · cost saved; roll pending', parameters: { actor: actor.name, action: action.name, ...(roll ? { total: roll.total } : {}) } } });
  if (campaign.chat.length > 1000) campaign.chat.splice(0, campaign.chat.length - 1000);
  return true;
}
