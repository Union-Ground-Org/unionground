import { MemberApiError } from "./memberApi.js";

function resultOrThrow(result, label) {
  if (result?.error) throw new MemberApiError(label, result.error);
  return result?.data;
}

// BUG-UG-WEB-STAFF-CAMPAIGNS-REGISTRY-UNBOUNDED-READ-20261002: the
// registry read is a bounded keyset page (get_staff_vote_campaigns(p_state,
// p_limit, p_cursor), migration 20261003048000), so no single request carries
// every ballot and pulse of a large organization. loadCampaigns walks the pages
// and returns the registry shape the view renders, with the latest server counts.
// A campaign can change state and move past the cursor after being returned;
// keep its latest projection once, using both kind and id as its identity.
// A database that has not applied that migration has only the parameterless
// read: PostgREST answers PGRST202 for the paged call and the registry falls
// back to it once. A walk that does not end is an error, never a short list.
export const CAMPAIGN_PAGE_SIZE = 50;
const CAMPAIGN_PAGE_LIMIT = 200;

export async function loadCampaigns(client) {
  const campaigns = new Map();
  let registry = null;
  let cursor = null;
  for (let page = 0; page < CAMPAIGN_PAGE_LIMIT; page += 1) {
    const result = await client.rpc("get_staff_vote_campaigns", { p_state: null, p_limit: CAMPAIGN_PAGE_SIZE, p_cursor: cursor });
    if (page === 0 && result?.error?.code === "PGRST202") {
      return resultOrThrow(await client.rpc("get_staff_vote_campaigns"), "Campaigns");
    }
    const data = resultOrThrow(result, "Campaigns");
    registry = registry || data;
    if (data?.counts) registry = { ...registry, counts: data.counts };
    for (const campaign of Array.isArray(data?.campaigns) ? data.campaigns : []) {
      campaigns.set(`${campaign.kind}-${campaign.id}`, campaign);
    }
    const next = data?.nextCursor || null;
    if (next && cursor && JSON.stringify(next) === JSON.stringify(cursor)) break;
    cursor = next;
    if (!cursor) return { ...registry, campaigns: [...campaigns.values()], nextCursor: null };
  }
  throw new MemberApiError("Campaigns", { message: "the campaign registry did not finish paging" });
}

// REQ-UG-SURVEY-AND-POLL-BUILDER-OPTIONS-20261030: Spanish is
// optional. A blank Spanish title or option sends the English text, which is
// what members reading in Spanish already see where no translation exists.
export function spanishOrEnglish(english, spanish) {
  return String(spanish ?? "").trim() || String(english ?? "").trim();
}

export async function saveCampaignDraft(client, fields) {
  return resultOrThrow(await client.rpc("save_vote_campaign_draft", {
    p_kind: fields.kind,
    p_campaign_id: fields.id?.trim() || null,
    p_scope: fields.scope,
    p_title_en: fields.titleEn.trim(),
    p_title_es: spanishOrEnglish(fields.titleEn, fields.titleEs),
    p_closes_at: fields.closesAt,
    p_quorum_target: fields.kind === "ballot" ? Number(fields.quorumTarget) : null,
    p_body_en: fields.bodyEn.trim(),
    p_body_es: String(fields.bodyEs ?? "").trim(),
    p_options: fields.options.map((option) => ({
      labelEn: option.labelEn.trim(),
      labelEs: spanishOrEnglish(option.labelEn, option.labelEs),
    })),
  }), "Save campaign draft");
}

export async function publishCampaign(client, kind, campaignId) {
  return resultOrThrow(await client.rpc("publish_vote_campaign", {
    p_kind: kind,
    p_campaign_id: campaignId,
  }), "Publish campaign");
}

export async function closeCampaign(client, kind, campaignId) {
  return resultOrThrow(await client.rpc("close_vote_campaign", {
    p_kind: kind,
    p_campaign_id: campaignId,
  }), "Close campaign");
}

// A never-published standard ballot or pulse draft (delete_vote_campaign_draft
// refuses anything else, including officer-removal drafts).
export async function deleteCampaignDraft(client, kind, campaignId) {
  return resultOrThrow(await client.rpc("delete_vote_campaign_draft", {
    p_kind: kind,
    p_campaign_id: campaignId,
  }), "Delete campaign draft");
}
