import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store, type Session } from '../server/store.ts';
import type { Command, Journal } from '../shared/model.ts';
import { seedCampaign } from '../server/engine.ts';
import { readCampaign } from '../server/migrations.ts';
import { sanitizeJournalHtml } from '../server/journal-html.ts';
import { JOURNAL_COMMANDS, plainTextToJournalHtml, validJournalImageUrl } from '../shared/journals.ts';

function fixture(path = ':memory:') {
  let store = new Store(path);
  const auth = store.create('Synthetic journal lab', 'GM'), gm = store.authenticate(auth.token);
  const aAuth = store.join(store.snapshot(gm).inviteCode!, 'Editor'), a = store.authenticate(aAuth.token);
  const bAuth = store.join(store.snapshot(gm).inviteCode!, 'Viewer'), b = store.authenticate(bAuth.token);
  const state = () => store.export(gm);
  const issue = (who: Session, type: Command['type'], payload: Record<string, unknown>, extra: Partial<Command> = {}) =>
    store.command(who, { id: randomUUID(), type, payload, expectedRevision: state().revision, ...extra });
  const ok = (who: Session, type: Command['type'], payload: Record<string, unknown>, extra: Partial<Command> = {}) => {
    const result = issue(who, type, payload, extra); assert.equal(result.ack.ok, true, `${type}: ${result.ack.code} ${result.ack.error}`); return result;
  };
  const get = (id: string) => state().journals.find(j => j.id === id)!;
  const create = (extra: Record<string, unknown> = {}) => {
    ok(gm, 'journal.create', { name: 'Research pages', permissions: { default: 'none', members: { [aAuth.memberId]: 'edit', [bAuth.memberId]: 'view' } },
      gmNotes: 'only-gm-secret', pages: [{ name: 'Text', kind: 'text', html: '<h2>Research</h2><p>Original</p>' },
        { name: 'Image', kind: 'image', src: '/assets/observatory.svg', alt: 'Observatory', caption: 'Test image' }], ...extra });
    return state().journals.at(-1)!;
  };
  const journal = (who: Session, type: Command['type'], id: string, payload: Record<string, unknown> = {}, extra: Partial<Command> = {}) =>
    issue(who, type, { id, journalRevision: get(id).revision, ...payload }, extra);
  return { get store() { return store; }, gm, a, b, aAuth, bAuth, state, issue, ok, get, create, journal,
    reopen() { store.close(); store = new Store(path); } };
}
const use = (run: (f: ReturnType<typeof fixture>) => void) => { const f = fixture(); try { run(f); } finally { f.store.close(); } };

test('legacy plain journal migration is deterministic, escaped and lossless with default permissions', () => {
  const campaign = seedCampaign('Legacy', 'GM');
  const legacy = { id: 'legacy-doc', name: 'Old', revision: 7, content: '<script>not executable</script>\n& quoted', visibleTo: 'all' };
  const raw = JSON.stringify({ ...campaign, journalFolders: undefined, journalPresentations: undefined, journalReceipts: undefined, journals: [legacy] });
  const first = readCampaign(raw), second = readCampaign(JSON.stringify(first));
  assert.deepEqual(first, second);
  assert.equal(first.journals[0].legacyContent, legacy.content);
  assert.equal(first.journals[0].pages[0].id, 'legacy-doc-page-1');
  assert.equal(first.journals[0].pages[0].kind === 'text' && first.journals[0].pages[0].html, '<p>&lt;script&gt;not executable&lt;/script&gt;<br />&amp; quoted</p>');
  assert.deepEqual(first.journals[0].permissions, { default: 'view', members: {} });
  assert.equal(first.journals[0].content, undefined); assert.equal(first.journals[0].revision, 7);
  assert.deepEqual(first.journalReceipts, []);
});

test('server sanitizer keeps rich structure and valid images while excluding executable or clobbering markup', () => {
  const html = sanitizeJournalHtml('<h2 id="jh-start">Title</h2><p><strong>Bold</strong> <em>em</em> <u>u</u></p><ul><li>one</li></ul><blockquote>quote</blockquote><pre><code>&lt;script&gt;literal&lt;/script&gt;</code></pre><table><tbody><tr><th colspan="2">Head</th></tr><tr><td>cell</td></tr></tbody></table><a href="https://example.org/doc">link</a><img src="/assets/observatory.svg" alt="map">');
  for (const expected of ['<h2 id="jh-start">', '<strong>', '<em>', '<u>', '<ul>', '<blockquote>', '<pre><code>', '<table>', 'colspan="2"', 'src="/assets/observatory.svg"']) assert.ok(html.includes(expected), expected);
  assert.ok(html.includes('rel="noopener noreferrer"')); assert.ok(html.includes('&lt;script&gt;literal'));
  const dirty = '<script>LEAK_A</script><style>LEAK_B</style><iframe srcdoc="LEAK_C">LEAK_D</iframe><svg><a xlink:href="javascript:evil()">LEAK_E</a></svg><math><mtext>LEAK_F</mtext></math><p onclick="evil()" style="background:url(javascript:evil())">safe</p><a href="jav&#x61;script:evil()">bad link</a><img src="data:image/svg+xml,bad" onerror="evil()"><h2 id="__proto__">title</h2>';
  const clean = sanitizeJournalHtml(dirty);
  assert.ok(clean.includes('safe')); assert.ok(!/LEAK_|script:|onclick|style=|onerror|srcdoc|<svg|<math|__proto__/.test(clean));
  assert.equal(sanitizeJournalHtml(clean), clean, 'normalization is idempotent');
  assert.throws(() => sanitizeJournalHtml('<section class="secret">private</section>'), /Secret/);
});

test('image references are validated without fetching and bad URLs roll back the full command', () => use(f => {
  for (const src of ['/assets/../private', '/assets/%2e%2e/private', '/assets/%252e%252e/private', '//tracker.test/a', 'javascript:alert(1)', 'data:image/png,x', 'https://user:pass@example.org/a', 'file:///tmp/a', 'https://example.org/\nimage']) assert.equal(validJournalImageUrl(src), false, src);
  assert.equal(validJournalImageUrl('https://example.org/unavailable.png'), true);
  const j = f.create(), before = f.state();
  const result = f.journal(f.gm, 'journal.page.update', j.id, { pageId: j.pages[1].id, pageRevision: 1, name: 'Must not partially save', src: 'javascript:alert(1)' });
  assert.equal(result.ack.code, 'VALIDATION'); assert.deepEqual(f.state(), before);
}));

test('every journal mutation requires a campaign revision including legacy requests', () => use(f => {
  for (const type of JOURNAL_COMMANDS) {
    const before = f.state(); const result = f.issue(f.gm, type, {}, { expectedRevision: undefined });
    assert.equal(result.ack.code, 'REVISION_REQUIRED', type); assert.deepEqual(f.state(), before);
  }
}));

test('server projection enforces per-page access, removes GM notes and does not disclose other member ACLs', () => use(f => {
  const j = f.create();
  f.ok(f.gm, 'journal.permissions', { id: j.id, journalRevision: 1, pageId: j.pages[1].id, pageRevision: 1, permissions: { default: 'none', members: {} } });
  const projected = f.store.snapshot(f.a).campaign.journals.find(x => x.id === j.id)!;
  assert.equal(projected.access, 'edit'); assert.equal(projected.pages.length, 1); assert.equal(projected.pages[0].access, 'edit');
  assert.equal(projected.canReorderPages, false);
  assert.ok(!JSON.stringify(projected).includes(j.pages[1].id), 'capability does not disclose hidden page identity');
  assert.ok(!Object.keys(projected).some(key => /count|total|hidden/i.test(key)), 'no total/hidden count is projected');
  assert.equal(projected.gmNotes, ''); assert.ok(!JSON.stringify(projected).includes('only-gm-secret'));
  assert.ok(!JSON.stringify(projected.permissions).includes(f.bAuth.memberId));
  assert.equal(f.store.snapshot(f.gm).campaign.journals.find(x => x.id === j.id)!.pages.length, 2);
  assert.equal(f.store.snapshot(f.gm).campaign.journals.find(x => x.id === j.id)!.canReorderPages, true);
  assert.equal(f.journal(f.a, 'journal.page.reorder', j.id, { pageIds: [j.pages[0].id] }).ack.code, 'FORBIDDEN');
  const denied = f.journal(f.a, 'journal.page.update', j.id, { pageId: j.pages[1].id, pageRevision: 2, caption: 'guess' });
  assert.equal(denied.ack.code, 'JOURNAL_UNAVAILABLE');
}));

test('page editing, parent gating and ACL revocation are checked at command time', () => use(f => {
  const j = f.create();
  assert.equal(f.journal(f.a, 'journal.page.update', j.id, { pageId: j.pages[0].id, pageRevision: 1, html: '<p>Editor saved</p>' }).ack.ok, true);
  assert.equal(f.journal(f.b, 'journal.page.update', j.id, { pageId: j.pages[0].id, pageRevision: 2, html: '<p>Forbidden</p>' }).ack.code, 'FORBIDDEN');
  for (const type of ['journal.update', 'journal.permissions', 'journal.archive', 'journal.show'] as const) assert.equal(f.journal(f.a, type, j.id).ack.code, 'FORBIDDEN');
  const latest = f.get(j.id);
  f.ok(f.gm, 'journal.permissions', { id: j.id, journalRevision: latest.revision, permissions: { default: 'none', members: {} } });
  const before = f.state();
  assert.equal(f.journal(f.a, 'journal.page.update', j.id, { pageId: j.pages[0].id, pageRevision: 2, html: 'stale owner' }).ack.code, 'JOURNAL_UNAVAILABLE');
  assert.equal(f.store.snapshot(f.a).campaign.journals.some(x => x.id === j.id), false); assert.deepEqual(f.state(), before);
}));

test('concurrent document/page revisions preserve the losing draft without a partial overwrite', () => use(f => {
  const j = f.create(), revision = f.state().revision;
  assert.equal(f.journal(f.a, 'journal.page.update', j.id, { pageId: j.pages[0].id, pageRevision: 1, html: '<p>Winner</p>' }, { expectedRevision: revision }).ack.ok, true);
  const after = f.state();
  assert.equal(f.issue(f.gm, 'journal.page.update', { id: j.id, journalRevision: 1, pageId: j.pages[0].id, pageRevision: 1, html: '<p>Loser</p>' }, { expectedRevision: revision }).ack.code, 'CONFLICT');
  assert.equal(f.journal(f.gm, 'journal.page.update', j.id, { pageId: j.pages[0].id, pageRevision: 1, html: '<p>Still stale page</p>' }).ack.code, 'CONFLICT');
  assert.deepEqual(f.state(), after);
}));

test('page creation, exact permutation and deletion enforce permissions and keep at least one page', () => use(f => {
  const j = f.create();
  assert.equal(f.store.snapshot(f.a).campaign.journals.find(entry => entry.id === j.id)!.canReorderPages, true);
  assert.equal(f.store.snapshot(f.b).campaign.journals.find(entry => entry.id === j.id)!.canReorderPages, false);
  assert.equal(f.journal(f.a, 'journal.page.create', j.id, { page: { kind: 'text', name: 'Third', html: '<p>3</p>' } }).ack.ok, true);
  const pages = f.get(j.id).pages, ids = pages.map(p => p.id).reverse();
  assert.equal(f.journal(f.a, 'journal.page.reorder', j.id, { pageIds: ids }).ack.ok, true);
  assert.deepEqual(f.get(j.id).pages.map(p => p.id), ids);
  const before = f.state();
  assert.equal(f.journal(f.gm, 'journal.page.reorder', j.id, { pageIds: [ids[0], ids[0], ids[2]] }).ack.code, 'VALIDATION'); assert.deepEqual(f.state(), before);
  for (const page of pages.slice(0, 2)) assert.equal(f.journal(f.a, 'journal.page.delete', j.id, { pageId: page.id, pageRevision: page.revision }).ack.ok, true);
  assert.equal(f.journal(f.a, 'journal.page.delete', j.id, { pageId: pages[2].id, pageRevision: pages[2].revision }).ack.code, 'LAST_PAGE');
}));

test('folder references reject cycles and nonempty deletion and project only visible paths', () => use(f => {
  f.ok(f.gm, 'journal.folder.create', { name: 'Root' }); const root = f.state().journalFolders[0];
  f.ok(f.gm, 'journal.folder.create', { name: 'Child', parentId: root.id }); const child = f.state().journalFolders[1];
  f.ok(f.gm, 'journal.folder.create', { name: 'Unrelated private' }); const unrelated = f.state().journalFolders[2];
  const j = f.create({ folderId: child.id });
  assert.deepEqual(f.store.snapshot(f.a).campaign.journalFolders.map(folder => folder.id), [root.id, child.id]);
  const before = f.state();
  assert.equal(f.issue(f.gm, 'journal.folder.update', { id: root.id, folderRevision: 1, parentId: child.id }).ack.code, 'VALIDATION');
  assert.equal(f.issue(f.gm, 'journal.folder.delete', { id: child.id, folderRevision: 1 }).ack.code, 'FOLDER_NOT_EMPTY'); assert.deepEqual(f.state(), before);
  f.ok(f.gm, 'journal.folder.delete', { id: unrelated.id, folderRevision: 1 });
  assert.equal(f.journal(f.gm, 'journal.update', j.id, { folderId: null }).ack.ok, true);
  f.ok(f.gm, 'journal.folder.delete', { id: child.id, folderRevision: 1 });
}));

test('show sends a frozen selected-page copy to selected players without changing persistent access', () => use(f => {
  const j = f.create({ permissions: { default: 'none', members: {} } });
  const revision = j.revision;
  assert.equal(f.journal(f.gm, 'journal.show', j.id, { pageIds: [j.pages[0].id], recipientIds: [f.aAuth.memberId] }).ack.ok, true);
  const show = f.state().journalPresentations[0];
  assert.equal(show.journalRevision, revision); assert.equal(f.get(j.id).revision, revision);
  assert.equal(f.store.snapshot(f.a).campaign.journals.some(entry => entry.id === j.id), false);
  const view = f.store.snapshot(f.a).campaign.journalPresentations[0];
  assert.equal(view.pages.length, 1); assert.ok(!JSON.stringify(view).includes('only-gm-secret'));
  assert.deepEqual(f.store.snapshot(f.b).campaign.journalPresentations, []);
  assert.equal(f.journal(f.gm, 'journal.page.update', j.id, { pageId: j.pages[0].id, pageRevision: 1, html: '<p>Later version</p>' }).ack.ok, true);
  assert.deepEqual(f.state().journalPresentations[0], show, 'later edits do not rewrite delivery snapshot');
}));

test('dismissal is recipient-specific, revoke is GM-only and archiving revokes active presentations', () => use(f => {
  const j = f.create();
  const show = () => { assert.equal(f.journal(f.gm, 'journal.show', j.id, { pageIds: [j.pages[0].id], recipientIds: [f.aAuth.memberId, f.bAuth.memberId] }).ack.ok, true); return f.state().journalPresentations.at(-1)!; };
  const first = show(); f.ok(f.a, 'journal.presentation.dismiss', { id: first.id });
  assert.deepEqual(f.store.snapshot(f.a).campaign.journalPresentations, []); assert.equal(f.store.snapshot(f.b).campaign.journalPresentations.length, 1);
  assert.equal(f.issue(f.b, 'journal.presentation.revoke', { id: first.id }).ack.code, 'FORBIDDEN');
  f.ok(f.gm, 'journal.presentation.revoke', { id: first.id }); assert.deepEqual(f.store.snapshot(f.b).campaign.journalPresentations, []);
  show(); assert.equal(f.journal(f.gm, 'journal.archive', j.id, { archived: true }).ack.ok, true);
  assert.equal(f.store.snapshot(f.gm).campaign.journals.find(entry => entry.id === j.id)!.canReorderPages, false);
  assert.deepEqual(f.store.snapshot(f.a).campaign.journalPresentations, []);
  assert.equal(f.store.snapshot(f.a).campaign.journals.some(entry => entry.id === j.id), false);
  assert.equal(f.journal(f.gm, 'journal.page.update', j.id, { pageId: j.pages[0].id, pageRevision: 1, html: 'archive edit' }).ack.code, 'ARCHIVED');
  assert.equal(f.journal(f.gm, 'journal.archive', j.id, { archived: false }).ack.ok, true);
  assert.equal(f.store.snapshot(f.a).campaign.journals.some(entry => entry.id === j.id), true);
  assert.deepEqual(f.store.snapshot(f.a).campaign.journalPresentations, [], 'restore does not re-show revoked snapshots');
}));

test('exact show retry after SQLite reopen cannot duplicate delivery and changed ID payload rejects', () => {
  const directory = mkdtempSync(join(tmpdir(), 'vtt-journal-test-')), path = join(directory, 'test.sqlite'), f = fixture(path);
  try {
    const j = f.create(), command: Command = { id: randomUUID(), type: 'journal.show', expectedRevision: f.state().revision,
      payload: { id: j.id, journalRevision: j.revision, pageIds: [j.pages[0].id], recipientIds: [f.aAuth.memberId] } };
    const first = f.store.command(f.gm, command); assert.equal(first.ack.ok, true); const after = f.state();
    f.reopen(); assert.deepEqual(f.store.command(f.gm, command), { ack: first.ack, changed: false });
    assert.deepEqual(f.state(), after);
    assert.equal(f.store.command(f.gm, { ...command, payload: { ...command.payload, recipientIds: [f.bAuth.memberId] } }).ack.code, 'ID_REUSED');
    assert.equal(f.state().journalPresentations.length, 1);
  } finally { f.store.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()))); rmSync(directory, { recursive: true, force: true }); }
});

test('journal and combat receipts enforce cross-family IDs in both directions', () => use(f => {
  const j = f.create();
  for (const journalFirst of [true, false]) {
    const id = randomUUID();
    if (journalFirst) assert.equal(f.journal(f.a, 'journal.page.update', j.id, { pageId: j.pages[0].id, pageRevision: f.get(j.id).pages[0].revision, html: '<p>Journal first</p>' }, { id }).ack.ok, true);
    else f.ok(f.gm, 'combat.settings', { allowPlayerEndTurn: true }, { id });
    const before = f.state();
    const next = journalFirst ? f.issue(f.gm, 'combat.settings', { allowPlayerEndTurn: false }, { id })
      : f.journal(f.a, 'journal.page.update', j.id, { pageId: j.pages[0].id, pageRevision: f.get(j.id).pages[0].revision, html: '<p>Must not apply</p>' }, { id });
    assert.equal(next.ack.code, 'ID_REUSED'); assert.deepEqual(f.state(), before);
  }
}));

test('legacy content commands remain compatible but canonical pages are the only mutable source', () => use(f => {
  f.ok(f.gm, 'journal.create', { name: 'Legacy command', content: '<b>literal</b>', visibleTo: 'all' });
  const j = f.state().journals.at(-1)!;
  assert.equal(j.content, undefined); assert.equal(j.pages[0].kind === 'text' && j.pages[0].html, '<p>&lt;b&gt;literal&lt;/b&gt;</p>');
  f.ok(f.gm, 'journal.update', { id: j.id, content: 'new\ntext' });
  assert.equal(f.get(j.id).pages[0].kind === 'text' && (f.get(j.id).pages[0] as Extract<Journal['pages'][number], { kind: 'text' }>).html, '<p>new<br />text</p>');
  assert.equal(f.store.snapshot(f.a).campaign.journals.find(entry => entry.id === j.id)!.legacyContent, undefined);
}));

test('unknown fields, oversized HTML and failed permissions cannot partially commit content or receipts', () => use(f => {
  const j = f.create();
  const bad = [
    { pageId: j.pages[0].id, pageRevision: 1, html: '<p>new</p>', gmNotes: 'forged' },
    { pageId: j.pages[0].id, pageRevision: 1, html: 'x'.repeat(100001) },
    { pageId: j.pages[0].id, pageRevision: 1, html: '<section class="secret">must not become public</section>' }
  ];
  for (const payload of bad) { const before = f.state(); assert.equal(f.journal(f.a, 'journal.page.update', j.id, payload).ack.ok, false); assert.deepEqual(f.state(), before); }
  const before = f.state();
  assert.equal(f.journal(f.gm, 'journal.permissions', j.id, { permissions: { default: 'view', members: { unknown: 'edit' } } }).ack.code, 'VALIDATION');
  assert.deepEqual(f.state(), before);
}));
