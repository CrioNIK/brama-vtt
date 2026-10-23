import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applyActionCommand } from '../server/actions.ts';
import { addPlayer, DomainError, makeScene, projectSnapshot, seedCampaign } from '../server/engine.ts';
import { ACTION_LIMITS, previewHpApplication, previewOutcomeRoll } from '../shared/actions.ts';
import type { ActorAction, Command, Member, TypedActionOutcome } from '../shared/model.ts';

const failure = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
function fixture(outcome: TypedActionOutcome = { kind: 'damage', parts: [{ number: 1, denomination: 4, bonus: 0, type: 'force' }], allowCritical: false }, target: ActorAction['target'] = 'none') {
  const campaign = seedCampaign('Staged outcome', 'GM'), gm = campaign.members[0], actor = campaign.actors[0], scene = campaign.scenes[0];
  const owner = addPlayer(campaign, 'Caster owner'), targetOwner = addPlayer(campaign, 'Target owner'), foreign = addPlayer(campaign, 'Foreign');
  actor.owners = [owner.id];
  const targetActor = campaign.actors[1], token = scene.tokens[1];
  targetActor.owners = [owner.id, targetOwner.id]; targetActor.hp = 7; targetActor.maxHp = 10;
  token.owners = [targetOwner.id]; token.hp = 99; token.maxHp = 100; // Linked token cache is deliberately stale.
  actor.resources = [{ id: 'slot', label: 'Slot1', value: 2, max: 2, kind: 'spell-slot', level: 1, recovery: 'manual' }];
  const action: ActorAction = { id: 'research', version: 1, name: 'Research Spark', description: '', sourceLabel: 'Private source', category: 'spell', known: true, prepared: true, requiresPreparation: true, enabled: true, target, costs: [{ resourceId: 'slot', amount: 1 }], outcome };
  actor.actions = [action];
  const command = (type: Command['type'], payload: Record<string, unknown>): Command => ({ id: randomUUID(), type, payload: { id: actor.id, ...payload }, expectedRevision: campaign.revision });
  const cast = (member = owner) => {
    const cmd = command('actor.action.execute', { actionId: action.id, actionVersion: action.version, visibility: 'public', ...(target === 'token' ? { targetTokenId: token.id } : {}) });
    applyActionCommand(campaign, member, cmd, { drawDie: () => { throw new Error('Cast must not roll'); }, roll: () => { throw new Error('Cast must not use d20'); } });
    return campaign.actionResolutions.at(-1)!;
  };
  const roll = (resolutionId: string, critical = false, value = 4, member = owner) => {
    const cmd = command('actor.action.rollOutcome', { resolutionId, critical });
    applyActionCommand(campaign, member, cmd, { drawDie: () => value });
    return campaign.outcomeRolls.at(-1)!;
  };
  return { campaign, gm, owner, targetOwner, foreign, actor, action, scene, token, targetActor, command, cast, roll };
}

test('typed cast spends once without RNG/HP; independent rolls use the immutable deleted-action snapshot', () => {
  const f = fixture(), targetBefore = f.targetActor.hp, cast = f.cast();
  assert.equal(f.actor.resources[0].value, 1); assert.equal(f.targetActor.hp, targetBefore);
  assert.equal(cast.roll, undefined); assert.equal(cast.manualOutcome, undefined); assert.equal(f.campaign.outcomeRolls.length, 0);
  const original = structuredClone(cast);
  f.action.name = 'Edited'; f.action.outcome = { kind: 'manual', text: 'Do not use' }; f.actor.actions = [];
  const first = f.roll(cast.id, false, 4), second = f.roll(cast.id, false, 2);
  assert.equal(first.total, 4); assert.equal(second.total, 2); assert.notEqual(first.id, second.id);
  assert.equal(first.parts[0].roll.formula, '1d4'); assert.equal(first.parts[0].definition.type, 'force');
  assert.deepEqual(f.campaign.actionResolutions[0], original); assert.equal(f.actor.resources[0].value, 1);
  assert.equal(f.targetActor.hp, targetBefore); assert.equal(f.campaign.hpApplications.length, 0);
  assert.equal(JSON.stringify(f.campaign.chat).includes('Private source'), false);
});

test('typed definitions reject malformed parts, formulas, critical healing and aggregate excess atomically', () => {
  const f = fixture(), before = structuredClone(f.campaign), valid = f.action.outcome;
  const invalid: unknown[] = [
    { ...valid, parts: [] }, { ...valid, formula: '1d4' },
    { ...valid, parts: [{ number: 1, denomination: 4, bonus: '@mod', type: 'force' }] },
    { ...valid, parts: [{ number: 1, denomination: 4, bonus: 0, type: 'force', scaling: 1 }] },
    { ...valid, parts: [{ number: 1.1, denomination: 4, bonus: 0, type: 'force' }] },
    { ...valid, parts: [{ number: 1, denomination: 1, bonus: 0, type: 'force' }] },
    { ...valid, parts: [{ number: 1, denomination: 4, bonus: 100001, type: 'force' }] },
    { ...valid, parts: [{ number: 1, denomination: 4, bonus: 0, type: 'unknown' }] },
    { ...valid, parts: Array.from({ length: 21 }, () => ({ number: 1, denomination: 4, bonus: 0, type: 'force' })) },
    { ...valid, parts: [{ number: 60, denomination: 4, bonus: 0, type: 'force' }, { number: 41, denomination: 6, bonus: 0, type: 'fire' }] },
    { kind: 'healing', parts: [{ number: 1, denomination: 4, bonus: 0, type: 'healing' }], allowCritical: true },
    { kind: 'healing', parts: [{ number: 1, denomination: 4, bonus: 0, type: 'force' }], allowCritical: false },
  ];
  for (const outcome of invalid) {
    assert.throws(() => applyActionCommand(f.campaign, f.gm, f.command('actor.action.update', { actionId: f.action.id, actionVersion: 1, name: 'Must not commit', outcome })), error => error instanceof DomainError);
    assert.deepEqual(f.campaign, before);
  }
});

test('every roll preflight failure precedes RNG, including critical aggregate cap and current permission', () => {
  const cases: { code: string; change?: (f: ReturnType<typeof fixture>, castId: string) => void; payload?: Record<string, unknown>; member?: (f: ReturnType<typeof fixture>) => Member; noRevision?: boolean }[] = [
    { code: 'REVISION_REQUIRED', noRevision: true },
    { code: 'VALIDATION', payload: { critical: 'yes' } },
    { code: 'VALIDATION', payload: { formula: '1d999' } },
    { code: 'OUTCOME_UNAVAILABLE', payload: { resolutionId: 'missing' } },
    { code: 'CRITICAL_UNAVAILABLE', payload: { critical: true } },
    { code: 'FORBIDDEN', member: f => f.foreign },
    { code: 'FORBIDDEN', change: f => { f.actor.owners = []; } },
    { code: 'OUTCOME_UNAVAILABLE', change: f => { f.campaign.actionResolutions[0].action.outcome = { kind: 'manual', text: '' }; } },
    { code: 'LIMIT', change: f => { f.campaign.actionResolutions[0].action.outcome = { kind: 'damage', parts: [{ number: 51, denomination: 4, bonus: 0, type: 'force' }], allowCritical: true }; }, payload: { critical: true } },
    { code: 'LIMIT', change: f => { const r = f.roll(f.campaign.actionResolutions[0].id); f.campaign.outcomeRolls = Array.from({ length: ACTION_LIMITS.receipts }, (_, i) => ({ ...structuredClone(r), id: `full${i}`, commandId: `full${i}` })); } },
  ];
  for (const row of cases) {
    const f = fixture(), cast = f.cast(); row.change?.(f, cast.id);
    const before = structuredClone(f.campaign); let draws = 0;
    const cmd = f.command('actor.action.rollOutcome', { resolutionId: cast.id, critical: false, ...row.payload });
    if (row.noRevision) delete cmd.expectedRevision;
    assert.throws(() => applyActionCommand(f.campaign, row.member?.(f) ?? f.owner, cmd, { drawDie: () => { draws++; return 1; } }), failure(row.code), row.code);
    assert.equal(draws, 0); assert.deepEqual(f.campaign, before);
  }
});

test('critical doubles only dice; negative part totals clamp independently; normal 100-die cap is supported', () => {
  const f = fixture({ kind: 'damage', allowCritical: true, parts: [{ number: 1, denomination: 4, bonus: -10, type: 'force' }, { number: 2, denomination: 6, bonus: 3, type: 'fire' }] });
  const cast = f.cast(), preview = previewOutcomeRoll(cast, true);
  assert.equal(preview.available, true); assert.equal(preview.diceCount, 6);
  const rolled = f.roll(cast.id, true, 2);
  assert.deepEqual(rolled.parts.map(p => [p.roll.formula, p.roll.total, p.amount]), [['2d4-10', -6, 0], ['4d6+3', 11, 11]]);
  assert.equal(rolled.total, 11); assert.equal(f.actor.resources[0].value, 1);
  const cap = fixture({ kind: 'damage', allowCritical: true, parts: [{ number: 100, denomination: 1000, bonus: 100000, type: 'force' }] });
  assert.equal(cap.roll(cap.cast().id, false, 1000).total, 200000);
});

test('damage applies authoritative linked HP with floor multiplier and immutable before/after', () => {
  const f = fixture(), rolled = f.roll(f.cast().id, false, 3), cmd = f.command('actor.action.applyOutcome', { outcomeId: rolled.id, targetTokenId: f.token.id, multiplier: 0.5 });
  const preview = previewHpApplication(projectSnapshot(f.campaign, f.owner, '').campaign, f.owner, rolled, f.token.id, 0.5);
  assert.equal(preview.available, true); assert.equal(preview.requestedAmount, 1); assert.equal(preview.after, 6);
  applyActionCommand(f.campaign, f.owner, cmd, { drawDie: () => { throw new Error('Apply must not roll'); } });
  assert.equal(f.targetActor.hp, 6); assert.equal(f.token.hp, 99); assert.equal(f.actor.resources[0].value, 1);
  const receipt = structuredClone(f.campaign.hpApplications[0]);
  assert.deepEqual([receipt.before, receipt.after, receipt.max, receipt.requestedAmount, receipt.appliedAmount], [7, 6, 10, 1, 1]);
  assert.deepEqual(receipt.hpPool, { kind: 'actor', id: f.targetActor.id });
  f.targetActor.hp = 1; f.targetActor.name = 'Changed'; f.token.name = 'Changed token';
  assert.deepEqual(f.campaign.hpApplications[0], receipt);
  const chat = f.campaign.chat.at(-1)!; assert.equal(chat.text.includes('Lyra'), false); assert.equal(chat.roll, undefined);
});

test('healing clamps max, unlinked HP stays independent, and repeated outcome cannot use a linked alias', () => {
  const f = fixture({ kind: 'healing', parts: [{ number: 1, denomination: 4, bonus: 10, type: 'healing' }], allowCritical: false });
  const rolled = f.roll(f.cast().id);
  applyActionCommand(f.campaign, f.owner, f.command('actor.action.applyOutcome', { outcomeId: rolled.id, targetTokenId: f.token.id, multiplier: 1 }));
  assert.equal(f.targetActor.hp, 10); assert.equal(f.campaign.hpApplications[0].appliedAmount, 3); assert.equal(f.campaign.hpApplications[0].requestedAmount, 14);
  const alias = { ...f.token, id: 'linked-alias', name: 'Alias' }; f.scene.tokens.push(alias);
  f.targetActor.hp = 5;
  const before = structuredClone(f.campaign);
  assert.throws(() => applyActionCommand(f.campaign, f.owner, f.command('actor.action.applyOutcome', { outcomeId: rolled.id, targetTokenId: alias.id, multiplier: 1 })), failure('ALREADY_APPLIED'));
  assert.deepEqual(f.campaign, before);
  const unlinked = { ...f.token, id: 'independent', linked: false, hp: 2, maxHp: 8, owners: [f.owner.id] }; f.scene.tokens.push(unlinked);
  applyActionCommand(f.campaign, f.owner, f.command('actor.action.applyOutcome', { outcomeId: rolled.id, targetTokenId: unlinked.id, multiplier: 1 }));
  assert.equal(unlinked.hp, 8); assert.equal(f.targetActor.hp, 5); assert.deepEqual(f.campaign.hpApplications[1].hpPool, { kind: 'token', id: unlinked.id });
});

test('HP application rejects unknown, invalid, no-change, disallowed multiplier and no authority without mutations', () => {
  const cases: { code: string; change?: (f: ReturnType<typeof fixture>) => void; payload?: Record<string, unknown>; member?: (f: ReturnType<typeof fixture>) => Member }[] = [
    { code: 'HP_UNKNOWN', change: f => { f.targetActor.hp = null; } },
    { code: 'HP_UNKNOWN', change: f => { f.targetActor.maxHp = null; } },
    { code: 'HP_UNKNOWN', change: f => { f.targetActor.hp = 11; } },
    { code: 'HP_UNKNOWN', change: f => { f.targetActor.hp = NaN; } },
    { code: 'HP_UNKNOWN', change: f => { f.targetActor.maxHp = Infinity; } },
    { code: 'NO_CHANGE', change: f => { f.targetActor.hp = 0; } },
    { code: 'NO_CHANGE', payload: { multiplier: 0 } },
    { code: 'VALIDATION', payload: { multiplier: 0.75 } },
    { code: 'VALIDATION', payload: { rawDamage: 999 } },
    { code: 'FORBIDDEN', change: f => { f.targetActor.owners = [f.targetOwner.id]; } },
    { code: 'FORBIDDEN', member: f => f.targetOwner },
    { code: 'FORBIDDEN', change: f => { f.actor.owners = []; } },
    { code: 'TARGET_UNAVAILABLE', change: f => { f.token.linked = true; f.token.actorId = 'missing'; } },
  ];
  for (const row of cases) {
    const f = fixture(), rolled = f.roll(f.cast().id); row.change?.(f);
    const before = structuredClone(f.campaign);
    assert.throws(() => applyActionCommand(f.campaign, row.member?.(f) ?? f.owner, f.command('actor.action.applyOutcome', { outcomeId: rolled.id, targetTokenId: f.token.id, multiplier: 1, ...row.payload })), failure(row.code));
    assert.deepEqual(f.campaign, before, row.code);
  }
  const healing = fixture({ kind: 'healing', allowCritical: false, parts: [{ number: 1, denomination: 4, bonus: 0, type: 'healing' }] });
  const rolled = healing.roll(healing.cast().id), before = structuredClone(healing.campaign);
  assert.throws(() => applyActionCommand(healing.campaign, healing.owner, healing.command('actor.action.applyOutcome', { outcomeId: rolled.id, targetTokenId: healing.token.id, multiplier: 2 })), failure('VALIDATION'));
  assert.deepEqual(healing.campaign, before);
});

test('application target visibility and committed self/token restrictions precede HP lookup', () => {
  for (const which of ['hidden', 'missing', 'inactive-level', 'foreign-scene', 'outside-vision']) {
    const f = fixture(), rolled = f.roll(f.cast().id); let targetTokenId = f.token.id;
    if (which === 'hidden') f.token.hidden = true;
    if (which === 'missing') targetTokenId = 'missing';
    if (which === 'inactive-level') f.token.levelId = 'upper';
    if (which === 'foreign-scene') { const other = makeScene('Elsewhere'); other.tokens = [f.token]; f.scene.tokens = f.scene.tokens.filter(t => t.id !== f.token.id); f.campaign.scenes.push(other); }
    if (which === 'outside-vision') { f.scene.visionEnabled = true; f.scene.tokens.forEach(t => { t.owners = []; }); }
    const before = structuredClone(f.campaign);
    assert.throws(() => applyActionCommand(f.campaign, f.owner, f.command('actor.action.applyOutcome', { outcomeId: rolled.id, targetTokenId, multiplier: 1 })), failure('TARGET_UNAVAILABLE'), which);
    assert.deepEqual(f.campaign, before);
  }
  const self = fixture(undefined, 'self'), rollSelf = self.roll(self.cast().id);
  assert.throws(() => applyActionCommand(self.campaign, self.owner, self.command('actor.action.applyOutcome', { outcomeId: rollSelf.id, targetTokenId: self.token.id, multiplier: 1 })), failure('TARGET_UNAVAILABLE'));
  const ownToken = self.scene.tokens[0];
  applyActionCommand(self.campaign, self.owner, self.command('actor.action.applyOutcome', { outcomeId: rollSelf.id, targetTokenId: ownToken.id, multiplier: 1 }));
  const fixed = fixture(undefined, 'token'), rollFixed = fixed.roll(fixed.cast().id);
  const alias = { ...fixed.token, id: 'wrong-token-same-actor' }; fixed.scene.tokens.push(alias);
  assert.throws(() => applyActionCommand(fixed.campaign, fixed.owner, fixed.command('actor.action.applyOutcome', { outcomeId: rollFixed.id, targetTokenId: alias.id, multiplier: 1 })), failure('TARGET_UNAVAILABLE'));
});

test('receipt projection reveals outcomes only to cast readers and hides HP/pool history after ownership loss', () => {
  const f = fixture(), cast = f.cast(), rolled = f.roll(cast.id);
  applyActionCommand(f.campaign, f.owner, f.command('actor.action.applyOutcome', { outcomeId: rolled.id, targetTokenId: f.token.id, multiplier: 1 }));
  const persisted = structuredClone(f.campaign.hpApplications[0]);
  assert.equal(projectSnapshot(f.campaign, f.foreign, '').campaign.outcomeRolls.length, 0);
  assert.equal(projectSnapshot(f.campaign, f.foreign, '').campaign.hpApplications.length, 0);
  const targetView = projectSnapshot(f.campaign, f.targetOwner, '').campaign;
  assert.equal(targetView.outcomeRolls.length, 0); assert.equal(targetView.hpApplications[0].after, 3);
  f.targetActor.owners = [f.targetOwner.id];
  let ownerView = projectSnapshot(f.campaign, f.owner, '').campaign;
  assert.equal(ownerView.outcomeRolls.length, 1); assert.deepEqual(ownerView.hpApplications[0].hpPool, { kind: 'redacted' });
  assert.deepEqual([ownerView.hpApplications[0].before, ownerView.hpApplications[0].after, ownerView.hpApplications[0].max, ownerView.hpApplications[0].appliedAmount], [null, null, null, null]);
  f.token.hidden = true; ownerView = projectSnapshot(f.campaign, f.owner, '').campaign;
  assert.deepEqual(ownerView.hpApplications[0].target, { kind: 'redacted' });
  assert.equal(projectSnapshot(f.campaign, f.targetOwner, '').campaign.hpApplications[0].before, null);
  assert.deepEqual(f.campaign.hpApplications[0], persisted);
  assert.deepEqual(projectSnapshot(f.campaign, f.gm, '').campaign.hpApplications[0], persisted);
});

test('all ledgers participate in cross-intent ID guards and full HP ledger rejects before mutation', () => {
  const f = fixture(), cast = f.cast(), rolled = f.roll(cast.id), before = structuredClone(f.campaign);
  assert.throws(() => applyActionCommand(f.campaign, f.owner, { ...f.command('actor.action.rollOutcome', { resolutionId: cast.id, critical: false }), id: cast.id }), failure('ID_REUSED'));
  assert.throws(() => applyActionCommand(f.campaign, f.owner, { ...f.command('actor.action.applyOutcome', { outcomeId: rolled.id, targetTokenId: f.token.id, multiplier: 1 }), id: rolled.id }), failure('ID_REUSED'));
  assert.deepEqual(f.campaign, before);
  applyActionCommand(f.campaign, f.owner, f.command('actor.action.applyOutcome', { outcomeId: rolled.id, targetTokenId: f.token.id, multiplier: 1 }));
  const app = f.campaign.hpApplications[0];
  f.campaign.hpApplications = Array.from({ length: ACTION_LIMITS.receipts }, (_, i) => ({ ...structuredClone(app), id: `hp${i}`, commandId: `hp${i}`, outcomeId: `other${i}` }));
  const full = structuredClone(f.campaign);
  assert.throws(() => applyActionCommand(f.campaign, f.owner, f.command('actor.action.applyOutcome', { outcomeId: rolled.id, targetTokenId: f.token.id, multiplier: 1 })), failure('LIMIT'));
  assert.deepEqual(f.campaign, full);
});
