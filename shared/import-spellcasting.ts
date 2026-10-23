import type { ActorAction, ActorResource, ActorSpell, ActorSpellcasting, ImportedActorSource, SpellActivityContext, TypedActionOutcome } from './model.js';
import { DAMAGE_TYPES } from './model.js';
import { previewOutcomeRoll } from './actions.js';

/** Strict neutral 0.6 reader. Native paths and IDs are returned only as GM source references. */
export function importSpellcasting(value: unknown, path: string, fail: (path: string, message: string) => never) {
  const obj = (v: unknown, p: string): Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : fail(p, 'Expected an object');
  const keys = (o: Record<string, unknown>, allowed: string[], p: string) => { for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${p}/${k}`, 'Unsupported spellcasting field'); };
  const arr = (v: unknown, p: string, max: number): unknown[] => Array.isArray(v) && v.length <= max ? v : fail(p, `Expected at most ${max} entries`);
  const text = (v: unknown, p: string, max = 256, empty = false): string => typeof v === 'string' && v.length <= max && (empty || v.trim().length > 0) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v) ? v : fail(p, 'Invalid spellcasting text');
  const integer = (v: unknown, p: string, min: number, max: number): number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fail(p, 'Invalid spellcasting integer');
  const boolean = (v: unknown, p: string): boolean => typeof v === 'boolean' ? v : fail(p, 'Expected a boolean');
  const choice = <T extends string>(v: unknown, options: readonly T[], p: string): T => options.find(o => o === v) ?? fail(p, `Expected ${options.join(' | ')}`);
  const source = obj(value, path);
  keys(source, ['profile', 'resources', 'spells', 'activities', 'unsupported'], path);
  const profile = choice(source.profile, ['foundry-dnd5e-6.0.6-base-cast-v1'], `${path}/profile`);
  const resources: ActorResource[] = [], spells: ActorSpell[] = [], actions: ActorAction[] = [];
  const resourceRefs: NonNullable<ImportedActorSource['resourceRefs']> = [], spellRefs: NonNullable<ImportedActorSource['spellRefs']> = [], activityRefs: NonNullable<ImportedActorSource['activityRefs']> = [];
  const resourceMap = new Map<string, ActorResource>(), spellMap = new Map<string, ActorSpell>(), nativeSpellIds = new Set<string>(), sourceKeys = new Set<string>(), activityIds = new Set<string>(), nativeActivityIds = new Set<string>();
  for (const [i, v] of arr(source.resources, `${path}/resources`, 9).entries()) {
    const p = `${path}/resources/${i}`, r = obj(v, p);
    keys(r, ['id', 'sourceKey', 'sourcePath', 'label', 'kind', 'level', 'value', 'max', 'maxSource', 'recovery'], p);
    const id = text(r.id, `${p}/id`), sourceKey = text(r.sourceKey, `${p}/sourceKey`), level = integer(r.level, `${p}/level`, 1, 9);
    if (sourceKey !== `spell${level}` || sourceKeys.has(sourceKey) || resourceMap.has(id)) fail(p, 'Duplicate or inconsistent slot identity');
    text(r.sourcePath, `${p}/sourcePath`, 2000);
    choice(r.kind, ['spell-slot'], `${p}/kind`); choice(r.recovery, ['long-rest'], `${p}/recovery`);
    const maxSource = choice(r.maxSource, ['override', 'unknown'], `${p}/maxSource`);
    const max = r.max === null ? null : integer(r.max, `${p}/max`, 0, 100000);
    const current = r.value === null ? null : integer(r.value, `${p}/value`, 0, max ?? 100000);
    if ((max === null) !== (maxSource === 'unknown')) fail(p, 'Slot maximum must match its explicit source');
    const runtime: ActorResource = { id: `resource-${crypto.randomUUID()}`, label: text(r.label, `${p}/label`, 120), kind: 'spell-slot', level, value: current, max, unit: '', recovery: 'long-rest' };
    resources.push(runtime); resourceMap.set(id, runtime); sourceKeys.add(sourceKey); resourceRefs.push({ resourceId: runtime.id, sourceKey });
  }
  for (const [i, v] of arr(source.spells, `${path}/spells`, 200).entries()) {
    const p = `${path}/spells/${i}`, s = obj(v, p);
    keys(s, ['id', 'sourceItemId', 'sourcePath', 'name', 'description', 'level', 'method', 'preparation'], p);
    const id = text(s.id, `${p}/id`), sourceItemId = text(s.sourceItemId, `${p}/sourceItemId`);
    if (spellMap.has(id) || nativeSpellIds.has(sourceItemId)) fail(p, 'Duplicate Spell identity');
    text(s.sourcePath, `${p}/sourcePath`, 2000);
    const runtime: ActorSpell = { id: `spell-${crypto.randomUUID()}`, version: 1, name: text(s.name, `${p}/name`, 120), description: text(s.description, `${p}/description`, 20000, true), level: integer(s.level, `${p}/level`, 0, 9), method: choice(s.method, ['spell'], `${p}/method`), preparation: choice(s.preparation, ['unprepared', 'prepared', 'always'], `${p}/preparation`) };
    spells.push(runtime); spellMap.set(id, runtime); nativeSpellIds.add(sourceItemId); spellRefs.push({ spellId: runtime.id, sourceItemId });
  }
  for (const [i, v] of arr(source.activities, `${path}/activities`, 200).entries()) {
    const p = `${path}/activities/${i}`, a = obj(v, p);
    keys(a, ['id', 'spellId', 'sourceActivityId', 'sourcePath', 'name', 'description', 'context', 'inheritance', 'cost', 'outcome'], p);
    const id = text(a.id, `${p}/id`), spell = spellMap.get(text(a.spellId, `${p}/spellId`));
    if (!spell) fail(`${p}/spellId`, 'Unknown parent Spell');
    const sourceItemId = spellRefs.find(ref => ref.spellId === spell.id)!.sourceItemId;
    const sourceActivityId = text(a.sourceActivityId, `${p}/sourceActivityId`), nativeKey = `${sourceItemId}:${sourceActivityId}`;
    if (activityIds.has(id) || nativeActivityIds.has(nativeKey)) fail(p, 'Duplicate Activity identity');
    activityIds.add(id); nativeActivityIds.add(nativeKey); text(a.sourcePath, `${p}/sourcePath`, 2000);
    const context = obj(a.context, `${p}/context`); keys(context, ['activation', 'duration', 'range', 'target'], `${p}/context`);
    const activation = obj(context.activation, `${p}/context/activation`); keys(activation, ['type'], `${p}/context/activation`); choice(activation.type, ['action'], `${p}/context/activation/type`);
    const duration = obj(context.duration, `${p}/context/duration`); keys(duration, ['type'], `${p}/context/duration`); choice(duration.type, ['instantaneous'], `${p}/context/duration/type`);
    const range = obj(context.range, `${p}/context/range`), rangeType = choice(range.type, ['distance', 'self'], `${p}/context/range/type`);
    let runtimeRange: SpellActivityContext['range'];
    if (rangeType === 'self') { keys(range, ['type'], `${p}/context/range`); runtimeRange = { type: 'self' }; }
    else {
      keys(range, ['type', 'value', 'unit'], `${p}/context/range`);
      const distance = range.value;
      if (typeof distance !== 'number' || !Number.isFinite(distance) || distance <= 0 || distance > 100000) fail(`${p}/context/range/value`, 'Invalid range');
      runtimeRange = { type: 'distance', value: distance, unit: choice(range.unit, ['ft'], `${p}/context/range/unit`) };
    }
    const target = obj(context.target, `${p}/context/target`); keys(target, ['type', 'count', 'prompt'], `${p}/context/target`);
    choice(target.type, ['creature'], `${p}/context/target/type`); integer(target.count, `${p}/context/target/count`, 1, 1);
    const casting: SpellActivityContext = { activation: { type: 'action' }, duration: { type: 'instantaneous' }, range: runtimeRange, target: { type: 'creature', count: 1, prompt: boolean(target.prompt, `${p}/context/target/prompt`) } };
    const inheritance = obj(a.inheritance, `${p}/inheritance`); keys(inheritance, ['activation', 'duration', 'range', 'target'], `${p}/inheritance`);
    const origin = (key: string) => choice(inheritance[key], ['item-merge', 'activity'], `${p}/inheritance/${key}`);
    const costs: ActorAction['costs'] = [];
    if (spell.level === 0) { if (a.cost !== null) fail(`${p}/cost`, 'Cantrip must have no slot cost'); }
    else {
      const cost = obj(a.cost, `${p}/cost`); keys(cost, ['resourceId', 'amount', 'castLevel'], `${p}/cost`);
      const resource = resourceMap.get(text(cost.resourceId, `${p}/cost/resourceId`));
      if (!resource || resource.level !== spell.level) fail(`${p}/cost/resourceId`, 'Base cast requires its matching slot level');
      if (resource.max === null) fail(`${p}/cost/resourceId`, 'Base cast profile requires a known slot maximum');
      integer(cost.amount, `${p}/cost/amount`, 1, 1); integer(cost.castLevel, `${p}/cost/castLevel`, spell.level, spell.level);
      costs.push({ resourceId: resource.id, amount: 1 });
    }
    const outcome = obj(a.outcome, `${p}/outcome`); keys(outcome, ['kind', 'parts', 'allowCritical'], `${p}/outcome`);
    const kind = choice(outcome.kind, ['damage', 'healing'], `${p}/outcome/kind`);
    const definition: TypedActionOutcome = { kind, allowCritical: boolean(outcome.allowCritical, `${p}/outcome/allowCritical`), parts: arr(outcome.parts, `${p}/outcome/parts`, 20).map((v, j) => {
      const q = `${p}/outcome/parts/${j}`, part = obj(v, q); keys(part, ['number', 'denomination', 'bonus', 'type'], q);
      return { number: integer(part.number, `${q}/number`, 1, 100), denomination: integer(part.denomination, `${q}/denomination`, 2, 1000), bonus: integer(part.bonus, `${q}/bonus`, -100000, 100000), type: choice(part.type, kind === 'healing' ? ['healing'] : DAMAGE_TYPES, `${q}/type`) };
    }) };
    const runtime: ActorAction = { id: `action-${crypto.randomUUID()}`, version: 1, name: text(a.name, `${p}/name`, 120), description: text(a.description, `${p}/description`, 20000, true), sourceLabel: spell.name, category: kind === 'healing' ? "Healing" : "Damage", known: true, prepared: false, requiresPreparation: false, enabled: true, target: 'none', costs, outcome: definition, spellId: spell.id, casting, inheritance: { activation: origin('activation'), duration: origin('duration'), range: origin('range'), target: origin('target') } };
    if (!previewOutcomeRoll({ action: runtime }, false).available || definition.allowCritical && !previewOutcomeRoll({ action: runtime }, true).available) fail(`${p}/outcome`, 'Unsupported outcome or dice limit');
    actions.push(runtime); activityRefs.push({ actionId: runtime.id, sourceActivityId, sourceItemId });
  }
  const unsupported: ActorSpellcasting['unsupported'] = arr(source.unsupported, `${path}/unsupported`, 500).map((v, i) => {
    const p = `${path}/unsupported/${i}`, u = obj(v, p);
    keys(u, ['kind', 'sourcePath', 'sourceItemId', 'sourceActivityId', 'name', 'codes', 'reason'], p);
    const kind = choice(u.kind, ['spell', 'activity', 'resource'], `${p}/kind`);
    text(u.sourcePath, `${p}/sourcePath`, 2000);
    const itemId = u.sourceItemId === null ? null : text(u.sourceItemId, `${p}/sourceItemId`);
    const activityId = u.sourceActivityId === null ? null : text(u.sourceActivityId, `${p}/sourceActivityId`);
    if (kind === 'spell' && itemId !== null && nativeSpellIds.has(itemId) || kind === 'activity' && itemId !== null && activityId !== null && nativeActivityIds.has(`${itemId}:${activityId}`)) fail(p, 'Supported and unsupported definitions overlap');
    const codes = arr(u.codes, `${p}/codes`, 50).map((v, j) => text(v, `${p}/codes/${j}`, 120));
    if (!codes.length) fail(`${p}/codes`, 'At least one reason code is required');
    return { kind, name: u.name === null ? null : text(u.name, `${p}/name`, 120), codes, reason: text(u.reason, `${p}/reason`, 2000) };
  });
  return { spellcasting: { profile, spells, unsupported } satisfies ActorSpellcasting, resources, actions, resourceRefs, spellRefs, activityRefs };
}
