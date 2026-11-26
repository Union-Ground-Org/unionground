import { businessRpc } from './businessWriters';
import type { MobileSessionWriter } from './supabase';
// Staff campaign registry for the native apps
// (BUG-UG-NATIVE-SEVEN-FEATURE-KEYS-OPEN-ONLY-THE-GENERIC-SCREEN-20261113,
// #8630): the same RPCs the web registry calls (src/lib/campaignApi.js). The
// database checks the staff role, the organization boundary and each state
// change; this file only shapes the answers.
import type { SaveCampaignDraftArgs } from '../lib/campaignDraft';
import { getSupabaseClient } from './supabase';

export const CAMPAIGN_REGISTRY_RPC_NAMES = Object.freeze({
  page: 'get_staff_vote_campaigns',
  publish: 'publish_vote_campaign',
  close: 'close_vote_campaign',
  deleteDraft: 'delete_vote_campaign_draft',
  saveDraft: 'save_vote_campaign_draft',
});

// One registry page; the screen asks for the next one only when the person
// reaches the end of the list.
export const CAMPAIGN_REGISTRY_PAGE_SIZE = 20;

export type CampaignKind = 'ballot' | 'pulse';
export type CampaignState = 'draft' | 'open' | 'closed';
export type CampaignFilter = 'all' | CampaignState;

export type StaffCampaign = {
  id: string;
  kind: CampaignKind;
  state: CampaignState;
  scope: 'chapter' | 'union';
  titleEn: string;
  titleEs: string;
  bodyEn: string;
  closesAt: string;
  quorumTarget: number | null;
  optionCount: number;
};

export type CampaignCounts = Record<CampaignFilter, number>;

export type CampaignRegistryPage = {
  campaigns: StaffCampaign[];
  counts: CampaignCounts;
  // The opaque keyset cursor the next page is read with; null on the last page.
  nextCursor: Record<string, unknown> | null;
  // #9099 part 3: whether this account may write a chapter-wide or a
  // union-wide draft (private.can_manage_vote_scope, as the registry reports).
  canManageChapter: boolean;
  canManageUnion: boolean;
  // #9533 (B-43): the registry said, in so many words, that this account cannot
  // manage the organization's scope, so the organization's ballots and pulses
  // are left out of this list. Only an explicit false sets it, as on the website
  // (CampaignsView registry.canManageUnion === false): an answer without the
  // field says nothing.
  organizationVotesElsewhere: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

// A row the screen cannot name, place or act on is left out rather than drawn
// with invented fields.
export function normalizeStaffCampaign(value: unknown): StaffCampaign | null {
  const row = record(value);
  if (!row) return null;
  const id = text(row.id);
  const kind = row.kind === 'ballot' || row.kind === 'pulse' ? row.kind : null;
  const state = row.state === 'draft' || row.state === 'open' || row.state === 'closed' ? row.state : null;
  const titleEn = text(row.titleEn).trim();
  if (!id || !kind || !state || !titleEn) return null;
  return {
    id,
    kind,
    state,
    scope: row.scope === 'union' ? 'union' : 'chapter',
    titleEn,
    titleEs: text(row.titleEs).trim(),
    bodyEn: text(row.bodyEn).trim(),
    closesAt: text(row.closesAt),
    quorumTarget: kind === 'ballot' && typeof row.quorumTarget === 'number' ? row.quorumTarget : null,
    optionCount: Array.isArray(row.options) ? row.options.length : 0,
  };
}

export function normalizeCampaignRegistryPage(value: unknown): CampaignRegistryPage {
  const data = record(value);
  if (!data) throw new Error('The campaign registry did not answer.');
  const counts = record(data.counts);
  return {
    campaigns: (Array.isArray(data.campaigns) ? data.campaigns as unknown[] : []).flatMap((row) => {
      const campaign = normalizeStaffCampaign(row);
      return campaign ? [campaign] : [];
    }),
    counts: { all: count(counts?.all), draft: count(counts?.draft), open: count(counts?.open), closed: count(counts?.closed) },
    nextCursor: record(data.nextCursor),
    canManageChapter: data.canManageChapter === true,
    canManageUnion: data.canManageUnion === true,
    organizationVotesElsewhere: data.canManageUnion === false,
  };
}

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const client = getSupabaseClient();
  if (!client) throw new Error('The secure mobile backend is not configured.');
  const result: { data: unknown; error: unknown } = await client.rpc(name, args);
  if (result.error) throw result.error;
  return result.data;
}

export async function loadCampaignRegistryPage(filter: CampaignFilter, cursor: Record<string, unknown> | null = null): Promise<CampaignRegistryPage> {
  return normalizeCampaignRegistryPage(await rpc(CAMPAIGN_REGISTRY_RPC_NAMES.page, {
    p_state: filter === 'all' ? null : filter,
    p_limit: CAMPAIGN_REGISTRY_PAGE_SIZE,
    p_cursor: cursor,
  }));
}

export type CampaignAction = 'publish' | 'close' | 'deleteDraft';

/** Saves a new draft the way the website's saveCampaignDraft does; the RPC checks role, scope and fields. */
export async function saveMobileCampaignDraft(writer: MobileSessionWriter, args: SaveCampaignDraftArgs): Promise<void> {
  await businessRpc(writer, CAMPAIGN_REGISTRY_RPC_NAMES.saveDraft, args);
}

export async function changeCampaign(writer: MobileSessionWriter, action: CampaignAction, campaign: Pick<StaffCampaign, 'kind' | 'id'>): Promise<void> {
  await businessRpc(writer, CAMPAIGN_REGISTRY_RPC_NAMES[action], { p_kind: campaign.kind, p_campaign_id: campaign.id });
}
