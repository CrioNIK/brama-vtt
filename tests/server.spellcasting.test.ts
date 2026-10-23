import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addPlayer, applyCommand, DomainError, projectSnapshot, seedCampaign } from '../server/engine.ts';
import { applyActionCommand } from '../server/actions.ts';
import { readCampaign } from '../server/migrations.ts';
import { actionPreparation, previewAction } from '../shared/actions.ts';
import { blankActorSheet, normalizeActorSheet } from '../shared/model.ts';
import type { ActorAction, ActorSpell, Command, Member, SpellActivityContext } from '../shared/model.ts';

const context: SpellActivityContext = {
  activation: { type: 'action' }, duration: { type: 'instantaneous' },
  range: { type: 'distance', value: 30, unit: 'ft' }, target: { type: 'creature', count: 1, prompt: false },
};
function fixture(level = 1, preparation: ActorSpell['preparation'] = 'unprepared') {
  const campaign = seedCampaign('Spellcasting contract', 'GM'), gm = campaign.members[0];
  const owner = addPlayer(campaign, 'Spell owner'), foreign = addPlayer(campaign, 'Observer');
  const actor = campaign.actors[0]; actor.owners = [owner.id]; actor.sheetKind = 'dnd5e';
  campaign.scenes[0].tokens[0].owners = [owner.id];
  actor.resources = [
    { id: 'runtime-slot-1', label: 'Spell slots 1', value: 2, max: 2, kind: 'spell-slot', level: 1, unit: '', recovery: 'long-rest' },
    { id: 'runtime-action-pool', label: 'Action', value: 1, max: 1, kind: 'action', level: null, unit: '', recovery: 'turn' },
  ];
  actor.spellcasting = { profile: 'foundry-dnd5e-6.0.6-base-cast-v1', spells: [
    { id: 'runtime-spell', version: 1, name: 'Research spell', description: 'Plain own description', level, method: 'spell', preparation },
  ], unsupported: [{ kind: 'activity', name: 'Unsupported activity', codes: ['UNSUPPORTED'], reason: 'No supported executable subset.' }] };
  const base: ActorAction = {
    id: 'runtime-utility', version: 1, name: 'Utility activity', description: '', sourceLabel: 'Research spell', category: 'spell',
    // Deliberately contrary local values demonstrate that the spell group is authoritative.
    known: false, prepared: true, requiresPreparation: false, enabled: true, target: 'none',
    spellId: 'runtime-spell', casting: structuredClone(context),
    inheritance: { activation: 'item-merge', range: 'item-merge', target: 'activity', duration: 'item-merge' },
    costs: level === 0 ? [] : [{ resourceId: 'runtime-slot-1', amount: 1 }], outcome: { kind: 'manual', text: 'Declared utility result' },
  };
  actor.actions = [base, { ...structuredClone(base), id: 'runtime-damage', name: 'Damage activity', prepared: false, requiresPreparation: true,
    outcome: { kind: 'damage', parts: [{ number: 1, denomination: 4, bonus: 0, type: 'force' }], allowCritical: false } }];
  actor.source = { sourceActorRef: 'NATIVE_ACTOR_SENTINEL', resolution: 'resolved', systemId: 'dnd5e', systemVersion: '6.0.6',
    spellRefs: [{ spellId: 'runtime-spell', sourceItemId: 'NATIVE_ITEM_SENTINEL' }],
    activityRefs: actor.actions.map(action => ({ actionId: action.id, sourceActivityId: 'NATIVE_ACTIVITY_SENTINEL', sourceItemId: 'NATIVE_ITEM_SENTINEL' })),
    resourceRefs: [{ resourceId: 'runtime-slot-1', sourceKey: 'NATIVE_RESOURCE_SENTINEL' }],
    unsupportedSpellcasting: [{ sourceItemId: 'NATIVE_UNSUPPORTED_SENTINEL' }],
  };
  const spell = () => actor.spellcasting!.spells[0];
  const command = (type: Command['type'], payload: Record<string, unknown>, extra: Partial<Command> = {}): Command =>
    ({ id: randomUUID(), type, payload, expectedRevision: campaign.revision, ...extra });
  const run = (member: Member, type: Command['type'], payload: Record<string, unknown>) => {
    const intent = command(type, payload); applyCommand(campaign, member, intent); campaign.revision++; return intent;
  };
  const prepare = (prepared: boolean, member = owner) => run(member, 'actor.spell.prepare', { id: actor.id, spellId: spell().id, spellVersion: spell().version, prepared });
  const execute = (action = actor.actions[0]) => ({ id: actor.id, actionId: action.id, actionVersion: action.version, visibility: 'public' });
  const preview = (action = actor.actions[0]) => previewAction(actor, action, { memberId: owner.id, role: 'player', actionVersion: action.version, visibleTokens: [] });
  return { campaign, gm, owner, foreign, actor, spell, command, run, prepare, execute, preview };
}
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
function rejected(f: ReturnType<typeof fixture>, member: Member, intent: Command, expected: string) {
  const before = structuredClone(f.campaign);
  assert.throws(() => applyCommand(f.campaign, member, intent), code(expected));
  assert.deepEqual(f.campaign, before, 'Rejected command must preserve group, activities, resources and history.');
}

test('spell preparation is shared by both activities and ignores their legacy preparation booleans', () => {
  const f = fixture(), definitions = structuredClone(f.actor.actions), pools = structuredClone(f.actor.resources);
  for (const action of f.actor.actions) {
    assert.deepEqual(actionPreparation(f.actor, action), { known: true, prepared: false, requiresPreparation: true });
    assert.equal(f.preview(action).reasons[0].code, 'UNPREPARED');
  }
  f.prepare(true);
  assert.equal(f.spell().version, 2); assert.equal(f.spell().preparation, 'prepared');
  for (const action of f.actor.actions) {
    assert.deepEqual(actionPreparation(f.actor, action), { known: true, prepared: true, requiresPreparation: true });
    assert.equal(f.preview(action).available, true);
  }
  assert.deepEqual(f.actor.actions, definitions); assert.deepEqual(f.actor.resources, pools);
  f.prepare(false, f.gm);
  assert.equal(f.spell().version, 3); assert.deepEqual(f.actor.actions, definitions);
  for (const action of f.actor.actions) rejected(f, f.owner, f.command('actor.action.execute', f.execute(action)), 'UNPREPARED');
});

test('spell prepare enforces revision, spell version, current ownership and exact payload before mutation', () => {
  const f = fixture(), payload = { id: f.actor.id, spellId: f.spell().id, spellVersion: 1, prepared: true };
  rejected(f, f.owner, f.command('actor.spell.prepare', payload, { expectedRevision: undefined }), 'REVISION_REQUIRED');
  rejected(f, f.owner, f.command('actor.spell.prepare', payload, { expectedRevision: f.campaign.revision - 1 }), 'CONFLICT');
  rejected(f, f.owner, f.command('actor.spell.prepare', { ...payload, spellVersion: 2 }), 'SPELL_STALE');
  rejected(f, f.foreign, f.command('actor.spell.prepare', payload), 'FORBIDDEN');
  rejected(f, f.owner, f.command('actor.spell.prepare', { ...payload, prepared: 'true' }), 'VALIDATION');
  rejected(f, f.owner, f.command('actor.spell.prepare', { ...payload, level: 9 }), 'VALIDATION');
  rejected(f, f.owner, f.command('actor.spell.prepare', { ...payload, spellId: 'absent' }), 'SPELL_UNAVAILABLE');
  f.prepare(true);
  rejected(f, f.owner, f.command('actor.spell.prepare', { ...payload, prepared: false }), 'SPELL_STALE');
  f.run(f.gm, 'actor.update', { id: f.actor.id, owners: [] });
  rejected(f, f.owner, f.command('actor.spell.prepare', { ...payload, spellVersion: 2, prepared: false }), 'FORBIDDEN');
  rejected(f, f.owner, f.command('actor.action.execute', f.execute()), 'FORBIDDEN');
  f.prepare(false, f.gm); assert.equal(f.spell().preparation, 'unprepared');
});

test('always-prepared groups cannot be unprepared and cantrips require neither preparation nor a slot', () => {
  const always = fixture(1, 'always');
  assert.deepEqual(actionPreparation(always.actor, always.actor.actions[0]), { known: true, prepared: true, requiresPreparation: false });
  assert.equal(always.preview().available, true);
  rejected(always, always.owner, always.command('actor.spell.prepare', { id: always.actor.id, spellId: always.spell().id, spellVersion: 1, prepared: false }), 'ALWAYS_PREPARED');
  rejected(always, always.gm, always.command('actor.spell.prepare', { id: always.actor.id, spellId: always.spell().id, spellVersion: 1, prepared: true }), 'NO_CHANGE');
  const cantrip = fixture(0), before = structuredClone(cantrip.actor.resources);
  assert.deepEqual(actionPreparation(cantrip.actor, cantrip.actor.actions[0]), { known: true, prepared: false, requiresPreparation: false });
  assert.equal(cantrip.preview().available, true);
  cantrip.run(cantrip.owner, 'actor.action.execute', cantrip.execute());
  assert.deepEqual(cantrip.actor.resources, before); assert.deepEqual(cantrip.campaign.actionResolutions[0].costs, []);
  assert.equal(cantrip.campaign.actionResolutions[0].spell!.level, 0);
});

test('generic commands cannot create bindings, mutate imported activities or replace the spellcasting group', () => {
  const f = fixture(1, 'prepared'), action = f.actor.actions[0];
  for (const [type, patch] of [
    ['actor.action.update', { name: 'Changed' }], ['actor.action.delete', {}], ['actor.action.prepare', { prepared: false }],
  ] as const) rejected(f, f.gm, f.command(type, { id: f.actor.id, actionId: action.id, actionVersion: 1, ...patch }), 'SPELL_BOUND_ACTION');
  for (const patch of [{ spellId: 'runtime-spell' }, { casting: context }, { inheritance: action.inheritance }]) {
    rejected(f, f.gm, f.command('actor.action.create', { id: f.actor.id, name: 'Forged binding', ...patch }), 'VALIDATION');
  }
  for (const spellcasting of [null, {}, f.actor.spellcasting]) {
    rejected(f, f.gm, f.command('actor.update', { id: f.actor.id, name: 'Must not change', spellcasting }), 'VALIDATION');
  }
  rejected(f, f.gm, f.command('actor.resource.delete', { id: f.actor.id, resourceId: 'runtime-slot-1' }), 'RESOURCE_IN_USE');
});

test('bound activity preflight fails closed for absent groups, unsupported context and non-base slot costs', () => {
  const cases: { expected: string; change: (f: ReturnType<typeof fixture>) => void }[] = [
    { expected: 'SPELL_UNAVAILABLE', change: f => { delete f.actor.spellcasting; } },
    { expected: 'SPELL_UNAVAILABLE', change: f => { f.actor.actions[0].spellId = 'missing'; } },
    { expected: 'SPELL_UNAVAILABLE', change: f => { f.actor.spellcasting!.spells.push(structuredClone(f.spell())); } },
    { expected: 'SPELL_UNSUPPORTED', change: f => { delete f.actor.actions[0].casting; } },
    { expected: 'SPELL_UNSUPPORTED', change: f => { f.actor.actions[0].casting!.range = { type: 'distance', value: Infinity, unit: 'ft' }; } },
    { expected: 'SPELL_UNSUPPORTED', change: f => { f.actor.actions[0].casting!.range = { type: 'distance', value: 0, unit: 'ft' }; } },
    { expected: 'SPELL_UNSUPPORTED', change: f => { f.actor.actions[0].costs = []; } },
    { expected: 'SPELL_UNSUPPORTED', change: f => { f.actor.actions[0].costs[0].amount = 2; } },
    { expected: 'SPELL_UNSUPPORTED', change: f => { f.actor.resources[0].level = 2; } },
    { expected: 'SPELL_UNSUPPORTED', change: f => { f.actor.resources[0].kind = 'custom'; } },
    { expected: 'SPELL_UNSUPPORTED', change: f => { f.actor.resources[0].max = null; } },
    { expected: 'SPELL_UNSUPPORTED', change: f => { f.actor.resources[0].value = 1.5; } },
    { expected: 'SPELL_UNSUPPORTED', change: f => { f.actor.resources[0].value = Infinity; } },
    { expected: 'SPELL_UNSUPPORTED', change: f => { f.actor.resources[0].value = 3; } },
    { expected: 'RESOURCE_UNKNOWN', change: f => { f.actor.resources[0].value = null; } },
    { expected: 'SPELL_UNSUPPORTED', change: f => { f.actor.actions[0].costs.push({ resourceId: 'runtime-action-pool', amount: 1 }); } },
    { expected: 'SPELL_UNSUPPORTED', change: f => { f.spell().level = 0; } },
  ];
  for (const row of cases) {
    const f = fixture(1, 'prepared'); row.change(f); const before = structuredClone(f.campaign); let rngCalls = 0;
    assert.equal(f.preview().reasons[0].code, row.expected);
    assert.throws(() => applyActionCommand(f.campaign, f.owner, f.command('actor.action.execute', f.execute()), { roll: () => { rngCalls++; throw new Error('Forbidden RNG'); } }), code(row.expected));
    assert.equal(rngCalls, 0); assert.deepEqual(f.campaign, before);
  }
});

test('cast snapshots capture the spell group and subsequent preparation changes do not alter typed outcomes', () => {
  const f = fixture(); f.prepare(true); const damage = f.actor.actions[1];
  const cast = f.run(f.owner, 'actor.action.execute', f.execute(damage)), recorded = structuredClone(f.campaign.actionResolutions[0]);
  assert.deepEqual(recorded.spell, { id: 'runtime-spell', version: 2, name: 'Research spell', description: 'Plain own description', level: 1, method: 'spell', preparation: 'prepared' });
  assert.deepEqual(recorded.action.casting, context); assert.equal(f.actor.resources[0].value, 1); assert.equal(f.actor.resources[1].value, 1);
  assert.equal(f.campaign.outcomeRolls.length, 0); assert.equal(f.actor.hp, 18);
  f.prepare(false);
  rejected(f, f.owner, f.command('actor.action.execute', f.execute(damage)), 'UNPREPARED');
  const roll = f.command('actor.action.rollOutcome', { id: f.actor.id, resolutionId: cast.id, critical: false });
  applyActionCommand(f.campaign, f.owner, roll, { drawDie: () => 4 }); f.campaign.revision++;
  assert.equal(f.campaign.outcomeRolls[0].total, 4); assert.equal(f.actor.hp, 18);
  f.run(f.gm, 'actor.action.applyOutcome', { id: f.actor.id, outcomeId: roll.id, targetTokenId: f.campaign.scenes[0].tokens[0].id, multiplier: 1 });
  assert.equal(f.actor.hp, 14); assert.equal(f.actor.resources[0].value, 1);
  assert.deepEqual(f.campaign.actionResolutions[0], recorded);
  assert.equal(f.campaign.hpApplications[0].resolutionId, cast.id);
});

test('players never receive native spell/activity/resource refs and summary sheets omit optional spellcasting', () => {
  const f = fixture(1, 'prepared'); f.run(f.owner, 'actor.action.execute', f.execute());
  const authoritative = structuredClone(f.campaign), gm = projectSnapshot(f.campaign, f.gm, 'private-invite').campaign;
  assert.equal(gm.actors[0].source!.spellRefs![0].sourceItemId, 'NATIVE_ITEM_SENTINEL');
  const owner = projectSnapshot(f.campaign, f.owner, 'private-invite').campaign;
  const ownedActor = owner.actors.find(actor => actor.id === f.actor.id)!;
  assert.deepEqual(ownedActor.spellcasting, f.actor.spellcasting); assert.equal(Object.hasOwn(ownedActor, 'source'), false);
  assert.deepEqual(owner.actionResolutions[0].spell, f.campaign.actionResolutions[0].spell);
  assert.equal(JSON.stringify(owner).includes('NATIVE_'), false);
  const observer = projectSnapshot(f.campaign, f.foreign, 'private-invite').campaign;
  const summary = observer.actors.find(actor => actor.id === f.actor.id)!;
  assert.equal(summary.sheetAccess, 'summary'); assert.equal(Object.hasOwn(summary, 'spellcasting'), false);
  assert.deepEqual(summary.actions, []); assert.equal(observer.actionResolutions.length, 0); assert.equal(JSON.stringify(observer).includes('NATIVE_'), false);
  assert.deepEqual(f.campaign, authoritative);
});

test('legacy normalization keeps spellcasting absent while persisted new groups and snapshots survive migration', () => {
  const blank = blankActorSheet(), normalized = normalizeActorSheet({ ...blank });
  assert.equal(Object.hasOwn(blank, 'spellcasting'), false); assert.equal(Object.hasOwn(normalized, 'spellcasting'), false);
  const f = fixture(1, 'prepared'); f.run(f.owner, 'actor.action.execute', f.execute());
  const migrated = readCampaign(JSON.stringify(f.campaign));
  assert.deepEqual(migrated, f.campaign); assert.deepEqual(normalizeActorSheet(f.actor).spellcasting, f.actor.spellcasting);
  delete f.actor.spellcasting;
  const legacy = readCampaign(JSON.stringify(f.campaign));
  assert.equal(Object.hasOwn(legacy.actors[0], 'spellcasting'), false);
  assert.deepEqual(legacy.actionResolutions[0].spell, migrated.actionResolutions[0].spell);
});

test('unbound manual actions retain their legacy preparation lifecycle and do not acquire spell snapshots', () => {
  const f = fixture();
  f.actor.resources[0].max = null;
  f.run(f.gm, 'actor.action.create', { id: f.actor.id, name: 'Manual action', known: true, requiresPreparation: true, prepared: false, target: 'none', costs: [{ resourceId: 'runtime-slot-1', amount: 1 }], outcome: { kind: 'manual', text: 'Own action' } });
  const manual = f.actor.actions.at(-1)!;
  assert.deepEqual(actionPreparation(f.actor, manual), { known: true, prepared: false, requiresPreparation: true });
  f.run(f.owner, 'actor.action.prepare', { id: f.actor.id, actionId: manual.id, actionVersion: 1, prepared: true });
  const latest = f.actor.actions.at(-1)!;
  f.run(f.owner, 'actor.action.execute', f.execute(latest));
  assert.equal(Object.hasOwn(f.campaign.actionResolutions[0], 'spell'), false); assert.equal(f.spell().version, 1);
  assert.equal(f.actor.resources[0].value, 1); assert.equal(f.actor.resources[0].max, null);
  f.run(f.gm, 'actor.action.delete', { id: f.actor.id, actionId: latest.id, actionVersion: latest.version });
  assert.equal(f.actor.actions.length, 2);
});

test('no-op and exhausted spell versions cannot mutate the group or activities', () => {
  const f = fixture(1, 'prepared');
  rejected(f, f.owner, f.command('actor.spell.prepare', { id: f.actor.id, spellId: f.spell().id, spellVersion: 1, prepared: true }), 'NO_CHANGE');
  f.spell().version = Number.MAX_SAFE_INTEGER;
  rejected(f, f.owner, f.command('actor.spell.prepare', { id: f.actor.id, spellId: f.spell().id, spellVersion: Number.MAX_SAFE_INTEGER, prepared: false }), 'LIMIT');
});
