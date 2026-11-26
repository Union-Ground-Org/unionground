import { describe, expect, it, vi } from "vitest";
import { createConnectionAdapter, matchingProfile } from "../src/features/connectionSuggestions/adapter.js";
import { createConnectionPreview } from "../src/features/connectionSuggestions/preview.js";

describe("published chapter RPC boundary", () => {
  it.each(["requested", "accepted", "active", "declined", "closed"])("acknowledges a stable request replay at lifecycle status %s", async (status) => {
    const row = { id: "request-id", status, chapter_id: "source", receiving_chapter_id: "target" };
    const rpc = vi.fn().mockRejectedValueOnce(new Error("lost reply")).mockResolvedValue({ data: row, error: null });
    const adapter = createConnectionAdapter({ rpc }, "admin");
    const request = () => adapter.requestHandshake("source", "target", { title: "Training", purpose: "Approved lessons", dataScope: "no_member_data" }, "stable-key");
    await expect(request()).rejects.toThrow("lost reply");
    await expect(request()).resolves.toEqual(row);
    expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
  });
  it.each([{ status: "draft" }, { status: "unknown" }, { status: null }, { id: "" }, { chapter_id: "wrong" }, { receiving_chapter_id: "wrong" }])("rejects an invalid handshake receipt %j", async (invalid) => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "request-id", status: "accepted", chapter_id: "source", receiving_chapter_id: "target", ...invalid }, error: null });
    await expect(createConnectionAdapter({ rpc }, "admin").requestHandshake("source", "target", { title: "Training", purpose: "Approved lessons", dataScope: "no_member_data" }, "stable-key"))
      .rejects.toThrow("invalid_handshake_response");
  });
  it("fails closed when no service is configured", async () => {
    const adapter = createConnectionAdapter(undefined, "admin");
    await expect(adapter.workspace()).rejects.toThrow("connection_service_unavailable");
    await expect(adapter.profiles()).rejects.toThrow("connection_service_unavailable");
    await expect(adapter.save("chapter-a", {}, true)).rejects.toThrow("connection_service_unavailable");
    await expect(adapter.save("chapter-a", {}, false)).rejects.toThrow("connection_service_unavailable");
    await expect(adapter.reviewSource("chapter-a", "survey", "source-a", [])).rejects.toThrow("connection_service_unavailable");
    await expect(adapter.freezeIssues("chapter-a")).rejects.toThrow("connection_service_unavailable");
  });

  it.each([null, undefined, "serialized response", 42, false])("rejects malformed response data %s", async (data) => {
    const rpc = vi.fn().mockResolvedValue({ data, error: null });
    await expect(createConnectionAdapter({ rpc }, "admin").workspace()).rejects.toThrow("invalid_connection_response");
  });

  it("preserves server error codes so permission and missing-migration states remain distinct", async () => {
    const error = { code: "42501", message: "source outside selected scope" };
    const rpc = vi.fn().mockResolvedValue({ data: { ignored: true }, error });
    const adapter = createConnectionAdapter({ rpc }, "advisor");
    await expect(adapter.workspace("chapter-a")).rejects.toBe(error);
    await expect(adapter.reviewSource("chapter-a", "feedback", "source-a", ["pay"])).rejects.toBe(error);
    await expect(adapter.freezeIssues("chapter-a")).rejects.toBe(error);
  });

  it("loads a selected chapter without accepting a tenant argument and adapts only published metadata", async () => {
    const original = { id: "chapter-a", publication: { status: "published", publishedAt: "2026-08-01" }, issuePriorities: [{ key: "pay", strength: 0.5 }] };
    const rpc = vi.fn().mockResolvedValue({ data: { chapterId: "chapter-a", profile: original }, error: null });
    const workspace = await createConnectionAdapter({ rpc }, "advisor").workspace("chapter-a");
    expect(rpc).toHaveBeenCalledExactlyOnceWith("get_chapter_connection_workspace", { p_selected_hat: "advisor", p_chapter_id: "chapter-a" });
    expect(workspace.profile).toEqual({ ...original, discoverable: true, publishedAt: "2026-08-01", assistanceNeeds: [{ key: "pay", strength: 0.5 }] });
    expect(original).not.toHaveProperty("discoverable");
    rpc.mockResolvedValue({ data: { profile: null }, error: null });
    expect((await createConnectionAdapter({ rpc }, "admin").workspace()).profile).toBeNull();
    expect(rpc).toHaveBeenLastCalledWith("get_chapter_connection_workspace", { p_selected_hat: "admin" });
  });

  it("preserves withdrawal and explicit needs without substituting private activity for publication time", () => {
    expect(matchingProfile(null)).toBeNull();
    const needs = [{ key: "training", strength: 1 }];
    expect(matchingProfile({ discoverable: false, publishedAt: "2026-09-01", publication: { status: "published", publishedAt: "2026-08-01" }, assistanceNeeds: needs, issuePriorities: [{ key: "pay", strength: 1 }] })).toMatchObject({ discoverable: false, publishedAt: "2026-09-01", assistanceNeeds: needs });
    expect(matchingProfile({ sourceAsOf: "2026-07-01", publication: { status: "withdrawn" } })).toMatchObject({ discoverable: false, publishedAt: "2026-07-01" });
    expect(matchingProfile({ discoverable: true, privateActivityAt: "2026-09-27" })).toMatchObject({ discoverable: true, publishedAt: undefined });
  });

  it("sends separate publishing, withdrawal, review and freezing requests with minimal payloads", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {}, error: null });
    const adapter = createConnectionAdapter({ rpc }, "admin");
    const declaration = { kind: "chapter", location: { country: "US" }, declaredIssueKeys: ["pay"] };
    await adapter.save("chapter-a", declaration, true);
    expect(rpc).toHaveBeenLastCalledWith("save_chapter_connection_profile", { p_selected_hat: "admin", p_chapter_id: "chapter-a", p_profile: declaration, p_publish: true });
    await adapter.save("chapter-a", declaration, false);
    expect(rpc).toHaveBeenLastCalledWith("withdraw_chapter_connection_profile", { p_selected_hat: "admin", p_chapter_id: "chapter-a" });
    await adapter.reviewSource("chapter-a", "feedback", "source-a", []);
    expect(rpc).toHaveBeenLastCalledWith("set_chapter_connection_source_tags", { p_selected_hat: "admin", p_chapter_id: "chapter-a", p_source_kind: "feedback", p_source_id: "source-a", p_topic_keys: [] });
    await adapter.freezeIssues("chapter-a");
    expect(rpc).toHaveBeenLastCalledWith("freeze_chapter_connection_issue_aggregates", { p_selected_hat: "admin", p_chapter_id: "chapter-a" });
  });

  it("refuses malformed pages and returns no partial candidates when a later page fails", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { rows: {} }, error: null });
    const adapter = createConnectionAdapter({ rpc }, "admin");
    await expect(adapter.profiles()).rejects.toThrow("invalid_connection_page");
    const candidate = createConnectionPreview().profiles[0];
    rpc.mockResolvedValueOnce({ data: { rows: [candidate], snapshotToken: "v1", nextCursor: candidate.id, complete: false }, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: "snapshot_changed" } });
    await expect(adapter.profiles(undefined, "chapter-a")).rejects.toMatchObject({ code: "snapshot_changed" });
    expect(rpc).toHaveBeenLastCalledWith("list_chapter_connection_profiles", { p_selected_hat: "admin", p_chapter_id: "chapter-a", p_after_id: candidate.id, p_snapshot_token: "v1", p_limit: 250 });
  });

  it("stops a cancelled page request before traversing more chapters", async () => {
    const controller = new AbortController();
    const rpc = vi.fn();
    const adapter = createConnectionAdapter({ rpc }, "admin");
    controller.abort(new Error("chapter changed"));
    await expect(adapter.profiles(controller.signal)).rejects.toThrow("chapter changed");
    expect(rpc).not.toHaveBeenCalled();
  });
});

// REQ-UG-INVITE-AND-STANDING-HANDSHAKE-FOR-PARTNERS-NOT-YET-ON-PLATFORM-20261031
describe("partner office RPC boundary", () => {
  it("scopes every partner read and write to the selected hat and chapter", async () => {
    const rpc = vi.fn().mockImplementation(async (name) => ({
      data: name === "list_partner_offices_not_on_platform" ? { matchedOn: "state", rows: [] }
        : name === "list_chapter_handshake_offers" ? { offers: [], invitations: [], openLimit: 10, pendingInvitationLimit: 5 }
        : { id: "row", status: "open" },
      error: null,
    }));
    const adapter = createConnectionAdapter({ rpc }, "admin");
    await adapter.listPartnerOffices("chapter-a", "");
    await adapter.listPartnerOffices("chapter-a", "Riv", 25);
    await adapter.listPartnerOffers("chapter-a");
    await adapter.createPartnerOffer("chapter-a", "office-1", { title: "T", purpose: "P", dataScope: "no_member_data" }, "key-1");
    await adapter.withdrawPartnerOffer("chapter-a", "offer-1");
    await adapter.requestPartnerInvitation("chapter-a", "office-1", undefined, { name: "Dana Ruiz", email: "dana@example.invalid", locale: "en" }, "key-2");
    await adapter.requestPartnerInvitation("chapter-a", "office-1", "offer-1", { name: "Dana Ruiz", email: "dana@example.invalid", locale: "es" }, "key-3");
    expect(rpc.mock.calls).toEqual([
      ["list_partner_offices_not_on_platform", { p_selected_hat: "admin", p_chapter_id: "chapter-a", p_query: null, p_limit: 25, p_offset: 0 }],
      ["list_partner_offices_not_on_platform", { p_selected_hat: "admin", p_chapter_id: "chapter-a", p_query: "Riv", p_limit: 25, p_offset: 25 }],
      ["list_chapter_handshake_offers", { p_selected_hat: "admin", p_chapter_id: "chapter-a" }],
      ["create_chapter_handshake_offer", { p_selected_hat: "admin", p_chapter_id: "chapter-a", p_union_org_id: "office-1", p_title: "T", p_purpose: "P", p_data_scope: "no_member_data", p_idempotency_key: "key-1" }],
      ["withdraw_chapter_handshake_offer", { p_selected_hat: "admin", p_chapter_id: "chapter-a", p_offer_id: "offer-1" }],
      ["request_partner_founder_invitation", { p_selected_hat: "admin", p_chapter_id: "chapter-a", p_union_org_id: "office-1", p_offer_id: null, p_contact_name: "Dana Ruiz", p_contact_email: "dana@example.invalid", p_locale: "en", p_idempotency_key: "key-2" }],
      ["request_partner_founder_invitation", { p_selected_hat: "admin", p_chapter_id: "chapter-a", p_union_org_id: "office-1", p_offer_id: "offer-1", p_contact_name: "Dana Ruiz", p_contact_email: "dana@example.invalid", p_locale: "es", p_idempotency_key: "key-3" }],
    ]);
  });

  it("rejects malformed partner pages and ledgers", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { rows: "none", offers: [], invitations: null }, error: null });
    const adapter = createConnectionAdapter({ rpc }, "admin");
    await expect(adapter.listPartnerOffices("chapter-a")).rejects.toThrow("invalid_partner_page");
    await expect(adapter.listPartnerOffers("chapter-a")).rejects.toThrow("invalid_partner_offers");
    rpc.mockResolvedValue({ data: { offers: null, invitations: [] }, error: null });
    await expect(adapter.listPartnerOffers("chapter-a")).rejects.toThrow("invalid_partner_offers");
  });
});
