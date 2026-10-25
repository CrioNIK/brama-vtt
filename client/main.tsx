import React, { useEffect, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './actors.css';
import './actions.css';
import './checks.css';
import './progression.css';
import './brand.css';
import { getLocale, subscribeLocale, t } from '../shared/i18n';
import { initializeGeometryWasm } from '../shared/wasm-raycast';
function LocalizedApp() {
  const language = useSyncExternalStore(subscribeLocale, getLocale, () => 'uk' as const);
  useEffect(() => { document.documentElement.lang = language; document.title = `BRAMA VTT — ${t('Virtual tabletop')}`; }, [language]);
  return <App />;
}
// Initialize before the first scene enters the geometry cache. The loader keeps
// the TypeScript implementation available if the browser cannot load WebAssembly.
void initializeGeometryWasm().then(() => {
  createRoot(document.getElementById('root')!).render(<React.StrictMode><LocalizedApp /></React.StrictMode>);
});
