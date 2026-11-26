import { collectPublishedProfiles } from "./engine.js";
import { isConnectionHandshakeReceipt } from "./contract.js";

// RPCs derive the organization from the authenticated session. Neither a
// caller-supplied tenant nor private case data enters this read surface.
export function matchingProfile(row) {
  if (!row) return null;
  return {
    ...row,
    discoverable: row.discoverable !== false && (row.discoverable === true || row.publication?.status === "published"),
    publishedAt: row.publishedAt || row.publication?.publishedAt || row.sourceAsOf,
    assistanceNeeds: row.assistanceNeeds || row.issuePriorities,
  };
}

export function createConnectionAdapter(client, selectedHat) {
  const result = async (request) => {
    if (!request) throw new Error("connection_service_unavailable");
    const { data, error } = await request;
    if (error) throw error;
    if (!data || typeof data !== "object") throw new Error("invalid_connection_response");
    return data;
  };
  return {
    async workspace(chapterId) {
      const data = await result(client?.rpc("get_chapter_connection_workspace", { p_selected_hat: selectedHat, ...(chapterId ? { p_chapter_id: chapterId } : {}) }));
      return { ...data, profile: matchingProfile(data.profile) };
    },
    async profiles(signal, chapterId) {
      return collectPublishedProfiles(async ({ afterId, snapshotToken, limit }) => {
        const data = await result(client?.rpc("list_chapter_connection_profiles", { p_selected_hat: selectedHat, p_after_id: afterId || null, p_snapshot_token: snapshotToken || null, p_limit: limit, ...(chapterId ? { p_chapter_id: chapterId } : {}) }));
        if (!Array.isArray(data.rows)) throw new Error("invalid_connection_page");
        return { ...data, rows: data.rows.map(matchingProfile) };
      }, { signal, pageSize: 250 });
    },
    save(chapterId, profile, publish) {
      if (!publish) return result(client?.rpc("withdraw_chapter_connection_profile", { p_selected_hat: selectedHat, p_chapter_id: chapterId }));
      return result(client?.rpc("save_chapter_connection_profile", { p_selected_hat: selectedHat, p_chapter_id: chapterId, p_profile: profile, p_publish: publish }));
    },
    reviewSource(chapterId, sourceKind, sourceId, topicKeys) {
      return result(client?.rpc("set_chapter_connection_source_tags", { p_selected_hat: selectedHat, p_chapter_id: chapterId, p_source_kind: sourceKind, p_source_id: sourceId, p_topic_keys: topicKeys }));
    },
    freezeIssues(chapterId) {
      return result(client?.rpc("freeze_chapter_connection_issue_aggregates", { p_selected_hat: selectedHat, p_chapter_id: chapterId }));
    },
    async requestHandshake(chapterId, targetChapterId, fields, idempotencyKey) {
      const data = await result(client?.rpc("request_chapter_connection_handshake", {
        p_selected_hat: selectedHat, p_chapter_id: chapterId, p_target_chapter_id: targetChapterId,
        p_title: fields.title, p_purpose: fields.purpose, p_data_scope: fields.dataScope,
        p_idempotency_key: idempotencyKey,
      }));
      if (!isConnectionHandshakeReceipt(data, chapterId, targetChapterId)) {
        throw new Error("invalid_handshake_response");
      }
      return data;
    },
    // Catalogue offices with no chapter yet. A standing offer waits for the
    // office to join; an invitation request waits for the operator.
    async listPartnerOffices(chapterId, query, offset = 0) {
      const data = await result(client?.rpc("list_partner_offices_not_on_platform", { p_selected_hat: selectedHat, p_chapter_id: chapterId, p_query: query || null, p_limit: 25, p_offset: offset }));
      if (!Array.isArray(data.rows)) throw new Error("invalid_partner_page");
      return data;
    },
    async listPartnerOffers(chapterId) {
      const data = await result(client?.rpc("list_chapter_handshake_offers", { p_selected_hat: selectedHat, p_chapter_id: chapterId }));
      if (!Array.isArray(data.offers) || !Array.isArray(data.invitations)) throw new Error("invalid_partner_offers");
      return data;
    },
    createPartnerOffer(chapterId, unionOrgId, fields, idempotencyKey) {
      return result(client?.rpc("create_chapter_handshake_offer", {
        p_selected_hat: selectedHat, p_chapter_id: chapterId, p_union_org_id: unionOrgId,
        p_title: fields.title, p_purpose: fields.purpose, p_data_scope: fields.dataScope,
        p_idempotency_key: idempotencyKey,
      }));
    },
    withdrawPartnerOffer(chapterId, offerId) {
      return result(client?.rpc("withdraw_chapter_handshake_offer", { p_selected_hat: selectedHat, p_chapter_id: chapterId, p_offer_id: offerId }));
    },
    requestPartnerInvitation(chapterId, unionOrgId, offerId, contact, idempotencyKey) {
      return result(client?.rpc("request_partner_founder_invitation", {
        p_selected_hat: selectedHat, p_chapter_id: chapterId, p_union_org_id: unionOrgId, p_offer_id: offerId || null,
        p_contact_name: contact.name, p_contact_email: contact.email, p_locale: contact.locale,
        p_idempotency_key: idempotencyKey,
      }));
    },
  };
}
