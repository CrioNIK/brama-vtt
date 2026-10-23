/** Inert source observations. These records never issue runtime grants. */
export type EvidenceJson = null | boolean | number | string | EvidenceJson[] | { [key: string]: EvidenceJson };
export interface AdvancementEvidence {
  profile: 'foundry-dnd5e-advancement-evidence-v1';
  classes: { id: string; sourceItemId: string; name: string; identifier: string | null; levels: number | null }[];
  steps: { id: string; classId: string | null; sourceItemId: string; sourceAdvancementId: string; itemName: string; itemType: string; type: string; name: string | null; level: number | null; sourcePath: string; configuration: Record<string, EvidenceJson>; value: Record<string, EvidenceJson>; support: 'observed-only' | 'unsupported' }[];
  observedGrants: { id: string; stepId: string; level: number | null; sourceTargetItemId: string | null; sourceUuid: string | null; sourcePath: string; targetName: string | null; normalizedTargets: { kind: 'item' | 'spell' | 'activity'; id: string }[]; evidence: 'value-and-origin' | 'value-only' | 'origin-only' | 'conflict'; confidence: 'confirmed' | 'partial' | 'conflict'; materialization: 'present-in-snapshot' | 'unresolved' }[];
  issues: { code: string; reason: string; sourcePath: string }[];
  history: [];
}
export interface ObservedAdvancementSummary {
  classes: { name: string; levels: number | null }[];
  steps: { itemName: string; itemType: string; type: string; name: string | null; level: number | null; support: 'observed-only' | 'unsupported' }[];
  grantCount: number; issueCount: number;
}
type Fail = (path: string, message: string) => never;
type TargetSets = Record<'item' | 'spell' | 'activity', ReadonlySet<string>>;

export function importAdvancementEvidence(value: unknown, path: string, targets: TargetSets, fail: Fail): { evidence: AdvancementEvidence; summary: ObservedAdvancementSummary } {
  const obj = (v: unknown, p: string): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail(p, 'Expected an object');
  const keys = (v: Record<string, unknown>, fields: string[], p: string) => { if (Object.keys(v).length !== fields.length || fields.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !fields.includes(k))) fail(p, 'Unexpected or missing advancement evidence fields'); };
  const str = (v: unknown, p: string, max = 256, empty = false): string => typeof v === 'string' && v.length <= max && (empty || v.trim().length > 0) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v) ? v : fail(p, 'Invalid evidence text');
  const nullableText = (v: unknown, p: string, max: number) => v === null ? null : str(v, p, max);
  const level = (v: unknown, p: string): number | null => v === null ? null : typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1000 ? v : fail(p, 'Invalid observed level');
  const arr = (v: unknown, p: string, max: number): unknown[] => Array.isArray(v) && v.length <= max ? v : fail(p, `Expected at most ${max} entries`);
  const one = <T extends string>(v: unknown, allowed: readonly T[], p: string): T => allowed.includes(v as T) ? v as T : fail(p, 'Unsupported evidence enum');
  const unique = (id: string, used: Set<string>, p: string) => { if (used.has(id)) fail(p, 'Duplicate evidence identifier'); used.add(id); return id; };
  function jsonObject(v: unknown, p: string): Record<string, EvidenceJson> {
    obj(v, p); let nodes = 0;
    function visit(node: unknown, depth: number) {
      if (++nodes > 10000 || depth > 30) fail(p, 'Evidence JSON exceeds depth or size limits');
      if (node === null || typeof node === 'boolean') return;
      if (typeof node === 'number') { if (!Number.isFinite(node)) fail(p, 'Non-finite evidence number'); return; }
      if (typeof node === 'string') { str(node, p, 20000, true); return; }
      if (Array.isArray(node)) { for (const child of node) visit(child, depth + 1); return; }
      for (const [key, child] of Object.entries(obj(node, p))) { str(key, p, 20000, true); visit(child, depth + 1); }
    }
    visit(v, 0); return structuredClone(v) as Record<string, EvidenceJson>;
  }
  const root = obj(value, path); keys(root, ['profile', 'classes', 'steps', 'observedGrants', 'issues', 'history'], path);
  if (root.profile !== 'foundry-dnd5e-advancement-evidence-v1') fail(`${path}/profile`, 'Unsupported advancement evidence profile');
  if (arr(root.history, `${path}/history`, 0).length) fail(`${path}/history`, 'An observed snapshot cannot supply an event history');
  const classIds = new Set<string>(), stepIds = new Set<string>(), grantIds = new Set<string>(), nativeClasses = new Set<string>(), nativeSteps = new Set<string>();
  const classes = arr(root.classes, `${path}/classes`, 100).map((entry, i) => {
    const p = `${path}/classes/${i}`, item = obj(entry, p); keys(item, ['id', 'sourceItemId', 'name', 'identifier', 'levels'], p);
    return { id: unique(str(item.id, `${p}/id`), classIds, p), sourceItemId: unique(str(item.sourceItemId, `${p}/sourceItemId`), nativeClasses, p), name: str(item.name, `${p}/name`, 120), identifier: nullableText(item.identifier, `${p}/identifier`, 256), levels: level(item.levels, `${p}/levels`) };
  });
  const steps = arr(root.steps, `${path}/steps`, 1000).map((entry, i) => {
    const p = `${path}/steps/${i}`, item = obj(entry, p); keys(item, ['id', 'classId', 'sourceItemId', 'sourceAdvancementId', 'itemName', 'itemType', 'type', 'name', 'level', 'sourcePath', 'configuration', 'value', 'support'], p);
    const classId = nullableText(item.classId, `${p}/classId`, 256), sourceItemId = str(item.sourceItemId, `${p}/sourceItemId`);
    unique(`${sourceItemId}\u0000${str(item.sourceAdvancementId, `${p}/sourceAdvancementId`)}`, nativeSteps, p);
    if (classId !== null && !classes.some(c => c.id === classId && c.sourceItemId === sourceItemId)) fail(`${p}/classId`, 'Unknown or mismatched source class');
    return { id: unique(str(item.id, `${p}/id`), stepIds, p), classId, sourceItemId, sourceAdvancementId: str(item.sourceAdvancementId, `${p}/sourceAdvancementId`), itemName: str(item.itemName, `${p}/itemName`, 120), itemType: str(item.itemType, `${p}/itemType`, 60), type: str(item.type, `${p}/type`, 60), name: nullableText(item.name, `${p}/name`, 120), level: level(item.level, `${p}/level`), sourcePath: str(item.sourcePath, `${p}/sourcePath`, 2000), configuration: jsonObject(item.configuration, `${p}/configuration`), value: jsonObject(item.value, `${p}/value`), support: one(item.support, ['observed-only', 'unsupported'] as const, `${p}/support`) };
  });
  const observedGrants = arr(root.observedGrants, `${path}/observedGrants`, 2000).map((entry, i) => {
    const p = `${path}/observedGrants/${i}`, item = obj(entry, p); keys(item, ['id', 'stepId', 'level', 'sourceTargetItemId', 'sourceUuid', 'sourcePath', 'targetName', 'normalizedTargets', 'evidence', 'confidence', 'materialization'], p);
    const stepId = str(item.stepId, `${p}/stepId`); if (!stepIds.has(stepId)) fail(`${p}/stepId`, 'Unknown source advancement step');
    const seen = new Set<string>();
    const normalizedTargets = arr(item.normalizedTargets, `${p}/normalizedTargets`, 2000).map((v, j) => {
      const q = `${p}/normalizedTargets/${j}`, target = obj(v, q); keys(target, ['kind', 'id'], q);
      const kind = one(target.kind, ['item', 'spell', 'activity'] as const, `${q}/kind`), id = str(target.id, `${q}/id`);
      unique(`${kind}:${id}`, seen, q); if (!targets[kind].has(id)) fail(q, 'Normalized target is not present in the imported sheet'); return { kind, id };
    });
    const evidence = one(item.evidence, ['value-and-origin', 'value-only', 'origin-only', 'conflict'] as const, `${p}/evidence`);
    const confidence = one(item.confidence, ['confirmed', 'partial', 'conflict'] as const, `${p}/confidence`);
    const materialization = one(item.materialization, ['present-in-snapshot', 'unresolved'] as const, `${p}/materialization`);
    const sourceTargetItemId = nullableText(item.sourceTargetItemId, `${p}/sourceTargetItemId`, 256);
    if (confidence === 'confirmed' && (evidence !== 'value-and-origin' || materialization !== 'present-in-snapshot' || sourceTargetItemId === null)) fail(p, 'Confirmed grants require a matching present source Item');
    if ((evidence === 'conflict') !== (confidence === 'conflict')) fail(p, 'Inconsistent conflict evidence');
    if (materialization === 'unresolved' && normalizedTargets.length > 0) fail(p, 'Unresolved grants cannot link imported runtime targets');
    return { id: unique(str(item.id, `${p}/id`), grantIds, p), stepId, level: level(item.level, `${p}/level`), sourceTargetItemId, sourceUuid: nullableText(item.sourceUuid, `${p}/sourceUuid`, 2000), sourcePath: str(item.sourcePath, `${p}/sourcePath`, 2000), targetName: nullableText(item.targetName, `${p}/targetName`, 120), normalizedTargets, evidence, confidence, materialization };
  });
  const issues = arr(root.issues, `${path}/issues`, 2000).map((entry, i) => {
    const p = `${path}/issues/${i}`, issue = obj(entry, p); keys(issue, ['code', 'reason', 'sourcePath'], p);
    return { code: str(issue.code, `${p}/code`, 120), reason: str(issue.reason, `${p}/reason`, 2000), sourcePath: str(issue.sourcePath, `${p}/sourcePath`, 2000) };
  });
  return { evidence: { profile: root.profile, classes, steps, observedGrants, issues, history: [] }, summary: {
    classes: classes.map(({ name, levels }) => ({ name, levels })),
    steps: steps.map(({ itemName, itemType, type, name, level, support }) => ({ itemName, itemType, type, name, level, support })), grantCount: observedGrants.length, issueCount: issues.length,
  } };
}
