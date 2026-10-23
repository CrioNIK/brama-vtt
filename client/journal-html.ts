import { t } from '../shared/i18n';
import DOMPurify from 'dompurify';
import { JOURNAL_HTML_ATTRIBUTES, JOURNAL_HTML_TAGS, validJournalImageUrl, validJournalLinkUrl } from '../shared/journals';

export function safeJournalImage(raw: string): string | null {
  const value = raw.trim();
  return validJournalImageUrl(value) ? value : null;
}
export function safeJournalLink(raw: string): string | null {
  const value = raw.trim();
  return validJournalLinkUrl(value) ? value : null;
}

const secretProblem = () => t("Embedded Secret blocks are unsupported. Keep private text in GM notes. Pasting and editing this HTML is blocked.");
const EDITOR_TAGS = new Set<string>(JOURNAL_HTML_TAGS.filter(tag => !['sub', 'sup', 'caption', 'thead', 'tfoot'].includes(tag)));
const EDITOR_ATTRIBUTES: Record<string, ReadonlySet<string>> = {
  a: new Set(['href', 'title', 'target', 'rel']),
  img: new Set(['src', 'alt', 'title', 'loading', 'referrerpolicy']),
  th: new Set(['colspan', 'rowspan']),
  td: new Set(['colspan', 'rowspan']),
};
function secretElements(document: Document): Element[] {
  return Array.from(document.querySelectorAll('[class]')).filter(element => /(?:^|\s)secret(?:\s|$)/i.test(element.getAttribute('class') || ''));
}
function rawSecretCount(html: string): number {
  let count = 0;
  // HTML tree repair can discard an orphan <tr>/<td> before a DOM query sees its class.
  // Tokenize opening tags first; quoted '>' characters must not terminate an attribute.
  for (const tag of html.matchAll(/<[a-z][a-z0-9:-]*((?:\s+(?:"[^"]*"|'[^']*'|[^'">])*)?)\s*\/?>/gi)) {
    for (const attribute of tag[1].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      if (attribute[1].toLowerCase() !== 'class') continue;
      const encoded = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
      const decoded = new DOMParser().parseFromString(`<p>${encoded.replaceAll('<', '&lt;')}</p>`, 'text/html').body.textContent || '';
      if (/(?:^|\s)secret(?:\s|$)/i.test(decoded)) { count++; break; }
    }
  }
  return count;
}

/** Check raw HTML before sanitizing or passing it into Tiptap's narrower schema. */
export function journalEditorProblem(html: string): string | null {
  const document = new DOMParser().parseFromString(html, 'text/html');
  if (rawSecretCount(html) || secretElements(document).length) return secretProblem();
  for (const element of document.body.querySelectorAll('*')) {
    const tag = element.localName;
    if (!EDITOR_TAGS.has(tag)) return t("The editor cannot preserve <{value0}> yet. The page is read only; original markup is unchanged.", { value0: tag });
    for (const attribute of Array.from(element.attributes)) {
      if (!EDITOR_ATTRIBUTES[tag]?.has(attribute.name)) return t("The editor cannot preserve attribute {value0} on <{value1}> yet. The page is read only; original markup is unchanged.", { value0: attribute.name, value1: tag });
    }
    if (tag === 'a' && (!element.hasAttribute('href') || !safeJournalLink(element.getAttribute('href') || ''))) return t("A link without a supported address cannot be edited safely. Original markup is preserved.");
    if (tag === 'img' && !safeJournalImage(element.getAttribute('src') || '')) return t("An image without a supported address cannot be edited safely. Original markup is preserved.");
    if ((tag === 'td' || tag === 'th') && ['colspan', 'rowspan'].some(name => element.hasAttribute(name) && !/^(?:[1-9]|[1-9]\d|100)$/.test(element.getAttribute(name) || ''))) return t("Unsupported merged cell size. Original markup is preserved.");
  }
  return null;
}
/** Server sanitization is authoritative. This protects local drafts and rendering as well. */
export function cleanJournalHtml(html: string): string {
  // Removing only class would disclose the contents. Remove the whole secret subtree first.
  const source = new DOMParser().parseFromString(html, 'text/html');
  const secrets = secretElements(source);
  // If tree repair lost a secret boundary, its contents cannot be separated reliably.
  if (rawSecretCount(html) > secrets.length) return '';
  for (const element of secrets) {
    if (element === source.body || element === source.documentElement) source.body.replaceChildren();
    else element.remove();
  }
  const clean = DOMPurify.sanitize(source.body.innerHTML, {
    ALLOWED_TAGS: [...JOURNAL_HTML_TAGS], ALLOWED_ATTR: [...JOURNAL_HTML_ATTRIBUTES],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
  });
  const document = new DOMParser().parseFromString(clean, 'text/html');
  document.querySelectorAll('a').forEach(link => { const safe = safeJournalLink(link.getAttribute('href') || ''); if (safe) { link.setAttribute('href', safe); link.setAttribute('target', '_blank'); link.setAttribute('rel', 'noopener noreferrer'); } else link.removeAttribute('href'); });
  document.querySelectorAll('img').forEach(img => { const safe = safeJournalImage(img.getAttribute('src') || ''); if (safe) { img.setAttribute('src', safe); img.setAttribute('referrerpolicy', 'no-referrer'); img.setAttribute('loading', 'lazy'); } else img.removeAttribute('src'); });
  return document.body.innerHTML;
}
