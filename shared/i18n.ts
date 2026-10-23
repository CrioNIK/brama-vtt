import { coreMessages } from '../client/catalog-core.ts';
import { advancedMessages } from '../client/catalog-advanced.ts';
import { domainMessages } from './catalog-domain.ts';

import { SUPPORTED_LOCALES, isLocale, type Locale } from './locale.ts';
export { isLocale, type Locale } from './locale.ts';
export const LOCALES = SUPPORTED_LOCALES;
export type MessageParameters = Record<string, unknown>;
export type MessageTranslations = Record<Locale, string>;
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English', es: 'Español', uk: 'Українська', pl: 'Polski', cs: 'Čeština',
};
const baseMessages: Record<string, MessageTranslations> = {
  'Language': { en: 'Language', es: 'Idioma', uk: 'Мова', pl: 'Język', cs: 'Jazyk' },
  'Virtual tabletop': { en: 'Virtual tabletop', es: 'Mesa virtual', uk: 'Віртуальний ігровий стіл', pl: 'Wirtualny stół do gry', cs: 'Virtuální herní stůl' },
};
export const messages: Record<string, MessageTranslations> = { ...coreMessages, ...advancedMessages, ...domainMessages, ...baseMessages };
const storageKey = 'brama.locale';
const listeners = new Set<() => void>();
function initialLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  try { const saved = window.localStorage.getItem(storageKey); if (isLocale(saved)) return saved; } catch { /* Storage is optional. */ }
  return 'uk';
}
let locale: Locale = initialLocale();
export function getLocale(): Locale { return locale; }
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function setLocale(next: Locale): void {
  if (!isLocale(next)) throw new Error('Unsupported language');
  if (locale === next) return;
  locale = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  try { if (typeof window !== 'undefined') window.localStorage.setItem(storageKey, next); } catch { /* Keep the selection for this session. */ }
  for (const listener of listeners) listener();
}
export function translate(key: string, parameters: MessageParameters = {}, language: Locale = 'en'): string {
  const template = messages[key]?.[language] ?? key;
  return template.replace(/\{([A-Za-z][\w]*)\}/g, (token, name: string) =>
    Object.hasOwn(parameters, name) ? String(parameters[name] ?? '') : token);
}
export function t(key: string, parameters: MessageParameters = {}): string { return translate(key, parameters, locale); }

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
type MessageRule = { key: string; pattern: RegExp; names: string[]; specificity: number };
let exactMessages: Map<string, string> | undefined;
let messageRules: MessageRule[] | undefined;
function prepareSystemMessages(): void {
  exactMessages = new Map(); messageRules = [];
  for (const [key, variants] of Object.entries(messages)) {
    for (const language of LOCALES) {
      const template = variants[language];
      if (!template) continue;
      const slots = [...template.matchAll(/\{([A-Za-z][\w]*)\}/g)];
      if (!slots.length) { if (!exactMessages.has(template)) exactMessages.set(template, key); continue; }
      let cursor = 0, expression = '^'; const names: string[] = [];
      for (const slot of slots) {
        expression += escapeRegex(template.slice(cursor, slot.index)) + '([\\s\\S]*?)';
        names.push(slot[1]); cursor = slot.index! + slot[0].length;
      }
      expression += escapeRegex(template.slice(cursor)) + '$';
      const specificity = template.replace(/\{[A-Za-z][\w]*\}/g, '').length;
      // Never treat an arbitrary user string as a system message through a bare placeholder.
      if (specificity >= 2) messageRules.push({ key, names, pattern: new RegExp(expression), specificity });
    }
  }
  messageRules.sort((a, b) => b.specificity - a.specificity);
}
/** Only call this for application-authored errors/notices, never campaign or chat content. */
export function translateSystemMessage(message: string, allowPathPrefix = true): string {
  if (!exactMessages || !messageRules) prepareSystemMessages();
  const exact = exactMessages!.get(message);
  if (exact) return t(exact);
  if (allowPathPrefix && /^(?:\/[^\r\n]*|\$|): /.test(message)) {
    // Validation diagnostics can carry a schema path before an application message.
    for (const separator of message.matchAll(/: /g)) {
      const start = separator.index! + 2;
      const suffix = message.slice(start), translated = translateSystemMessage(suffix, false);
      if (translated !== suffix) return message.slice(0, start) + translated;
    }
  }
  for (const rule of messageRules!) {
    const match = rule.pattern.exec(message);
    if (match) return t(rule.key, Object.fromEntries(rule.names.map((name, index) => [name, match[index + 1]])));
  }
  return message;
}

/** Only server-authored messages carry this metadata; ordinary chat remains verbatim. */
export function chatMessageText(message: { text: string; system?: { key: string; parameters: Record<string, string | number>; localizedParameters?: string[] } }): string {
  if (!message.system) return message.text;
  const { key, localizedParameters = [] } = message.system;
  const parameters = { ...message.system.parameters };
  for (const name of localizedParameters) if (Object.hasOwn(parameters, name)) parameters[name] = t(String(parameters[name]));
  return t(key, parameters);
}
