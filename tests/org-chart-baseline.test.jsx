import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { normalizeOrganizationStructure } from "../src/lib/memberApi.js";
import { OrgStructureView } from "../src/views/OrgStructureView.jsx";
import {
  buildOrgChartCsv,
  easternToday,
  effectiveSeatStatus,
  initiallyExpanded,
  outlineRows,
  seatMarkers,
} from "../src/features/orgChart/model.js";

// REQ-UG-TENANT-ORG-CHART-BASELINE-20261030. The owner-selected
// reference charts set the functional baseline (hierarchy, expand and
// collapse, filtering, print and phone reflow), never the content: every
// fixture here is synthetic and belongs to no organization.

const TODAY = easternToday();
const daysAgo = (days) => {
  const [y, m, d] = TODAY.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
};

const node = (id, parentId, label, extra = {}) => ({
  id, parentId, chapterId: null, nodeKind: "role", label, subtitle: null,
  positionX: 0, positionY: 0, sortOrder: 0, ...extra,
});

const STRUCTURE = normalizeOrganizationStructure({
  organizationId: "org-synthetic",
  chapterId: "chapter-synthetic",
  generatedAt: "2026-10-30T00:00:00.000Z",
  charts: [
    {
      chartKind: "union",
      nodes: [
        node("u-root", null, "Synthetic council", { nodeKind: "organization", seatStatus: "confirmed", seatStatusReviewedOn: daysAgo(10) }),
        node("u-board", "u-root", "Synthetic board", { nodeKind: "team", seatStatus: "confirmed", seatStatusReviewedOn: daysAgo(10) }),
        node("u-chair", "u-board", "Synthetic chair seat", { seatStatus: "confirmed", seatStatusReviewedOn: daysAgo(400) }),
        node("u-open", "u-board", "Synthetic open seat", { vacant: true, seatStatus: "confirmed", seatStatusReviewedOn: daysAgo(5) }),
        node("u-roster", "u-root", "Synthetic steward roster", { nodeKind: "team", collapsedByDefault: true, seatStatus: "unknown" }),
        node("u-steward", "u-roster", "Synthetic steward seat", { sourceLabel: "Synthetic roster sheet", sourceAsOf: "2026-10-01" }),
      ],
      edges: [],
    },
    {
      chartKind: "agency",
      nodes: [node("a-root", null, "Synthetic employer office", { nodeKind: "organization" })],
      edges: [],
    },
  ],
});

const show = (structure = STRUCTURE) => render(
  <LanguageProvider lang="en"><OrgStructureView structure={structure} /></LanguageProvider>,
);
const outline = () => screen.getByRole("list", { name: "Union hierarchy" });

afterEach(() => vi.restoreAllMocks());

describe("seat state model", () => {
  it("reads absent or unknown values as unconfirmed and aged confirmations as stale", () => {
    expect(effectiveSeatStatus({}, TODAY)).toBe("unconfirmed");
    expect(effectiveSeatStatus({ seatStatus: "verified" }, TODAY)).toBe("unconfirmed");
    expect(effectiveSeatStatus({ seatStatus: "confirmed", seatStatusReviewedOn: daysAgo(30) }, TODAY)).toBe("confirmed");
    expect(effectiveSeatStatus({ seatStatus: "confirmed", seatStatusReviewedOn: daysAgo(366) }, TODAY)).toBe("stale");
    expect(effectiveSeatStatus({ seatStatus: "confirmed" }, TODAY)).toBe("stale");
    expect(effectiveSeatStatus({ seatStatus: "unknown" }, TODAY)).toBe("unknown");
    expect(seatMarkers({ vacant: true, seatStatus: "confirmed", seatStatusReviewedOn: daysAgo(1) }, TODAY)).toEqual(["vacant"]);
    expect(seatMarkers({ vacant: true, seatStatus: "unknown" }, TODAY)).toEqual(["vacant", "unknown"]);
  });

  it("normalizes the server's seat fields and never upgrades a missing state", () => {
    const [chart] = normalizeOrganizationStructure({
      charts: [{ chartKind: "union", nodes: [{ id: "x", label: "X" }, { id: "y", label: "Y", seatStatus: "stale", seatStatusReviewedOn: "2025-01-02", collapsedByDefault: true }], edges: [] }],
    }).charts;
    expect(chart.nodes[0]).toMatchObject({ seatStatus: "unconfirmed", seatStatusReviewedOn: null, collapsedByDefault: false });
    expect(chart.nodes[1]).toMatchObject({ seatStatus: "stale", seatStatusReviewedOn: "2025-01-02", collapsedByDefault: true });
  });

  it("opens branches unless the organization marked them collapsed", () => {
    const union = STRUCTURE.charts.find((chart) => chart.chartKind === "union");
    expect([...initiallyExpanded(union.nodes)].sort()).toEqual(["u-board", "u-root"]);
    expect(outlineRows(union.nodes).map((row) => [row.node.id, row.depth])).toEqual([
      ["u-root", 0], ["u-board", 1], ["u-chair", 2], ["u-open", 2], ["u-roster", 1], ["u-steward", 2],
    ]);
  });
});

describe("organization chart page", () => {
  it("expands and collapses the hierarchy one branch or all at once", () => {
    show();
    // The roster branch starts closed because the organization said so.
    const rosterToggle = within(outline()).getByRole("button", { name: "Show 1 position under Synthetic steward roster" });
    expect(rosterToggle).toHaveAttribute("aria-expanded", "false");
    expect(within(outline()).queryByRole("button", { name: /^Synthetic steward seat/ })).toBeNull();
    fireEvent.click(rosterToggle);
    expect(within(outline()).getByRole("button", { name: "Hide 1 position under Synthetic steward roster" })).toHaveAttribute("aria-expanded", "true");
    expect(within(outline()).getByRole("button", { name: /^Synthetic steward seat/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(within(outline()).queryByRole("button", { name: /^Synthetic board/ })).toBeNull();
    expect(within(outline()).getByRole("button", { name: "Show 2 positions under Synthetic council" })).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    for (const label of ["Synthetic board", "Synthetic chair seat", "Synthetic open seat", "Synthetic steward seat"]) {
      expect(within(outline()).getByRole("button", { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    }
  });

  it("labels vacant, unknown, unconfirmed and stale seats, and explains each label", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    const seat = (label) => within(outline()).getByRole("button", { name: new RegExp(`^${label}`) });
    expect(within(seat("Synthetic chair seat")).getByText("Stale")).toBeInTheDocument();
    expect(within(seat("Synthetic open seat")).getByText("Vacant")).toBeInTheDocument();
    expect(within(seat("Synthetic steward roster")).getByText("Unknown")).toBeInTheDocument();
    expect(within(seat("Synthetic steward seat")).getByText("Unconfirmed")).toBeInTheDocument();
    // A current confirmation carries no warning label.
    expect(within(seat("Synthetic board")).queryByText(/Vacant|Unknown|Unconfirmed|Stale/)).toBeNull();
    const legend = document.querySelector("dl.orgstructure__legend");
    expect(legend).toHaveAttribute("aria-label", "What the seat labels mean");
    expect(within(legend).getByText("No one holds this seat.")).toBeInTheDocument();
    expect(within(legend).getByText("Last confirmed more than a year ago, or never dated.")).toBeInTheDocument();
  });

  it("shows a seat's status, review date and own source in its detail", () => {
    show();
    fireEvent.click(within(outline()).getByRole("button", { name: "Show 1 position under Synthetic steward roster" }));
    fireEvent.click(within(outline()).getByRole("button", { name: /^Synthetic steward seat/ }));
    const detail = screen.getByRole("complementary", { name: "Selected position" });
    expect(within(detail).getByText("Unconfirmed")).toBeInTheDocument();
    expect(within(detail).getByText("Synthetic roster sheet · Oct 1, 2026")).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole("button", { name: "Close" }));
    fireEvent.click(within(outline()).getByRole("button", { name: /^Synthetic open seat/ }));
    const open = screen.getByRole("complementary", { name: "Selected position" });
    expect(within(open).getByText("Confirmed")).toBeInTheDocument();
    expect(within(open).getByText("Seat")).toBeInTheDocument();
    // The review date is a calendar day in words (#9892), never the stored ISO day.
    const reviewed = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
      .format(new Date(`${daysAgo(5)}T00:00:00Z`));
    expect(within(open).getByText(reviewed)).toBeInTheDocument();
    expect(within(open).queryByText(daysAgo(5))).toBeNull();
  });

  it("filters to vacant seats or seats that need confirmation, opening every match", () => {
    show();
    const filter = screen.getByRole("combobox", { name: "Show" });
    fireEvent.change(filter, { target: { value: "vacant" } });
    expect(screen.getByText("1 positions · 0 reporting lines")).toBeInTheDocument();
    expect(within(outline()).getByRole("button", { name: /^Synthetic open seat/ })).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: "needsReview" } });
    // Stale, unknown and unconfirmed seats; the hidden roster member is shown.
    expect(screen.getByText("3 positions · 0 reporting lines")).toBeInTheDocument();
    expect(within(outline()).getByRole("button", { name: /^Synthetic steward seat/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Employer" }));
    expect(screen.getByText("1 positions · 0 reporting lines")).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: "vacant" } });
    expect(screen.getByText("No position matches this filter.")).toBeInTheDocument();
  });

  it("prints the chart through the browser with every branch open", () => {
    let printedSteward = null;
    const print = vi.spyOn(window, "print").mockImplementation(() => {
      printedSteward = within(outline()).queryByRole("button", { name: /^Synthetic steward seat/ });
    });
    show();
    // The roster branch is closed on screen; the printed page still lists its seat.
    expect(within(outline()).queryByRole("button", { name: /^Synthetic steward seat/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Print chart" }));
    expect(print).toHaveBeenCalledTimes(1);
    expect(printedSteward).not.toBeNull();
    act(() => { window.dispatchEvent(new Event("afterprint")); });
    expect(within(outline()).queryByRole("button", { name: /^Synthetic steward seat/ })).toBeNull();
  });

  it("opens every branch for a browser print started outside the page", () => {
    show();
    act(() => { window.dispatchEvent(new Event("beforeprint")); });
    expect(within(outline()).getByRole("button", { name: /^Synthetic steward seat/ })).toBeInTheDocument();
    act(() => { window.dispatchEvent(new Event("afterprint")); });
    expect(within(outline()).queryByRole("button", { name: /^Synthetic steward seat/ })).toBeNull();
  });

  it("downloads only the chart on screen, from the rows the server scoped", async () => {
    const blobs = [];
    const createObjectURL = vi.fn((blob) => { blobs.push(blob); return "blob:synthetic"; });
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    show();
    fireEvent.click(screen.getByRole("button", { name: "Download chart (CSV)" }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:synthetic");
    const csv = await blobs[0].text();
    expect(csv.split("\n")[0]).toBe("Organization,Campaign,Chart,Level,Path,Position,Kind,Detail,Reports to,Seat status,Vacant,Reviewed on,Source,Source as of");
    expect(csv).toContain("org-synthetic,chapter-synthetic,Union,3,Synthetic council > Synthetic board > Synthetic open seat,Synthetic open seat,role,,,Confirmed,Yes,");
    expect(csv).toContain(",Stale,No,");
    // The other chart and everything the server did not send stay out.
    expect(csv).not.toContain("Synthetic employer office");
    expect(csv.trim().split("\n")).toHaveLength(7);
  });

  it("keeps exported cells inert in spreadsheets", () => {
    const csv = buildOrgChartCsv({
      chart: { chartKind: "union", nodes: [node("x", null, "=HYPERLINK(\"http://example.invalid\")")] },
      organizationId: "org-synthetic",
      today: TODAY,
    });
    expect(csv).toContain("\"'=HYPERLINK(\"\"http://example.invalid\"\")\"");
  });
});
