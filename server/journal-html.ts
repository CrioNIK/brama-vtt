import sanitizeHtml from 'sanitize-html';
import { JOURNAL_HTML_ATTRIBUTES, JOURNAL_HTML_TAGS, validJournalImageUrl, validJournalLinkUrl } from '../shared/journals.ts';
import { fail } from './engine.ts';

/** Authoritative sanitizer. No resource is fetched; active content and CSS never reach persisted HTML. */
export function sanitizeJournalHtml(html: string): string {
  let containsSecret = false;
  const clean = sanitizeHtml(html, {
    allowedTags: [...JOURNAL_HTML_TAGS],
    allowedAttributes: { a: ['href', 'title', 'target', 'rel'], img: ['src', 'alt', 'title'],
      th: ['colspan', 'rowspan', 'scope'], td: ['colspan', 'rowspan'],
      h1: ['id'], h2: ['id'], h3: ['id'], h4: ['id'], h5: ['id'], h6: ['id'] },
    allowedSchemes: ['http', 'https', 'mailto'], allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'style', 'textarea', 'option', 'iframe', 'object', 'embed', 'svg', 'math', 'template'],
    parseStyleAttributes: false,
    transformTags: {
      '*': (tagName, attributes) => {
        if (/(?:^|\s)secret(?:\s|$)/i.test(attributes.class ?? '')) containsSecret = true;
        const attrs: Record<string, string> = {};
        for (const key of JOURNAL_HTML_ATTRIBUTES) if (attributes[key] !== undefined) attrs[key] = attributes[key];
        if (attrs.id && !/^jh-[A-Za-z0-9_-]{1,76}$/.test(attrs.id)) delete attrs.id;
        if (tagName === 'a') {
          if (!validJournalLinkUrl(attrs.href)) delete attrs.href;
          if (attrs.href && !attrs.href.startsWith('#')) { attrs.target = '_blank'; attrs.rel = 'noopener noreferrer'; }
        }
        if (tagName === 'img' && !validJournalImageUrl(attrs.src)) delete attrs.src;
        for (const key of ['colspan', 'rowspan']) if (attrs[key] && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(attrs[key])) delete attrs[key];
        if (attrs.scope && !['row', 'col', 'rowgroup', 'colgroup'].includes(attrs.scope)) delete attrs.scope;
        return { tagName, attribs: attrs };
      }
    },
    exclusiveFilter: frame => frame.tag === 'img' && !frame.attribs.src
  });
  if (containsSecret) fail('UNSUPPORTED_SECRET', "Inline Secret blocks need a separate model. Move private text to GM notes.");
  return clean;
}
