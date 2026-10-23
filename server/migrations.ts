import type { Campaign } from '../shared/model.ts';
import { normalizeActorSheet } from '../shared/model.ts';
import { normalizeCombat } from '../shared/combat.ts';
import { normalizeJournals } from './journals.ts';

/** Additive JSON migration; does not infer data from source systems or replace nullable HP. */
export function readCampaign(document: string): Campaign {
  const campaign = JSON.parse(document) as Campaign;
  campaign.actionResolutions ??= [];
  campaign.resourceRecoveries ??= [];
  campaign.outcomeRolls ??= [];
  campaign.hpApplications ??= [];
  campaign.progressionProfiles ??= [];
  campaign.progressionCommits ??= [];
  campaign.combatReceipts ??= [];
  campaign.combat = normalizeCombat(campaign.combat);
  normalizeJournals(campaign);
  for (const actor of campaign.actors) {
    Object.assign(actor, normalizeActorSheet(actor));
    delete actor.sheetAccess; // Access is computed for each recipient, never persisted as authority.
  }
  return campaign;
}
