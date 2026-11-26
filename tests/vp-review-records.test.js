// @vitest-environment node
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

const migration = fs.readFileSync(
  new URL(
    "../supabase/migrations/20260810151000_vp_review_records.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("President attention review records", () => {
  it("pins durable uniqueness, President writes, same-chapter staff reads, and MFA", () => {
    expect(migration).toContain("unique (chapter_id, case_id)");
    expect(migration).toContain("member_has_role(array['vp'])");
    expect(migration).toContain(
      "member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])",
    );
    expect(migration).toContain("r.chapter_id = caller_chapter");
    expect(migration).toContain("on conflict (chapter_id, case_id) do nothing");
    expect(migration).toContain("private.mfa_satisfied()");
    expect(migration).toContain(
      "revoke all on table public.member_vp_case_reviews from authenticated",
    );
  });

  it("loads staff-visible reviews with the desk and writes through the RPC", async () => {
    const { loadVpOverview, markVpCaseReviewed } =
      await import("../src/lib/memberApi.js");
    const rpc = vi.fn(async (name, args) => {
      if (name === "get_vp_overview")
        return { data: { attention: [] }, error: null };
      if (name === "get_staff_roster") return { data: [], error: null };
      if (name === "list_vp_case_reviews")
        return { data: [{ caseId: "case-1" }], error: null };
      if (name === "mark_vp_case_reviewed")
        return { data: { caseId: args.p_case_id }, error: null };
      throw new Error(name);
    });
    const client = { rpc };
    await expect(loadVpOverview(client)).resolves.toMatchObject({
      reviews: [{ caseId: "case-1" }],
    });
    await expect(markVpCaseReviewed(client, "case-1")).resolves.toMatchObject({
      caseId: "case-1",
    });
    expect(rpc).toHaveBeenCalledWith("mark_vp_case_reviewed", {
      p_case_id: "case-1",
    });
  });

  it("surfaces the same reviews to every staff hat on the admin desk, localized", async () => {
    const { loadAdminDesk } = await import("../src/lib/memberApi.js");
    const client = {
      rpc: async (name) => {
        if (name === "get_staff_roster")
          return { data: [{ userId: "u1" }], error: null };
        if (name === "get_admin_events") return { data: [], error: null };
        if (name === "get_admin_audit") return { data: [], error: null };
        if (name === "get_admin_mfa_status")
          return { data: { enrolledMembers: 0, staff: [] }, error: null };
        if (name === "get_admin_reward_queue") return { data: [], error: null };
        if (name === "get_staff_mfa_policy") return { data: null, error: null };
        if (name === "get_admin_governance_requests")
          return { data: [], error: null };
        if (name === "get_compass_ai_governance")
          return { data: null, error: null };
        if (name === "get_member_invitations")
          return { data: { chapter: null, items: [] }, error: null };
        if (name === "get_admin_member_directory")
          return { data: { items: [], nextCursor: null }, error: null };
        if (name === "get_admin_org_structure")
          return { data: { scope: "chapter", chapters: [] }, error: null };
        if (name === "get_admin_organization_configuration")
          return { data: null, error: null };
        if (name === "list_failed_login_operations_inbox")
          return { data: null, error: null };
        if (name === "get_organization_retention_engine")
          return { data: null, error: { message: "optional unavailable" } };
        if (name === "list_vp_case_reviews") {
          return {
            data: [
              {
                caseId: "att-case-1",
                caseReference: "G-2291",
                reviewerName: "Taylor Morgan",
                reviewedAt: "2026-07-23T15:00:00Z",
              },
            ],
            error: null,
          };
        }
        throw new Error(name);
      },
    };
    const desk = await loadAdminDesk(client);
    expect(desk.leadershipReviews).toHaveLength(1);
    expect(desk.leadershipReviews[0]).toMatchObject({
      caseId: "att-case-1",
      reviewerName: "Taylor Morgan",
    });
    expect(desk.leadershipReviews[0].reviewedLabel).toContain("Jul");
  });
});
