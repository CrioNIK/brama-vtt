import { t, translateSystemMessage } from '../shared/i18n';
import { useState } from 'react';
import type { Actor, ActorAction, ActorSpell } from '../shared/model';
import type { ActionProps } from './Actions';

export const preparationLabel = (spell: ActorSpell) => spell.level === 0 ? t("Cantrip · no preparation needed") : spell.preparation === 'always' ? t("Always prepared") : spell.preparation === 'prepared' ? t("Prepared") : t("Not prepared");

export function Spellbook({ actor, campaign, command, reliable, online, hasDraft }: ActionProps) {
  const [busy, setBusy] = useState<string | null>(null), [notice, setNotice] = useState('');
  if (!actor.spellcasting) return null;
  const pending = reliable.operations.some(operation => operation.actorId === actor.id) || !!reliable.storageError;
  async function prepare(spell: ActorSpell) {
    if (!online || busy || hasDraft || pending) return;
    setBusy(spell.id); setNotice('');
    try {
      if (await command('actor.spell.prepare', { id: actor.id, spellId: spell.id, spellVersion: spell.version, prepared: spell.preparation !== 'prepared' }, campaign.revision)) setNotice(t("“{value0}”: preparation updated for all its actions.", { value0: spell.name }));
    } finally { setBusy(null); }
  }
  return <section className="spellbook" aria-label={t("Character spells")}>
    <h3>{t("Spells")}</h3>
    <p className="muted small">{t("Casting is available at base level. Preparation applies to every action of the spell. Confirm range, target validity and action cost with the GM.")}</p>
    <div className="spellbook-cards">{actor.spellcasting.spells.map(spell => <article className="spell-card" key={spell.id} aria-label={t("Spell: {value0}", { value0: spell.name })}>
      <div><strong>{spell.name}</strong><span className="muted small">{spell.level === 0 ? t("Cantrip") : t("Level {value0}", { value0: spell.level })} {t("· actions:")} {actor.actions.filter(action => action.spellId === spell.id).length}</span></div>
      <div className="spell-preparation"><span>{preparationLabel(spell)}</span>{spell.level > 0 && spell.preparation !== 'always' && <button aria-label={`${spell.preparation === 'prepared' ? t("Unprepare") : t("Prepare")}: ${spell.name}`} disabled={!online || busy !== null || hasDraft || pending} onClick={() => void prepare(spell)}>{busy === spell.id ? t("Saving…") : spell.preparation === 'prepared' ? t("Unprepare") : t("Prepare")}</button>}</div>
      {spell.description && <details><summary>{t("Spell description")}</summary><p className="plain-text small">{spell.description}</p></details>}
    </article>)}</div>
    {notice && <p className="muted small" role="status">{translateSystemMessage(notice)}</p>}
    <UnsupportedSpells actor={actor}/>
  </section>;
}

export function UnsupportedSpells({ actor }: { actor: Actor }) {
  const blocked = actor.spellcasting?.unsupported ?? [];
  return blocked.length > 0 ? <details className="spell-unsupported"><summary>{t("Not imported:")} {blocked.length}</summary><p className="muted small">{t("These entries cannot be used here. Their original definitions remain in the transfer file.")}</p><ul>{blocked.map((item, i) => <li key={i}><strong>{item.name || (item.kind === 'resource' ? t("Resource") : t("Untitled"))}</strong><p>{translateSystemMessage(item.reason)}</p></li>)}</ul></details> : null;
}

export function SpellContext({ action }: { action: ActorAction }) {
  if (!action.casting) return null;
  const context = action.casting;
  const origin = (field: 'activation' | 'duration' | 'range' | 'target') => action.inheritance?.[field] === 'item-merge' ? t("from spell") : t("custom value");
  return <dl className="spell-context">
    <div><dt>{t("Activation")} <small>{origin('activation')}</small></dt><dd>{t("Action")}</dd></div>
    <div><dt>{t("Range")} <small>{origin('range')}</small></dt><dd>{context.range.type === 'self' ? t("Self") : t("{value0} feet", { value0: context.range.value })}</dd></div>
    <div><dt>{t("Target")} <small>{origin('target')}</small></dt><dd>{t("1 creature")}</dd></div>
    <div><dt>{t("Duration")} <small>{origin('duration')}</small></dt><dd>{t("Instantaneous")}</dd></div>
  </dl>;
}
