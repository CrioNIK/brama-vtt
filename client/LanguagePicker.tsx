import { useSyncExternalStore } from 'react';
import { getLocale, isLocale, LOCALES, LOCALE_NAMES, setLocale, subscribeLocale, t } from '../shared/i18n';

export function LanguagePicker() {
  const language = useSyncExternalStore(subscribeLocale, getLocale, () => 'uk' as const);
  return <label className="language-picker"><span>{t('Language')}</span><select aria-label={t('Language')} value={language} onChange={event => { if (isLocale(event.target.value)) setLocale(event.target.value); }}>
    {LOCALES.map(code => <option key={code} value={code} lang={code}>{LOCALE_NAMES[code]}</option>)}
  </select></label>;
}
