import { randomUUID } from 'node:crypto';
import type { Actor, Campaign, Command, Member } from '../shared/model.ts';
import type { ProgressionDefinition, ProgressionPlan, ProgressionProfile } from '../shared/progression.ts';
import { draftProgressionActor, previewProgression, PROGRESSION_LIMITS, validateProgressionProfile } from '../shared/progression.ts';
import { fail, object, str } from './engine.ts';

function keys(value: Record<string, unknown>, allowed: string[]) { if (Object.keys(value).some(k => !allowed.includes(k))) fail('VALIDATION', "Unknown progression-command field."); }
function uuid(value: unknown): string { const id = str(value, 'id'); return /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id) ? id : fail('VALIDATION', "An object UUID is required."); }
function version(value: unknown, min = 0): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min ? value : fail('VALIDATION', "Invalid version."); }
function revision(campaign: Campaign, command: Command) {
  if (command.expectedRevision === undefined) fail('REVISION_REQUIRED', "Progression requires the current expectedRevision.");
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision! < 0) fail('VALIDATION', "Invalid expectedRevision.");
  if (command.expectedRevision !== campaign.revision) fail('CONFLICT', "The campaign changed; review your changes.");
}
export function applyProgressionCommand(campaign: Campaign, member: Member, command: Command): boolean {
  if (!['progression.profile.publish', 'actor.progression.create', 'actor.progression.commit'].includes(command.type)) return false;
  revision(campaign, command); const p = object(command.payload);
  if (command.type === 'progression.profile.publish') {
    if (member.role !== 'gm') fail('FORBIDDEN', "Only the GM can publish profiles.");
    keys(p, ['profileId', 'baseVersion', 'definition']);
    if (campaign.progressionProfiles.length >= PROGRESSION_LIMITS.profiles) fail('LIMIT', "The published-version catalog is full.");
    const id = p.profileId === undefined ? randomUUID() : uuid(p.profileId), current = Math.max(0, ...campaign.progressionProfiles.filter(v => v.id === id).map(v => v.version));
    if (version(p.baseVersion) !== current) fail('PROFILE_STALE', "Another version has appeared in the catalog.");
    if (p.profileId !== undefined && !current) fail('PROFILE_UNAVAILABLE', "Do not supply profileId for a new series.");
    const definition = object(p.definition);
    keys(definition, ['name', 'description', 'maxLevel', 'abilityArray', 'baseHp', 'proficiencyByLevel', 'backgrounds', 'classes', 'actions', 'resources', 'items']);
    const errors = validateProgressionProfile(definition);
    if (errors.length) fail('PROFILE_INVALID', errors[0]);
    if (current >= Number.MAX_SAFE_INTEGER) fail('LIMIT', "The profile-version limit has been reached.");
    campaign.progressionProfiles.push({ ...structuredClone(definition) as unknown as ProgressionDefinition, id, version: current + 1 });
    return true;
  }
  const create = command.type === 'actor.progression.create';
  keys(p, create ? ['id', 'name', 'owners', 'profile', 'plan', 'previewKey'] : ['id', 'progressionVersion', 'profile', 'plan', 'previewKey']);
  const id = create ? uuid(p.id) : str(p.id, 'id');
  let actor: Actor;
  if (create) {
    if (campaign.actors.some(a => a.id === id)) fail('ID_REUSED', "A character with this ID already exists.");
    if (campaign.actors.length >= 1000) fail('LIMIT', "The character limit has been reached.");
    let owners = [member.id];
    if (p.owners !== undefined) {
      if (!Array.isArray(p.owners) || p.owners.length > 32 || p.owners.some(v => typeof v !== 'string' || !campaign.members.some(m => m.id === v)) || new Set(p.owners).size !== p.owners.length) fail('VALIDATION', "Invalid owners list.");
      owners = p.owners as string[];
      if (member.role !== 'gm' && (owners.length !== 1 || owners[0] !== member.id)) fail('FORBIDDEN', "A player can only create a character for themselves.");
    }
    actor = draftProgressionActor(id, str(p.name, 'name'), owners);
  } else {
    actor = campaign.actors.find(a => a.id === id) ?? fail('NOT_FOUND', "Character not found.");
    if (member.role !== 'gm' && !actor.owners.includes(member.id)) fail('FORBIDDEN', "You cannot control this character.");
    if (version(p.progressionVersion) !== (actor.progression?.version ?? 0)) fail('PROGRESSION_STALE', "Character progression changed.");
    if ((actor.progression?.version ?? 0) >= Number.MAX_SAFE_INTEGER) fail('LIMIT', "The character-version limit has been reached.");
  }
  const ref = object(p.profile); keys(ref, ['id', 'version']);
  const profileId = uuid(ref.id), profileVersion = version(ref.version, 1);
  const profile = campaign.progressionProfiles.find(v => v.id === profileId && v.version === profileVersion) ?? fail('PROFILE_UNAVAILABLE', "The published profile version was not found.");
  const plan = object(p.plan) as unknown as ProgressionPlan;
  if (create !== (plan.operation === 'create')) fail('PLAN_INVALID', "Incorrect command for this plan.");
  if (campaign.progressionCommits.length >= PROGRESSION_LIMITS.receipts) fail('LIMIT', "Progression history is full; records are preserved.");
  if ([...campaign.progressionCommits, ...campaign.actionResolutions, ...campaign.resourceRecoveries, ...campaign.outcomeRolls, ...campaign.hpApplications, ...campaign.combatReceipts, ...campaign.journalReceipts].some(r => r.commandId === command.id)) fail('ID_REUSED', "This outcome ID has already been used.");
  const preview = previewProgression(actor, profile, plan);
  if (!preview.ready) fail(preview.blockedReasons[0].code, preview.blockedReasons[0].reason);
  if (str(p.previewKey, 'previewKey', 100) !== preview.previewKey) fail('PREVIEW_STALE', "The preview is stale; review your changes.");
  const receipt = { id: command.id, commandId: command.id, actor: { id, name: actor.name }, author: { id: member.id, name: member.name }, createdAt: new Date().toISOString(),
    operation: plan.operation, profile: structuredClone(profile) as ProgressionProfile, plan: structuredClone(plan), previewKey: preview.previewKey,
    before: { progression: structuredClone(actor.progression ?? null), hp: actor.hp, maxHp: actor.maxHp },
    after: { progression: structuredClone(preview.actor.progression!), hp: preview.actor.hp, maxHp: preview.actor.maxHp }, diff: structuredClone(preview.diff) };
  if (create) campaign.actors.push(preview.actor); else Object.assign(actor, preview.actor);
  campaign.progressionCommits.push(receipt);
  return true;
}
