import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MEMBER_PATH_VIEWS, SPA_ROUTE_PATHS } from "../src/lib/appRoutes.js";
import {
  QA_DATABASE_DEPENDENCIES,
  MI1_QA_WEB_DONOR,
  buildQaActor,
  isMissingQaRpcError,
  loadOrganizationSessionScope,
  mergeQaSessionScope,
} from "../src/lib/mi1QaWiring.js";
import { STAFF_TOOLS } from "../src/lib/staffPlanes.js";
import { FEATURE_GROUPS } from "../src/lib/mobileNav.js";
import { createQaRpcAdapter } from "../src/features/qa/adapter.js";

describe("CR-018 QA web wiring", () => {
  it("records clean-room provenance and rejected donor assumptions", () => {
    expect(MI1_QA_WEB_DONOR.baseline).toBe("donor-baseline-20260721");
    expect(MI1_QA_WEB_DONOR.disposition).toBe("port_adapt");
    expect(MI1_QA_WEB_DONOR.rejected).toEqual(expect.arrayContaining([
      "in-memory writes presented as persisted success",
      "fictional live tenants",
    ]));
  });

  it("registers the member Q&A and officer-queue routes additively", () => {
    expect(MEMBER_PATH_VIEWS["/m/qa"]).toBe("qa");
    expect(STAFF_TOOLS.map((tool) => tool.view)).toEqual(expect.arrayContaining(["qaQueue"]));
    expect(SPA_ROUTE_PATHS).toEqual(expect.arrayContaining(["/m/qa", "/m/qa-queue"]));
  });

  it("keeps member Q&A on the phone All-features union group", () => {
    const union = FEATURE_GROUPS.find((group) => group.key === "union");
    expect(union.items.map((item) => item.key)).toEqual(expect.arrayContaining(["qa"]));
  });

  it("maps missing RPCs and empty session scope without inventing an organization", async () => {
    expect(isMissingQaRpcError({ code: "PGRST202" })).toBe(true);
    expect(await loadOrganizationSessionScope(null)).toEqual({
      organizationId: null,
      chapterId: null,
      organizationRoles: [],
      chapterRoles: [],
      unavailable: true,
    });
    const client = {
      rpc: async () => ({ error: { code: "PGRST202", message: "Could not find the function" } }),
    };
    expect(await loadOrganizationSessionScope(client)).toMatchObject({
      organizationId: null,
      unavailable: true,
    });
    expect(buildQaActor({ userId: "user-a" }).selectedOrganizationId).toBeNull();
    expect(await loadOrganizationSessionScope({
      rpc: async () => ({ data: [{ organizationId: "not-selected", organizationRoles: ["admin"] }], error: null }),
    })).toEqual({ organizationId: null, chapterId: null, organizationRoles: [], chapterRoles: [], unavailable: false });
    expect(mergeQaSessionScope(buildQaActor({
      userId: "user-a",
      organizationId: "org-a",
      organizationRoles: ["admin"],
    }), {
      organizationId: "org-a",
      chapterId: "chapter-a",
      organizationRoles: [],
      chapterRoles: [],
      unavailable: false,
    })).toMatchObject({ organizationRoles: [], chapterRoles: [] });
    const adapter = createQaRpcAdapter(client);
    const list = await adapter.list({});
    expect(list.ok).toBe(false);
    expect(list.message).toMatch(/required functions/i);
  });

  it("reads an expired session token as an authorization failure, not an outage", async () => {
    for (const error of [
      { code: "PGRST301", message: "JWT expired" },
      { code: "PGRST302", message: "Anonymous access is disabled" },
      { status: 401, message: "JWT expired" },
    ]) {
      const adapter = createQaRpcAdapter({ rpc: async () => ({ data: null, error }) });
      const queue = await adapter.officerQueue();
      expect(queue).toMatchObject({ ok: false, code: "forbidden" });
    }
  });

  it("lists the reserved X-DB Q&A dependencies only", () => {
    expect(QA_DATABASE_DEPENDENCIES.rpcs).toContain("list_member_qa_questions");
    expect(QA_DATABASE_DEPENDENCIES.rpcs).toContain("reply_member_qa_official");
    expect(QA_DATABASE_DEPENDENCIES.tables).toEqual([
      "member_qa_questions",
      "member_qa_replies",
      "member_qa_votes",
    ]);
  });

  it("does not import other MI1 domains or migrations", () => {
    const wiring = readFileSync("src/lib/mi1QaWiring.js", "utf8");
    const app = readFileSync("src/App.jsx", "utf8");
    const memberView = readFileSync("src/views/MemberQaView.jsx", "utf8");
    const officerView = readFileSync("src/views/OfficerQaView.jsx", "utf8");
    expect(wiring).not.toMatch(/supabase\/migrations/);
    expect(wiring).not.toMatch(/features\/(pay|analytics|integrations|operations|publicDirectory)/);
    expect(app).toContain("MemberQaView");
    expect(app).toContain("OfficerQaView");
    expect(app).toContain("createInMemoryQaStore");
    expect(app).toContain("createQaStoreAdapter");
    expect(app).toContain('fixtureDemo ? "preview-qa-organization" : null');
    expect(memberView + officerView).not.toMatch(/PayToolsView|AnalyticsCoreView|IntegrationsView|OperationsHealthView|PublicDirectoryApp/);
  });
});
