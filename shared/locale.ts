/** Supported application locales; stored player content is never translated automatically. */
export const SUPPORTED_LOCALES = ['en', 'es', 'uk', 'pl', 'cs'] as const;
export type Locale = typeof SUPPORTED_LOCALES[number];
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
