import { randomInt } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AbilityKey, Actor, Campaign, CheckRequest, Command, Member, RollResult, SkillKey, SystemChatMessage } from '../shared/model.ts';
import { previewCheck, validActorChecks } from '../shared/checks.ts';
import { fail, object, str } from './engine.ts';

const abilityNames: Record<AbilityKey, string> = { str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" };
const skillNames: Record<SkillKey, string> = {
  acr: "Acrobatics", ani: "Animal Handling", arc: "Arcana", ath: "Athletics", dec: "Deception", his: "History", ins: "Insight", itm: "Intimidation",
  inv: "Investigation", med: "Medicine", nat: "Nature", prc: "Perception", prf: "Performance", per: "Persuasion", rel: "Religion", slt: "Sleight of Hand", ste: "Stealth", sur: "Survival",
};

function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('VALIDATION', "Unknown check-command field.");
}
function requestFromPayload(p: Record<string, unknown>): CheckRequest {
  return { kind: p.kind as CheckRequest['kind'], key: p.key as string,
    ...(p.abilityOverride === undefined ? {} : { abilityOverride: p.abilityOverride as CheckRequest['abilityOverride'] }),
    ...(p.situationalBonus === undefined ? {} : { situationalBonus: p.situationalBonus as number }), mode: p.mode as CheckRequest['mode'] };
}

/** The draw dependency is test-only; clients submit intent and never dice or totals. */
export function rollConfiguredCheck(actor: Actor, request: CheckRequest, draw: () => number = () => randomInt(1, 21)): RollResult {
  const preview = previewCheck(actor, request);
  if (preview.blockedReasons.length) return fail(preview.blockedReasons[0].code, preview.blockedReasons[0].reason);
  if (preview.modifier === null) return fail('CHECKS_INVALID', "The check modifier is unknown.");
  const mode = preview.mode, values = [draw()];
  if (mode !== 'normal') values.push(draw());
  if (values.some(value => !Number.isInteger(value) || value < 1 || value > 20)) return fail('VALIDATION', "Invalid d20 result.");
  const keptIndex = values.length === 2 && (mode === 'advantage' ? values[1] > values[0] : values[1] < values[0]) ? 1 : 0;
  const modifier = preview.modifier, formula = `${mode === 'normal' ? '1d20' : mode === 'advantage' ? '2d20kh1' : '2d20kl1'}${modifier >= 0 ? '+' : ''}${modifier}`;
  return { formula, dice: [{ sides: 20, values }], modifier, total: values[keptIndex] + modifier, d20: { mode, keptIndex },
    actor: { id: actor.id, name: actor.name }, ability: preview.snapshot.ability!, checkSnapshot: structuredClone(preview.snapshot) };
}

export function applyCheckCommand(campaign: Campaign, member: Member, command: Command, draw?: () => number): boolean {
  if (command.type !== 'actor.checks.update' && command.type !== 'actor.check.roll') return false;
  if (command.expectedRevision === undefined) return fail('REVISION_REQUIRED', "A check requires the current expectedRevision.");
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) return fail('VALIDATION', "Invalid expectedRevision.");
  if (command.expectedRevision !== campaign.revision) return fail('CONFLICT', "The campaign changed; review the action again.");
  const p = object(command.payload), actor = campaign.actors.find(a => a.id === str(p.id, 'id')) ?? fail('NOT_FOUND', "Character not found.");
  if (member.role !== 'gm' && !actor.owners.includes(member.id)) return fail('FORBIDDEN', "You cannot control this character.");
  if (actor.sheetKind !== 'dnd5e') return fail('CHECKS_UNAVAILABLE', "Checks require a D&D 5e character sheet.");
  if (command.type === 'actor.checks.update') {
    keys(p, ['id', 'checksVersion', 'checks']);
    if (!Number.isSafeInteger(p.checksVersion) || (p.checksVersion as number) < 0) return fail('VALIDATION', "Invalid checksVersion.");
    const current = actor.checks?.version ?? 0;
    if (p.checksVersion !== current) return fail('CHECKS_STALE', "The checks profile changed.");
    if (current >= Number.MAX_SAFE_INTEGER) return fail('LIMIT', "The checks-profile version limit has been reached.");
    const input = object(p.checks); keys(input, ['profile', 'proficiency', 'global', 'abilities', 'skills', 'saves', 'unsupported']);
    const candidate = { ...structuredClone(input), version: current + 1 };
    if (!validActorChecks(candidate)) return fail('VALIDATION', "Invalid checks profile.");
    if (!isDeepStrictEqual(candidate.unsupported, actor.checks?.unsupported ?? [])) return fail('CHECKS_UNSUPPORTED_IMMUTABLE', "Unsupported-rule diagnostics must be preserved when editing.");
    actor.checks = candidate;
    return true;
  }
  keys(p, ['id', 'kind', 'key', 'abilityOverride', 'situationalBonus', 'mode', 'visibility']);
  if (!['default', 'normal', 'advantage', 'disadvantage'].includes(p.mode as string) || !['public', 'gm', 'self'].includes(p.visibility as string)) return fail('VALIDATION', "A valid check mode and visibility are required.");
  if (campaign.chat.some(message => message.id === command.id)) return fail('ID_REUSED', "This check ID has already been used.");
  const request = requestFromPayload(p), roll = rollConfiguredCheck(actor, request, draw);
  const label = request.kind === 'skill' ? skillNames[request.key as SkillKey] : `${request.kind === 'save' ? 'Saving throw' : 'Check'}: ${abilityNames[request.key as AbilityKey]}`;
  const system: SystemChatMessage = request.kind === 'skill'
    ? { key: '{actor} · {label}', parameters: { actor: actor.name, label: skillNames[request.key as SkillKey] }, localizedParameters: ['label'] }
    : { key: '{actor} · {kind}: {ability}', parameters: { actor: actor.name, kind: request.kind === 'save' ? 'Saving throw' : 'Check', ability: abilityNames[request.key as AbilityKey] }, localizedParameters: ['kind', 'ability'] };
  campaign.chat.push({ id: command.id, authorId: member.id, authorName: member.name, text: `${actor.name} · ${label}`,
    visibility: p.visibility as 'public' | 'gm' | 'self', createdAt: new Date().toISOString(), roll, system });
  if (campaign.chat.length > 1000) campaign.chat = campaign.chat.slice(-1000);
  return true;
}
