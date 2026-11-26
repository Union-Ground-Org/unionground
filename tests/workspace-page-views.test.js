// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { abortableRpcClient, createWorkspacePageViewRecorder, workspacePageKey } from "../src/lib/workspacePageViews.js";
import { recordWorkspacePageView } from "../src/lib/memberApi.js";
import { guardedFetch } from "../src/lib/transportGuard.js";

// OPS-UG-ANALYTICS-READ-SIDE-SHIPPED-BUT-NOTHING-IN-PRODUCTION-WRITES-ORGANIZATION-ENGAGEMENT-EVENTS-20260921
// ( AUTHENTICATED PAGE-VIEW PRODUCER): the web client
// sends one normalized workspace path per page change and nothing else.
describe("workspace page-view producer (web)", () => {
  it("binds each page-view RPC to the analytics abort signal current at call time", async () => {
    const first = new AbortController();
    const second = new AbortController();
    let current = first;
    const builder = { abortSignal: vi.fn(() => "request") };
    const client = { rpc: vi.fn(() => builder) };
    let allowed = true;
    const gated = abortableRpcClient(client, () => current.signal, () => allowed);
    expect(gated.rpc("record_workspace_page_view", { p_page: "/m" })).toBe("request");
    current = second;
    gated.rpc("record_workspace_page_view", { p_page: "/m/cases" });
    expect(client.rpc).toHaveBeenCalledWith("record_workspace_page_view", { p_page: "/m/cases" });
    expect(builder.abortSignal.mock.calls.map(([signal]) => signal)).toEqual([first.signal, second.signal]);

    // The client's guarded fetch re-reads the choice for these signals only.
    const transport = vi.fn(async () => new Response("{}"));
    const fetchGuard = guardedFetch(transport);
    allowed = false;
    await expect(fetchGuard("https://project.supabase.co/rest/v1/rpc/record_workspace_page_view", { signal: second.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    await fetchGuard("https://project.supabase.co/rest/v1/rpc/member_snapshot", { signal: new AbortController().signal });
    await fetchGuard("https://project.supabase.co/rest/v1/rpc/member_snapshot");
    allowed = true;
    await fetchGuard("https://project.supabase.co/rest/v1/rpc/record_workspace_page_view", { signal: second.signal });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("keys a view by the normalized /m path and ignores everything else", () => {
    expect(workspacePageKey("/m")).toBe("/m");
    expect(workspacePageKey("/m/")).toBe("/m");
    expect(workspacePageKey("/m/voting?tab=past#ballot-1")).toBe("/m/voting");
    expect(workspacePageKey("/m/tasks/board")).toBe("/m/tasks/board");
    for (const location of ["/", "/invite#invite=secret", "/stop-updates#confirm=secret", "/verify-card", "/chapters/x", "", null, `/m/${"a".repeat(120)}`, "/m/bad path", "/m/%20"]) {
      expect(workspacePageKey(location), location).toBeNull();
    }
  });

  it("sends a page once per minute, re-sends on a page change, and never throws for the page", async () => {
    let clock = 1_000;
    const record = vi.fn().mockRejectedValue(new Error("offline"));
    const recorder = createWorkspacePageViewRecorder({ record, now: () => clock });
    expect(recorder.view("/m/voting?x=1", { hat: "member", organizationId: "org-1" })).toBe(true);
    expect(recorder.view("/m/voting#y", { hat: "member", organizationId: "org-1" })).toBe(false);
    clock += 30_000;
    expect(recorder.view("/m/voting", {})).toBe(false);
    expect(recorder.view("/m/events", {})).toBe(true);
    clock += 61_000;
    expect(recorder.view("/m/events", {})).toBe(true);
    expect(recorder.view("/invite#invite=secret", {})).toBe(false);
    await Promise.resolve();
    expect(record.mock.calls.map(([page]) => page)).toEqual(["/m/voting", "/m/events", "/m/events"]);
    expect(record.mock.calls[0][1]).toEqual({ hat: "member", organizationId: "org-1" });
    recorder.reset();
    expect(recorder.view("/m/events", {})).toBe(true);
  });

  it("calls the authenticated RPC with the page, the hat and the organization only", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: { recorded: true }, error: null }) };
    await recordWorkspacePageView(client, "/m/voting", "steward", "org-1");
    await recordWorkspacePageView(client, "/m");
    expect(client.rpc.mock.calls).toEqual([
      ["record_workspace_page_view", { p_page: "/m/voting", p_hat: "steward", p_organization_id: "org-1" }],
      ["record_workspace_page_view", { p_page: "/m", p_hat: "member", p_organization_id: null }],
    ]);
  });

  it.each([
    ["live member", false, false, false, true, "active", true],
    ["authenticated SAMPLE member", true, true, false, true, "active", true],
    ["static demo", true, false, true, true, "active", false],
    ["test preview", false, false, true, true, "active", false],
    ["signed out SAMPLE", true, true, false, false, "active", false],
    ["inactive SAMPLE membership", true, true, false, true, "inactive", false],
  ])("runs the actual route effect for %s", (_label, demo, sampleLive, demoActive, signedIn, membershipStatus, expected) => {
    const app = readFileSync("src/App.jsx", "utf8");
    const start = app.indexOf("const pageViewRecorder = useMemo");
    const effect = app.slice(start).match(/useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[/)?.[1];
    expect(effect).toBeTruthy();
    const pageViewRecorder = { view: vi.fn() };
    // eslint-disable-next-line no-new-func -- evaluates source extracted from the module under test
    const run = new Function("demo", "sampleLive", "demoActive", "session", "data", "pageViewRecorder", "routeLocation", "selectedStaffHat", effect);
    run(demo, sampleLive, demoActive, signedIn ? { user: { id: "sample-member" } } : null,
      { member: { organizationId: "sample-org", membershipStatus } }, pageViewRecorder, "/m/events?demo=1", "member");
    expect(pageViewRecorder.view).toHaveBeenCalledTimes(expected ? 1 : 0);
    if (expected) expect(pageViewRecorder.view).toHaveBeenCalledWith("/m/events?demo=1", { hat: "member", organizationId: "sample-org" });
  });

  it("is wired to workspace route changes on active live or SAMPLE memberships and never in static previews", () => {
    const app = readFileSync("src/App.jsx", "utf8");
    expect(app).toContain('import { abortableRpcClient, createWorkspacePageViewRecorder } from "./lib/workspacePageViews.js";');
    expect(app).toContain("record: (page, context) => recordWorkspacePageView(abortableRpcClient(sessionDataClient, productAnalyticsSignal, isDemoAnalyticsEnabled), page, context.hat, context.organizationId),");
    expect(app).toContain('if (demoActive || (demo && !sampleLive) || !session || !data?.member?.organizationId || data.member.membershipStatus !== "active") return;');
    expect(app).toContain("pageViewRecorder.view(routeLocation, { hat: selectedStaffHat, organizationId: data.member.organizationId });");
    expect(app).toContain("}, [data?.member?.organizationId, data?.member?.membershipStatus, demo, demoActive, sampleLive, pageViewRecorder, routeLocation, selectedStaffHat, session]);");
  });
});
