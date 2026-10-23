import type { CommandType, Member } from './model.ts';

export type JournalPermission = 'none' | 'view' | 'edit';
export interface JournalPermissions { default: JournalPermission; members: Record<string, JournalPermission> }
interface JournalPageBase {
  id: string; name: string; revision: number; permissions: JournalPermissions | null;
  /** Computed by projection, never accepted as persisted authority. */
  access?: 'view' | 'edit';
}
export type JournalPage = JournalPageBase & (
  { kind: 'text'; html: string } | { kind: 'image'; src: string; alt: string; caption: string }
);
export interface Journal {
  id: string; name: string; revision: number; folderId: string | null; archived: boolean;
  permissions: JournalPermissions; gmNotes: string; pages: JournalPage[];
  access?: 'view' | 'edit';
  /** Recipient capability only; does not reveal how many hidden pages exist. */
  canReorderPages?: boolean;
  /** Original plain text of a migrated record; GM-only, never an editable second source. */
  legacyContent?: string;
  /** Legacy fields are accepted only by the migration/compatibility command adapter. */
  content?: string; visibleTo?: 'all' | 'gm';
}
export interface JournalFolder { id: string; name: string; parentId: string | null; sort: number; revision: number }
export interface JournalPresentation {
  id: string; journalId: string; journalRevision: number; title: string;
  pages: JournalPage[]; recipientIds: string[]; authorId: string; createdAt: string;
  dismissedBy: string[]; revoked: boolean;
}
export interface JournalReceipt {
  commandId: string; authorId: string; action: CommandType; createdAt: string;
  journalId: string | null; version: number;
}
export const JOURNAL_COMMANDS = ['journal.create', 'journal.update', 'journal.archive', 'journal.permissions',
  'journal.page.create', 'journal.page.update', 'journal.page.delete', 'journal.page.reorder',
  'journal.folder.create', 'journal.folder.update', 'journal.folder.delete',
  'journal.show', 'journal.presentation.dismiss', 'journal.presentation.revoke'] as const;
export type JournalCommandType = typeof JOURNAL_COMMANDS[number];
export const JOURNAL_LIMITS = { journals: 500, pages: 100, folders: 100, folderDepth: 8,
  html: 100000, gmNotes: 50000, presentations: 1000, receipts: 5000 } as const;
export const JOURNAL_HTML_TAGS = ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i',
  'u', 's', 'strike', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'a', 'img', 'table', 'thead',
  'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'sub', 'sup', 'span'] as const;
export const JOURNAL_HTML_ATTRIBUTES = ['href', 'src', 'alt', 'title', 'id', 'colspan', 'rowspan', 'scope'] as const;

export function journalAccess(journal: Journal, member: Pick<Member, 'id' | 'role'>): JournalPermission {
  if (member.role === 'gm') return 'edit';
  if (journal.archived) return 'none';
  return journal.permissions.members[member.id] ?? journal.permissions.default;
}
export function journalPageAccess(journal: Journal, page: JournalPage, member: Pick<Member, 'id' | 'role'>): JournalPermission {
  const parent = journalAccess(journal, member);
  if (parent === 'none' || member.role === 'gm') return parent;
  return page.permissions === null ? parent : page.permissions.members[member.id] ?? page.permissions.default;
}
export const getJournalAccess = journalAccess;
export const getJournalPageAccess = journalPageAccess;
export function canReorderJournalPages(journal: Journal, member: Pick<Member, 'id' | 'role'>): boolean {
  return !journal.archived && journalAccess(journal, member) === 'edit'
    && journal.pages.every(page => journalPageAccess(journal, page, member) !== 'none');
}

/** Validate a reference only. This does not fetch, upload or guarantee the referenced image exists. */
export function validJournalImageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  if (value.startsWith('/assets/')) {
    try {
      const decoded = decodeURIComponent(value);
      return !/[?#\\\u0000-\u0020\u007f]/.test(decoded) && !decoded.split('/').some(part => part === '..' || part === '.')
        && !decoded.includes('%') && decoded.length > 8;
    } catch { return false; }
  }
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}
export function validJournalLinkUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  if (/^#[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value)) return true;
  if (validJournalImageUrl(value)) return true;
  return /^mailto:[^?<>\s]+@[^?<>\s]+$/.test(value);
}
export function plainTextToJournalHtml(content: string): string {
  const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return `<p>${escaped.replace(/\r\n|\r|\n/g, '<br>')}</p>`;
}
