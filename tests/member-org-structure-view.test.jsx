import { fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { OrgStructureView } from "../src/views/OrgStructureView.jsx";

// REQ-UG-MEMBER-ORG-STRUCTURE-VIEW-20260922 — the web half.
//
// The chart rows already existed; only a staff door did. This pins the member
// door: it renders both chart kinds read-only, it never grows a write control,
// and it appears with matching keys in the desktop rail and the phone nav (the
// exact shape of the two shipped nav defects tests/nav-view-key-parity.test.js
// was written for).

const STRUCTURE = {
  organizationId: "org-1",
  chapterId: "wor",
  generatedAt: "2026-09-22T00:00:00.000Z",
  charts: [
    {
      chartKind: "agency",
      nodes: [
        { id: "a1", parentId: null, chapterId: null, nodeKind: "organization", label: "Central office", subtitle: "Statewide", positionX: 0, positionY: 0, sortOrder: 1 },
        { id: "a2", parentId: "a1", chapterId: "wor", nodeKind: "team", label: "Area service team", subtitle: "Supports", positionX: 1, positionY: 1, sortOrder: 2 },
      ],
      edges: [],
    },
    {
      chartKind: "union",
      nodes: [
        { id: "u1", parentId: null, chapterId: null, nodeKind: "organization", label: "Statewide council", subtitle: null, positionX: 0, positionY: 0, sortOrder: 1 },
        { id: "u2", parentId: "u1", chapterId: "wor", nodeKind: "person", label: "Sam Okafor", subtitle: "Steward", positionX: 0, positionY: 1, sortOrder: 2 },
      ],
      edges: [{ id: "e1", sourceId: "u2", targetId: "u1", kind: "reports_to" }],
    },
  ],
};

const show = (props = {}) => render(
  <LanguageProvider lang="en"><OrgStructureView structure={STRUCTURE} {...props} /></LanguageProvider>,
);

const chapterContext = {
  organizationId: "org-1", chapterId: "larkspur",
  organizationName: "Larkspur Workers", chapterName: "Larkspur Main Depot",
};
const emptyChart = { organizationId: "org-1", chapterId: "larkspur", charts: [] };

describe("member org structure page", () => {
  it.each([
    ["en", true, "Organization: Larkspur Workers", "Campaign: Larkspur Main Depot"],
    ["es", false, "Organización: Larkspur Workers", "Campaña: Larkspur Main Depot"],
  ])("shows membership context before chart publication (%s)", (lang, desktop, org, chapter) => {
    render(
      <LanguageProvider lang={lang}>
        <OrgStructureView structure={emptyChart} scopeLabels={chapterContext} desktop={desktop} />
      </LanguageProvider>,
    );
    expect(screen.getByText(org)).toBeInTheDocument();
    expect(screen.getByText(chapter)).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });


  it("opens the selected position from a diagram card", () => {
    const nodes = [{ id: "tamarack-diagram", nodeKind: "role", label: "Tamarack diagram role", positionX: 0, positionY: 0 }];
    const { container } = show({ structure: { charts: [{ chartKind: "union", nodes, edges: [] }] } });
    fireEvent.click(container.querySelector(".oi-map__node"));
    const detail = screen.getByRole("complementary", { name: "Selected position" });
    expect(within(detail).getByText("Tamarack diagram role")).toBeInTheDocument();
    expect(within(detail).getByText("Role")).toBeInTheDocument();
  });

  it("recovers the chart after a failed read when the reader retries", async () => {
    const nodes = [{ id: "tamarack-recovered", nodeKind: "chapter", label: "Tamarack recovery", positionX: 0, positionY: 0 }];
    const loader = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ charts: [{ chartKind: "union", nodes, edges: [] }] });
    render(<LanguageProvider lang="en"><OrgStructureView loader={loader} /></LanguageProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("The org structure could not be loaded.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect((await screen.findAllByText("Tamarack recovery")).length).toBeGreaterThan(0);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("uses Spanish card-kind labels and the catalogue marker casing", () => {
    const kinds = ["organization", "division", "chapter", "team", "role", "person"];
    const nodes = kinds.map((nodeKind, i) => ({ id: String(i), nodeKind, label: `Tamarack ${i}`, positionX: i % 3, positionY: Math.floor(i / 3), seatStatus: "unconfirmed" }));
    const { container } = render(<LanguageProvider lang="es"><OrgStructureView structure={{ charts: [{ chartKind: "union", nodes, edges: [] }] }} /></LanguageProvider>);
    expect([...container.querySelectorAll(".oi-map__node > span:first-child")].map(node => node.textContent)).toEqual(["Organización", "División", "Campaña", "Equipo", "Puesto", "Persona"]);
    expect([...container.querySelectorAll(".oi-map__node .orgstructure-marker")].every(node => node.textContent === "Sin confirmar")).toBe(true);
    expect(screen.getByPlaceholderText("Nombre, equipo o puesto").closest("label")).toHaveClass("orgstructure__search--name");
  });

  it.each(["en", "es"])("uses one position in the %s branch control's accessible name", (lang) => {
    const nodes = [{ id: "tamarack-council", nodeKind: "organization", label: "Tamarack council", positionX: 0, positionY: 0 }, { id: "tamarack-role", parentId: "tamarack-council", nodeKind: "role", label: "Tamarack role", positionX: 1, positionY: 1 }];
    render(<LanguageProvider lang={lang}><OrgStructureView structure={{ charts: [{ chartKind: "union", nodes, edges: [] }] }} /></LanguageProvider>);
    const name = lang === "es" ? "Ocultar 1 puesto bajo Tamarack council" : "Hide 1 position under Tamarack council";
    const toggle = screen.getByRole("button", { name });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: lang === "es" ? "Mostrar 1 puesto bajo Tamarack council" : "Show 1 position under Tamarack council" })).toHaveAttribute("aria-expanded", "false");
  });
  it("opens on the union chart and renders its nodes and reporting line", () => {
    show();
    expect(screen.getByRole("heading", { name: "Org structure", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Union" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("2 positions · 1 reporting lines")).toBeInTheDocument();
    expect(screen.getAllByText("Sam Okafor").length).toBeGreaterThan(0);
  });

  it("switches to the employer chart", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Employer" }));
    expect(screen.getAllByText("Area service team").length).toBeGreaterThan(0);
    expect(screen.queryByText("Sam Okafor")).toBeNull();
  });

  it("filters by search and says so when nothing matches", () => {
    show();
    const search = screen.getByRole("searchbox", { name: "Search this chart" });
    fireEvent.change(search, { target: { value: "Sam" } });
    expect(screen.getByText("1 positions · 0 reporting lines")).toBeInTheDocument();
    // The edge went with the filtered-out node rather than pointing at nothing.
    fireEvent.change(search, { target: { value: "nobody here" } });
    expect(screen.getByText("No position matches that search.")).toBeInTheDocument();
  });

  it("opens a detail panel for a selected node and closes it again", () => {
    show();
    fireEvent.click(within(screen.getByRole("list", { name: "Union hierarchy" })).getByRole("button", { name: /Sam Okafor/ }));
    const detail = screen.getByRole("complementary", { name: "Selected position" });
    expect(within(detail).getByText("Person")).toBeInTheDocument();
    expect(within(detail).getByText("Steward")).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("complementary", { name: "Selected position" })).toBeNull();
  });

  it("opens a Search result with the matched officer selected and named in the filter", () => {
    show({ focus: { view: "orgStructure", nodeId: "u2", nonce: 1 } });
    expect(screen.getByRole("searchbox", { name: "Search this chart" })).toHaveValue("Sam Okafor");
    const detail = screen.getByRole("complementary", { name: "Selected position" });
    expect(within(detail).getByText("Steward")).toBeInTheDocument();
    // The focus applies once: the member can clear the filter afterwards.
    fireEvent.change(screen.getByRole("searchbox", { name: "Search this chart" }), { target: { value: "" } });
    expect(screen.getByRole("searchbox", { name: "Search this chart" })).toHaveValue("");
  });

  it("renders an explicit empty state for an organization with no chart", () => {
    render(
      <LanguageProvider lang="en">
        <OrgStructureView structure={{ organizationId: "org-1", chapterId: "wor", charts: [] }} />
      </LanguageProvider>,
    );
    expect(screen.getByText("Your organization has not published a structure yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Union" })).toBeNull();
  });

  it("surfaces a loader failure instead of an empty page", async () => {
    render(
      <LanguageProvider lang="en">
        <OrgStructureView loader={() => Promise.reject(new Error("denied"))} />
      </LanguageProvider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("The org structure could not be loaded.");
  });

  // BUG-UG-WEB-ORG-STRUCTURE-ALWAYS-EMPTY-20261003: the live page
  // loads through the client, not an injected loader.
  it("shows the published charts the server returns through the real client", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: STRUCTURE, error: null }) };
    render(<LanguageProvider lang="en"><OrgStructureView client={client} /></LanguageProvider>);
    expect(await screen.findByRole("button", { name: "Union" })).toBeInTheDocument();
    expect(screen.getAllByText("Sam Okafor").length).toBeGreaterThan(0);
    expect(screen.queryByText("Your organization has not published a structure yet.")).toBeNull();
    expect(client.rpc).toHaveBeenCalledWith("get_member_organization_structure");
  });

  it("shows the error state, not the empty message, when the server refuses", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "permission denied", code: "42501" } }) };
    render(<LanguageProvider lang="en"><OrgStructureView client={client} /></LanguageProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("The org structure could not be loaded.");
    expect(screen.queryByText("Your organization has not published a structure yet.")).toBeNull();
  });

  it("loads through the injected loader exactly once", async () => {
    const loader = vi.fn().mockResolvedValue(STRUCTURE);
    render(<LanguageProvider lang="en"><OrgStructureView loader={loader} /></LanguageProvider>);
    expect(await screen.findByRole("button", { name: "Union" })).toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("is read-only by construction", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../src/views/OrgStructureView.jsx"), "utf8");
    // No writer may reach this page: no mutation adapter, no form, no main
    // landmark (the shell owns that one).
    for (const forbidden of ["<form", "<main", "onSubmit", "createOrganizationChartNode", "adapter.commit", "upsert"]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    // And it must not import the staff editor, only the layout functions and
    // the open-centred-on-the-root hook (#9534).
    expect(source).toContain('import { chartAxisSpan, normalizedPositions, useChartRootCentring } from "./OrganizationIntelligenceView.jsx"');
    expect(source).not.toContain("OrganizationIntelligenceView(");
  });
});

describe("org structure navigation parity", () => {
  const read = (path) => readFileSync(resolve(import.meta.dirname, path), "utf8");

  it("carries the same key -> view pair in the desktop rail and the phone nav", () => {
    const pattern = /\{ key: "org-structure", viewKey: "orgStructure", labelKey: "nav\.orgStructure", path: "\/m\/org-structure"/;
    expect(read("../src/components/DesktopRail.jsx")).toMatch(pattern);
    expect(read("../src/lib/mobileNav.js")).toMatch(pattern);
  });

  it("keeps the view loader and the SPA rewrite in step", () => {
    expect(read("../src/App.jsx")).toContain('orgStructure: () => import("./views/OrgStructureView.jsx")');
    expect(read("../vercel.json")).toContain('{ "source": "/m/org-structure", "destination": "/index.html" }');
  });

  it("leaves the staff organization map untouched", () => {
    const app = read("../src/App.jsx");
    expect(app).toContain('organizationMap: () => import("./views/OrganizationIntelligenceView.jsx")');
    // The member page is its own view key; it must not be routed through the
    // staff snapshot's view or its actor.
    expect(app).not.toMatch(/orgStructure: <OrganizationIntelligenceView/);
  });
});

describe("importer-carried node detail", () => {
  // The import lane (API-CONTRACT.md 1.1) adds descriptive columns to
  // organization_chart_nodes. They are optional everywhere: this client also
  // runs against a database that has not applied that migration yet, so a
  // missing column renders as absent rather than as an empty row.
  const RICH = {
    organizationId: "org-1", chapterId: "wor",
    charts: [{
      chartKind: "union",
      nodes: [{
        id: "u1", parentId: null, chapterId: "wor", nodeKind: "person",
        label: "Sam Okafor", subtitle: "Steward", positionX: 0, positionY: 0, sortOrder: 1,
        badge: "Casework", chipLabel: "Area 3", reportsToLabel: "Chapter president",
        vacant: false, sourceLabel: "Imported chart", sourceAsOf: "2026-09-01",
      }],
      edges: [],
    }],
  };

  it("shows the area, unit and free-text reporting line without turning any of them into an edge", () => {
    render(<LanguageProvider lang="en"><OrgStructureView structure={RICH} /></LanguageProvider>);
    fireEvent.click(within(screen.getByRole("list", { name: "Union hierarchy" })).getByRole("button", { name: /Sam Okafor/ }));
    const detail = screen.getByRole("complementary", { name: "Selected position" });
    expect(within(detail).getByText("Casework")).toBeInTheDocument();
    expect(within(detail).getByText("Area 3")).toBeInTheDocument();
    expect(within(detail).getByText("Chapter president")).toBeInTheDocument();
    // reports_to_label is a label, not a parent: the chart still draws nothing.
    expect(screen.getByText("1 positions · 0 reporting lines")).toBeInTheDocument();
    expect(screen.getByText("Source: Imported chart · Sep 1, 2026")).toBeInTheDocument();
  });

  it("marks a vacant seat in the tree and chart before selection and shows its role class", () => {
    const vacant = {
      ...RICH,
      charts: [{ ...RICH.charts[0], nodes: [{ ...RICH.charts[0].nodes[0], label: "Area director", vacant: true, roleClass: "director" }] }],
    };
    render(<LanguageProvider lang="en"><OrgStructureView structure={vacant} /></LanguageProvider>);
    const treeButton = within(screen.getByRole("list", { name: "Union hierarchy" })).getByRole("button", { name: /Area director/ });
    expect(within(treeButton).getByText("Vacant")).toBeInTheDocument();
    // Outline, chart canvas, and the legend that explains the label.
    expect(screen.getAllByText("Vacant")).toHaveLength(3);
    fireEvent.click(treeButton);
    const detail = screen.getByRole("complementary", { name: "Selected position" });
    expect(within(detail).getByText("Vacant")).toBeInTheDocument();
    expect(within(detail).getByText("Role class")).toBeInTheDocument();
    expect(within(detail).getByText("director")).toBeInTheDocument();
    expect(screen.getByText("Source: Imported chart · Sep 1, 2026")).toBeInTheDocument();
  });

  // UX-UG-ORG-STRUCTURE-SEAT-REVIEW-DATE-RAW-20261124 (#9892): the
  // seat's review date read "2026-11-24" while the source date beside it was
  // in words. It is a calendar day: the same day in every zone.
  it.each([
    ["en", "Last reviewed", "Nov 24, 2026", "Source: Imported chart · Sep 1, 2026"],
    ["es", "Última revisión", "24 nov 2026", "Fuente: Imported chart · 1 sept 2026"],
  ])("shows the seat review date in words in %s, like the source date", (lang, label, reviewed, source) => {
    const node = { ...RICH.charts[0].nodes[0], seatStatus: "confirmed", seatStatusReviewedOn: "2026-11-24" };
    render(<LanguageProvider lang={lang}><OrgStructureView structure={{ ...RICH, charts: [{ ...RICH.charts[0], nodes: [node] }] }} /></LanguageProvider>);
    fireEvent.click(within(screen.getByRole("list")).getByRole("button", { name: /Sam Okafor/ }));
    const detail = screen.getByRole("complementary");
    const row = within(detail).getByText(label).parentElement;
    expect(within(row).getByText(reviewed)).toBeInTheDocument();
    expect(within(detail).queryByText("2026-11-24")).toBeNull();
    expect(screen.getByText(source)).toBeInTheDocument();
  });

  it("shows a stored review value that is not a calendar day as stored", () => {
    const node = { ...RICH.charts[0].nodes[0], seatStatusReviewedOn: "2026-02-30" };
    render(<LanguageProvider lang="en"><OrgStructureView structure={{ ...RICH, charts: [{ ...RICH.charts[0], nodes: [node] }] }} /></LanguageProvider>);
    fireEvent.click(within(screen.getByRole("list", { name: "Union hierarchy" })).getByRole("button", { name: /Sam Okafor/ }));
    const row = within(screen.getByRole("complementary", { name: "Selected position" })).getByText("Last reviewed").parentElement;
    expect(within(row).getByText("2026-02-30")).toBeInTheDocument();
  });

  it("searches the importer labels too", () => {
    render(<LanguageProvider lang="en"><OrgStructureView structure={RICH} /></LanguageProvider>);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search this chart" }), { target: { value: "Area 3" } });
    expect(screen.getByText("1 positions · 0 reporting lines")).toBeInTheDocument();
  });

  it("renders nothing extra when the columns are absent", () => {
    show();
    fireEvent.click(within(screen.getByRole("list", { name: "Union hierarchy" })).getByRole("button", { name: /Sam Okafor/ }));
    const detail = screen.getByRole("complementary", { name: "Selected position" });
    for (const label of ["Area", "Role class", "Unit", "Reports to", "Seat", "Last reviewed", "Source"]) {
      expect(within(detail).queryByText(label), label).toBeNull();
    }
    // REQ-UG-TENANT-ORG-CHART-BASELINE-20261030: the seat state is
    // always stated. Nothing confirmed this seat, so it says so.
    expect(within(detail).getByText("Status")).toBeInTheDocument();
    expect(within(detail).getByText("Unconfirmed")).toBeInTheDocument();
    expect(screen.queryByText(/^Source:/)).toBeNull();
  });
});

// UX-UG-ORGANIZATION-CHARTS-OPEN-ON-EMPTY-SPACE-WITH-NINE-PIXEL-TEXT-20261122
// (#9534, findings B-25 and B-45): a chart wider than its frame opened at its
// left edge, on empty space, with the root card off to the right. It opens
// centred on the root, as the staff chart has since BUG-UG-WEB-ORG-CHART-OPENS-ON-EMPTY-CANVAS-20261002.
describe("member org chart initial viewport (#9534)", () => {
  // Six people in a row under a root drawn at the far right; the root comes
  // last in the list, so it is found through the outline, not by order.
  const people = Array.from({ length: 6 }, (_, index) => ({
    id: `p${index}`, parentId: "root", nodeKind: "person", label: `Tamarack person ${index}`, positionX: index, positionY: 1, sortOrder: index + 2,
  }));
  const WIDE = { charts: [{ chartKind: "union", edges: [], nodes: [
    ...people,
    { id: "root", parentId: null, nodeKind: "organization", label: "Tamarack executive board", positionX: 5, positionY: 0, sortOrder: 1 },
  ] }] };

  it("opens a chart wider than its frame centred on its root", () => {
    const frameWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockImplementation(function clientWidth() { return this.classList.contains("oi-map-scroll") ? 400 : 0; });
    try {
      const { container } = render(<LanguageProvider lang="en"><OrgStructureView structure={WIDE} /></LanguageProvider>);
      const frame = container.querySelector(".oi-map-scroll");
      const canvasWidth = Number.parseFloat(frame.querySelector(".oi-map--chart").style.minWidth);
      expect(canvasWidth).toBeGreaterThan(400);
      const root = within(frame).getByRole("button", { name: /Tamarack executive board/ });
      const centre = (Number.parseFloat(root.style.left) / 100) * canvasWidth;
      // The whole 150px root card is inside the 400px frame.
      expect(frame.scrollLeft).toBeGreaterThan(0);
      expect(centre - 75).toBeGreaterThanOrEqual(frame.scrollLeft);
      expect(centre + 75).toBeLessThanOrEqual(frame.scrollLeft + 400);
    } finally {
      frameWidth.mockRestore();
    }
  });

  it("opens on a card when the chart has no outline root", () => {
    const frameWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockImplementation(function clientWidth() { return this.classList.contains("oi-map-scroll") ? 400 : 0; });
    try {
      const chart = WIDE.charts[0];
      const nodes = chart.nodes.map(node => node.id === "root" ? { ...node, parentId: "p0" } : node);
      const { container } = show({ structure: { charts: [{ ...chart, nodes }] } });
      const frame = container.querySelector(".oi-map-scroll");
      const canvasWidth = parseFloat(frame.querySelector(".oi-map--chart").style.minWidth);
      const card = within(frame).getByRole("button", { name: /Tamarack person 0/ });
      const center = parseFloat(card.style.left) / 100 * canvasWidth;
      expect(frame.scrollLeft).toBe(Math.round(center - 200));
    } finally {
      frameWidth.mockRestore();
    }
  });

  it("keeps the left edge when the frame is wider than the chart", () => {
    const frameWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockImplementation(function clientWidth() { return this.classList.contains("oi-map-scroll") ? 3000 : 0; });
    try {
      const { container } = render(<LanguageProvider lang="en"><OrgStructureView structure={WIDE} /></LanguageProvider>);
      expect(container.querySelector(".oi-map-scroll").scrollLeft).toBe(0);
    } finally {
      frameWidth.mockRestore();
    }
  });
});
