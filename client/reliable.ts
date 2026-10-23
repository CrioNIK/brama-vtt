import { t as tr } from '../shared/i18n';
import type { Command, CommandResult, CommandType } from '../shared/model';
import { JOURNAL_COMMANDS } from '../shared/journals';

export const ACTOR_RELIABLE_TYPES = ['actor.action.execute', 'actor.resource.recover', 'actor.action.rollOutcome', 'actor.action.applyOutcome', 'actor.progression.create', 'actor.progression.commit'] as const;
export const COMBAT_SCOPE = '__combat__' as const;
export const COMBAT_RELIABLE_TYPES = ['combat.add', 'combat.remove', 'combat.roll', 'combat.next', 'combat.end', 'combat.update', 'combat.custom', 'combat.previous', 'combat.settings', 'combat.reset', 'combat.clear', 'combat.endTurn'] as const;
export type ActorReliableType = typeof ACTOR_RELIABLE_TYPES[number];
export type CombatReliableType = typeof COMBAT_RELIABLE_TYPES[number];
export const JOURNAL_SCOPE = '__journal__' as const;
export const JOURNAL_RELIABLE_TYPES = JOURNAL_COMMANDS;
export type JournalReliableType = typeof JOURNAL_RELIABLE_TYPES[number];
export const RELIABLE_TYPES = [...ACTOR_RELIABLE_TYPES, ...COMBAT_RELIABLE_TYPES, ...JOURNAL_RELIABLE_TYPES] as const;
export type ReliableType = typeof RELIABLE_TYPES[number];
export interface PendingOperation {
  version: 1; campaignId: string; memberId: string; actorId: string;
  label: string; createdAt: string; command: Command;
}
export type ReliableResult = { status: 'ack'; ack: CommandResult } | { status: 'unknown' | 'not-sent'; error: string };
export interface ReliableController {
  operations: PendingOperation[]; sending: string[]; storageError: string;
  execute: (actorId: string, type: ReliableType, payload: Record<string, unknown>, revision: number, label: string) => Promise<ReliableResult>;
  retry: (actorId: string) => Promise<ReliableResult>;
}
export const reliableKey = (campaignId: string, memberId: string) => `brama-vtt-reliable-v1:${campaignId}:${memberId}`;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
export const isCombatReliableType = (value: unknown): value is CombatReliableType =>
  typeof value === 'string' && (COMBAT_RELIABLE_TYPES as readonly string[]).includes(value);
export const isJournalReliableType = (value: unknown): value is JournalReliableType =>
  typeof value === 'string' && (JOURNAL_RELIABLE_TYPES as readonly string[]).includes(value);
const isReliableType = (value: unknown): value is ReliableType =>
  typeof value === 'string' && (RELIABLE_TYPES as readonly string[]).includes(value);
const combatNeedsId = new Set<CombatReliableType>(['combat.add', 'combat.remove', 'combat.roll', 'combat.update', 'combat.endTurn']);

function validScope(actorId: string, type: ReliableType, payload: Record<string, unknown>): boolean {
  if (isJournalReliableType(type)) {
    if (actorId !== JOURNAL_SCOPE) return false;
    if (Object.hasOwn(payload, 'id')) return identity(payload.id) && payload.id !== JOURNAL_SCOPE && payload.id !== COMBAT_SCOPE;
    return type === 'journal.create' || type === 'journal.folder.create';
  }
  if (isCombatReliableType(type)) {
    if (actorId !== COMBAT_SCOPE) return false;
    // The scope serializes combat changes. The payload ID identifies a real token/combatant.
    if (Object.hasOwn(payload, 'id')) return identity(payload.id) && payload.id !== COMBAT_SCOPE && payload.id !== JOURNAL_SCOPE;
    return !combatNeedsId.has(type);
  }
  return actorId !== COMBAT_SCOPE && actorId !== JOURNAL_SCOPE && payload.id === actorId;
}

function validOperation(entry: unknown, campaignId: string, memberId: string): entry is PendingOperation {
  if (!record(entry) || !record(entry.command)) return false;
  const command = entry.command;
  return entry.version === 1 && entry.campaignId === campaignId && entry.memberId === memberId
    && identity(entry.actorId) && typeof entry.label === 'string'
    && typeof entry.createdAt === 'string' && Number.isFinite(Date.parse(entry.createdAt))
    && identity(command.id) && isReliableType(command.type) && record(command.payload)
    && validScope(entry.actorId, command.type, command.payload)
    && typeof command.expectedRevision === 'number' && Number.isSafeInteger(command.expectedRevision) && command.expectedRevision >= 0;
}

function validatedOperations(parsed: unknown, campaignId: string, memberId: string): PendingOperation[] {
  if (!Array.isArray(parsed) || parsed.length > 500) throw new Error(tr("Invalid pending operation storage."));
  const scopes = new Set<string>(), ids = new Set<string>();
  const operations: PendingOperation[] = [];
  for (const entry of parsed) {
    if (!validOperation(entry, campaignId, memberId) || scopes.has(entry.actorId) || ids.has(entry.command.id)) {
      throw new Error(tr("Could not verify the saved operation. New operations are blocked."));
    }
    scopes.add(entry.actorId); ids.add(entry.command.id); operations.push(entry);
  }
  return operations;
}

/** A persisted request is an immutable envelope. Never substitute a new revision or ID on retry. */
export function readOperations(storage: Pick<Storage, 'getItem'>, campaignId: string, memberId: string): PendingOperation[] {
  const raw = storage.getItem(reliableKey(campaignId, memberId));
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  return validatedOperations(parsed, campaignId, memberId);
}
export function writeOperations(storage: Pick<Storage, 'setItem'>, campaignId: string, memberId: string, operations: PendingOperation[]) {
  storage.setItem(reliableKey(campaignId, memberId), JSON.stringify(validatedOperations(operations, campaignId, memberId)));
}
export function newOperation(campaignId: string, memberId: string, actorId: string, type: ReliableType, payload: Record<string, unknown>, revision: number, label: string): PendingOperation {
  if (!identity(campaignId) || !identity(memberId) || !identity(actorId) || !isReliableType(type) || !record(payload)
    || typeof label !== 'string' || !Number.isSafeInteger(revision) || revision < 0 || !validScope(actorId, type, payload)) {
    throw new Error(tr("Invalid operation preview."));
  }
  return { version: 1, campaignId, memberId, actorId, label, createdAt: new Date().toISOString(),
    command: { id: crypto.randomUUID(), type: type as CommandType, payload: structuredClone(payload), expectedRevision: revision } };
}

export interface ReliableReceiptSnapshot {
  id: string;
  actionResolutions?: readonly { commandId: string }[];
  resourceRecoveries?: readonly { commandId: string }[];
  outcomeRolls?: readonly { commandId: string }[];
  hpApplications?: readonly { commandId: string }[];
  progressionCommits?: readonly { commandId: string }[];
  combatReceipts?: readonly { commandId: string; authorId: string; version: number; action: CommandType }[];
  journalReceipts?: readonly { commandId: string; authorId: string; version: number; action: CommandType }[];
}

/** A minimal combat receipt proves only this member's exact command, not another queue's request. */
export function hasOperationReceipt(operation: PendingOperation, campaign: ReliableReceiptSnapshot): boolean {
  if (operation.campaignId !== campaign.id) return false;
  if (isJournalReliableType(operation.command.type)) {
    return operation.actorId === JOURNAL_SCOPE && (campaign.journalReceipts ?? []).some(receipt =>
      receipt.commandId === operation.command.id && receipt.authorId === operation.memberId
      && receipt.action === operation.command.type && Number.isSafeInteger(receipt.version) && receipt.version > 0);
  }
  if (isCombatReliableType(operation.command.type)) {
    return operation.actorId === COMBAT_SCOPE && (campaign.combatReceipts ?? []).some(receipt =>
      receipt.commandId === operation.command.id && receipt.authorId === operation.memberId
      && receipt.action === operation.command.type && Number.isSafeInteger(receipt.version) && receipt.version > 0);
  }
  if (operation.actorId === COMBAT_SCOPE || operation.actorId === JOURNAL_SCOPE) return false;
  return [campaign.actionResolutions, campaign.resourceRecoveries, campaign.outcomeRolls, campaign.hpApplications, campaign.progressionCommits]
    .some(receipts => receipts?.some(receipt => receipt.commandId === operation.command.id));
}
