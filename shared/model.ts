import type { AdvancementEvidence, ObservedAdvancementSummary } from './advancement-evidence.ts';
import type { ActorProgression, ProgressionCommitReceipt, ProgressionProfile } from './progression.ts';
import type { Journal, JournalFolder, JournalPresentation, JournalReceipt } from './journals.ts';
export type { Journal, JournalPage, JournalPermission, JournalPermissions, JournalFolder, JournalPresentation, JournalReceipt } from './journals.ts';
export type Role = 'gm' | 'player';
export interface Point { x: number; y: number }
export interface Member { id: string; name: string; role: Role; color: string }
export interface Level { id: string; name: string; bottom: number; top: number }
export interface Grid { size: number; distance: number; units: string; type: 'square' | 'none' }
export interface ImportedActorSource {
  sourceActorRef: string; resolution: 'resolved' | 'unresolved';
  systemId: string | null; systemVersion: string | null;
  itemRefs?: { itemId: string; sourceItemId: string }[];
  effectRefs?: { effectId: string; sourceEffectId: string }[];
  spellRefs?: { spellId: string; sourceItemId: string }[];
  activityRefs?: { actionId: string; sourceActivityId: string; sourceItemId: string }[];
  resourceRefs?: { resourceId: string; sourceKey: string }[];
  checkRefs?: { scope: 'all' | 'skill' | 'save' | 'ability'; key: string | null; code: string; sourcePath: string }[];
  /** Inert import diagnostics; omitted from every player projection. */
  unsupportedSpellcasting?: Record<string, unknown>[];
  advancementEvidence?: AdvancementEvidence;
}
export interface ImportedTokenSource {
  sourceTokenId: string | null; sourceActorRef: string | null;
  actorResolution: 'resolved' | 'unresolved' | 'unlinked' | 'none';
  rotationConvention: 'foundry-zero-south'; elevation: number;
  sightMetadata: Record<string, unknown>;
}
export const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
export type AbilityKey = typeof ABILITY_KEYS[number];
export type AbilityScores = Record<AbilityKey, number | null>;
export type RollMode = 'normal' | 'advantage' | 'disadvantage';
export const SKILL_KEYS = ['acr', 'ani', 'arc', 'ath', 'dec', 'his', 'ins', 'itm', 'inv', 'med', 'nat', 'prc', 'prf', 'per', 'rel', 'slt', 'ste', 'sur'] as const;
export type SkillKey = typeof SKILL_KEYS[number];
export const SKILL_ABILITIES: Record<SkillKey, AbilityKey> = { acr: 'dex', ani: 'wis', arc: 'int', ath: 'str', dec: 'cha', his: 'int', ins: 'wis', itm: 'cha', inv: 'int', med: 'wis', nat: 'int', prc: 'wis', prf: 'cha', per: 'cha', rel: 'int', slt: 'dex', ste: 'dex', sur: 'wis' };
export interface CheckBonus { bonus: number; mode: RollMode }
export interface ActorChecks {
  profile: 'dnd5e-checks-v1'; version: number;
  proficiency: { mode: 'unknown' | 'manual' | 'class-level'; bonus: number | null; level: number | null };
  global: Record<'check' | 'skill' | 'save', CheckBonus>;
  abilities: Record<AbilityKey, { check: CheckBonus }>;
  skills: Record<SkillKey, { ability: AbilityKey; proficiency: 0 | 0.5 | 1 | 2; bonus: number; passiveBonus: number; mode: RollMode }>;
  saves: Record<AbilityKey, { proficiency: 0 | 1; bonus: number; mode: RollMode }>;
  unsupported: { scope: 'all' | 'skill' | 'save' | 'ability'; key: string | null; code: string; reason: string }[];
}
export type CheckKind = 'ability' | 'skill' | 'save';
export type CheckRollMode = 'default' | RollMode;
export interface CheckRequest { kind: CheckKind; key: string; abilityOverride?: AbilityKey; situationalBonus?: number; mode?: CheckRollMode }
export interface CheckBlockedReason { code: string; reason: string }
export interface CheckSnapshot {
  kind: CheckKind; key: string; checksVersion: number | null;
  ability: AbilityKey | null; defaultAbility: AbilityKey | null; abilityOverride: AbilityKey | null;
  abilityBreakdown: AbilityBreakdown | null;
  proficiency: { mode: ActorChecks['proficiency']['mode']; bonus: number | null; level: number | null; multiplier: number; contribution: number | null };
  bonusContributions: { key: string; value: number }[];
  modeContributions: { key: string; mode: RollMode }[];
  configuredMode: RollMode; requestedMode: CheckRollMode; mode: RollMode;
  modifier: number | null; passive: number | null; passiveBonus: number;
  progression?: { version: number; profile: { id: string; version: number }; profileName: string; proficiencyPolicy: 'profile' | 'preserve'; baseProficiency: ActorChecks['proficiency']; baseMultiplier: number; grantIds: string[] };
}
export interface CheckPreview {
  modifier: number | null; passive: number | null; mode: RollMode;
  blockedReasons: CheckBlockedReason[]; snapshot: CheckSnapshot;
}
export interface ActorItem {
  id: string; name: string; type: string; quantity: number; weight: number;
  weightUnit: 'lb' | 'kg' | 'unit'; description: string; equipped: boolean;
  uses?: { value: number; max: number };
}
export type ResourceKind = 'custom' | 'action' | 'bonus-action' | 'reaction' | 'spell-slot' | 'charge';
export type RecoveryPolicy = 'manual' | 'turn' | 'short-rest' | 'long-rest';
export type RecoveryEvent = Exclude<RecoveryPolicy, 'manual'>;
export interface ActorResource {
  id: string; label: string; value: number | null; max: number | null;
  kind?: ResourceKind; level?: number | null; unit?: string; recovery?: RecoveryPolicy;
}
export function normalizeActorResource(resource: ActorResource): ActorResource {
  return { ...resource, kind: resource.kind ?? 'custom', level: resource.level ?? null, unit: resource.unit ?? '', recovery: resource.recovery ?? 'manual' };
}
export const DAMAGE_TYPES = ['acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder'] as const;
export interface OutcomePart { number: number; denomination: number; bonus: number; type: string }
export interface TypedActionOutcome { kind: 'damage' | 'healing'; parts: OutcomePart[]; allowCritical: boolean }
export type ActionOutcome = { kind: 'manual'; text: string } | { kind: 'roll'; ability: AbilityKey | null; modifier: number; mode: RollMode } | TypedActionOutcome;
export interface ActorSpell {
  id: string; version: number; name: string; description: string; level: number;
  method: 'spell'; preparation: 'unprepared' | 'prepared' | 'always';
}
export interface SpellActivityContext {
  activation: { type: 'action' };
  duration: { type: 'instantaneous' };
  range: { type: 'distance'; value: number; unit: 'ft' } | { type: 'self' };
  target: { type: 'creature'; count: 1; prompt: boolean };
}
export interface ActorSpellcasting {
  profile: 'foundry-dnd5e-6.0.6-base-cast-v1';
  spells: ActorSpell[];
  unsupported: { kind: 'spell' | 'activity' | 'resource'; name: string | null; codes: string[]; reason: string }[];
}
export interface ActorAction {
  id: string; version: number; name: string; description: string; sourceLabel: string; category: string;
  known: boolean; prepared: boolean; requiresPreparation: boolean; enabled: boolean;
  target: 'none' | 'self' | 'token'; costs: { resourceId: string; amount: number }[]; outcome: ActionOutcome;
  spellId?: string;
  casting?: SpellActivityContext;
  inheritance?: Record<'activation' | 'range' | 'target' | 'duration', 'item-merge' | 'activity'>;
}
export interface ActionCostSnapshot { resourceId: string; label: string; amount: number; before: number; after: number; max: number | null }
export type ActionTargetSnapshot = { kind: 'none' } | { kind: 'redacted' } | { kind: 'self'; actorId: string; name: string } | { kind: 'token'; sceneId: string; tokenId: string; name: string };
export interface ActionResolution {
  id: string; commandId: string; actor: { id: string; name: string }; action: ActorAction;
  author: { id: string; name: string }; createdAt: string; target: ActionTargetSnapshot;
  costs: ActionCostSnapshot[]; roll?: RollResult; manualOutcome?: string; visibility: ChatMessage['visibility'];
  spell?: ActorSpell;
  progression?: { profile: { id: string; version: number }; version: number; grantIds: string[]; sourceLabels: string[] };
}
export interface OutcomeRollReceipt {
  id: string; commandId: string; resolutionId: string; actor: { id: string; name: string };
  author: { id: string; name: string }; createdAt: string; kind: 'damage' | 'healing'; critical: boolean;
  parts: { definition: OutcomePart; roll: RollResult; amount: number }[]; total: number;
}
export type HpPoolReference = { kind: 'actor' | 'token'; id: string };
export interface HpApplicationReceipt {
  id: string; commandId: string; outcomeId: string; resolutionId: string;
  actor: { id: string; name: string }; author: { id: string; name: string }; createdAt: string;
  target: ActionTargetSnapshot; hpPool: HpPoolReference | { kind: 'redacted' };
  kind: 'damage' | 'healing'; multiplier: 0 | 0.5 | 1 | 2; requestedAmount: number;
  /** Null is used only by a redacted projection; persisted successful applications contain numbers. */
  appliedAmount: number | null; before: number | null; after: number | null; max: number | null;
}
export interface ResourceRecoveryChange {
  resourceId: string; label: string; before: number | null; after: number | null; max: number | null;
  policy: RecoveryPolicy; applied: boolean; reason: 'recovered' | 'unknown' | 'policy-mismatch' | 'already-full';
}
export interface ResourceRecoveryReceipt {
  id: string; commandId: string; actor: { id: string; name: string }; author: { id: string; name: string };
  createdAt: string; event: RecoveryEvent; changes: ResourceRecoveryChange[];
}
export interface ActorEffect {
  id: string; name: string; description: string; disabled: boolean;
  changes: { ability: AbilityKey; mode: 'add'; value: number }[];
  /** Informational only; no automatic expiration or combat clock is implemented. */
  duration?: { rounds: number | null; seconds: number | null };
}
export interface AbilityBreakdown {
  ability: AbilityKey; base: number | null; effective: number | null; modifier: number | null;
  totalBonus: number; contributions: { effectId: string; effectName: string; value: number }[];
}
export interface ActorSheet {
  sheetKind: 'generic' | 'dnd5e'; abilities: AbilityScores;
  items: ActorItem[]; resources: ActorResource[]; effects: ActorEffect[]; actions: ActorAction[];
  spellcasting?: ActorSpellcasting;
  checks?: ActorChecks;
  progression?: ActorProgression;
  observedAdvancement?: ObservedAdvancementSummary;
}
export function blankActorSheet(): ActorSheet {
  return { sheetKind: 'generic', abilities: { str: null, dex: null, con: null, int: null, wis: null, cha: null }, items: [], resources: [], effects: [], actions: [] };
}
/** Additive legacy migration only: absent fields get neutral defaults; source systems imply no scores or rules. */
export function normalizeActorSheet(actor: Partial<ActorSheet>): ActorSheet {
  const blank = blankActorSheet();
  return { sheetKind: actor.sheetKind ?? blank.sheetKind, abilities: { ...blank.abilities, ...actor.abilities }, items: actor.items ?? [], resources: (actor.resources ?? []).map(normalizeActorResource), effects: actor.effects ?? [], actions: actor.actions ?? [], ...(actor.spellcasting === undefined ? {} : { spellcasting: actor.spellcasting }), ...(actor.checks === undefined ? {} : { checks: actor.checks }), ...(actor.progression === undefined ? {} : { progression: actor.progression }), ...(actor.observedAdvancement === undefined ? {} : { observedAdvancement: actor.observedAdvancement }) };
}
export interface Actor extends ActorSheet {
  id: string; name: string; color: string; owners: string[];
  hp: number | null; maxHp: number | null; notes: string; gmNotes: string;
  source?: ImportedActorSource;
  sheetAccess?: 'full' | 'summary';
}
export interface Token extends Point {
  id: string; name: string; color: string; levelId: string;
  width: number; height: number; rotation: number;
  owners: string[]; hidden: boolean; actorId: string | null; linked: boolean;
  hp: number | null; maxHp: number | null; vision: number; conditions: string[];
  visionEnabled?: boolean; visionUnlimited?: boolean;
  /** Absent preserves the legacy center-based range; token-edge tracks occupied dimensions. */
  visionRangeOrigin?: 'center' | 'token-edge';
  /** External-light detection range in configured pixels; absent preserves enabled/unlimited legacy behavior. */
  lightPerception?: { enabled: boolean; range: number | null };
  source?: ImportedTokenSource;
}
export type WallSenseMode = 'none' | 'normal' | 'limited' | 'proximity' | 'distance';
export const WALL_THRESHOLD_MAX = 100000;
export type WallDirection = 'both' | 'left' | 'right';
export interface Wall {
  id: string; a: Point; b: Point; levelId: string; levelIds?: string[];
  kind: 'wall' | 'door' | 'secret'; state: 'closed' | 'open' | 'locked';
  movement: boolean; sight: boolean; light: boolean; sound: boolean;
  /** Explicit sense modes override legacy booleans; absent channels retain their boolean behavior. */
  senseModes?: Partial<Record<'sight' | 'light' | 'sound', WallSenseMode>>;
  /** Positive distances in scene pixels; an absent or null threshold does not bypass the wall. */
  senseThresholds?: Partial<Record<'sight' | 'light' | 'sound', number | null>>;
  /** Shared threshold attenuation switch; absent means false. */
  thresholdAttenuation?: boolean;
  /** Blocked source side of directed A→B in screen coordinates; absent means both. */
  direction?: WallDirection;
}
export interface Light extends Point { id: string; name: string; levelId: string; levelIds?: string[]; bright: number; dim: number; color: string; enabled: boolean }
export interface Scene {
  id: string; name: string; width: number; height: number; grid: Grid;
  levels: Level[]; activeLevelId: string; background: string; visionEnabled: boolean;
  globalLightEnabled?: boolean;
  tokens: Token[]; walls: Wall[]; lights: Light[];
  importWarnings?: string[];
}
export interface RollResult {
  formula: string; dice: { sides: number; values: number[] }[]; modifier: number; total: number;
  d20?: { mode: RollMode; keptIndex: number }; actor?: { id: string; name: string }; ability?: AbilityKey;
  abilitySnapshot?: AbilityBreakdown;
  checkSnapshot?: CheckSnapshot;
}
export interface SystemChatMessage {
  /** An application-authored English catalog key; player chat never sets this field. */
  key: string;
  parameters: Record<string, string | number>;
  /** Only controlled labels are localized; character and action names remain literal. */
  localizedParameters?: string[];
}
export interface ChatMessage { id: string; authorId: string; authorName: string; text: string; visibility: 'public' | 'gm' | 'self'; createdAt: string; roll?: RollResult; system?: SystemChatMessage }
export interface CombatCounter { value: number; step: number; event: 'round' | 'turn' }
export interface Combatant {
  id: string; sceneId: string; tokenId: string; name: string; initiative: number | null;
  kind?: 'token' | 'custom'; hidden?: boolean; defeated?: boolean; tieRank?: number;
  counter?: CombatCounter; roll?: RollResult;
}
export interface CombatCounterTransition {
  beforeId: string; afterId: string; beforeRound: number; afterRound: number;
  counters: { id: string; value: number }[];
}
export interface Combat {
  active: boolean; round: number; turn: number; combatants: Combatant[]; version: number;
  settings: { skipDefeated: boolean; allowPlayerEndTurn: boolean };
  /** GM-only reverse transitions; omitted from player snapshots. */
  counterHistory?: CombatCounterTransition[];
}
export interface CombatReceipt { commandId: string; authorId: string; version: number; action: CommandType; createdAt: string }
export interface Campaign {
  id: string; name: string; revision: number; activeSceneId: string;
  members: Member[]; scenes: Scene[]; actors: Actor[]; chat: ChatMessage[];
  combat: Combat; journals: Journal[]; createdAt: string;
  actionResolutions: ActionResolution[]; resourceRecoveries: ResourceRecoveryReceipt[];
  outcomeRolls: OutcomeRollReceipt[]; hpApplications: HpApplicationReceipt[];
  progressionProfiles: ProgressionProfile[]; progressionCommits: ProgressionCommitReceipt[];
  combatReceipts: CombatReceipt[];
  journalFolders: JournalFolder[]; journalPresentations: JournalPresentation[]; journalReceipts: JournalReceipt[];
}
export interface Snapshot { campaign: Campaign; self: Member; inviteCode?: string }
export interface AuthResult { token: string; campaignId: string; memberId: string }
export type CommandType =
  | 'scene.create' | 'scene.activate' | 'scene.update' | 'scene.import'
  | 'level.create' | 'level.activate'
  | 'token.create' | 'token.update' | 'token.move' | 'token.delete'
  | 'actor.create' | 'actor.update' | 'actor.place'
  | 'actor.item.create' | 'actor.item.update' | 'actor.item.delete' | 'actor.item.consume'
  | 'actor.resource.create' | 'actor.resource.update' | 'actor.resource.delete' | 'actor.roll'
  | 'actor.effect.create' | 'actor.effect.update' | 'actor.effect.delete'
  | 'actor.action.create' | 'actor.action.update' | 'actor.action.delete' | 'actor.action.prepare' | 'actor.action.execute' | 'actor.resource.recover'
  | 'actor.action.rollOutcome' | 'actor.action.applyOutcome'
  | 'actor.spell.prepare'
  | 'actor.checks.update' | 'actor.check.roll'
  | 'progression.profile.publish' | 'actor.progression.create' | 'actor.progression.commit'
  | 'wall.create' | 'wall.update' | 'wall.delete' | 'door.toggle'
  | 'light.create' | 'light.update' | 'light.delete'
  | 'chat.send' | 'chat.roll' | 'combat.add' | 'combat.remove' | 'combat.roll' | 'combat.next' | 'combat.end'
  | 'combat.update' | 'combat.custom' | 'combat.previous' | 'combat.settings' | 'combat.reset' | 'combat.clear' | 'combat.endTurn'
  | 'journal.create' | 'journal.update' | 'journal.archive' | 'journal.permissions'
  | 'journal.page.create' | 'journal.page.update' | 'journal.page.delete' | 'journal.page.reorder'
  | 'journal.folder.create' | 'journal.folder.update' | 'journal.folder.delete'
  | 'journal.show' | 'journal.presentation.dismiss' | 'journal.presentation.revoke';
export interface Command { id: string; type: CommandType; payload: Record<string, unknown>; expectedRevision?: number }
export interface CommandResult { type: 'ack'; id: string; ok: boolean; revision?: number; error?: string; code?: string }
export type ServerMessage = { type: 'snapshot'; data: Snapshot } | CommandResult | { type: 'error'; error: string };
export type ClientMessage = { type: 'auth'; token: string } | { type: 'command'; command: Command };

export const TOKEN_COLORS = ['#d5b270', '#6ab7ae', '#bd8cc3', '#d77e6c', '#83a6d0'];
export function activeScene(campaign: Campaign): Scene { return campaign.scenes.find(s => s.id === campaign.activeSceneId) ?? campaign.scenes[0]; }
export function tokenResources(token: Token, actors: Actor[]): { hp: number | null; maxHp: number | null } {
  const actor = token.linked ? actors.find(a => a.id === token.actorId) : undefined;
  return actor ? { hp: actor.hp, maxHp: actor.maxHp } : { hp: token.hp, maxHp: token.maxHp };
}
