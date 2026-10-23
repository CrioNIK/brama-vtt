import { randomUUID } from 'node:crypto';
import type { Campaign, Command, Journal, JournalPage, JournalPermissions, JournalPermission, Member } from '../shared/model.ts';
import { JOURNAL_COMMANDS, JOURNAL_LIMITS, canReorderJournalPages, journalAccess, journalPageAccess, plainTextToJournalHtml, validJournalImageUrl } from '../shared/journals.ts';
import { fail, object, str } from './engine.ts';
import { sanitizeJournalHtml } from './journal-html.ts';

const commands = new Set<string>(JOURNAL_COMMANDS);
const uid = () => randomUUID();
const text = (v: unknown, field: string, max = 120, empty = false) => str(v, field, max, empty);
const keys = (p: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(p).some(key => !allowed.includes(key))) fail('VALIDATION', "Unknown journal-command field.");
};
const gm = (member: Member) => { if (member.role !== 'gm') fail('FORBIDDEN', "This action is available to the GM."); };
const unavailable = (): never => fail('JOURNAL_UNAVAILABLE', "This content is unavailable.");
const integer = (value: unknown, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return fail('VALIDATION', "Invalid integer.");
  return value;
};
const rev = (value: unknown, actual: number) => {
  integer(value, 1, Number.MAX_SAFE_INTEGER);
  if (value !== actual) fail('CONFLICT', "The content changed. Keep your draft and load the latest state.");
};
const permission = (value: unknown): JournalPermission => {
  if (value !== 'none' && value !== 'view' && value !== 'edit') return fail('VALIDATION', "Invalid access level.");
  return value;
};
const acl = (value: unknown, campaign: Campaign): JournalPermissions => {
  const p = object(value); keys(p, ['default', 'members']);
  const members = object(p.members), entries = Object.entries(members);
  if (entries.length > 32 || entries.some(([id]) => !campaign.members.some(m => m.id === id))) fail('VALIDATION', "Unknown access member.");
  return { default: permission(p.default), members: Object.fromEntries(entries.map(([id, level]) => [id, permission(level)])) };
};
const folderRef = (value: unknown, campaign: Campaign): string | null => {
  if (value === null) return null;
  const id = text(value, 'folderId');
  if (!campaign.journalFolders.some(folder => folder.id === id)) fail('VALIDATION', "Folder not found.");
  return id;
};
const image = (value: unknown): string => validJournalImageUrl(value) ? value : fail('VALIDATION', "Use an http/https URL or an /assets/ path without directory traversal.");
function pageInput(value: unknown, campaign: Campaign): JournalPage {
  const p = object(value); keys(p, ['name', 'kind', 'html', 'src', 'alt', 'caption', 'permissions']);
  const base = { id: uid(), name: text(p.name ?? "New page", 'name'), revision: 1,
    permissions: p.permissions == null ? null : acl(p.permissions, campaign) };
  if (p.kind === 'text') {
    if (['src', 'alt', 'caption'].some(key => Object.hasOwn(p, key))) fail('VALIDATION', "Image fields are not allowed on a text page.");
    return { ...base, kind: 'text', html: sanitizeJournalHtml(text(p.html ?? '', 'html', JOURNAL_LIMITS.html, true)) };
  }
  if (p.kind === 'image') {
    if (Object.hasOwn(p, 'html')) fail('VALIDATION', "HTML is not allowed on an image page.");
    return { ...base, kind: 'image', src: image(p.src), alt: text(p.alt ?? '', 'alt', 500, true), caption: text(p.caption ?? '', 'caption', 4000, true) };
  }
  return fail('VALIDATION', "Unknown page type.");
}
function validateFolderTree(campaign: Campaign) {
  for (const folder of campaign.journalFolders) {
    const seen = new Set<string>(); let current: typeof folder | undefined = folder;
    while (current) {
      if (seen.has(current.id) || seen.size >= JOURNAL_LIMITS.folderDepth) fail('VALIDATION', "Folder nesting is cyclic or too deep.");
      seen.add(current.id);
      current = current.parentId === null ? undefined : campaign.journalFolders.find(f => f.id === current!.parentId);
      if (!current && [...seen].some(id => {
        const candidate = campaign.journalFolders.find(f => f.id === id)!;
        return candidate.parentId !== null && !campaign.journalFolders.some(f => f.id === candidate.parentId);
      })) fail('VALIDATION', "Parent folder not found.");
    }
  }
}

/** Additive deterministic migration: plain text is escaped, never interpreted as legacy HTML. */
export function normalizeJournals(campaign: Campaign) {
  campaign.journalFolders ??= [];
  campaign.journalPresentations ??= [];
  campaign.journalReceipts ??= [];
  campaign.journals ??= [];
  for (const journal of campaign.journals) {
    if (!Array.isArray(journal.pages)) {
      const content = typeof journal.content === 'string' ? journal.content : '';
      journal.legacyContent = content;
      journal.pages = [{ id: `${journal.id}-page-1`, name: journal.name, revision: 1, permissions: null, kind: 'text', html: plainTextToJournalHtml(content) }];
      journal.permissions = { default: journal.visibleTo === 'all' ? 'view' : 'none', members: {} };
      journal.folderId = null; journal.archived = false; journal.gmNotes = '';
    }
    delete journal.content; delete journal.visibleTo; delete journal.access; delete journal.canReorderPages;
    for (const page of journal.pages) {
      delete page.access;
      if (page.kind === 'text') page.html = sanitizeJournalHtml(page.html);
    }
  }
  for (const presentation of campaign.journalPresentations) for (const page of presentation.pages) {
    if (page.kind === 'text') page.html = sanitizeJournalHtml(page.html);
  }
}

export function applyJournalCommand(campaign: Campaign, member: Member, command: Command): boolean {
  if (!commands.has(command.type)) return false;
  if (command.expectedRevision === undefined) fail('REVISION_REQUIRED', "A journal command requires the current expectedRevision.");
  if (command.expectedRevision !== campaign.revision) fail('CONFLICT', "The campaign changed. Review the content again.");
  if (campaign.journalReceipts.length >= JOURNAL_LIMITS.receipts) fail('LIMIT', "The journal receipt limit has been reached.");
  if ([...campaign.journalReceipts, ...campaign.combatReceipts, ...campaign.actionResolutions, ...campaign.resourceRecoveries,
    ...campaign.outcomeRolls, ...campaign.hpApplications, ...campaign.progressionCommits].some(receipt => receipt.commandId === command.id)) fail('ID_REUSED', "This outcome ID has already been used.");
  const p = object(command.payload);
  let journalId: string | null = null, version = 1;
  if (command.type.startsWith('journal.folder.')) {
    gm(member);
    if (command.type === 'journal.folder.create') {
      keys(p, ['name', 'parentId', 'sort']);
      if (campaign.journalFolders.length >= JOURNAL_LIMITS.folders) fail('LIMIT', "The folder limit has been reached.");
      const folder = { id: uid(), name: text(p.name, 'name'), parentId: p.parentId == null ? null : folderRef(p.parentId, campaign), sort: integer(p.sort ?? 0, -100000, 100000), revision: 1 };
      campaign.journalFolders.push(folder); validateFolderTree(campaign);
    } else {
      keys(p, command.type.endsWith('delete') ? ['id', 'folderRevision'] : ['id', 'folderRevision', 'name', 'parentId', 'sort']);
      const folder = campaign.journalFolders.find(f => f.id === p.id) ?? unavailable();
      rev(p.folderRevision, folder.revision);
      if (command.type === 'journal.folder.delete') {
        if (campaign.journalFolders.some(f => f.parentId === folder.id) || campaign.journals.some(j => j.folderId === folder.id)) fail('FOLDER_NOT_EMPTY', "Move the folder’s contents first.");
        campaign.journalFolders = campaign.journalFolders.filter(f => f.id !== folder.id); version = folder.revision + 1;
      } else {
        if (p.name !== undefined) folder.name = text(p.name, 'name');
        if (p.parentId !== undefined) folder.parentId = folderRef(p.parentId, campaign);
        if (p.sort !== undefined) folder.sort = integer(p.sort, -100000, 100000);
        validateFolderTree(campaign); version = ++folder.revision;
      }
    }
  } else if (command.type.startsWith('journal.presentation.')) {
    keys(p, ['id']);
    const presentation = campaign.journalPresentations.find(entry => entry.id === p.id);
    if (!presentation || (member.role !== 'gm' && !presentation.recipientIds.includes(member.id))) unavailable();
    const entry = presentation!;
    journalId = entry.journalId; version = entry.journalRevision;
    if (command.type === 'journal.presentation.revoke') {
      gm(member); if (entry.revoked) fail('ALREADY_REVOKED', "This presentation has already been revoked."); entry.revoked = true;
    } else {
      if (entry.revoked || !entry.recipientIds.includes(member.id)) unavailable();
      if (entry.dismissedBy.includes(member.id)) fail('ALREADY_DISMISSED', "This presentation has already been dismissed.");
      entry.dismissedBy.push(member.id);
    }
  } else if (command.type === 'journal.create') {
    gm(member); keys(p, ['name', 'folderId', 'permissions', 'gmNotes', 'pages', 'content', 'visibleTo']);
    if (campaign.journals.length >= JOURNAL_LIMITS.journals) fail('LIMIT', "The document limit has been reached.");
    const legacy = p.content !== undefined || p.visibleTo !== undefined;
    if (legacy && (p.pages !== undefined || p.permissions !== undefined)) fail('VALIDATION', "Legacy and paged formats cannot be mixed.");
    if (p.visibleTo !== undefined && p.visibleTo !== 'all' && p.visibleTo !== 'gm') fail('VALIDATION', "Invalid legacy access.");
    const inputs = p.pages ?? [{ name: "Page 1", kind: 'text', html: plainTextToJournalHtml(text(p.content ?? '', 'content', 50000, true)) }];
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > JOURNAL_LIMITS.pages) fail('LIMIT', "Between 1 and 100 pages are required.");
    const journal: Journal = { id: uid(), name: text(p.name ?? "New document", 'name'), revision: 1,
      folderId: p.folderId == null ? null : folderRef(p.folderId, campaign), archived: false,
      permissions: p.permissions === undefined ? { default: p.visibleTo === 'all' ? 'view' : 'none', members: {} } : acl(p.permissions, campaign),
      gmNotes: text(p.gmNotes ?? '', 'gmNotes', JOURNAL_LIMITS.gmNotes, true), pages: (inputs as unknown[]).map(page => pageInput(page, campaign)) };
    campaign.journals.push(journal); journalId = journal.id;
  } else {
    const journal = campaign.journals.find(j => j.id === p.id);
    if (!journal || journalAccess(journal, member) === 'none') unavailable();
    const entry = journal!; journalId = entry.id;
    const legacy = command.type === 'journal.update' && (p.content !== undefined || p.visibleTo !== undefined);
    if (!(legacy && p.journalRevision === undefined)) rev(p.journalRevision, entry.revision);
    if (entry.archived && command.type !== 'journal.archive') fail('ARCHIVED', "Restore the archived document first.");
    if (command.type === 'journal.update') {
      gm(member); keys(p, ['id', 'journalRevision', 'name', 'folderId', 'gmNotes', 'content', 'visibleTo']);
      if (p.name !== undefined) entry.name = text(p.name, 'name');
      if (p.folderId !== undefined) entry.folderId = folderRef(p.folderId, campaign);
      if (p.gmNotes !== undefined) entry.gmNotes = text(p.gmNotes, 'gmNotes', JOURNAL_LIMITS.gmNotes, true);
      if (p.content !== undefined) {
        const first = entry.pages[0];
        if (entry.pages.length !== 1 || first.kind !== 'text') return fail('VALIDATION', "A legacy update requires exactly one text page.");
        first.html = plainTextToJournalHtml(text(p.content, 'content', 50000, true)); first.revision++;
      }
      if (p.visibleTo !== undefined) {
        if (p.visibleTo !== 'all' && p.visibleTo !== 'gm') fail('VALIDATION', "Invalid legacy access.");
        entry.permissions = { default: p.visibleTo === 'all' ? 'view' : 'none', members: {} };
      }
    } else if (command.type === 'journal.archive') {
      gm(member); keys(p, ['id', 'journalRevision', 'archived']);
      if (typeof p.archived !== 'boolean') fail('VALIDATION', "An explicit archived value is required.");
      entry.archived = p.archived as boolean;
      if (entry.archived) campaign.journalPresentations.filter(show => show.journalId === entry.id).forEach(show => { show.revoked = true; });
    } else if (command.type === 'journal.permissions') {
      gm(member); keys(p, ['id', 'journalRevision', 'pageId', 'pageRevision', 'permissions']);
      if (p.pageId !== undefined) {
        const page = entry.pages.find(page => page.id === p.pageId) ?? unavailable(); rev(p.pageRevision, page.revision);
        page.permissions = p.permissions === null ? null : acl(p.permissions, campaign); page.revision++;
      } else entry.permissions = acl(p.permissions, campaign);
    } else if (command.type === 'journal.page.create') {
      keys(p, ['id', 'journalRevision', 'page']);
      if (journalAccess(entry, member) !== 'edit') fail('FORBIDDEN', "You cannot add pages.");
      if (entry.pages.length >= JOURNAL_LIMITS.pages) fail('LIMIT', "The page limit has been reached.");
      const page = pageInput(p.page, campaign);
      if (member.role !== 'gm' && page.permissions !== null) fail('FORBIDDEN', "Only the GM can change access.");
      entry.pages.push(page);
    } else if (command.type === 'journal.page.reorder') {
      keys(p, ['id', 'journalRevision', 'pageIds']);
      if (!canReorderJournalPages(entry, member)) fail('FORBIDDEN', "You cannot reorder the complete page set.");
      const pageIds = p.pageIds;
      if (!Array.isArray(pageIds) || pageIds.length !== entry.pages.length || new Set(pageIds).size !== entry.pages.length || pageIds.some(id => !entry.pages.some(page => page.id === id))) return fail('VALIDATION', "Include each page exactly once.");
      entry.pages = pageIds.map(id => entry.pages.find(page => page.id === id)!);
    } else if (command.type === 'journal.show') {
      gm(member); keys(p, ['id', 'journalRevision', 'pageIds', 'recipientIds']);
      if (campaign.journalPresentations.length >= JOURNAL_LIMITS.presentations) fail('LIMIT', "The presentation limit has been reached.");
      const pageIds = p.pageIds, recipientIds = p.recipientIds;
      if (!Array.isArray(pageIds) || !pageIds.length || new Set(pageIds).size !== pageIds.length || pageIds.some(id => !entry.pages.some(page => page.id === id))) return fail('VALIDATION', "Select existing pages without duplicates.");
      if (!Array.isArray(recipientIds) || !recipientIds.length || recipientIds.length > 32 || new Set(recipientIds).size !== recipientIds.length || recipientIds.some(id => !campaign.members.some(m => m.id === id && m.role === 'player'))) return fail('VALIDATION', "Select players without duplicates.");
      campaign.journalPresentations.push({ id: command.id, journalId: entry.id, journalRevision: entry.revision, title: entry.name,
        pages: pageIds.map(id => ({ ...structuredClone(entry.pages.find(page => page.id === id)!), permissions: null, access: 'view' })),
        recipientIds: [...recipientIds] as string[], authorId: member.id, createdAt: new Date().toISOString(), dismissedBy: [], revoked: false });
    } else {
      keys(p, command.type === 'journal.page.delete' ? ['id', 'journalRevision', 'pageId', 'pageRevision'] : ['id', 'journalRevision', 'pageId', 'pageRevision', 'name', 'html', 'src', 'alt', 'caption']);
      const page = entry.pages.find(page => page.id === p.pageId);
      if (!page || journalPageAccess(entry, page, member) === 'none') unavailable();
      const selected = page!;
      if (journalPageAccess(entry, selected, member) !== 'edit') fail('FORBIDDEN', "You cannot edit this page.");
      rev(p.pageRevision, selected.revision);
      if (command.type === 'journal.page.delete') {
        if (entry.pages.length <= 1) fail('LAST_PAGE', "The last page cannot be deleted.");
        entry.pages = entry.pages.filter(page => page.id !== selected.id);
      } else {
        if (p.name !== undefined) selected.name = text(p.name, 'name');
        if (selected.kind === 'text') {
          if (['src', 'alt', 'caption'].some(key => Object.hasOwn(p, key))) fail('VALIDATION', "Image fields are not allowed on a text page.");
          if (p.html !== undefined) selected.html = sanitizeJournalHtml(text(p.html, 'html', JOURNAL_LIMITS.html, true));
        } else {
          if (Object.hasOwn(p, 'html')) fail('VALIDATION', "HTML is not allowed for an image.");
          if (p.src !== undefined) selected.src = image(p.src);
          if (p.alt !== undefined) selected.alt = text(p.alt, 'alt', 500, true);
          if (p.caption !== undefined) selected.caption = text(p.caption, 'caption', 4000, true);
        }
        selected.revision++;
      }
    }
    // Showing a frozen copy changes the campaign but not the source document revision.
    version = command.type === 'journal.show' ? entry.revision : ++entry.revision;
  }
  campaign.journalReceipts.push({ commandId: command.id, authorId: member.id, action: command.type,
    createdAt: new Date().toISOString(), journalId, version });
  return true;
}

/** Replaces all journal fields with the recipient's projection, including transient shows. */
export function projectJournals(campaign: Campaign, member: Member) {
  if (member.role === 'gm') {
    campaign.journals.forEach(journal => { journal.access = 'edit'; journal.canReorderPages = canReorderJournalPages(journal, member); journal.pages.forEach(page => { page.access = 'edit'; }); });
    return;
  }
  campaign.journals = campaign.journals.filter(journal => journalAccess(journal, member) !== 'none').map(journal => {
    const access = journalAccess(journal, member) as 'view' | 'edit';
    journal.canReorderPages = canReorderJournalPages(journal, member);
    journal.pages = journal.pages.filter(page => journalPageAccess(journal, page, member) !== 'none').map(page => {
      const pageAccess = journalPageAccess(journal, page, member) as 'view' | 'edit';
      return { ...page, permissions: { default: 'none', members: { [member.id]: pageAccess } }, access: pageAccess };
    });
    journal.permissions = { default: 'none', members: { [member.id]: access } };
    journal.gmNotes = ''; journal.access = access; delete journal.legacyContent;
    return journal;
  });
  const folders = new Set<string>();
  for (const journal of campaign.journals) {
    let folder = campaign.journalFolders.find(folder => folder.id === journal.folderId);
    while (folder && !folders.has(folder.id)) { folders.add(folder.id); folder = campaign.journalFolders.find(candidate => candidate.id === folder!.parentId); }
  }
  campaign.journalFolders = campaign.journalFolders.filter(folder => folders.has(folder.id));
  campaign.journalPresentations = campaign.journalPresentations.filter(show => !show.revoked && !show.dismissedBy.includes(member.id) && show.recipientIds.includes(member.id)).map(show => ({
    ...show, recipientIds: [member.id], dismissedBy: [], pages: show.pages.map(page => ({ ...page, permissions: null, access: 'view' }))
  }));
  campaign.journalReceipts = campaign.journalReceipts.filter(receipt => receipt.authorId === member.id);
}
