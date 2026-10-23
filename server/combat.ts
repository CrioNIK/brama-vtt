import { randomUUID } from 'node:crypto';
import type { Campaign, Combatant, CombatCounter, Command, Member } from '../shared/model.ts';
import { blankCombat, COMBAT_LIMITS, initiativePreview, preserveCombatCurrent, removeCombatEntries, sortCombatants } from '../shared/combat.ts';
import { fail, object, projectSnapshot, rollDice, str } from './engine.ts';

const commands = new Set(['combat.add', 'combat.remove', 'combat.roll', 'combat.next', 'combat.end', 'combat.update', 'combat.custom', 'combat.previous', 'combat.settings', 'combat.reset', 'combat.clear', 'combat.endTurn']);
function keys(p: Record<string, unknown>, allowed: string[]) { if (Object.keys(p).some(k => !allowed.includes(k))) fail('VALIDATION', "Unknown combat-command field."); }
function integer(value: unknown, name: string, limit: number = COMBAT_LIMITS.counter): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Math.abs(value) > limit) return fail('VALIDATION', `Invalid integer ${name}.`);
  return value;
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') return fail('VALIDATION', "Expected a boolean."); return value; }
function initiative(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > COMBAT_LIMITS.initiative) return fail('VALIDATION', "Initiative must be a finite number within ±2000000.");
  return value;
}
function counter(value: unknown): CombatCounter {
  const p = object(value); keys(p, ['value', 'step', 'event']);
  if (!['round', 'turn'].includes(p.event as string)) return fail('VALIDATION', "Counter event must be round or turn.");
  return { value: integer(p.value, 'value'), step: integer(p.step, 'step'), event: p.event as CombatCounter['event'] };
}
export function applyCombatCommand(campaign: Campaign, member: Member, command: Command): boolean {
  if (!commands.has(command.type)) return false;
  if (command.expectedRevision === undefined) fail('REVISION_REQUIRED', "Combat requires the current expectedRevision.");
  if (command.expectedRevision !== campaign.revision) fail('CONFLICT', "The campaign changed. Review the combat order.");
  const p = object(command.payload), combat = campaign.combat, gm = member.role === 'gm';
  if (!gm && !['combat.roll', 'combat.endTurn'].includes(command.type)) fail('FORBIDDEN', "Only the GM can manage combat.");
  if (campaign.combatReceipts.length >= COMBAT_LIMITS.receipts) fail('LIMIT', "The combat log is full.");
  if ([...campaign.combatReceipts, ...campaign.actionResolutions, ...campaign.resourceRecoveries, ...campaign.outcomeRolls, ...campaign.hpApplications, ...campaign.progressionCommits, ...campaign.journalReceipts].some(r => r.commandId === command.id)) fail('ID_REUSED', "This outcome ID has already been used.");
  const currentId = combat.combatants[combat.turn]?.id;
  const entry = (): Combatant => combat.combatants.find(e => e.id === str(p.id, 'id')) ?? fail('NOT_FOUND', "Combat participant not found.");
  const tokenFor = (e: Combatant) => campaign.scenes.find(s => s.id === e.sceneId)?.tokens.find(t => t.id === e.tokenId);
  const requireControl = (e: Combatant) => {
    const token = tokenFor(e), scene = campaign.scenes.find(s => s.id === e.sceneId);
    if (!token || !scene) return fail('NOT_FOUND', "Participant token not found.");
    if (!gm && (e.kind === 'custom' || e.hidden || token.hidden || !token.owners.includes(member.id)
      || scene.id !== campaign.activeSceneId || token.levelId !== scene.activeLevelId
      || !projectSnapshot(campaign, member, '').campaign.scenes.some(s => s.tokens.some(t => t.id === token.id)))) fail('FORBIDDEN', "You cannot control this combat participant.");
    return token;
  };
  const nextRank = () => Math.max(-1, ...combat.combatants.map(e => e.tieRank ?? 0)) + 1;
  const invalidate = () => { combat.counterHistory = []; };
  switch (command.type) {
    case 'combat.add': {
      keys(p, ['id', 'sceneId']);
      const scene = campaign.scenes.find(s => s.id === (p.sceneId ?? campaign.activeSceneId)) ?? fail('NOT_FOUND', "Scene not found.");
      const token = scene.tokens.find(t => t.id === str(p.id, 'id')) ?? fail('NOT_FOUND', "Token not found.");
      if (combat.combatants.some(e => e.kind !== 'custom' && e.sceneId === scene.id && e.tokenId === token.id)) fail('VALIDATION', "This token is already in combat.");
      if (combat.combatants.length >= COMBAT_LIMITS.entries) fail('LIMIT', "At most 200 participants are allowed.");
      combat.combatants.push({ id: randomUUID(), kind: 'token', tokenId: token.id, sceneId: scene.id, name: token.name, initiative: null, hidden: false, defeated: false, tieRank: nextRank() });
      sortCombatants(combat.combatants); preserveCombatCurrent(combat, currentId); invalidate(); break;
    }
    case 'combat.custom': {
      keys(p, ['name', 'initiative', 'hidden', 'counter']);
      if (combat.combatants.length >= COMBAT_LIMITS.entries) fail('LIMIT', "At most 200 participants are allowed.");
      const e: Combatant = { id: randomUUID(), kind: 'custom', tokenId: '', sceneId: '', name: str(p.name, 'name'), initiative: p.initiative == null ? null : initiative(p.initiative), hidden: p.hidden === undefined ? false : boolean(p.hidden), defeated: false, tieRank: nextRank() };
      if (p.counter !== undefined) e.counter = counter(p.counter);
      combat.combatants.push(e); sortCombatants(combat.combatants); preserveCombatCurrent(combat, currentId); invalidate(); break;
    }
    case 'combat.remove': keys(p, ['id']); { const e = entry(); removeCombatEntries(combat, row => row.id === e.id); break; }
    case 'combat.update': {
      keys(p, ['id', 'initiative', 'hidden', 'defeated', 'name', 'counter', 'beforeId']); const e = entry();
      if (p.name !== undefined) { if (e.kind !== 'custom') fail('VALIDATION', "Change a token’s name in its properties."); e.name = str(p.name, 'name'); }
      if (p.initiative !== undefined) { e.initiative = p.initiative === null ? null : initiative(p.initiative); delete e.roll; }
      if (p.hidden !== undefined) e.hidden = boolean(p.hidden);
      if (p.defeated !== undefined) e.defeated = boolean(p.defeated);
      if (p.counter !== undefined) { if (e.kind !== 'custom') fail('VALIDATION', "Counters are available for custom rows."); if (p.counter === null) delete e.counter; else e.counter = counter(p.counter); }
      sortCombatants(combat.combatants);
      if (p.beforeId !== undefined) {
        const group = combat.combatants.filter(row => row.initiative === e.initiative && row.id !== e.id);
        const before = p.beforeId === null ? group.length : group.findIndex(row => row.id === str(p.beforeId, 'beforeId'));
        if (before < 0) fail('VALIDATION', "Only participants with equal initiative can be reordered.");
        group.splice(before, 0, e); const ranks = combat.combatants.filter(row => row.initiative === e.initiative).map(row => row.tieRank ?? 0).sort((a,b) => a-b);
        group.forEach((row, i) => { row.tieRank = ranks[i]; }); sortCombatants(combat.combatants);
      }
      preserveCombatCurrent(combat, currentId); invalidate(); break;
    }
    case 'combat.roll': {
      keys(p, ['id', 'formula']); const e = entry();
      if (!gm && p.formula !== undefined) fail('FORBIDDEN', "Only the GM can override the initiative formula.");
      const token = e.kind === 'custom' ? undefined : requireControl(e);
      if (e.kind === 'custom' && !gm) fail('FORBIDDEN', "Custom rows are controlled by the GM.");
      const preview = initiativePreview(token ? campaign.actors.find(a => a.id === token.actorId) : undefined);
      if (p.formula === undefined && preview.modifier === null) fail('INITIATIVE_UNKNOWN', preview.reason!);
      const roll = rollDice(p.formula ?? `1d20${preview.modifier! < 0 ? '' : '+'}${preview.modifier}`);
      integer(roll.total, 'initiative', COMBAT_LIMITS.initiative); e.initiative = roll.total; e.roll = roll;
      sortCombatants(combat.combatants); preserveCombatCurrent(combat, currentId); invalidate(); break;
    }
    case 'combat.settings': keys(p, ['skipDefeated', 'allowPlayerEndTurn']); {
      if (p.skipDefeated !== undefined) combat.settings.skipDefeated = boolean(p.skipDefeated);
      if (p.allowPlayerEndTurn !== undefined) combat.settings.allowPlayerEndTurn = boolean(p.allowPlayerEndTurn);
      invalidate(); break;
    }
    case 'combat.next': case 'combat.endTurn': {
      keys(p, command.type === 'combat.endTurn' ? ['id'] : []);
      if (command.type === 'combat.endTurn') {
        const e = entry(); if (!combat.active || e.id !== currentId) fail('TURN_CHANGED', "It is another participant’s turn.");
        if (!gm && !combat.settings.allowPlayerEndTurn) fail('FORBIDDEN', "The GM has not allowed players to end their own turns.");
        if (e.kind !== 'custom' || !gm) requireControl(e);
      }
      const eligible = combat.combatants.filter(e => !combat.settings.skipDefeated || !e.defeated);
      if (!eligible.length) fail('VALIDATION', "No participants can take a turn.");
      if (!combat.active) { combat.active = true; combat.round = 1; combat.turn = combat.combatants.indexOf(eligible[0]); invalidate(); break; }
      if ((combat.counterHistory?.length ?? 0) >= COMBAT_LIMITS.history) fail('LIMIT', "Turn history is full. Stop combat before starting again.");
      const indices = combat.combatants.map((e,i) => !combat.settings.skipDefeated || !e.defeated ? i : -1).filter(i => i >= 0);
      const nextIndex = indices.find(i => i > combat.turn) ?? indices[0], wrapped = nextIndex <= combat.turn;
      const nextRound = combat.round + (wrapped ? 1 : 0); if (nextRound > COMBAT_LIMITS.round) fail('LIMIT', "The round limit has been reached.");
      const beforeCounters = combat.combatants.flatMap(e => e.counter ? [{ id: e.id, value: e.counter.value }] : []);
      const nextId = combat.combatants[nextIndex].id;
      const changes = eligible.flatMap(e => e.counter && (e.counter.event === 'turn' && e.id === nextId || e.counter.event === 'round' && wrapped) ? [{ entry: e, value: integer(e.counter.value + e.counter.step, 'counter') }] : []);
      combat.counterHistory ??= []; combat.counterHistory.push({ beforeId: currentId!, afterId: combat.combatants[nextIndex].id, beforeRound: combat.round, afterRound: nextRound, counters: beforeCounters });
      for (const change of changes) change.entry.counter!.value = change.value;
      combat.turn = nextIndex; combat.round = nextRound; break;
    }
    case 'combat.previous': {
      keys(p, []); const last = combat.counterHistory?.at(-1);
      if (!combat.active || !last || last.afterId !== currentId || last.afterRound !== combat.round) fail('NO_PREVIOUS', "No unchanged transition can be undone. Roster or initiative changes reset undo.");
      const previous = combat.combatants.findIndex(e => e.id === last!.beforeId);
      if (previous < 0) fail('NO_PREVIOUS', "The previous participant is unavailable.");
      for (const saved of last!.counters) { const e = combat.combatants.find(row => row.id === saved.id); if (!e?.counter) fail('NO_PREVIOUS', "The counter changed."); e!.counter!.value = saved.value; }
      combat.turn = previous; combat.round = last!.beforeRound; combat.counterHistory!.pop(); break;
    }
    case 'combat.end': keys(p, []); combat.active = false; combat.round = 0; combat.turn = 0; invalidate(); break;
    case 'combat.reset': keys(p, []); if (combat.active) fail('COMBAT_ACTIVE', "Stop combat first."); for (const e of combat.combatants) { e.initiative = null; delete e.roll; } sortCombatants(combat.combatants); invalidate(); break;
    case 'combat.clear': keys(p, []); campaign.combat = { ...blankCombat(combat.version), settings: { ...combat.settings } }; break;
  }
  campaign.combat.version++;
  campaign.combatReceipts.push({ commandId: command.id, authorId: member.id, version: campaign.combat.version, action: command.type, createdAt: new Date().toISOString() });
  return true;
}
