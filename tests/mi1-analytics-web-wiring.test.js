import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MEMBER_PATH_VIEWS, SPA_ROUTE_PATHS } from "../src/lib/appRoutes.js";
import {
  MI1_ANALYTICS_DATABASE_DEPENDENCIES,
  MI1_ANALYTICS_WEB_DONOR,
  buildMi1AnalyticsActor,
  createAnalyticsExportRequester,
  createAnalyticsLayoutDeleter,
  createAnalyticsLayoutSaver,
  createAnalyticsSnapshotLoader,
  createAnalyticsWorkspaceLoader,
  createWiredAnalyticsAdapter,
  isAnalyticsAuthorizationError,
  isMissingRpcError,
  isTransientTransportFailure,
  loadOrganizationSessionScope,
  mergeMi1AnalyticsScope,
} from "../src/lib/mi1AnalyticsWiring.js";
import { STAFF_TOOLS } from "../src/lib/staffPlanes.js";
import { createPreviewAnalyticsSnapshot } from "../src/features/analytics/index.js";
import { STAFF_ROLE_NAVIGATION } from "../src/lib/staffNavigation.js";

const ORG = "11111111-1111-4111-8111-111111111111";

describe("MI1 analytics web wiring", () => {
  it("records analytics-only provenance and rejected donor assumptions", () => {
    expect(MI1_ANALYTICS_WEB_DONOR.baseline).toBe("donor-baseline-20260721");
    expect(MI1_ANALYTICS_WEB_DONOR.webWiring).toBe("ad2aef01af257be3d6fbbbe985b24f984cf8f222");
    expect(MI1_ANALYTICS_WEB_DONOR.disposition).toBe("port_adapt");
    expect(MI1_ANALYTICS_WEB_DONOR.rejected).toEqual(expect.arrayContaining([
      "in-memory writes presented as persisted success",
      "other first-wave domains and migrations",
    ]));
  });

  it("registers Organization analytics as a staff tool, never a member path", () => {
    expect(MEMBER_PATH_VIEWS["/m/analytics"]).toBeUndefined();
    expect(STAFF_TOOLS.map((tool) => tool.view)).toContain("analytics");
    expect(SPA_ROUTE_PATHS).toContain("/m/analytics");
    for (const items of Object.values(STAFF_ROLE_NAVIGATION)) {
      expect(items).toContainEqual({
        key: "analytics",
        viewKey: "analytics",
        labelKey: "nav.analytics",
        path: "/m/analytics",
        icon: "📊",
      });
    }
  });

  it("maps missing snapshot RPCs to unset without inventing an organization", async () => {
    expect(isMissingRpcError({ code: "PGRST202" })).toBe(true);
    expect(await loadOrganizationSessionScope(null)).toEqual({
      organizationId: null,
      chapterId: null,
      organizationRoles: [],
      chapterRoles: [],
      unavailable: true,
    });
    expect(buildMi1AnalyticsActor({ userId: "user-a" }).selectedOrganizationId).toBeNull();

    const adapter = createWiredAnalyticsAdapter({
      rpc: async () => ({ error: { code: "PGRST202", message: "Could not find the function" } }),
    });
    const desk = await adapter.loadDesk({
      viewer: buildMi1AnalyticsActor({
        userId: "admin-a",
        organizationId: ORG,
        roles: ["admin"],
        selectedHat: "admin",
      }),
    });
    expect(desk.state).toBe("unset");
    expect(desk.stats).toBeNull();
    expect(desk.usage).toBeNull();
  });

  it("lists exact X-DB analytics dependencies and stays out of other domains", () => {
    expect(MI1_ANALYTICS_DATABASE_DEPENDENCIES.rpcs).toEqual([
      "get_organization_analytics_snapshot",
      "get_organization_analytics_workspace",
      "save_organization_analytics_layout",
      "delete_organization_analytics_layout",
      "request_organization_analytics_export",
    ]);
    expect(MI1_ANALYTICS_DATABASE_DEPENDENCIES.tables).toContain("organization_page_views");
    expect(MI1_ANALYTICS_DATABASE_DEPENDENCIES.tables).toContain("organization_analytics_layouts");
    const wiring = readFileSync("src/lib/mi1AnalyticsWiring.js", "utf8");
    const app = readFileSync("src/App.jsx", "utf8");
    const analyticsView = readFileSync("src/views/AnalyticsCoreView.jsx", "utf8");
    expect(wiring).not.toMatch(/supabase\/migrations/);
    expect(wiring).not.toContain("createQaRpcAdapter");
    expect(wiring).not.toContain("INTEGRATION_PROVIDER");
    expect(app).toContain("AnalyticsCoreView");
    expect(analyticsView).not.toMatch(/MemberQaView|PayToolsView|IntegrationsView|OperationsHealthView|PublicDirectoryApp/);
    // The [organizationScope] blanking is the deliberate cross-tenant guard.
    // PR #2156's keep-the-desk-mounted approach must not be copied here.
    expect(analyticsView).toMatch(/const organizationScope = stableScopedViewer\.organizationId \|\| null;/);
    expect(analyticsView).toMatch(/useEffect\(\(\) => \{\s*requestSequence\.current \+= 1;\s*setModel\(null\);\s*setStatus\("loading"\);\s*\}, \[organizationScope\]\);/);
    expect(analyticsView).toContain("Do not copy PR #2156");

    const desk = readFileSync("src/features/analytics/ui/AnalyticsCoreDesk.jsx", "utf8");
    const css = readFileSync("src/features/analytics/analyticsCore.css", "utf8");
    const motion = readFileSync("src/motion.css", "utf8");
    expect(desk).toMatch(/<div className="mi1-ana__ready" data-analytics-ready-subtree="">/);
    expect(css).toMatch(/\.mi1-ana\s*\{\s*display:\s*flex;\s*flex-direction:\s*column;\s*gap:\s*16px;/);
    expect(css).toMatch(/\.mi1-ana__ready\s*\{\s*display:\s*contents;/);
    expect(css).not.toMatch(/\.mi1-ana__ready\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(
      /\.screen\.mi1-ana\s*>\s*\.mi1-ana__ready\s*>\s*\*\s*\{[^}]*animation:\s*sg-rise var\(--sg-motion-duration-slow\) var\(--sg-motion-ease-emphasized\) backwards;/,
    );
    expect(css).toMatch(
      /\.screen\.mi1-ana\s*>\s*\.mi1-ana__ready:nth-child\(2\)\s*>\s*:nth-child\(1\)\s*\{\s*animation-delay:\s*40ms;/,
    );
    expect(css).toMatch(
      /\.screen\.mi1-ana\s*>\s*\.mi1-ana__ready:nth-child\(2\)\s*>\s*:nth-child\(2\)\s*\{\s*animation-delay:\s*80ms;/,
    );
    expect(motion).toMatch(
      /\.screen\s*>\s*\*\s*\{\s*animation:\s*sg-rise var\(--sg-motion-duration-slow\) var\(--sg-motion-ease-emphasized\) backwards;/,
    );
    expect(motion).toMatch(/\.screen\s*>\s*:nth-child\(2\)\s*\{\s*animation-delay:\s*40ms;/);
    expect(motion).toMatch(/\.screen\s*>\s*:nth-child\(3\)\s*\{\s*animation-delay:\s*80ms;/);
  });

  it("persists authorized export requests through the landed RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { id: "export-a", format: "csv", expiresAt: "2026-08-26T12:00:00Z" },
      error: null,
    });
    await expect(createAnalyticsExportRequester({ rpc })({ format: "csv", rowCount: 12, suppressedCount: 3 })).resolves.toMatchObject({ id: "export-a" });
    expect(rpc).toHaveBeenCalledWith("request_organization_analytics_export", {
      p_format: "csv",
      p_row_count: 12,
      p_suppressed_count: 3,
    });
  });

  it("binds export receipts to the server-issued snapshot instead of client counts", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { id: "export-b", format: "json", expiresAt: "2026-09-26T12:00:00Z", rowCount: 40, suppressedCount: 2 },
      error: null,
    });
    await expect(createAnalyticsExportRequester({ rpc })({
      format: "json",
      snapshotId: "11111111-1111-4111-8111-111111111111",
      rowCount: 9999,
      suppressedCount: 0,
    })).resolves.toMatchObject({ id: "export-b", rowCount: 40 });
    expect(rpc).toHaveBeenCalledWith("request_organization_analytics_export", {
      p_format: "json",
      p_snapshot_id: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("persists and deletes reusable layout definitions through exact RPC arguments", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: { id: "layout-a", spec: { datasetId: "organization:chapter-health", chartType: "bar" } },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: "layout-a", deleted: true }, error: null });
    const input = {
      id: null,
      name: "Health overview",
      scope: "organization",
      chapterId: null,
      spec: { datasetId: "organization:chapter-health", chartType: "bar", title: "Health overview" },
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    };
    await expect(createAnalyticsLayoutSaver({ rpc })(input)).resolves.toMatchObject({ id: "layout-a" });
    expect(rpc).toHaveBeenNthCalledWith(1, "save_organization_analytics_layout", {
      p_layout_id: null,
      p_name: input.name,
      p_scope: input.scope,
      p_chapter_id: null,
      p_spec: input.spec,
      p_idempotency_key: input.idempotencyKey,
    });
    await expect(createAnalyticsLayoutDeleter({ rpc })({ id: "layout-a", idempotencyKey: input.idempotencyKey }))
      .resolves.toEqual({ id: "layout-a", deleted: true });
  });

  it("normalizes actor grants and merges a selected organization scope", () => {
    const actor = buildMi1AnalyticsActor({
      userId: "user-a",
      roles: ["admin", "admin", "not-a-role"],
      organizationRoles: ["coordinator", "invalid"],
      chapterRoles: ["steward", "invalid"],
      selectedHat: "member",
      membershipStatus: "",
      organizationStatus: "",
    });
    expect(actor.roles).toEqual(["admin"]);
    expect(actor.role).toBe("coordinator");
    expect(actor.membershipStatus).toBe("inactive");

    expect(mergeMi1AnalyticsScope(actor, {
      organizationId: ORG,
      chapterId: "chapter-a",
      chapterRoles: ["advisor"],
    })).toMatchObject({
      organizationId: ORG,
      chapterId: "chapter-a",
      chapterRoles: ["steward"],
    });
    expect(mergeMi1AnalyticsScope(actor, {
      organizationId: ORG,
      chapterId: "chapter-a",
      organizationRoles: [],
      chapterRoles: [],
      unavailable: false,
    })).toMatchObject({ organizationRoles: [], chapterRoles: [] });
    expect(buildMi1AnalyticsActor({ selectedHat: "" }).selectedHat).toBe("member");
  });

  it("loads selected membership scope and handles rejected or unavailable membership reads", async () => {
    await expect(loadOrganizationSessionScope({
      rpc: async () => ({
        data: [
          { organizationId: "other", chapterId: "other", organizationRoles: [], chapterRoles: ["steward"] },
          { selected: true, organizationId: ORG, chapterId: "chapter-a", organizationRoles: ["admin", "bad"], chapterRoles: ["steward"] },
        ],
        error: null,
      }),
    })).resolves.toEqual({
      organizationId: ORG,
      chapterId: "chapter-a",
      organizationRoles: ["admin"],
      chapterRoles: ["steward"],
      unavailable: false,
    });
    await expect(loadOrganizationSessionScope({ rpc: async () => ({ data: null, error: null }) }))
      .resolves.toEqual({ organizationId: null, chapterId: null, organizationRoles: [], chapterRoles: [], unavailable: false });
    await expect(loadOrganizationSessionScope({
      rpc: async () => ({ data: [{ organizationId: "not-selected", organizationRoles: ["admin"] }], error: null }),
    })).resolves.toEqual({ organizationId: null, chapterId: null, organizationRoles: [], chapterRoles: [], unavailable: false });
    await expect(loadOrganizationSessionScope({ rpc: async () => ({ error: new Error("denied") }) }))
      .resolves.toMatchObject({ unavailable: true });
    await expect(loadOrganizationSessionScope({ rpc: async () => { throw new Error("offline"); } }))
      .resolves.toMatchObject({ unavailable: true });
  });

  // BUG-UG-TAMARACK-WEB-ANALYTICS-FULL-RUN-FAILURE-CAUSE-20261021:
  // reproduced on a disposable Tamarack run (lane-ta-repro-2, October 21): the
  // browser dropped bot-01's workspace read with net::ERR_NETWORK_CHANGED and
  // Chapter charts showed "These charts could not load". These are the result
  // shapes @supabase/postgrest-js 2.110.7 returns for a POST with no response
  // and for the gateway's own 502.
  const droppedByBrowser = { data: null, error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" }, count: null, status: 0, statusText: "" };
  const gateway502 = { data: null, error: { message: "An invalid response was received from the upstream server" }, count: null, status: 502, statusText: "Bad Gateway" };
  const workspace = { organizationId: ORG, privacyThreshold: 25 };
  const sequence = (...results) => {
    const rpc = vi.fn(async () => results.shift());
    return { rpc };
  };

  it("reads the analytics workspace and snapshot again once when the request never reached the database", async () => {
    const dropped = sequence(droppedByBrowser, { data: workspace, error: null, status: 200 });
    await expect(createAnalyticsWorkspaceLoader(dropped)()).resolves.toEqual(workspace);
    expect(dropped.rpc).toHaveBeenCalledTimes(2);
    expect(dropped.rpc).toHaveBeenNthCalledWith(2, "get_organization_analytics_workspace");

    const gateway = sequence(gateway502, { data: { organizationId: ORG }, error: null, status: 200 });
    await expect(createAnalyticsSnapshotLoader(gateway)()).resolves.toEqual({ organizationId: ORG });
    expect(gateway.rpc).toHaveBeenCalledTimes(2);

    const poolTimeout = sequence({ data: null, error: { code: "PGRST003", message: "Timed out acquiring connection from connection pool." }, status: 504 }, { data: workspace, error: null, status: 200 });
    await expect(createAnalyticsWorkspaceLoader(poolTimeout)()).resolves.toEqual(workspace);
    expect(poolTimeout.rpc).toHaveBeenCalledTimes(2);
  });

  it("retries a dropped analytics read only once and never retries an answer from the database", async () => {
    const stillDown = sequence(droppedByBrowser, droppedByBrowser, { data: workspace, error: null, status: 200 });
    await expect(createAnalyticsWorkspaceLoader(stillDown)()).resolves.toEqual({ error: "workspace_failed" });
    expect(stillDown.rpc).toHaveBeenCalledTimes(2);

    for (const answered of [
      { data: null, error: { code: "XX000", message: "internal error" }, status: 500 },
      { data: null, error: { code: "42501", message: "not authorized" }, status: 403 },
      { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" }, status: 500 },
      { data: null, error: { code: "55P03", message: "lock timeout" }, status: 503 },
      // A gateway timeout does not prove the read never started (#5639 round 1).
      { data: null, error: { message: "The upstream server is timing out" }, status: 504 },
      { data: null, error: { message: "AbortError: signal is aborted without reason", code: "" }, status: 0 },
      { data: null, error: { message: "TimeoutError: Request timed out", code: "" }, status: 0 },
    ]) {
      expect(isTransientTransportFailure(answered)).toBe(false);
      const once = sequence(answered, { data: workspace, error: null, status: 200 });
      await createAnalyticsWorkspaceLoader(once)();
      expect(once.rpc).toHaveBeenCalledTimes(1);
    }
    expect(isTransientTransportFailure(droppedByBrowser)).toBe(true);
    expect(isTransientTransportFailure(gateway502)).toBe(true);
    expect(isTransientTransportFailure({ data: workspace, error: null, status: 200 })).toBe(false);
  });

  it("skips the retry when it could not finish before the load's deadline (#5639 round 1)", async () => {
    const tooLate = sequence(droppedByBrowser, { data: workspace, error: null, status: 200 });
    await expect(createAnalyticsWorkspaceLoader(tooLate)(null, { deadlineAt: Date.now() + 100 }))
      .resolves.toEqual({ error: "workspace_failed" });
    expect(tooLate.rpc).toHaveBeenCalledTimes(1);

    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      const expiresWhileWaiting = sequence(droppedByBrowser, { data: workspace, error: null, status: 200 });
      const read = createAnalyticsWorkspaceLoader(expiresWhileWaiting)(null, { deadlineAt: Date.now() + 300 });
      // A busy page delays the 250 ms timer past the deadline.
      await vi.advanceTimersByTimeAsync(0);
      vi.setSystemTime(Date.now() + 1_000);
      await vi.advanceTimersByTimeAsync(250);
      await expect(read).resolves.toEqual({ error: "timed_out" });
      expect(expiresWhileWaiting.rpc).toHaveBeenCalledTimes(1);

      const inTime = sequence(droppedByBrowser, { data: workspace, error: null, status: 200 });
      const retried = createAnalyticsWorkspaceLoader(inTime)(null, { deadlineAt: Date.now() + 10_000 });
      await vi.advanceTimersByTimeAsync(300);
      await expect(retried).resolves.toEqual(workspace);
      expect(inTime.rpc).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the first and the retried read at the load's deadline (#5639 final round)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const signals = [];
      // postgrest-js builders take .abortSignal(); an aborted request settles
      // as status 0 with an AbortError, as postgrest-js 2.110.7 reports it.
      const builder = (settle) => ({
        abortSignal(signal) {
          signals.push(signal);
          return settle(signal);
        },
      });
      const aborted = { data: null, error: { message: "AbortError: signal is aborted without reason", code: "" }, status: 0 };
      const client = {
        rpc: vi.fn()
          .mockImplementationOnce(() => builder(async () => droppedByBrowser))
          .mockImplementationOnce(() => builder((signal) => new Promise((resolve) => {
            signal.addEventListener("abort", () => resolve(aborted), { once: true });
          }))),
      };
      const read = createAnalyticsWorkspaceLoader(client)(null, { deadlineAt: Date.now() + 1_000 });
      await vi.advanceTimersByTimeAsync(300);
      expect(client.rpc).toHaveBeenCalledTimes(2);
      expect(signals).toHaveLength(2);
      expect(signals[1]).toBe(signals[0]);
      expect(signals[0].aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(700);
      expect(signals[0].aborted).toBe(true);
      // The deadline's own abort reads as "took too long" (#5665).
      await expect(read).resolves.toEqual({ error: "timed_out" });
      expect(client.rpc).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("words a read the load deadline aborted as timed out, through the wired adapter (#5665)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const aborted = { data: null, error: { message: "AbortError: signal is aborted without reason", code: "" }, status: 0 };
      const hangUntilAborted = () => ({
        abortSignal: (signal) => new Promise((resolve) => { signal.addEventListener("abort", () => resolve(aborted), { once: true }); }),
      });
      const answered = (data) => ({ abortSignal: async () => ({ data, error: null, status: 200 }) });
      const client = {
        rpc: vi.fn((name) => (name === "get_organization_analytics_snapshot" ? answered(createPreviewAnalyticsSnapshot()) : hangUntilAborted())),
      };
      const adapter = createWiredAnalyticsAdapter(client);
      const desk = adapter.loadDesk({
        viewer: buildMi1AnalyticsActor({ userId: "admin-a", organizationId: "preview-analytics-org", roles: ["admin"], mfaSatisfied: true, selectedHat: "admin" }),
        deadlineMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const model = await desk;
      expect(model.workspace).toMatchObject({ state: "error", reason: "timed_out" });
      expect(client.rpc).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }

    // An error that is not the deadline's keeps its wording.
    const failed = sequence({ data: null, error: { code: "XX000", message: "internal error" }, status: 500 });
    await expect(createAnalyticsWorkspaceLoader(failed)(null, { deadlineAt: Date.now() + 10_000 }))
      .resolves.toEqual({ error: "workspace_failed" });

    // An answer the database delivered after the deadline keeps its meaning
    // (#5675 round 1, r1g1): a refusal stays a refusal, a missing function
    // stays unset, a server error stays a failure.
    const past = () => ({ deadlineAt: Date.now() - 1 });
    await expect(createAnalyticsSnapshotLoader(sequence({ data: null, error: { code: "42501", message: "mfa required" }, status: 403 }))(null, past()))
      .resolves.toEqual({ unavailable: true, reason: "mfa_required" });
    await expect(createAnalyticsWorkspaceLoader(sequence({ data: null, error: { code: "42501", message: "not authorized" }, status: 403 }))(null, past()))
      .resolves.toEqual({ unavailable: true, reason: "authorization_required" });
    await expect(createAnalyticsWorkspaceLoader(sequence({ data: null, error: { code: "PGRST202", message: "Could not find the function" }, status: 404 }))(null, past()))
      .resolves.toBeNull();
    await expect(createAnalyticsSnapshotLoader(sequence({ data: null, error: { code: "XX000", message: "internal error" }, status: 500 }))(null, past()))
      .resolves.toEqual({ error: "snapshot_failed" });
    // A dropped read with no time left is the deadline's.
    await expect(createAnalyticsWorkspaceLoader(sequence(droppedByBrowser))(null, past()))
      .resolves.toEqual({ error: "timed_out" });
  });

  it("maps snapshot and export RPC outcomes without inventing success", async () => {
    await expect(createAnalyticsSnapshotLoader(null)()).resolves.toBeNull();
    await expect(createAnalyticsSnapshotLoader({ rpc: async () => ({ data: { organizationId: ORG }, error: null }) })())
      .resolves.toEqual({ organizationId: ORG });
    await expect(createAnalyticsSnapshotLoader({ rpc: async () => ({ data: null, error: null }) })())
      .resolves.toBeNull();
    await expect(createAnalyticsSnapshotLoader({ rpc: async () => ({ error: { status: 500, message: "offline" } }) })())
      .resolves.toEqual({ error: "snapshot_failed" });
    await expect(createAnalyticsSnapshotLoader({ rpc: async () => ({ error: { code: "42501", message: "denied" } }) })())
      .resolves.toEqual({ unavailable: true, reason: "authorization_required" });
    await expect(createAnalyticsSnapshotLoader({ rpc: async () => ({ error: { code: "42501", message: "mfa required" } }) })())
      .resolves.toEqual({ unavailable: true, reason: "mfa_required" });
    expect(isAnalyticsAuthorizationError({ code: "42501" })).toBe(true);
    expect(isMissingRpcError({ code: "42883" })).toBe(true);
    expect(isMissingRpcError(new Error("function does not exist"))).toBe(true);
    expect(isMissingRpcError({ status: 500, message: "offline" })).toBe(false);

    await expect(createAnalyticsExportRequester(null)()).rejects.toThrow("unavailable");
    await expect(createAnalyticsExportRequester({ rpc: async () => ({ error: new Error("denied") }) })())
      .rejects.toThrow("denied");
    await expect(createAnalyticsExportRequester({ rpc: async () => ({ data: { id: "missing-expiry" }, error: null }) })())
      .rejects.toThrow("receipt invalid");
  });
});
