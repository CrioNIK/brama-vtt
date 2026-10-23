import type { ActorChecks, ImportedActorSource } from './model.js';
import { validActorChecks } from './checks.js';

/** Neutral 0.7 carries data only; source diagnostics remain GM-only. */
export function importChecks(value: unknown, path: string, fail: (path: string, message: string) => never): { checks: ActorChecks; checkRefs: NonNullable<ImportedActorSource['checkRefs']> } {
  const object = (v: unknown, p: string): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail(p, 'Expected a checks object');
  const source = object(value, path), allowed = ['profile', 'proficiency', 'global', 'abilities', 'skills', 'saves', 'unsupported'];
  for (const key of Object.keys(source)) if (!allowed.includes(key)) fail(`${path}/${key}`, 'Unsupported checks field');
  if (!Array.isArray(source.unsupported) || source.unsupported.length > 512) fail(`${path}/unsupported`, 'Expected at most 512 blocked check definitions');
  const checkRefs: NonNullable<ImportedActorSource['checkRefs']> = [];
  const unsupported = source.unsupported.map((v, i) => {
    const p = `${path}/unsupported/${i}`, item = object(v, p);
    const { sourcePath, ...entry } = item;
    if (typeof sourcePath !== 'string' || !sourcePath.length || sourcePath.length > 2000 || /[\u0000-\u001f]/.test(sourcePath)) fail(`${p}/sourcePath`, 'Expected a source path');
    for (const field of ['code', 'reason']) if (typeof entry[field] === 'string' && /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(entry[field])) fail(`${p}/${field}`, 'Unsupported control character');
    return { entry, sourcePath };
  });
  const checks = { ...source, version: 1, unsupported: unsupported.map(item => item.entry) };
  if (!validActorChecks(checks)) fail(path, 'Invalid checks profile: requires all 18 skills, 6 saves, exact proficiency source, integer bonuses and supported modes');
  for (const [i, item] of unsupported.entries()) {
    const entry = checks.unsupported[i];
    checkRefs.push({ scope: entry.scope, key: entry.key, code: entry.code, sourcePath: item.sourcePath });
  }
  return { checks, checkRefs };
}
