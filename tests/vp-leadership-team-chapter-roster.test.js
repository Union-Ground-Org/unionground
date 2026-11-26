// @vitest-environment node
//
// BUG-UG-COUNTS-AND-STATUSES-DISAGREE-BETWEEN-PAGES-20261122 (#9533),
// finding B-55. The President's Leadership team asks the roster read for her
// open chapter only; every other reader of public.get_staff_roster keeps the
// organization-wide list it reads today. The database half is proved in
// tests/vp-leadership-team-chapter-roster-db.test.js.
import { describe, expect, it, vi } from "vitest";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";
import { loadAdvisorDesk, loadStaffCandidates, loadVpOverview } from "../src/lib/memberApi.js";

const MIGRATION = "20261124175100_vp_leadership_team_lists_open_chapter";

function recordingClient() {
  return {
    rpc: vi.fn(async (name) => {
      if (name === "get_vp_overview" || name === "get_advisor_overview") return { data: { attention: [] }, error: null };
      return { data: [], error: null };
    }),
  };
}

const rosterCalls = (client) => client.rpc.mock.calls.filter(([name]) => name === "get_staff_roster");

describe("the Leadership team on the President's desk (#9533)", () => {
  it("asks the roster read for the open chapter only", async () => {
    const client = recordingClient();
    await loadVpOverview(client);
    expect(rosterCalls(client)).toEqual([["get_staff_roster", { p_chapter_only: true }]]);
  });

  // The website deploys before the migration reaches the database. Until then
  // PostgREST has no get_staff_roster with p_chapter_only and answers PGRST202;
  // the desk asks once more without it and shows the organization list, as on
  // Main. Any other answer is handled as before: no second call.
  const organization = [{ userId: "org-1" }, { userId: "org-2" }];
  const chapter = [{ userId: "org-1" }];
  function rosterClient(narrowAnswer) {
    return {
      rpc: vi.fn(async (name, args) => {
        if (name === "get_vp_overview") return { data: { attention: [] }, error: null };
        if (name === "list_vp_case_reviews") return { data: [], error: null };
        if (name === "get_staff_roster") return args ? narrowAnswer : { data: organization, error: null };
        throw new Error(name);
      }),
    };
  }

  it("falls back once to the organization list while the database has no p_chapter_only", async () => {
    const client = rosterClient({ data: null, error: { code: "PGRST202", message: "Could not find the function public.get_staff_roster(p_chapter_only) in the schema cache" } });
    const desk = await loadVpOverview(client);
    expect(rosterCalls(client)).toEqual([["get_staff_roster", { p_chapter_only: true }], ["get_staff_roster"]]);
    expect(desk.roster).toEqual(organization);
  });

  it("shows the open chapter's list once the database has it, with no second call", async () => {
    const client = rosterClient({ data: chapter, error: null });
    const desk = await loadVpOverview(client);
    expect(rosterCalls(client)).toEqual([["get_staff_roster", { p_chapter_only: true }]]);
    expect(desk.roster).toEqual(chapter);
  });

  it("handles any other roster error as before, without asking for the organization list", async () => {
    const client = rosterClient({ data: null, error: { code: "42501", message: "staff role required" } });
    const desk = await loadVpOverview(client);
    expect(rosterCalls(client)).toEqual([["get_staff_roster", { p_chapter_only: true }]]);
    expect(desk.roster).toEqual([]);
  });

  it("leaves the case macro editor on the organization-wide list", async () => {
    const macro = recordingClient();
    await loadStaffCandidates(macro);
    expect(rosterCalls(macro)).toEqual([["get_staff_roster"]]);
  });
});

// BUG-UG-ADVISOR-LEADERSHIP-TEAM-LISTS-EVERY-CHAPTER-20261125
// (#10025, demo walk of Nov 25, 2026, row 86). The demo Advisor holds an
// organization-wide advisor grant, so the plain read listed every chapter's
// staff (65 people) under Chapter health for one chapter. The Advisor's
// Leadership team is the open chapter's, like the President's.
describe("the Leadership team on the Advisor's desk (#10025)", () => {
  const organization = [{ userId: "org-1" }, { userId: "org-2" }];
  const chapter = [{ userId: "org-1" }];
  function advisorClient(narrowAnswer) {
    return {
      rpc: vi.fn(async (name, args) => {
        if (name === "get_advisor_overview") return { data: { attention: [] }, error: null };
        if (name === "get_workload_stats") return { data: null, error: null };
        if (name === "get_staff_roster") return args ? narrowAnswer : { data: organization, error: null };
        throw new Error(name);
      }),
    };
  }

  it("asks the roster read for the open chapter only and shows that list", async () => {
    const client = advisorClient({ data: chapter, error: null });
    const desk = await loadAdvisorDesk(client);
    expect(rosterCalls(client)).toEqual([["get_staff_roster", { p_chapter_only: true }]]);
    expect(desk.roster).toEqual(chapter);
  });

  it("falls back once to the organization list while the database has no p_chapter_only", async () => {
    const client = advisorClient({ data: null, error: { code: "PGRST202", message: "Could not find the function public.get_staff_roster(p_chapter_only) in the schema cache" } });
    const desk = await loadAdvisorDesk(client);
    expect(rosterCalls(client)).toEqual([["get_staff_roster", { p_chapter_only: true }], ["get_staff_roster"]]);
    expect(desk.roster).toEqual(organization);
  });

  it("handles any other roster error as before, without asking for the organization list", async () => {
    const client = advisorClient({ data: null, error: { code: "42501", message: "staff role required" } });
    const desk = await loadAdvisorDesk(client);
    expect(rosterCalls(client)).toEqual([["get_staff_roster", { p_chapter_only: true }]]);
    expect(desk.roster).toEqual([]);
  });

  it("reads no roster for the first, overview-only paint", async () => {
    const client = advisorClient({ data: chapter, error: null });
    await loadAdvisorDesk(client, { overviewOnly: true });
    expect(rosterCalls(client)).toEqual([]);
  });
});

describe("20261124175100 replaces only the reviewed roster (static)", () => {
  const sql = stripComments(loadMigrationSql(MIGRATION));

  it("checks the exact predecessor and the absent receipt before it drops anything", () => {
    const guard = sql.indexOf("'7d43ad41668b217978179b132c6a69c4'");
    const receipt = sql.indexOf("object_name='get_staff_roster()'");
    const drop = sql.indexOf("drop function public.get_staff_roster();");
    expect(guard).toBeGreaterThan(-1);
    expect(receipt).toBeGreaterThan(guard);
    expect(drop).toBeGreaterThan(receipt);
    expect(sql.trim()).toMatch(/^begin;/u);
    expect(sql.trim()).toMatch(/commit;$/u);
  });

  it("narrows with a defaulted argument and keeps the refusal on the held grant", () => {
    expect(sql).toContain("public.get_staff_roster(p_chapter_only boolean DEFAULT false)");
    expect(sql).toContain("org_wide_view boolean := caller_org_wide and not coalesce(p_chapter_only, false)");
    // The refusal reads what the caller holds, never the narrowed view.
    expect(sql).toMatch(/not \(\s*caller_org_wide\s*or private\.member_has_chapter_role\(/u);
    expect(sql.match(/case when org_wide_view then null else caller_chapter end/gu)).toHaveLength(2);
    expect(sql).toContain("and (org_wide_view or c.id = caller_chapter)");
    expect(sql).not.toMatch(/case when caller_org_wide then/u);
  });

  it("restores the predecessor's grants exactly", () => {
    expect(sql).toContain("revoke all on function public.get_staff_roster(boolean) from public, anon, service_role;");
    expect(sql).toContain("grant execute on function public.get_staff_roster(boolean) to authenticated;");
  });
});
