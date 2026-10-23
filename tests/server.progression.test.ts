import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addPlayer, applyCommand, DomainError, projectSnapshot, seedCampaign } from '../server/engine.ts';
import { Store } from '../server/store.ts';
import { readCampaign } from '../server/migrations.ts';
import { abilityBreakdown } from '../shared/abilities.ts';
import { blankActorChecks, previewCheck } from '../shared/checks.ts';
import { blankActorSheet, normalizeActorSheet } from '../shared/model.ts';
import type { Actor, Command, Member } from '../shared/model.ts';
import { draftProgressionActor, managedBinding, previewProgression, progressionChoices, validateProgressionProfile } from '../shared/progression.ts';
import type { ProgressionDefinition, ProgressionPlan, ProgressionProfile } from '../shared/progression.ts';
import { newOperation, readOperations, writeOperations } from '../client/reliable.ts';

const scores = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 };
function definition(): ProgressionDefinition {
  return { name: 'Independent test rules', description: 'Synthetic, authored profile', maxLevel: 3, abilityArray: [15, 14, 13, 12, 10, 8], baseHp: 2, proficiencyByLevel: [2, 3, 4],
    backgrounds: [{ key: 'traveller', name: 'Traveller', grants: [{ key: 'observe', kind: 'action', definitionKey: 'observe' }] }, { key: 'none', name: 'Other background', grants: [] }],
    classes: [{ key: 'a', name: 'A', levels: [
      { level: 1, grants: [{ key: 'might', kind: 'ability', ability: 'str', value: 2 }, { key: 'athlete', kind: 'skill', skill: 'ath', rank: 1 }, { key: 'strong-save', kind: 'save', ability: 'str' }, { key: 'hp-a1', kind: 'hp', value: 8 }, { key: 'pool', kind: 'resource', definitionKey: 'charge', capacity: 3 }, { key: 'heal', kind: 'action', definitionKey: 'heal' }, { key: 'observe', kind: 'action', definitionKey: 'observe' }, { key: 'kit', kind: 'item', definitionKey: 'kit' }], choices: [{ key: 'training', name: 'Two skills', count: 2, options: ['arc', 'his', 'prc'].map(skill => ({ key: skill, name: skill, grants: [{ key: `skill-${skill}`, kind: 'skill' as const, skill: skill as 'arc' | 'his' | 'prc', rank: 1 as const }] })) }] },
      { level: 2, grants: [{ key: 'hp-a2', kind: 'hp', value: 4 }, { key: 'pool', kind: 'resource', definitionKey: 'charge', capacity: 5 }], choices: [] },
      { level: 3, grants: [{ key: 'hp-a3', kind: 'hp', value: 4 }], choices: [] },
    ] }, { key: 'b', name: 'B', levels: [{ level: 1, grants: [{ key: 'might', kind: 'ability', ability: 'str', value: 2 }, { key: 'observe', kind: 'action', definitionKey: 'observe' }], choices: [] }, { level: 2, grants: [], choices: [] }, { level: 3, grants: [], choices: [] }] }],
    resources: [{ key: 'charge', label: 'Charge', kind: 'charge', recovery: 'long-rest' }],
    actions: [{ key: 'observe', name: 'Observe', description: '', sourceLabel: '', category: 'custom', known: true, prepared: true, requiresPreparation: false, enabled: true, target: 'none', costs: [], outcome: { kind: 'manual', text: 'Observed' } }, { key: 'heal', name: 'Heal', description: '', sourceLabel: '', category: 'custom', known: true, prepared: true, requiresPreparation: false, enabled: true, target: 'self', costs: [{ resourceKey: 'charge', amount: 1 }], outcome: { kind: 'healing', allowCritical: false, parts: [{ number: 1, denomination: 4, bonus: 1, type: 'healing' }] } }],
    items: [{ key: 'kit', name: 'Kit', type: 'equipment', quantity: 2, weight: 1, weightUnit: 'lb', description: '', equipped: false, uses: { value: 3, max: 3 } }],
  };
}
const step = (classKey = 'a') => ({ id: randomUUID(), classKey, choices: classKey === 'a' ? [{ choiceKey: 'training', optionKeys: ['arc', 'his'] }] : [] });
const plan = (): ProgressionPlan => ({ operation: 'create', backgroundKey: 'traveller', steps: [step()], baseAbilities: { ...scores }, proficiencyPolicy: 'profile' });
const hasCode = (code: string) => (e: unknown) => e instanceof DomainError && e.code === code;
function fixture() {
  const campaign = seedCampaign('Progression contract', 'GM'), gm = campaign.members[0], owner = addPlayer(campaign, 'Owner'), other = addPlayer(campaign, 'Other');
  const command = (type: Command['type'], payload: Record<string, unknown>, extra: Partial<Command> = {}): Command => ({ id: randomUUID(), type, payload, expectedRevision: campaign.revision, ...extra });
  const run = (member: Member, type: Command['type'], payload: Record<string, unknown>) => { const cmd = command(type, payload); applyCommand(campaign, member, cmd); campaign.revision++; return cmd; };
  run(gm, 'progression.profile.publish', { baseVersion: 0, definition: definition() });
  const profile = campaign.progressionProfiles[0];
  const create = (p = plan()) => { const id = randomUUID(), preview = previewProgression(draftProgressionActor(id, 'Hero', [owner.id]), profile, p); assert.deepEqual(preview.blockedReasons, []); run(owner, 'actor.progression.create', { id, name: 'Hero', profile: { id: profile.id, version: profile.version }, plan: p, previewKey: preview.previewKey }); return campaign.actors.find(a => a.id === id)!; };
  const commit = (actor: Actor, p: ProgressionPlan, chosen = profile) => { const preview = previewProgression(actor, chosen, p); assert.deepEqual(preview.blockedReasons, []); run(owner, 'actor.progression.commit', { id: actor.id, progressionVersion: actor.progression?.version ?? 0, profile: { id: chosen.id, version: chosen.version }, plan: p, previewKey: preview.previewKey }); return preview; };
  const respec = (actor: Actor, extra: Partial<ProgressionPlan> = {}): ProgressionPlan => ({ operation: 'respec', backgroundKey: actor.progression!.backgroundKey, steps: structuredClone(actor.progression!.steps), proficiencyPolicy: actor.progression!.proficiencyPolicy, ...extra });
  const execute = (actor: Actor, key = 'heal') => { const a = actor.actions.find(a => managedBinding(actor, 'action', a.id)?.definitionKey === key)!; return run(owner, 'actor.action.execute', { id: actor.id, actionId: a.id, actionVersion: a.version, visibility: 'self' }); };
  return { campaign, gm, owner, other, command, run, profile, create, commit, respec, execute };
}

test('profile boundary validates complete authored rules and draft preview fails closed without throwing', () => {
  assert.deepEqual(validateProgressionProfile(definition()), []);
  for (const mutate of [(p: any) => p.classes[0].levels[0].choices[0].count = 4, (p: any) => p.actions[1].costs[0].resourceKey = 'missing', (p: any) => p.baseHp = 1.5, (p: any) => p.classes[1].levels[0].grants[0].value = 4, (p: any) => p.items[0].source = 'native', (p: any) => p.resources[0].kind = 'script']) { const p = definition(); mutate(p); assert.ok(validateProgressionProfile(p).length); }
  const profile = { ...definition(), id: randomUUID(), version: 1 }, actor = draftProgressionActor(randomUUID(), 'Draft');
  for (const incomplete of [null, {}, { ...plan(), steps: [null] }, { ...plan(), steps: [{ ...step(), classKey: '' }] }, { ...plan(), baseAbilities: { ...scores, str: NaN } }, { ...plan(), steps: [{ ...step(), choices: [] }] }]) {
    const p = previewProgression(actor, profile, incomplete as ProgressionPlan); assert.equal(p.ready, false); assert.ok(p.blockedReasons.length);
  }
  const p = plan(); p.steps[0].choices[0].optionKeys = ['arc'];
  const partial = previewProgression(actor, profile, p); assert.equal(partial.ready, false); assert.equal(partial.requiredChoices[0].count, 2);
});

test('creation previews are deterministic and immutable, then materialize exact choices and deduplicated capabilities', () => {
  const f = fixture(), p = plan(), draft = draftProgressionActor(randomUUID(), 'Hero', [f.owner.id]), before = structuredClone(draft);
  const a = previewProgression(draft, f.profile, p), b = previewProgression(draft, f.profile, p);
  assert.deepEqual(a, b); assert.deepEqual(draft, before); assert.equal(a.ready, true); assert.equal(a.actor.hp, 10);
  assert.equal(a.actor.actions.filter(v => v.name === 'Observe').length, 1); assert.equal(a.actor.progression!.bindings.find(v => v.definitionKey === 'observe')!.grantIds.length, 2);
  assert.equal(abilityBreakdown(a.actor, 'str').effective, 17); assert.deepEqual(a.actor.abilities, scores);
  assert.equal(a.actor.checks!.skills.ath.proficiency, 0); assert.equal(previewCheck(a.actor, { kind: 'skill', key: 'ath' }).modifier, 5);
  assert.equal(previewCheck(a.actor, { kind: 'save', key: 'str' }).modifier, 5);
  const collision = structuredClone(draft); collision.resources.push({ id: a.actor.resources[0].id, label: 'Manual collision', value: 7, max: 7 });
  const manualBefore = structuredClone(collision); assert.ok(previewProgression(collision, f.profile, p).blockedReasons.some(r => r.code === 'IDENTITY_CONFLICT')); assert.deepEqual(collision, manualBefore);
  const saved = f.create(p); assert.deepEqual(saved.progression!.profile, { id: f.profile.id, version: 1 }); assert.equal(saved.progression!.grants.filter(g => g.active).length, 11);
  assert.equal(f.campaign.progressionCommits.length, 1); assert.equal(f.campaign.progressionCommits[0].operation, 'create');
});

test('profile publication is GM-only, immutable and versioned; existing actor changes only on explicit respec', () => {
  const f = fixture(), actor = f.create(), before = structuredClone(actor);
  assert.throws(() => applyCommand(f.campaign, f.owner, f.command('progression.profile.publish', { baseVersion: 0, definition: definition() })), hasCode('FORBIDDEN'));
  const changed = definition(); changed.classes[0].levels[0].grants.find(g => g.kind === 'ability')!.value = 3;
  changed.classes[1].levels[0].grants.find(g => g.kind === 'ability')!.value = 3;
  f.run(f.gm, 'progression.profile.publish', { profileId: f.profile.id, baseVersion: 1, definition: changed });
  assert.deepEqual(actor, before); assert.equal(f.profile.classes[0].levels[0].grants.find(g => g.kind === 'ability')!.value, 2);
  assert.throws(() => applyCommand(f.campaign, f.gm, f.command('progression.profile.publish', { profileId: f.profile.id, baseVersion: 1, definition: changed })), hasCode('PROFILE_STALE'));
  f.commit(actor, f.respec(actor), f.campaign.progressionProfiles[1]); assert.equal(abilityBreakdown(actor, 'str').effective, 18);
  assert.equal(f.campaign.progressionCommits[0].profile.version, 1); assert.equal(f.campaign.progressionCommits[1].profile.version, 2);
});

test('creation enforces current role, unique client UUID and explicit owner boundaries', () => {
  const f = fixture(), p = plan(), id = randomUUID(), draft = draftProgressionActor(id, 'Hero', [f.owner.id]);
  const payload = { id, name: 'Hero', profile: { id: f.profile.id, version: 1 }, plan: p, previewKey: previewProgression(draft, f.profile, p).previewKey };
  assert.throws(() => applyCommand(f.campaign, f.owner, f.command('actor.progression.create', { ...payload, owners: [f.other.id] })), hasCode('FORBIDDEN'));
  assert.throws(() => applyCommand(f.campaign, f.owner, f.command('actor.progression.create', { ...payload, id: 'not-uuid' })), hasCode('VALIDATION'));
  f.run(f.owner, 'actor.progression.create', payload);
  assert.deepEqual(f.campaign.actors.find(a => a.id === id)!.owners, [f.owner.id]);
  assert.throws(() => applyCommand(f.campaign, f.owner, f.command('actor.progression.create', payload)), hasCode('ID_REUSED'));
});

test('ordered level-up preserves manual checks and scores while overlay ranks and duplicate ability grants combine once', () => {
  const f = fixture(), actor = f.create(); actor.checks!.skills.ath.proficiency = 2; actor.checks!.skills.ath.bonus = 7; actor.abilities.str = 18;
  const checks = structuredClone(actor.checks), current = structuredClone(actor.progression!.steps);
  f.commit(actor, f.respec(actor, { operation: 'level-up', steps: [...current, step('b')] }));
  assert.deepEqual(actor.checks, checks); assert.equal(actor.abilities.str, 18); assert.equal(abilityBreakdown(actor, 'str').effective, 20);
  const roll = previewCheck(actor, { kind: 'skill', key: 'ath' }); assert.equal(roll.modifier, 18); assert.equal(roll.snapshot.progression!.baseMultiplier, 2); assert.equal(roll.snapshot.proficiency.bonus, 3);
  assert.equal(roll.snapshot.progression!.proficiencyPolicy, 'profile'); assert.equal(roll.snapshot.progression!.profileName, f.profile.name);
  f.run(f.owner, 'actor.check.roll', { id: actor.id, kind: 'skill', key: 'ath', mode: 'normal', visibility: 'self' });
  const snapshot = structuredClone(f.campaign.chat.at(-1)!.roll!.checkSnapshot!);
  assert.equal(actor.actions.filter(a => a.name === 'Observe').length, 1);
  const invalid = f.respec(actor, { operation: 'level-up', steps: [step('b')] }); assert.equal(previewProgression(actor, f.profile, invalid).ready, false);
  f.commit(actor, f.respec(actor, { steps: [step('b')], proficiencyPolicy: 'preserve' }));
  assert.deepEqual(actor.checks, checks); assert.equal(previewCheck(actor, { kind: 'skill', key: 'ath' }).blockedReasons[0].code, 'PROFICIENCY_UNKNOWN');
  assert.equal(previewCheck(actor, { kind: 'skill', key: 'ath' }).snapshot.progression!.proficiencyPolicy, 'preserve');
  assert.deepEqual(f.campaign.chat.at(-1)!.roll!.checkSnapshot, snapshot); assert.equal(snapshot.progression!.proficiencyPolicy, 'profile');
});

test('revoking one source retains its capability and immutable cast receipts survive final revocation', () => {
  const f = fixture(), actor = f.create(), observe = actor.actions.find(a => a.name === 'Observe')!, id = observe.id;
  const cast = f.execute(actor, 'observe'), saved = structuredClone(f.campaign.actionResolutions[0]);
  assert.equal(saved.progression!.grantIds.length, 2); assert.equal(saved.progression!.profile.version, 1);
  f.commit(actor, f.respec(actor, { backgroundKey: 'none' }));
  assert.equal(actor.actions.find(a => a.id === id)!.enabled, true); assert.equal(managedBinding(actor, 'action', id)!.grantIds.length, 1);
  f.commit(actor, f.respec(actor, { backgroundKey: 'none', steps: [step('b')] }));
  assert.equal(actor.actions.find(a => a.id === id)!.enabled, true);
  const profile = definition(); profile.classes[1].levels[0].grants = [];
  f.run(f.gm, 'progression.profile.publish', { profileId: f.profile.id, baseVersion: 1, definition: profile });
  f.commit(actor, f.respec(actor), f.campaign.progressionProfiles[1]);
  assert.equal(actor.actions.find(a => a.id === id)!.enabled, false); assert.equal(managedBinding(actor, 'action', id)!.active, false);
  assert.deepEqual(f.campaign.actionResolutions.find(r => r.commandId === cast.id), saved);
  assert.equal(saved.action.enabled, true);
  assert.equal(saved.progression!.grantIds.length, 2);
});

test('spent pools survive shrink, growth, revocation and regrant without free restoration', () => {
  const f = fixture(), actor = f.create(), pool = actor.resources[0], poolId = pool.id;
  f.execute(actor); f.execute(actor); f.execute(actor);
  assert.equal(actor.resources[0].value, 0); assert.equal(managedBinding(actor, 'resource', poolId)!.spent, 3);
  const first = structuredClone(actor.progression!.steps[0]);
  f.commit(actor, f.respec(actor, { operation: 'level-up', steps: [first, { id: randomUUID(), classKey: 'a', choices: [] }] }));
  assert.equal(actor.resources[0].max, 5); assert.equal(actor.resources[0].value, 2);
  f.commit(actor, f.respec(actor, { steps: [step('b')] }));
  assert.equal(actor.resources[0].max, 0); assert.equal(actor.resources[0].value, 0); assert.equal(managedBinding(actor, 'resource', poolId)!.spent, 3);
  f.commit(actor, f.respec(actor, { steps: [first] })); assert.equal(actor.resources[0].value, 0); assert.equal(actor.resources[0].id, poolId);
  const small = definition(); const g = small.classes[0].levels[0].grants.find(g => g.kind === 'resource')!; if (g.kind === 'resource') g.capacity = 1;
  f.run(f.gm, 'progression.profile.publish', { profileId: f.profile.id, baseVersion: 1, definition: small });
  f.commit(actor, f.respec(actor), f.campaign.progressionProfiles[1]); assert.equal(actor.resources[0].value, 0);
  f.run(f.owner, 'actor.resource.update', { id: actor.id, resourceId: poolId, value: 0 }); assert.equal(managedBinding(actor, 'resource', poolId)!.spent, 3);
  f.commit(actor, f.respec(actor), f.profile); assert.equal(actor.resources[0].value, 0); assert.equal(managedBinding(actor, 'resource', poolId)!.spent, 3);
});

test('issued equipment stays after revocation and repeated issuance preserves quantity and spent uses', () => {
  const f = fixture(), actor = f.create(), itemId = actor.items[0].id, first = structuredClone(actor.progression!.steps[0]);
  f.run(f.owner, 'actor.item.consume', { id: actor.id, itemId, from: 'quantity', amount: 1 });
  f.run(f.owner, 'actor.item.consume', { id: actor.id, itemId, from: 'uses', amount: 2 });
  f.run(f.owner, 'actor.item.update', { id: actor.id, itemId, equipped: true });
  f.commit(actor, f.respec(actor, { steps: [step('b')] }));
  assert.equal(actor.items[0].quantity, 1); assert.equal(actor.items[0].uses!.value, 1); assert.equal(managedBinding(actor, 'item', itemId)!.active, false);
  f.commit(actor, f.respec(actor, { steps: [first] }));
  assert.equal(actor.items[0].id, itemId); assert.equal(actor.items[0].quantity, 1); assert.equal(actor.items[0].equipped, true); assert.equal(actor.items[0].uses!.value, 1);
  const small = definition(); small.items[0].uses = { value: 1, max: 1 };
  f.run(f.gm, 'progression.profile.publish', { profileId: f.profile.id, baseVersion: 1, definition: small });
  f.commit(actor, f.respec(actor), f.campaign.progressionProfiles[1]); assert.equal(actor.items[0].uses!.value, 0);
  f.run(f.owner, 'actor.item.update', { id: actor.id, itemId, equipped: false, uses: { value: 0, max: 1 } }); assert.equal(managedBinding(actor, 'item', itemId)!.spent, 2);
  f.commit(actor, f.respec(actor), f.profile); assert.equal(actor.items[0].uses!.value, 1);
});

test('managed definitions reject generic edits while operational preparation, pool values and manual objects remain editable', () => {
  const f = fixture(), actor = f.create(), action = actor.actions[0], item = actor.items[0], resource = actor.resources[0], effect = actor.effects[0];
  for (const [type, payload] of [
    ['actor.action.delete', { actionId: action.id, actionVersion: action.version }], ['actor.action.update', { actionId: action.id, actionVersion: action.version, name: 'Changed' }],
    ['actor.resource.update', { resourceId: resource.id, max: 10 }], ['actor.resource.delete', { resourceId: resource.id }],
    ['actor.item.delete', { itemId: item.id }], ['actor.item.update', { itemId: item.id, name: 'Changed' }], ['actor.effect.delete', { effectId: effect.id }], ['actor.effect.update', { effectId: effect.id, disabled: true }],
  ] as [Command['type'], Record<string, unknown>][]) { const before = structuredClone(f.campaign); assert.throws(() => applyCommand(f.campaign, f.gm, f.command(type, { id: actor.id, ...payload })), hasCode('PROGRESSION_MANAGED')); assert.deepEqual(f.campaign, before); }
  f.run(f.owner, 'actor.action.prepare', { id: actor.id, actionId: action.id, actionVersion: action.version, prepared: false });
  f.run(f.owner, 'actor.resource.update', { id: actor.id, resourceId: resource.id, value: 1 }); assert.equal(managedBinding(actor, 'resource', resource.id)!.spent, 2);
  assert.throws(() => applyCommand(f.campaign, f.owner, f.command('actor.resource.update', { id: actor.id, resourceId: resource.id, value: 1.5 })), hasCode('VALIDATION'));
  f.run(f.gm, 'actor.action.create', { id: actor.id, name: 'Fractional manual', costs: [{ resourceId: resource.id, amount: 0.5 }] });
  const fractional = actor.actions.at(-1)!; assert.throws(() => applyCommand(f.campaign, f.owner, f.command('actor.action.execute', { id: actor.id, actionId: fractional.id, actionVersion: fractional.version, visibility: 'self' })), hasCode('PROGRESSION_RESOURCE_INVALID'));
  f.run(f.owner, 'actor.item.create', { id: actor.id, name: 'Kit' }); const manual = actor.items.at(-1)!;
  f.run(f.owner, 'actor.item.delete', { id: actor.id, itemId: manual.id }); assert.ok(actor.items.some(i => i.id === item.id));
});

test('legacy adoption captures an explicit boundary without replaying native ASI, past class grants or inventory', () => {
  const f = fixture(), actor = f.campaign.actors[0]; actor.owners = [f.owner.id]; actor.abilities.str = 19; actor.hp = null; actor.maxHp = null;
  actor.items.push({ id: 'manual-kit', name: 'Kit', type: 'native', quantity: 9, weight: 0, weightUnit: 'unit', description: 'Keep me', equipped: true });
  actor.source = { sourceActorRef: 'native-secret', resolution: 'resolved', systemId: 'dnd5e', systemVersion: '6.0.6' };
  actor.checks = blankActorChecks(); actor.checks.version = 1; actor.checks.skills.arc.proficiency = 2;
  actor.checks.unsupported = [{ scope: 'skill', key: 'arc', code: 'NATIVE_FORMULA', reason: 'Unexecuted source formula' }];
  const baseChecks = structuredClone(actor.checks);
  const p: ProgressionPlan = { operation: 'adopt', baselineClasses: [{ classKey: 'a', level: 1 }], backgroundKey: null, steps: [], proficiencyPolicy: 'preserve' };
  f.commit(actor, p); assert.equal(actor.abilities.str, 19); assert.equal(actor.effects.length, 0); assert.equal(actor.progression!.grants.length, 0); assert.equal(actor.items[0].quantity, 9); assert.equal(actor.maxHp, null);
  assert.deepEqual(actor.progression!.baseline.classes, [{ classKey: 'a', level: 1 }]);
  const next: ProgressionPlan = { operation: 'level-up', backgroundKey: null, steps: [{ id: randomUUID(), classKey: 'a', choices: [] }], proficiencyPolicy: 'preserve' };
  assert.equal(progressionChoices(f.profile, next, actor.progression!.baseline.classes).length, 0);
  f.commit(actor, next); assert.equal(actor.hp, null); assert.equal(actor.maxHp, null); assert.equal(actor.abilities.str, 19); assert.equal(actor.items[0].id, 'manual-kit'); assert.equal(actor.actions.length, 0);
  assert.equal(actor.resources[0].max, 5); assert.equal(actor.progression!.steps.length, 1);
  assert.deepEqual(actor.checks, baseChecks); assert.ok(previewCheck(actor, { kind: 'skill', key: 'arc' }).blockedReasons.some(r => r.code === 'CHECK_UNSUPPORTED'));
});

test('HP grants never heal on level-up or respec and explicit manual max changes adjust the preserved baseline', () => {
  const f = fixture(), actor = f.create(); actor.hp = 3;
  const first = structuredClone(actor.progression!.steps[0]);
  f.commit(actor, f.respec(actor, { operation: 'level-up', steps: [first, { id: randomUUID(), classKey: 'a', choices: [] }] }));
  assert.equal(actor.hp, 3); assert.equal(actor.maxHp, 14);
  f.run(f.owner, 'actor.update', { id: actor.id, maxHp: 20 }); assert.equal(actor.progression!.baseline.maxHp, 8);
  f.commit(actor, f.respec(actor, { steps: [first] })); assert.equal(actor.maxHp, 16); assert.equal(actor.hp, 3);
  actor.hp = 15; f.commit(actor, f.respec(actor, { steps: [step('b')], backgroundKey: 'none' })); assert.equal(actor.maxHp, 8); assert.equal(actor.hp, 8);
  f.run(f.owner, 'actor.update', { id: actor.id, maxHp: null, hp: null }); f.commit(actor, f.respec(actor, { steps: [first] })); assert.equal(actor.maxHp, null); assert.equal(actor.hp, null);
});

test('current revision, progression version, preview, ownership and exact choices all reject atomically', () => {
  const f = fixture(), actor = f.create(), p = f.respec(actor), preview = previewProgression(actor, f.profile, p);
  const payload = { id: actor.id, progressionVersion: actor.progression!.version, profile: { id: f.profile.id, version: 1 }, plan: p, previewKey: preview.previewKey };
  const cases: [Member, Command, string][] = [
    [f.other, f.command('actor.progression.commit', payload), 'FORBIDDEN'], [f.owner, f.command('actor.progression.commit', { ...payload, progressionVersion: 0 }), 'PROGRESSION_STALE'],
    [f.owner, f.command('actor.progression.commit', { ...payload, previewKey: 'wrong' }), 'PREVIEW_STALE'], [f.owner, f.command('actor.progression.commit', payload, { expectedRevision: undefined }), 'REVISION_REQUIRED'],
    [f.owner, f.command('actor.progression.commit', payload, { expectedRevision: f.campaign.revision - 1 }), 'CONFLICT'],
    [f.owner, f.command('actor.progression.commit', { ...payload, plan: { ...p, steps: [{ ...p.steps[0], choices: [] }] } }), 'CHOICE_REQUIRED'],
  ];
  for (const [member, cmd, code] of cases) { const before = structuredClone(f.campaign); assert.throws(() => applyCommand(f.campaign, member, cmd), hasCode(code)); assert.deepEqual(f.campaign, before); }
  f.execute(actor); assert.throws(() => applyCommand(f.campaign, f.owner, f.command('actor.progression.commit', payload)), hasCode('PREVIEW_STALE'));
  actor.owners = [f.other.id]; assert.throws(() => applyCommand(f.campaign, f.owner, f.command('actor.progression.commit', payload)), hasCode('FORBIDDEN'));
});

test('published rules are shared but personal provenance and receipts follow author/current-owner privacy', () => {
  const f = fixture(), actor = f.create();
  actor.source = { sourceActorRef: 'RAW-SECRET', resolution: 'resolved', systemId: 'custom', systemVersion: null };
  actor.observedAdvancement = { classes: [], steps: [], grantCount: 0, issueCount: 0 };
  f.run(f.gm, 'actor.place', { id: actor.id, x: 500, y: 500 });
  const owner = projectSnapshot(f.campaign, f.owner, '').campaign, other = projectSnapshot(f.campaign, f.other, '').campaign;
  assert.equal(owner.progressionCommits.length, 1); assert.equal(other.progressionCommits.length, 0); assert.equal(other.progressionProfiles.length, 1);
  assert.equal(owner.actors.find(a => a.id === actor.id)!.source, undefined);
  const summary = other.actors.find(a => a.id === actor.id)!; assert.equal(summary.progression, undefined); assert.equal(summary.observedAdvancement, undefined); assert.equal(summary.checks, undefined);
  actor.owners = [f.other.id]; assert.equal(projectSnapshot(f.campaign, f.other, '').campaign.progressionCommits.length, 1); assert.equal(projectSnapshot(f.campaign, f.owner, '').campaign.progressionCommits.length, 1);
  assert.equal(JSON.stringify(projectSnapshot(f.campaign, f.owner, '')).includes('RAW-SECRET'), false);
});

test('explicit recovery clears tracked spending while unrelated legacy pools remain independent', () => {
  const f = fixture(), actor = f.create(), id = actor.resources[0].id;
  actor.resources.push({ id: 'manual', label: 'Charge', value: 7, max: 9, recovery: 'manual' });
  f.execute(actor); f.execute(actor); f.run(f.gm, 'actor.resource.recover', { id: actor.id, event: 'long-rest' });
  assert.equal(managedBinding(actor, 'resource', id)!.spent, 0); assert.equal(actor.resources.find(r => r.id === id)!.value, 3);
  f.commit(actor, f.respec(actor, { steps: [step('b')] })); f.commit(actor, f.respec(actor, { steps: [step()] }));
  assert.equal(actor.resources.find(r => r.id === id)!.value, 3); assert.equal(actor.resources.find(r => r.id === 'manual')!.value, 7);
  f.run(f.owner, 'actor.resource.update', { id: actor.id, resourceId: id, value: null });
  f.commit(actor, f.respec(actor, { steps: [step('b')] })); f.commit(actor, f.respec(actor, { steps: [step()] }));
  assert.equal(actor.resources.find(r => r.id === id)!.value, null); assert.equal(managedBinding(actor, 'resource', id)!.spent, null);
});

test('legacy migration is additive and source observations never become fabricated progression history', () => {
  const f = fixture(), legacy = JSON.parse(JSON.stringify(f.campaign)); delete legacy.progressionProfiles; delete legacy.progressionCommits;
  const read = readCampaign(JSON.stringify(legacy)); assert.deepEqual(read.progressionProfiles, []); assert.deepEqual(read.progressionCommits, []); assert.equal(read.actors[0].progression, undefined);
  assert.equal(Object.hasOwn(blankActorSheet(), 'progression'), false); assert.equal(Object.hasOwn(normalizeActorSheet(blankActorSheet()), 'progression'), false);
  const a = f.create(); assert.deepEqual(normalizeActorSheet(a).progression, a.progression);
});

test('durable create/commit exact retry survives SQLite reopen, changed envelopes and cross-session repeats cannot reapply', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtt-progression-')), path = join(dir, 'store.sqlite'); let store = new Store(path);
  try {
    const auth = store.create('Durable', 'GM'); let session = store.authenticate(auth.token);
    const issue = (type: Command['type'], payload: Record<string, unknown>, id = randomUUID()) => ({ id, type, payload, expectedRevision: store.campaign(session).campaign.revision });
    assert.equal(store.command(session, issue('progression.profile.publish', { baseVersion: 0, definition: definition() })).ack.ok, true);
    const profile = store.campaign(session).campaign.progressionProfiles[0], id = randomUUID(), p = plan(), draft = draftProgressionActor(id, 'Persistent', [auth.memberId]);
    const create = issue('actor.progression.create', { id, name: 'Persistent', profile: { id: profile.id, version: 1 }, plan: p, previewKey: previewProgression(draft, profile, p).previewKey });
    const created = store.command(session, create); assert.equal(created.ack.ok, true); store.close(); store = new Store(path); session = store.authenticate(auth.token);
    assert.deepEqual(store.command(session, create), { ack: created.ack, changed: false });
    let actor = store.campaign(session).campaign.actors.find(a => a.id === id)!;
    const respec: ProgressionPlan = { operation: 'respec', backgroundKey: actor.progression!.backgroundKey, steps: actor.progression!.steps, proficiencyPolicy: 'profile' };
    const commit = issue('actor.progression.commit', { id, progressionVersion: 1, profile: { id: profile.id, version: 1 }, plan: respec, previewKey: previewProgression(actor, profile, respec).previewKey });
    const done = store.command(session, commit); assert.equal(done.ack.ok, true);
    const afterFirst = store.export(session); assert.equal(store.command(session, { ...commit, id: randomUUID() }).ack.code, 'CONFLICT'); assert.deepEqual(store.export(session), afterFirst);
    const frozen = store.export(session); store.close(); store = new Store(path); session = store.authenticate(auth.token);
    assert.deepEqual(store.command(session, commit), { ack: done.ack, changed: false }); assert.deepEqual(store.export(session), frozen);
    assert.equal(store.command(session, { ...commit, payload: { ...commit.payload, previewKey: 'changed' } }).ack.code, 'ID_REUSED');
    const playerAuth = store.join(store.snapshot(session).inviteCode!, 'NewOwner'), playerSession = store.authenticate(playerAuth.token);
    assert.equal(store.command(session, issue('actor.update', { id, owners: [playerAuth.memberId] })).ack.ok, true);
    actor = store.campaign(session).campaign.actors.find(a => a.id === id)!;
    const fresh = { ...commit, expectedRevision: store.campaign(session).campaign.revision, payload: { ...commit.payload, progressionVersion: actor.progression!.version, previewKey: previewProgression(actor, profile, respec).previewKey } };
    assert.equal(store.command(playerSession, fresh).ack.code, 'ID_REUSED');
    const before = store.export(session), bad = { ...fresh, id: randomUUID(), payload: { ...fresh.payload, plan: { ...respec, steps: [{ ...respec.steps[0], choices: [] }] } } };
    assert.equal(store.command(playerSession, bad).ack.code, 'CHOICE_REQUIRED'); assert.deepEqual(store.export(session), before);
    assert.equal(store.command(session, { ...fresh, id: randomUUID() }).ack.ok, true); // GM remains authorized.
    const saved = new Map<string, string>(), storage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => { saved.set(k, v); } };
    for (const type of ['actor.progression.create', 'actor.progression.commit'] as const) { const op = newOperation(auth.campaignId, auth.memberId, id, type, { id, plan: p }, 1, type); writeOperations(storage, auth.campaignId, auth.memberId, [op]); assert.deepEqual(readOperations(storage, auth.campaignId, auth.memberId), [op]); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
