import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnalyticsCoreDesk,
  downloadAnalyticsExport,
} from "../src/features/analytics/ui/AnalyticsCoreDesk.jsx";
import {
  buildAnalyticsExport,
  buildOrganizationStatsSuite,
  composeAnalyticsCore,
  createPreviewAnalyticsSnapshot,
  createPreviewAnalyticsViewer,
} from "../src/features/analytics/index.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { analyticsViewOptions, showAnalyticsView } from "./helpers/analyticsView.js";

describe("analytics core desk", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the seven stats tabs from an authorized preview snapshot", () => {
    const snapshot = createPreviewAnalyticsSnapshot();
    const viewer = createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] });
    render(<AnalyticsCoreDesk snapshot={snapshot} viewer={viewer} />);
    expect(screen.getByText("Organization analytics")).toBeInTheDocument();
    expect(screen.getByText("PREVIEW figures — not a real organization.")).toBeInTheDocument();
    expect(analyticsViewOptions()).toEqual(["Overview", "Campaigns", "Issue categories", "Issues", "Committee", "Participation", "Comparison"]);
    expect(screen.getByText("Open issues")).toBeInTheDocument();
  });

  it("explains empty, unauthorized, and unset states", () => {
    const { rerender } = render(
      <AnalyticsCoreDesk viewer={{ selectedHat: "admin", roles: ["admin"] }} />,
    );
    expect(screen.getByRole("heading", { name: "No organization yet" })).toBeInTheDocument();

    rerender(
      <AnalyticsCoreDesk
        viewer={createPreviewAnalyticsViewer({ selectedHat: "member", roles: ["admin"] })}
        snapshot={createPreviewAnalyticsSnapshot()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Analytics isn't open to this role" })).toBeInTheDocument();

    rerender(
      <AnalyticsCoreDesk viewer={createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] })} />,
    );
    expect(screen.getByRole("heading", { name: "Analytics isn't connected here" })).toBeInTheDocument();
  });

  it("moves between desk surfaces and reports an export", async () => {
    vi.stubGlobal("navigator", { userAgent: "browser" });
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:analytics"), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const snapshot = createPreviewAnalyticsSnapshot();
    const viewer = createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] });
    const model = composeAnalyticsCore({ snapshot, viewer });
    const onExport = vi.fn(async (options) => ({
      ...buildAnalyticsExport(model, viewer, options),
      receipt: { id: "export-a", expiresAt: "2026-08-26T12:00:00Z" },
    }));
    render(<AnalyticsCoreDesk snapshot={snapshot} viewer={viewer} onExport={onExport} />);

    showAnalyticsView("Usage");
    expect(screen.getByText("Portal usage · 30 days")).toBeInTheDocument();
    expect(screen.queryByText("/m/admin")).not.toBeInTheDocument();

    showAnalyticsView("Heatmaps");
    expect(screen.getAllByText("Hidden").length).toBeGreaterThan(0);
    expect(screen.getByText("Issue concentrations")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(await screen.findByText(/Download expires in 24 hours/)).toBeInTheDocument();
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onExport).toHaveBeenCalledWith({ format: "csv" });
  });

  it("refuses steward exports from the control", () => {
    const snapshot = createPreviewAnalyticsSnapshot();
    const viewer = createPreviewAnalyticsViewer();
    const model = composeAnalyticsCore({ snapshot, viewer });
    render(<AnalyticsCoreDesk model={model} viewer={viewer} />);
    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();
    expect(screen.getByText(/limited to the Campaign lead, Admin, and Campaign chair roles/)).toBeInTheDocument();
  });

  it("renders every stats and organization surface from the preview model", () => {
    const snapshot = createPreviewAnalyticsSnapshot();
    const viewer = createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] });
    render(<AnalyticsCoreDesk snapshot={snapshot} viewer={viewer} />);

    for (const [tab, expected] of [
      ["Campaigns", "Campaign"],
      ["Issue categories", "Hidden until at least 25 people are in this comparison."],
      ["Issues", "By status"],
      ["Committee", "Average open"],
      ["Participation", "Active workers"],
      ["Comparison", "Campaign"],
    ]) {
      showAnalyticsView(tab);
      expect(screen.getByText(expected)).toBeInTheDocument();
    }

    showAnalyticsView("Insights");
    expect(screen.getByText("Correlation insights")).toBeInTheDocument();
    expect(screen.getByText(/Hidden until at least 25 campaign observations/)).toBeInTheDocument();

    showAnalyticsView("Engagement");
    expect(screen.getByText("Engagement scoring")).toBeInTheDocument();
    expect(screen.getByLabelText("Score bands")).toBeInTheDocument();

    showAnalyticsView("Attendance");
    expect(screen.getByRole("heading", { name: "Attendance" })).toBeInTheDocument();
    expect(screen.getAllByText("Check-ins")).toHaveLength(2);
  });

  it("renders loading and retryable error states", () => {
    const onRetry = vi.fn();
    const { rerender } = render(<AnalyticsCoreDesk status="loading" />);
    expect(screen.getByText(/Loading organization analytics/)).toBeInTheDocument();
    rerender(<AnalyticsCoreDesk model={{ state: "error", reason: "snapshot_failed" }} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("exposes the loading card as a status region and drops it when ready", () => {
    const { container, rerender } = render(<AnalyticsCoreDesk status="loading" />);
    const desk = container.querySelector(".mi1-ana");
    expect(screen.getByRole("status")).toHaveTextContent("Loading organization analytics");
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(desk).toHaveAttribute("aria-busy", "true");

    const snapshot = createPreviewAnalyticsSnapshot();
    const viewer = createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] });
    rerender(<AnalyticsCoreDesk snapshot={snapshot} viewer={viewer} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText(/Loading organization analytics/)).not.toBeInTheDocument();
    expect(desk).not.toHaveAttribute("aria-busy");
  });

  it("labels unpopulated live aggregate sources unavailable", () => {
    const viewer = createPreviewAnalyticsViewer({ organizationId: "org-live", selectedHat: "admin", roles: ["admin"] });
    const snapshot = {
      organizationId: "org-live",
      privacyThreshold: 25,
      chapters: [{ id: "chapter-a", memberCount: 40, stewardCount: 5 }],
      cases: [{ chapterId: "chapter-a", status: "active", count: 10 }],
      series: [{ chapterId: "chapter-a", openCases: 10, attendanceRate: null, engagementMean: null, usageViews: null }],
      heatmapPoints: [{ kind: "grievance", rowKey: "chapter-a", colKey: "contract", count: 10 }],
      attendanceEvents: [],
      attendanceCohorts: { organizationId: "org-live", firstTime: null, repeat: null, suppressed: true },
    };
    render(<AnalyticsCoreDesk snapshot={snapshot} viewer={viewer} />);

    showAnalyticsView("Insights");
    expect(screen.getByText(/aggregate is not available/)).toBeInTheDocument();
    expect(screen.queryByText(/No strong organization-level correlations/)).not.toBeInTheDocument();

    showAnalyticsView("Heatmaps");
    expect(screen.getByText(/Solidarity concentrations: This aggregate is not available/)).toBeInTheDocument();

    showAnalyticsView("Attendance");
    expect(screen.getByText(/aggregate is not available/)).toBeInTheDocument();
  });

  it("explains the anonymity floor on the issues tab instead of an empty table", () => {
    const viewer = createPreviewAnalyticsViewer({ organizationId: "org-live", selectedHat: "admin", roles: ["admin"] });
    const snapshot = {
      organizationId: "org-live",
      privacyThreshold: 25,
      chapters: [
        { id: "chapter-a", memberCount: 120, stewardCount: 6 },
        // The hosted aggregate returns a null memberCount for a sub-floor chapter.
        { id: "chapter-b", memberCount: null, stewardCount: 2 },
      ],
      cases: [
        { chapterId: "chapter-a", status: "active", type: "contract", step: 2, count: 60 },
        { chapterId: "chapter-b", status: "active", type: "contract", step: 2, count: 40 },
      ],
      series: [],
      heatmapPoints: [],
      attendanceEvents: [],
    };
    render(<AnalyticsCoreDesk snapshot={snapshot} viewer={viewer} />);

    showAnalyticsView("Issues");
    expect(screen.getByText("Hidden until at least 25 people are in this comparison.")).toBeInTheDocument();
    expect(screen.queryByText("By status")).not.toBeInTheDocument();
    expect(screen.queryByText("No rows yet.")).not.toBeInTheDocument();
  });

  // UX-UG-STATS-CASES-FLOORED-STATUS-BUCKETS-SHOW-AS-NO-ROWS-20260920: the
  // demo/preview snapshot carries un-floored case rows, so every per-status
  // bucket falls under the floor while Overview still totals open and resolved
  // cases. The Issues tab must explain the withholding, not read as empty.
  it("explains floored Issues buckets instead of no rows while Overview still shows open cases", () => {
    const snapshot = createPreviewAnalyticsSnapshot();
    const viewer = createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] });
    const stats = buildOrganizationStatsSuite(snapshot, viewer);
    expect(stats.overview.openCases).toBeGreaterThan(0);
    expect(stats.overview.resolvedCases).toBeGreaterThan(0);
    expect(stats.cases).toMatchObject({ enoughData: true, reason: null, byStatus: [], statusFloored: true });

    render(<AnalyticsCoreDesk snapshot={snapshot} viewer={viewer} />);
    const kpi = (label) => screen.getByText(label, { selector: ".mi1-ana-tile__label" }).nextElementSibling.textContent;
    expect(kpi("Open issues")).toBe(String(stats.overview.openCases));
    expect(kpi("Resolved issues")).toBe(String(stats.overview.resolvedCases));

    showAnalyticsView("Issues");
    expect(screen.getByText("By status")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Hidden until at least 25 people are in this comparison.");
    expect(screen.queryByText("No rows yet.")).not.toBeInTheDocument();
    // The note explains the floor; it publishes no withheld per-status count.
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("keeps no-rows copy when the Issues snapshot is genuinely empty", () => {
    const viewer = createPreviewAnalyticsViewer({ organizationId: "org-live", selectedHat: "admin", roles: ["admin"] });
    const snapshot = {
      organizationId: "org-live",
      privacyThreshold: 25,
      chapters: [{ id: "chapter-a", memberCount: 120, stewardCount: 6 }],
      cases: [],
      series: [],
      heatmapPoints: [],
      attendanceEvents: [],
    };
    expect(buildOrganizationStatsSuite(snapshot, viewer).cases.statusFloored).toBe(false);
    render(<AnalyticsCoreDesk snapshot={snapshot} viewer={viewer} />);

    showAnalyticsView("Issues");
    expect(screen.getByText("No rows yet.")).toBeInTheDocument();
    expect(screen.queryByText("Hidden until at least 25 people are in this comparison.")).not.toBeInTheDocument();
  });

  it("reports non-authorization export errors", async () => {
    const snapshot = createPreviewAnalyticsSnapshot();
    const viewer = createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] });
    render(<AnalyticsCoreDesk
      snapshot={snapshot}
      viewer={viewer}
      onExport={async () => ({ ok: false, reason: "export_failed" })}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(await screen.findByText(/could not be prepared/)).toBeInTheDocument();
  });

  it("downloads a prepared payload in a browser-capable environment", () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => "blob:analytics");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("navigator", { userAgent: "browser" });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    expect(downloadAnalyticsExport({
      body: "surface,section,label,value\n",
      format: "csv",
      filename: "analytics.csv",
    })).toBe(true);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:analytics");
    expect(downloadAnalyticsExport(null)).toBe(false);
    vi.useRealTimers();
  });

  it("labels known case statuses from the catalogue and keeps an unknown token readable", () => {
    const viewer = createPreviewAnalyticsViewer({
      organizationId: "org-live",
      selectedHat: "admin",
      roles: ["admin"],
    });
    const snapshot = {
      organizationId: "org-live",
      privacyThreshold: 25,
      chapters: [{ id: "chapter-a", label: "North", memberCount: 40, stewardCount: 5 }],
      cases: [
        { chapterId: "chapter-a", status: "active", count: 30 },
        { chapterId: "chapter-a", status: "resolved", count: 26 },
        { chapterId: "chapter-a", status: "queued_elsewhere", count: 25 },
      ],
      series: [{ chapterId: "chapter-a", openCases: 30, attendanceRate: null, engagementMean: null, usageViews: null }],
      heatmapPoints: [],
      attendanceEvents: [],
      attendanceCohorts: { organizationId: "org-live", firstTime: null, repeat: null, suppressed: true },
    };

    const { unmount } = render(
      <LanguageProvider lang="es">
        <AnalyticsCoreDesk snapshot={snapshot} viewer={viewer} />
      </LanguageProvider>,
    );
    showAnalyticsView("Asuntos");
    const spanish = screen.getByRole("table");
    expect(spanish).toHaveTextContent("Activo");
    expect(spanish).toHaveTextContent("Resuelto");
    expect(spanish).toHaveTextContent("30");
    expect(spanish).toHaveTextContent("26");
    expect(spanish).toHaveTextContent("queued_elsewhere");
    expect(spanish).not.toHaveTextContent(/\bactive\b/);
    expect(spanish).not.toHaveTextContent(/\bresolved\b/);
    unmount();

    render(
      <LanguageProvider lang="en">
        <AnalyticsCoreDesk snapshot={snapshot} viewer={viewer} />
      </LanguageProvider>,
    );
    showAnalyticsView("Issues");
    const english = screen.getByRole("table");
    expect(english).toHaveTextContent("Active");
    expect(english).toHaveTextContent("Resolved");
    expect(english).toHaveTextContent("queued_elsewhere");
    expect(english).not.toHaveTextContent(/\bactive\b/);
    expect(english).not.toHaveTextContent(/\bresolved\b/);
  });
});

// Record 8435, slice 7: the export keeps Export CSV focused under pending and
// exports once from one tick.
describe("analytics export while it runs (record 8435)", () => {
  function deskWithExport() {
    vi.stubGlobal("navigator", { userAgent: "browser" });
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:analytics"), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const snapshot = createPreviewAnalyticsSnapshot();
    const viewer = createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] });
    const model = composeAnalyticsCore({ snapshot, viewer });
    const onExport = vi.fn(async (options) => ({ ...buildAnalyticsExport(model, viewer, options), receipt: { id: "export-a", expiresAt: "2026-08-26T12:00:00Z" } }));
    render(<AnalyticsCoreDesk snapshot={snapshot} viewer={viewer} onExport={onExport} />);
    return { onExport, button: screen.getByRole("button", { name: "Export CSV" }) };
  }

  it("keeps Export CSV focused while the export is written, and exports once", async () => {
    const { onExport, button } = deskWithExport();
    await expectHeldWriteFocus(onExport, button);
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  // #8984 review P2: the export's busy state ends with its write, after a
  // successful and after a refused export, so Export CSV reads ready again.
  it("returns Export CSV to ready after a successful and after a refused export, and exports again", async () => {
    const { onExport, button } = deskWithExport();
    await act(async () => { fireEvent.click(button); });
    await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled", "true"));
    onExport.mockResolvedValueOnce({ ok: false, reason: "export_denied" });
    await act(async () => { fireEvent.click(button); });
    await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled", "true"));
    await act(async () => { fireEvent.click(button); });
    expect(onExport).toHaveBeenCalledTimes(3);
  });

  it("exports once when Export CSV is activated twice in one tick", async () => {
    const { onExport, button } = deskWithExport();
    await expectOneWriteFromOneTick(onExport, [() => fireEvent.click(button), () => fireEvent.click(button)]);
  });
});
