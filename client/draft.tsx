import { t as tr } from '../shared/i18n';
import { useEffect, useRef, useState } from 'react';

/** Freeze the revision when editing starts; never overwrite a concurrent change. */
export function useDraft<T extends object>(value: T, revision: number) {
  const [draft, setDraft] = useState(value), [dirty, setDirty] = useState(false);
  const [baseRevision, setBaseRevision] = useState(revision);
  const latest = useRef({ value, revision }); latest.current = { value, revision };
  const signature = JSON.stringify(value);
  useEffect(() => {
    if (!dirty) { setDraft(latest.current.value); setBaseRevision(latest.current.revision); }
  }, [signature, revision, dirty]);
  function edit(update: Partial<T>) {
    if (!dirty) setBaseRevision(latest.current.revision);
    setDraft(previous => ({ ...previous, ...update })); setDirty(true);
  }
  function reload() { setDraft(latest.current.value); setBaseRevision(latest.current.revision); setDirty(false); }
  return { draft, dirty, edit, reload, baseRevision, saved: () => setDirty(false), conflict: dirty && revision !== baseRevision };
}
export function DraftConflict({ show, reload }: { show: boolean; reload: () => void }) {
  return show ? <div className="draft-conflict" role="status"><p>{tr("The campaign changed while editing. Your draft is preserved in the form. Copy any text you need before replacing it.")}</p><button type="button" onClick={reload}>{tr("Replace draft with current data")}</button></div> : null;
}
