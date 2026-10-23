import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { AuthResult, Campaign, Command, CommandResult, Member, Snapshot } from '../shared/model.ts';
import { addPlayer, applyCommand, DomainError, fail, object, projectSnapshot, seedCampaign, str } from './engine.ts';
import { readCampaign } from './migrations.ts';
import { isLocale } from '../shared/locale.ts';

interface CampaignRow { id: string; document: string; invite: string }
export interface Session { hash: string; campaignId: string; memberId: string }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export class Store {
  private db: DatabaseSync;
  constructor(public path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, document TEXT NOT NULL, invite TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), member_id TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS command_results (session_hash TEXT NOT NULL REFERENCES sessions(hash), command_id TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(session_hash,command_id));
      CREATE TABLE IF NOT EXISTS import_archives (scene_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), created_at TEXT NOT NULL, document TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private makeSession(campaignId: string, memberId: string): AuthResult {
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO sessions (hash,campaign_id,member_id,created_at) VALUES (?,?,?,?)').run(hash(token), campaignId, memberId, new Date().toISOString());
    return { token, campaignId, memberId };
  }
  create(name: unknown, gmName: unknown, locale: unknown = 'en'): AuthResult {
    if (!isLocale(locale)) return fail('VALIDATION', 'Unsupported locale. Choose en, es, uk, pl or cs.');
    return this.transaction(() => {
      const campaign = seedCampaign(str(name, 'name'), str(gmName, 'gmName', 80), locale);
      const invite = randomBytes(12).toString('base64url');
      this.db.prepare('INSERT INTO campaigns(id,document,invite) VALUES(?,?,?)').run(campaign.id, JSON.stringify(campaign), invite);
      return this.makeSession(campaign.id, campaign.members[0].id);
    });
  }
  join(inviteCode: unknown, name: unknown): AuthResult {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT id,document,invite FROM campaigns WHERE invite=?').get(str(inviteCode, 'inviteCode', 100)) as unknown as CampaignRow | undefined;
      if (!row) return fail('NOT_FOUND', "Invitation code not found.");
      const campaign = readCampaign(row.document);
      const member = addPlayer(campaign, str(name, 'name', 80));
      this.save(campaign);
      return this.makeSession(campaign.id, member.id);
    });
  }
  authenticate(token: unknown): Session {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return fail('UNAUTHORIZED', "A valid session is required.");
    const digest = hash(token);
    const row = this.db.prepare('SELECT campaign_id,member_id FROM sessions WHERE hash=?').get(digest) as { campaign_id: string; member_id: string } | undefined;
    if (!row) return fail('UNAUTHORIZED', "A valid session is required.");
    return { hash: digest, campaignId: row.campaign_id, memberId: row.member_id };
  }
  private row(id: string): CampaignRow {
    return this.db.prepare('SELECT id,document,invite FROM campaigns WHERE id=?').get(id) as unknown as CampaignRow ?? fail('NOT_FOUND', "Campaign not found.");
  }
  private save(campaign: Campaign) { this.db.prepare('UPDATE campaigns SET document=? WHERE id=?').run(JSON.stringify(campaign), campaign.id); }
  campaign(session: Session): { campaign: Campaign; member: Member; invite: string } {
    const row = this.row(session.campaignId), campaign = readCampaign(row.document);
    const member = campaign.members.find(m => m.id === session.memberId) ?? fail('UNAUTHORIZED', "This member no longer exists.");
    return { campaign, member, invite: row.invite };
  }
  snapshot(session: Session): Snapshot { const { campaign, member, invite } = this.campaign(session); return projectSnapshot(campaign, member, invite); }
  export(session: Session): Campaign {
    const { campaign, member } = this.campaign(session);
    if (member.role !== 'gm') return fail('FORBIDDEN', "Only the GM can export.");
    return campaign;
  }
  imports(session: Session): { sceneId: string; createdAt: string }[] {
    this.export(session); // Enforce the persisted member role; never accept a role from the request.
    const rows = this.db.prepare('SELECT scene_id,created_at FROM import_archives WHERE campaign_id=? ORDER BY created_at').all(session.campaignId) as { scene_id: string; created_at: string }[];
    return rows.map(r => ({ sceneId: r.scene_id, createdAt: r.created_at }));
  }
  importArchive(session: Session, sceneId: string): unknown {
    this.export(session);
    const row = this.db.prepare('SELECT document FROM import_archives WHERE campaign_id=? AND scene_id=?').get(session.campaignId, sceneId) as { document: string } | undefined;
    if (!row) return fail('NOT_FOUND', "Import archive not found.");
    return JSON.parse(row.document);
  }
  command(session: Session, raw: unknown): { ack: CommandResult; changed: boolean } {
    const input = object(raw), id = str(input.id, 'command.id', 120), type = str(input.type, 'command.type', 60);
    const payload = object(input.payload);
    if (input.expectedRevision !== undefined && (typeof input.expectedRevision !== 'number' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)) fail('VALIDATION', "Invalid expectedRevision.");
    const command: Command = { id, type: type as Command['type'], payload, ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision as number }) };
    const fingerprint = hash(JSON.stringify(command));
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT fingerprint,response FROM command_results WHERE session_hash=? AND command_id=?').get(session.hash, id) as { fingerprint: string; response: string } | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint) return { ack: { type: 'ack', id, ok: false, code: 'ID_REUSED', error: "This ID has already been used for another command." }, changed: false };
        return { ack: JSON.parse(previous.response) as CommandResult, changed: false };
      }
      const { campaign, member } = this.campaign(session);
      let ack: CommandResult, changed = false;
      if (command.expectedRevision !== undefined && command.expectedRevision !== campaign.revision) {
        ack = { type: 'ack', id, ok: false, revision: campaign.revision, code: 'CONFLICT', error: "The campaign changed. Refresh and retry with a new ID." };
      } else {
        this.db.exec('SAVEPOINT command_write');
        try {
          // Work on this isolated document. Failed commands never update the stored campaign.
          applyCommand(campaign, member, command);
          campaign.revision++;
          if (JSON.stringify(campaign).length > 16_000_000) fail('LIMIT', "The campaign exceeds the 16 MB size limit.");
          this.save(campaign);
          if (command.type === 'scene.import') {
            this.db.prepare('INSERT INTO import_archives(scene_id,campaign_id,created_at,document) VALUES(?,?,?,?)').run(campaign.activeSceneId, campaign.id, new Date().toISOString(), JSON.stringify(command.payload.document));
          }
          this.db.exec('RELEASE command_write');
          ack = { type: 'ack', id, ok: true, revision: campaign.revision }; changed = true;
        } catch (error) {
          this.db.exec('ROLLBACK TO command_write'); this.db.exec('RELEASE command_write');
          if (!(error instanceof DomainError)) {
            // The import validator may use plain Error. Do not expose internal stack/database data.
            ack = { type: 'ack', id, ok: false, code: command.type === 'scene.import' ? 'VALIDATION' : 'INTERNAL', error: command.type === 'scene.import' ? "Invalid import document." : "The command could not be applied." };
          } else ack = { type: 'ack', id, ok: false, code: error.code, error: error.message };
          ack.revision = JSON.parse(this.row(session.campaignId).document).revision;
        }
      }
      this.db.prepare('INSERT INTO command_results(session_hash,command_id,fingerprint,response) VALUES(?,?,?,?)').run(session.hash, id, fingerprint, JSON.stringify(ack));
      return { ack, changed };
    });
  }
}
