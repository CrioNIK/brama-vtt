import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Store } from '../server/store.ts';
import { seedCampaign, projectSnapshot } from '../server/engine.ts';
import { readCampaign } from '../server/migrations.ts';
import type { Command } from '../shared/model.ts';

// Adversarial checks deliberately use synthetic documents, not the source-product fixtures as runtime proof.
test('review: load strips forged capabilities and sanitizes both live pages and frozen presentation HTML', () => {
  const campaign = seedCampaign('Synthetic load', 'GM');
  const gm = campaign.members[0], player = { id: randomUUID(), name: 'Player', role: 'player' as const, color: '#123456' };
  campaign.members.push(player);
  const doc = campaign.journals[0], page = doc.pages[0];
  assert.equal(page.kind, 'text');
  if (page.kind !== 'text') throw new Error('fixture');
  page.html = '<h2 id="constructor">Title</h2><p onclick="evil()">Visible</p><script>EXECUTABLE</script>';
  doc.permissions = { default: 'view', members: {} }; doc.gmNotes = 'GM_ONLY'; doc.legacyContent = 'ORIGINAL_PRIVATE'; doc.canReorderPages = true;
  campaign.journalPresentations.push({ id: randomUUID(), journalId: doc.id, journalRevision: doc.revision, title: 'Copy',
    pages: [{ ...page, html: '<p>Copy</p><img src="javascript:evil()"><svg>HIDDEN_PAYLOAD</svg>' }],
    recipientIds: [player.id], authorId: gm.id, createdAt: new Date().toISOString(), dismissedBy: [], revoked: false });
  const loaded = readCampaign(JSON.stringify(campaign));
  assert.equal(loaded.journals[0].canReorderPages, undefined);
  const projected = projectSnapshot(loaded, player, 'gm-invite');
  assert.equal(projected.campaign.journals[0].canReorderPages, false);
  const output = JSON.stringify(projected);
  assert.ok(output.includes('Visible')); assert.ok(output.includes('Copy'));
  for (const forbidden of ['EXECUTABLE', 'HIDDEN_PAYLOAD', 'onclick', 'constructor', 'javascript:', 'GM_ONLY', 'ORIGINAL_PRIVATE', 'gm-invite']) assert.ok(!output.includes(forbidden), forbidden);
  assert.deepEqual(readCampaign(JSON.stringify(loaded)), loaded, 'normalized loading remains idempotent');
});

test('review: explicit page edit does not bypass parent none and denied parent exposes no folder branch', () => {
  const campaign = seedCampaign('Synthetic ACL', 'GM');
  const player = { id: randomUUID(), name: 'Player', role: 'player' as const, color: '#123456' };
  campaign.members.push(player);
  const doc = campaign.journals[0];
  doc.permissions = { default: 'none', members: {} };
  doc.pages[0].permissions = { default: 'edit', members: {} };
  campaign.journalFolders.push({ id: 'private-folder', name: 'SECRET_FOLDER_NAME', parentId: null, sort: 0, revision: 1 });
  doc.folderId = 'private-folder'; doc.name = 'SECRET_DOCUMENT_NAME';
  const projected = projectSnapshot(campaign, player, 'private-invite');
  assert.deepEqual(projected.campaign.journals, []); assert.deepEqual(projected.campaign.journalFolders, []);
  assert.ok(!JSON.stringify(projected).includes('SECRET_'));
});

test('review: failed journal ACK remains sticky after another successful write and cannot be retried with substituted revision', () => {
  const store = new Store(':memory:');
  try {
    const auth = store.create('Synthetic retries', 'GM'), gm = store.authenticate(auth.token), original = store.export(gm);
    const doc = original.journals[0];
    const rejected: Command = { id: randomUUID(), type: 'journal.update', expectedRevision: original.revision - 1,
      payload: { id: doc.id, journalRevision: doc.revision, name: 'Losing draft' } };
    const failed = store.command(gm, rejected); assert.equal(failed.ack.code, 'CONFLICT');
    assert.equal(store.command(gm, { id: randomUUID(), type: 'journal.update', expectedRevision: original.revision,
      payload: { id: doc.id, journalRevision: doc.revision, name: 'Committed' } }).ack.ok, true);
    const committed = store.export(gm);
    assert.deepEqual(store.command(gm, rejected), { ack: failed.ack, changed: false });
    assert.equal(store.command(gm, { ...rejected, expectedRevision: committed.revision }).ack.code, 'ID_REUSED');
    assert.deepEqual(store.export(gm), committed);
  } finally { store.close(); }
});

test('review: arbitrary journal-shaped metadata in scene import remains an inert GM archive, never live journal content', () => {
  const store = new Store(':memory:');
  try {
    const auth = store.create('Synthetic import boundary', 'GM'), gm = store.authenticate(auth.token);
    const pAuth = store.join(store.snapshot(gm).inviteCode!, 'Player'), player = store.authenticate(pAuth.token);
    const document = JSON.parse(readFileSync(new URL('./fixtures/scene-populated.json', import.meta.url), 'utf8'));
    document.journals = [{ name: 'INERT_SOURCE_JOURNAL', html: '<script>INERT_SOURCE_SCRIPT</script>', ownership: { default: 3 } }];
    const before = store.export(gm);
    const result = store.command(gm, { id: randomUUID(), type: 'scene.import', payload: { document }, expectedRevision: before.revision });
    assert.equal(result.ack.ok, true, result.ack.error);
    const after = store.export(gm);
    assert.deepEqual(after.journals, before.journals); assert.deepEqual(after.journalPresentations, before.journalPresentations);
    assert.deepEqual(store.importArchive(gm, after.activeSceneId), document);
    assert.ok(!JSON.stringify(store.snapshot(player)).includes('INERT_SOURCE_'));
    assert.throws(() => store.importArchive(player, after.activeSceneId), /GM/);
  } finally { store.close(); }
});
