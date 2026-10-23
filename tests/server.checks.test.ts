import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { addPlayer, applyCommand, DomainError, projectSnapshot, rollActorCheck, seedCampaign } from '../server/engine.ts';
import { applyCheckCommand, rollConfiguredCheck } from '../server/checks.ts';
import { Store } from '../server/store.ts';
import { readCampaign } from '../server/migrations.ts';
import { blankActorChecks, previewCheck, validActorChecks } from '../shared/checks.ts';
import { ABILITY_KEYS, SKILL_KEYS, blankActorSheet, normalizeActorSheet } from '../shared/model.ts';
import type { ActorChecks, CheckRequest, Command, Member, RollMode } from '../shared/model.ts';

function fixture() {
  const campaign = seedCampaign('Check contract', 'GM'), gm = campaign.members[0], owner = addPlayer(campaign, 'Owner'), other = addPlayer(campaign, 'Other');
  const actor = campaign.actors[0]; actor.sheetKind = 'dnd5e'; actor.owners = [owner.id];
  actor.abilities = { str: 16, dex: 14, con: 12, int: 10, wis: 8, cha: 6 };
  actor.checks = blankActorChecks(); actor.checks.version = 1; actor.checks.proficiency = { mode: 'manual', bonus: 3, level: null };
  const command = (type: Command['type'], payload: Record<string, unknown>, extra: Partial<Command> = {}): Command => ({ id: randomUUID(), type, payload, expectedRevision: campaign.revision, ...extra });
  const run = (member: Member, type: Command['type'], payload: Record<string, unknown>) => { const cmd = command(type, payload); applyCommand(campaign, member, cmd); campaign.revision++; return cmd; };
  const roll = (extra: Record<string, unknown> = {}) => ({ id: actor.id, kind: 'skill', key: 'ath', mode: 'default', visibility: 'public', ...extra });
  return { campaign, gm, owner, other, actor, command, run, roll };
}
const withoutVersion = (checks: ActorChecks) => { const { version, ...value } = structuredClone(checks); return value; };
const hasCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
function rejected(f: ReturnType<typeof fixture>, member: Member, command: Command, code: string) {
  const before = structuredClone(f.campaign); let draws = 0;
  assert.throws(() => applyCheckCommand(f.campaign, member, command, () => { draws++; return 10; }), hasCode(code));
  assert.equal(draws, 0); assert.deepEqual(f.campaign, before);
}

test('checks initialize explicitly, preserve legacy absence, and validate every complete typed field', () => {
  assert.equal(Object.hasOwn(blankActorSheet(), 'checks'), false);
  assert.equal(Object.hasOwn(normalizeActorSheet(blankActorSheet()), 'checks'), false);
  const blank = blankActorChecks(); assert.equal(blank.version, 0); assert.equal(blank.proficiency.bonus, null);
  assert.equal(Object.keys(blank.skills).length, 18); assert.equal(Object.keys(blank.saves).length, 6); assert.equal(validActorChecks(blank), true);
  const f = fixture(); delete f.actor.checks;
  assert.equal(previewCheck(f.actor, { kind: 'skill', key: 'ath' }).blockedReasons[0].code, 'CHECKS_UNAVAILABLE');
  assert.equal(Object.hasOwn(readCampaign(JSON.stringify(f.campaign)).actors[0], 'checks'), false);
  const bad: ((c: any) => void)[] = [c => c.global.check.bonus = 1.5, c => c.skills.ath.passiveBonus = Infinity, c => c.skills.ath.bonus = -1001,
    c => c.saves.str.proficiency = 2, c => c.skills.ath.proficiency = 0.25, c => c.skills.ath.ability = 'luck', c => c.global.check.mode = 'best',
    c => delete c.skills.sur, c => c.skills.fake = c.skills.ath, c => c.abilities.str.extra = 0, c => c.skills.ath.sourcePath = 'native',
    c => c.unsupported = [{ scope: 'skill', key: 'fake', code: 'X', reason: 'Unknown' }], c => c.proficiency = { mode: 'manual', bonus: null, level: null },
    c => c.proficiency = { mode: 'unknown', bonus: 2, level: null }, c => c.proficiency = { mode: 'class-level', bonus: 2, level: 0 }];
  for (const mutate of bad) {
    const value = blankActorChecks(); mutate(value); assert.equal(validActorChecks(value), false);
    f.actor.checks = value; const blocked = previewCheck(f.actor, { kind: 'skill', key: 'ath' });
    assert.equal(blocked.modifier, null); assert.equal(blocked.blockedReasons[0].code, 'CHECKS_INVALID');
  }
  for (const malformed of [null, [], {}, { profile: 'dnd5e-checks-v1' }, { ...blankActorChecks(), abilities: null }]) {
    f.actor.checks = malformed as unknown as ActorChecks;
    assert.equal(previewCheck(f.actor, { kind: 'skill', key: 'ath' }).blockedReasons[0].code, 'CHECKS_INVALID');
  }
});

test('all 18 skills and six saves compute distinct bonus paths and proficiency ranks', () => {
  const f = fixture(), c = f.actor.checks!;
  c.global.check.bonus = 1; c.global.skill.bonus = 2; c.global.save.bonus = 11;
  ABILITY_KEYS.forEach(key => { c.abilities[key].check.bonus = 4; c.saves[key].bonus = 13; });
  const defaults = { acr: 'dex', ani: 'wis', arc: 'int', ath: 'str', dec: 'cha', his: 'int', ins: 'wis', itm: 'cha', inv: 'int', med: 'wis', nat: 'int', prc: 'wis', prf: 'cha', per: 'cha', rel: 'int', slt: 'dex', ste: 'dex', sur: 'wis' } as const;
  for (const key of SKILL_KEYS) {
    c.skills[key].bonus = 8;
    for (const rank of [0, 0.5, 1, 2] as const) {
      c.skills[key].proficiency = rank;
      const p = previewCheck(f.actor, { kind: 'skill', key });
      assert.equal(p.modifier, Math.floor((f.actor.abilities[defaults[key]]! - 10) / 2) + Math.floor(3 * rank) + 15);
      assert.equal(p.snapshot.proficiency.contribution, Math.floor(3 * rank)); assert.deepEqual(p.blockedReasons, []);
    }
  }
  for (const key of ABILITY_KEYS) {
    for (const rank of [0, 1] as const) { c.saves[key].proficiency = rank; assert.equal(previewCheck(f.actor, { kind: 'save', key }).modifier, Math.floor((f.actor.abilities[key]! - 10) / 2) + 3 * rank + 24); }
    assert.equal(previewCheck(f.actor, { kind: 'ability', key }).modifier, Math.floor((f.actor.abilities[key]! - 10) / 2) + 5);
    assert.equal(previewCheck(f.actor, { kind: 'save', key }).passive, null);
  }
});

test('unknown PB blocks only proficient checks and class levels use the agreed bounded calculation', () => {
  const f = fixture(), c = f.actor.checks!; c.proficiency = { mode: 'unknown', bonus: null, level: null };
  assert.equal(previewCheck(f.actor, { kind: 'skill', key: 'ath' }).modifier, 3);
  assert.equal(previewCheck(f.actor, { kind: 'ability', key: 'str' }).modifier, 3);
  for (const rank of [0.5, 1, 2] as const) { c.skills.ath.proficiency = rank; assert.equal(previewCheck(f.actor, { kind: 'skill', key: 'ath' }).blockedReasons[0].code, 'PROFICIENCY_UNKNOWN'); }
  c.saves.str.proficiency = 1; assert.equal(previewCheck(f.actor, { kind: 'save', key: 'str' }).modifier, null);
  for (const [level, pb] of [[0, 1], [1, 2], [4, 2], [5, 3], [20, 6], [1000, 251]]) {
    c.proficiency = { mode: 'class-level', level, bonus: pb }; assert.equal(validActorChecks(c), true);
    assert.equal(previewCheck(f.actor, { kind: 'save', key: 'str' }).modifier, 3 + pb);
  }
  c.proficiency = { mode: 'manual', bonus: 0, level: null }; assert.equal(previewCheck(f.actor, { kind: 'save', key: 'str' }).modifier, 3);
  f.actor.abilities.str = null; assert.equal(previewCheck(f.actor, { kind: 'save', key: 'str' }).blockedReasons[0].code, 'ABILITY_UNKNOWN');
});

test('configured advantage and disadvantage cancel regardless of counts, while explicit roll modes override', () => {
  const f = fixture(), c = f.actor.checks!, modes: RollMode[] = ['normal', 'advantage', 'disadvantage'];
  for (const check of modes) for (const skill of modes) for (const ability of modes) for (const local of modes) {
    c.global.check.mode = check; c.global.skill.mode = skill; c.abilities.str.check.mode = ability; c.skills.ath.mode = local;
    const list = [check, skill, ability, local], adv = list.includes('advantage'), dis = list.includes('disadvantage');
    const expected = adv === dis ? 'normal' : adv ? 'advantage' : 'disadvantage';
    for (const override of ['default', ...modes] as const) {
      let draws = 0; const result = rollConfiguredCheck(f.actor, { kind: 'skill', key: 'ath', mode: override }, () => [4, 18][draws++]);
      const actualMode = override === 'default' ? expected : override;
      assert.equal(result.d20!.mode, actualMode); assert.equal(result.checkSnapshot!.configuredMode, expected);
      assert.equal(draws, actualMode === 'normal' ? 1 : 2); assert.equal(result.total, (actualMode === 'advantage' ? 18 : 4) + 3);
      assert.equal(result.checkSnapshot!.passive, 13 + (expected === 'advantage' ? 5 : expected === 'disadvantage' ? -5 : 0));
    }
  }
  const tied = rollConfiguredCheck(f.actor, { kind: 'save', key: 'str', mode: 'advantage' }, () => 7); assert.equal(tied.d20!.keptIndex, 0);
});

test('situational ability override uses active effects and its ability bonus; passive excludes one-shot bonus and mode', () => {
  const f = fixture(), c = f.actor.checks!;
  c.skills.ath.proficiency = 2; c.skills.ath.bonus = 2; c.skills.ath.passiveBonus = 3; c.skills.ath.mode = 'advantage';
  c.abilities.str.check.bonus = 50; c.abilities.dex.check.bonus = 4;
  f.actor.effects = [{ id: 'active', name: 'Private agility', description: '', disabled: false, changes: [{ ability: 'dex', mode: 'add', value: 2 }] },
    { id: 'disabled', name: 'Inactive', description: '', disabled: true, changes: [{ ability: 'dex', mode: 'add', value: 100 }] }];
  const before = structuredClone(f.actor), p = previewCheck(f.actor, { kind: 'skill', key: 'ath', abilityOverride: 'dex', situationalBonus: 9, mode: 'disadvantage' });
  assert.equal(p.modifier, 24); assert.equal(p.passive, 33); assert.equal(p.mode, 'disadvantage');
  assert.equal(p.snapshot.defaultAbility, 'str'); assert.equal(p.snapshot.ability, 'dex');
  assert.deepEqual(p.snapshot.abilityBreakdown!.contributions, [{ effectId: 'active', effectName: 'Private agility', value: 2 }]);
  assert.deepEqual(p.snapshot.bonusContributions.map(v => v.key), ['global.check', 'global.skill', 'ability', 'skill', 'situational']);
  assert.deepEqual(f.actor, before);
});

test('unsupported rules block only their declared scope and cannot be bypassed by situational mode or ability', () => {
  const f = fixture(), c = f.actor.checks!;
  c.unsupported = [{ scope: 'skill', key: 'ath', code: 'FORMULA', reason: 'Unsupported local bonus' }];
  assert.equal(previewCheck(f.actor, { kind: 'skill', key: 'ath', abilityOverride: 'dex', mode: 'normal' }).modifier, null);
  assert.equal(previewCheck(f.actor, { kind: 'skill', key: 'acr' }).modifier, 2);
  c.unsupported = [{ scope: 'ability', key: 'dex', code: 'FORMULA', reason: 'Unsupported ability-check bonus' }];
  for (const request of [{ kind: 'skill', key: 'acr' }, { kind: 'skill', key: 'ath', abilityOverride: 'dex' }, { kind: 'ability', key: 'dex' }] as CheckRequest[]) assert.equal(previewCheck(f.actor, request).blockedReasons[0].code, 'CHECK_UNSUPPORTED');
  assert.equal(previewCheck(f.actor, { kind: 'skill', key: 'ath' }).modifier, 3);
  for (const key of ['dex', null] as const) {
    c.unsupported[0].key = key;
    const preview = previewCheck(f.actor, { kind: 'save', key: 'dex' });
    assert.deepEqual(preview.blockedReasons, []); assert.equal(preview.modifier, 2);
    const command = f.command('actor.check.roll', f.roll({ kind: 'save', key: 'dex' }));
    assert.equal(applyCheckCommand(f.campaign, f.owner, command, () => 10), true); f.campaign.revision++;
    assert.equal(f.campaign.chat.at(-1)!.roll!.total, 12, 'Ability-check formulas must not block saving throws.');
  }
  c.unsupported = [{ scope: 'save', key: null, code: 'BONUS', reason: 'Unknown saves' }];
  assert.equal(previewCheck(f.actor, { kind: 'save', key: 'str' }).modifier, null); assert.equal(previewCheck(f.actor, { kind: 'ability', key: 'str' }).modifier, 3);
  c.unsupported = [{ scope: 'all', key: null, code: 'DICE', reason: 'Unsupported proficiency mode' }];
  for (const kind of ['skill', 'ability', 'save'] as const) assert.equal(previewCheck(f.actor, { kind, key: kind === 'skill' ? 'ath' : 'str' }).modifier, null);
});

test('new roll rejects invalid, unknown, stale and unauthorized input atomically before RNG', () => {
  const f = fixture();
  rejected(f, f.owner, f.command('actor.check.roll', f.roll(), { expectedRevision: undefined }), 'REVISION_REQUIRED');
  rejected(f, f.owner, f.command('actor.check.roll', f.roll(), { expectedRevision: -1 }), 'VALIDATION');
  rejected(f, f.owner, f.command('actor.check.roll', f.roll(), { expectedRevision: 100 }), 'CONFLICT');
  rejected(f, f.other, f.command('actor.check.roll', f.roll()), 'FORBIDDEN');
  for (const extra of [{ key: 'fake' }, { kind: 'attack' }, { kind: 'save', key: 'str', abilityOverride: 'dex' }, { abilityOverride: 'fake' }, { situationalBonus: 1.5 }, { situationalBonus: 1001 }, { situationalBonus: Infinity }, { mode: undefined }, { visibility: 'everyone' }, { modifier: 99 }, { dice: [20] }, { sourcePath: 'native' }]) rejected(f, f.owner, f.command('actor.check.roll', f.roll(extra)), 'VALIDATION');
  f.actor.abilities.str = null; rejected(f, f.owner, f.command('actor.check.roll', f.roll()), 'ABILITY_UNKNOWN');
  f.actor.abilities.str = 16; f.actor.checks!.proficiency = { mode: 'unknown', bonus: null, level: null }; f.actor.checks!.skills.ath.proficiency = 1;
  rejected(f, f.owner, f.command('actor.check.roll', f.roll()), 'PROFICIENCY_UNKNOWN');
  f.actor.checks!.skills.ath.proficiency = 0; f.actor.checks!.unsupported = [{ scope: 'skill', key: 'ath', code: 'FORMULA', reason: 'Not supported' }];
  rejected(f, f.owner, f.command('actor.check.roll', f.roll()), 'CHECK_UNSUPPORTED');
});

test('full checks updates require current version and ownership, preserve unsupported diagnostics and reject generic patch', () => {
  const f = fixture(); f.actor.checks!.unsupported = [{ scope: 'save', key: 'dex', code: 'FORMULA', reason: 'Preserved import diagnostic' }];
  const payload = () => ({ id: f.actor.id, checksVersion: f.actor.checks!.version, checks: withoutVersion(f.actor.checks!) });
  rejected(f, f.owner, f.command('actor.checks.update', payload(), { expectedRevision: undefined }), 'REVISION_REQUIRED');
  rejected(f, f.other, f.command('actor.checks.update', payload()), 'FORBIDDEN');
  rejected(f, f.owner, f.command('actor.checks.update', { ...payload(), checksVersion: 0 }), 'CHECKS_STALE');
  rejected(f, f.owner, f.command('actor.checks.update', { ...payload(), checks: { ...payload().checks, version: 42 } }), 'VALIDATION');
  rejected(f, f.owner, f.command('actor.checks.update', { ...payload(), checks: { ...payload().checks, unsupported: [] } }), 'CHECKS_UNSUPPORTED_IMMUTABLE');
  const invalid = payload(); invalid.checks.global.skill.bonus = 1.5;
  rejected(f, f.owner, f.command('actor.checks.update', invalid), 'VALIDATION');
  const before = structuredClone(f.campaign);
  assert.throws(() => applyCommand(f.campaign, f.owner, f.command('actor.update', { id: f.actor.id, name: 'Should not change', checks: null })), hasCode('VALIDATION')); assert.deepEqual(f.campaign, before);
  const update = payload(); update.checks.skills.ath.proficiency = 2; f.run(f.owner, 'actor.checks.update', update);
  assert.equal(f.actor.checks!.version, 2); assert.equal(f.actor.checks!.skills.ath.proficiency, 2);
  assert.deepEqual(f.actor.checks!.unsupported, before.actors[0].checks!.unsupported);
  f.run(f.gm, 'actor.update', { id: f.actor.id, owners: [] });
  rejected(f, f.owner, f.command('actor.checks.update', payload()), 'FORBIDDEN');
  rejected(f, f.owner, f.command('actor.check.roll', f.roll()), 'FORBIDDEN');
  f.run(f.gm, 'actor.checks.update', payload()); assert.equal(f.actor.checks!.version, 3);
});

test('public roll reveals totals but provenance only to author, GM and current owner; private visibility and source stripping persist', () => {
  const f = fixture(); f.actor.source = { sourceActorRef: 'NATIVE_SECRET', resolution: 'resolved', systemId: 'dnd5e', systemVersion: '6.0.6' };
  f.actor.effects = [{ id: 'effect-private', name: 'PRIVATE_BREAKDOWN', description: '', disabled: false, changes: [{ ability: 'str', mode: 'add', value: 2 }] }];
  f.run(f.gm, 'actor.check.roll', f.roll());
  const publicId = f.campaign.chat.at(-1)!.id;
  f.run(f.owner, 'actor.check.roll', f.roll({ visibility: 'self' })); const selfId = f.campaign.chat.at(-1)!.id;
  f.run(f.owner, 'actor.check.roll', f.roll({ visibility: 'gm' })); const gmId = f.campaign.chat.at(-1)!.id;
  const full = structuredClone(f.campaign), owner = projectSnapshot(f.campaign, f.owner, '').campaign, other = projectSnapshot(f.campaign, f.other, '').campaign;
  assert.ok(owner.chat.find(m => m.id === publicId)!.roll!.checkSnapshot); assert.ok(owner.chat.find(m => m.id === selfId)); assert.ok(owner.chat.find(m => m.id === gmId));
  assert.equal(other.chat.find(m => m.id === publicId)!.roll!.checkSnapshot, undefined); assert.equal(other.chat.some(m => m.id === selfId || m.id === gmId), false);
  assert.equal(other.actors.find(a => a.id === f.actor.id)!.checks, undefined); assert.equal(JSON.stringify(other).includes('PRIVATE_BREAKDOWN'), false);
  assert.equal(JSON.stringify(owner).includes('NATIVE_SECRET'), false); assert.ok(projectSnapshot(f.campaign, f.gm, '').campaign.actors[0].source);
  f.run(f.gm, 'actor.update', { id: f.actor.id, owners: [f.other.id] });
  const former = projectSnapshot(f.campaign, f.owner, '').campaign, current = projectSnapshot(f.campaign, f.other, '').campaign;
  assert.equal(former.chat.find(m => m.id === publicId)!.roll!.checkSnapshot, undefined);
  assert.ok(former.chat.find(m => m.id === selfId)!.roll!.checkSnapshot, 'Author retains historical provenance after ownership changes.');
  assert.ok(current.chat.find(m => m.id === publicId)!.roll!.checkSnapshot);
  assert.deepEqual(full.chat, f.campaign.chat, 'Projection and ownership changes do not rewrite history.');
});

test('check snapshots capture independent data and survive later edits, effects and migration unchanged', () => {
  const f = fixture(); f.actor.checks!.skills.ath.proficiency = 1;
  f.run(f.owner, 'actor.check.roll', f.roll({ abilityOverride: 'dex', situationalBonus: -2, mode: 'advantage' }));
  const recorded = structuredClone(f.campaign.chat.at(-1)!);
  const next = withoutVersion(f.actor.checks!); next.proficiency = { mode: 'manual', bonus: 7, level: null }; next.skills.ath.bonus = 5;
  f.run(f.owner, 'actor.checks.update', { id: f.actor.id, checksVersion: 1, checks: next });
  f.run(f.owner, 'actor.update', { id: f.actor.id, abilities: { dex: 20 } });
  f.actor.effects.push({ id: 'later', name: 'Later effect', description: '', disabled: false, changes: [{ ability: 'dex', mode: 'add', value: 2 }] });
  assert.deepEqual(f.campaign.chat.find(m => m.id === recorded.id), recorded);
  assert.deepEqual(readCampaign(JSON.stringify(f.campaign)).chat.find(m => m.id === recorded.id), recorded);
  assert.deepEqual(normalizeActorSheet(f.actor).checks, f.actor.checks);
  assert.equal(recorded.roll!.checkSnapshot!.checksVersion, 1); assert.equal(recorded.roll!.checkSnapshot!.proficiency.bonus, 3);
  assert.equal(recorded.roll!.checkSnapshot!.abilityBreakdown!.effective, 14);
});

test('SQLite reopen preserves configuration, exact roll ACK and dice; changed and cross-session IDs cannot repeat', () => {
  const parent = resolve(tmpdir()), dir = mkdtempSync(join(parent, 'vtt-checks-')), path = join(dir, 'checks.sqlite');
  let store = new Store(path);
  try {
    const gmAuth = store.create('Persistent checks', 'GM'), gm = store.authenticate(gmAuth.token), ownerAuth = store.join(store.snapshot(gm).inviteCode!, 'Owner'), owner = store.authenticate(ownerAuth.token);
    const send = (session: typeof gm, type: Command['type'], payload: Record<string, unknown>) => {
      const command: Command = { id: randomUUID(), type, payload, expectedRevision: store.snapshot(gm).campaign.revision };
      const result = store.command(session, command); assert.equal(result.ack.ok, true, result.ack.error); return { command, result };
    };
    send(gm, 'actor.create', { name: 'Persistent hero', sheetKind: 'dnd5e', owners: [ownerAuth.memberId], abilities: { str: 16 } });
    const actorId = store.snapshot(gm).campaign.actors.at(-1)!.id;
    const checks = blankActorChecks(); checks.proficiency = { mode: 'manual', bonus: 3, level: null }; checks.skills.ath.proficiency = 2;
    send(owner, 'actor.checks.update', { id: actorId, checksVersion: 0, checks: withoutVersion(checks) });
    const rolled = send(owner, 'actor.check.roll', { id: actorId, kind: 'skill', key: 'ath', mode: 'advantage', visibility: 'public' });
    const before = store.export(gm), recorded = before.chat.at(-1)!;
    store.close(); store = new Store(path);
    assert.deepEqual(store.command(owner, rolled.command), { ack: rolled.result.ack, changed: false });
    assert.deepEqual(store.export(gm), before); assert.deepEqual(store.snapshot(owner).campaign.chat.at(-1), recorded);
    assert.equal(store.command(owner, { ...rolled.command, payload: { ...rolled.command.payload, mode: 'normal' } }).ack.code, 'ID_REUSED');
    assert.equal(store.command(gm, rolled.command).ack.code, 'CONFLICT');
    assert.equal(store.command(gm, { ...rolled.command, expectedRevision: before.revision }).ack.code, 'ID_REUSED');
    const stale: Command = { id: randomUUID(), type: 'actor.checks.update', expectedRevision: before.revision, payload: { id: actorId, checksVersion: 0, checks: withoutVersion(checks) } };
    assert.equal(store.command(owner, stale).ack.code, 'CHECKS_STALE'); assert.deepEqual(store.export(gm), before);
    send(gm, 'actor.update', { id: actorId, owners: [] });
    const afterRevoke = store.export(gm);
    assert.equal(store.command(owner, { ...rolled.command, id: randomUUID(), expectedRevision: afterRevoke.revision }).ack.code, 'FORBIDDEN');
    assert.deepEqual(store.export(gm), afterRevoke);
    assert.deepEqual(store.command(owner, rolled.command), { ack: rolled.result.ack, changed: false }, 'Exact retry remains an ACK replay, not a fresh roll.');
  } finally {
    store.close(); const resolved = resolve(dir); assert.ok(resolved.startsWith(parent + sep)); rmSync(resolved, { recursive: true, force: true });
  }
});

test('legacy actor d20 remains independent of checks profiles and situational skill rules', () => {
  const f = fixture(); delete f.actor.checks;
  assert.equal(rollActorCheck(f.actor, { ability: 'str', mode: 'normal' }, () => 8).total, 11);
  const legacy = rollActorCheck(f.actor, { modifier: -2, mode: 'normal' }, () => 8); assert.equal(legacy.total, 6); assert.equal(legacy.checkSnapshot, undefined);
  const draft = blankActorChecks();
  f.run(f.owner, 'actor.checks.update', { id: f.actor.id, checksVersion: 0, checks: withoutVersion(draft) });
  assert.equal(f.actor.checks!.version, 1); assert.equal(f.actor.checks!.proficiency.bonus, null);
  f.run(f.owner, 'actor.check.roll', f.roll()); assert.equal(f.campaign.chat.at(-1)!.roll!.modifier, 3);
  for (const [kind, key, label] of [['skill', 'acr', 'Acrobatics'], ['ability', 'wis', 'Check: Wisdom'], ['save', 'con', 'Saving throw: Constitution']] as const) {
    f.run(f.owner, 'actor.check.roll', f.roll({ kind, key }));
    const message = f.campaign.chat.at(-1)!;
    assert.equal(message.text, `${f.actor.name} · ${label}`);
    assert.equal(message.roll!.checkSnapshot!.kind, kind); assert.equal(message.roll!.checkSnapshot!.key, key);
  }
});
