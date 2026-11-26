import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createOrganizationIntelligenceAdapter } from "../src/features/organizationIntelligence/adapter.js";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";
import { localeFor } from "../src/lib/i18n/format.js";
import * as organizationIntelligenceWiring from "../src/lib/organizationIntelligenceWiring.js";
import {
  ORGANIZATION_INTELLIGENCE_PREVIEW_ORGANIZATION,
  ORGANIZATION_INTELLIGENCE_PREVIEW_SNAPSHOT,
} from "./fixtures/retired-pre-bot/src/features/organizationIntelligence/preview.js";
import {
  DIGITAL_ACTION_KINDS,
  DIGITAL_ACTION_PARTICIPATION_KINDS,
  digitalActionParticipationKind,
} from "../src/features/organizationIntelligence/contract.js";
import {
  CollectiveActionsView,
  exportCollectiveActionParticipants,
} from "../src/views/CollectiveActionsView.jsx";
import {
  OrganizationIntelligenceView,
  focusButtonNames,
  foldName,
  sameNameDetails,
  LIST_PAGE_SIZE,
  MAX_CHART_AXIS_PX,
  RELATIONSHIP_MAP_CAP,
  RELATIONSHIP_RING_MAX,
  chartAxisSpan,
  chartRootScrollLeft,
  deriveOrganizationIntelligenceRequestScope,
  normalizedPositions,
  relationshipGridLayout,
  relationshipMapHeight,
  relationshipMapSample,
  ringPillWidth,
} from "../src/views/OrganizationIntelligenceView.jsx";
import { nodes as seededChartNodes } from "./fixtures/pr1815-chart-nodes.js";
import { localDateTimeInputToIso, localDateTimeInputValue } from "../src/lib/localDateTime.js";
import { formatDateTimeWithZone } from "../src/lib/i18n/zonedDates.js";

function staff(overrides = {}) {
  return {
    userId: "staff-1",
    organizationId: ORGANIZATION_INTELLIGENCE_PREVIEW_ORGANIZATION,
    selectedHat: "admin",
    organizationRoles: ["admin"],
    membershipStatus: "active",
    organizationStatus: "active",
    mfaSatisfied: true,
    ...overrides,
  };
}

async function openOrganizationView(actor = staff(), props = {}) {
  render(<OrganizationIntelligenceView actor={actor} preview {...props} />);
  await screen.findAllByText("Statewide organization");
}

describe("organization intelligence web surface", () => {
  it("renders persisted charts and edits existing and new nodes", async () => {
    await openOrganizationView();
    expect(screen.getByRole("group", { name: "Agency persisted layout" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /Human Services Agency/ })[0]);
    expect(screen.getByRole("heading", { name: "Edit" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    const form = screen.getByRole("heading", { name: "Add chart node" }).closest("form");
    fireEvent.change(within(form).getByLabelText("Chart"), { target: { value: "union" } });
    fireEvent.change(within(form).getByLabelText("Type"), { target: { value: "chapter" } });
    fireEvent.change(within(form).getByLabelText("Label"), { target: { value: "South Chapter" } });
    fireEvent.change(within(form).getByLabelText("Subtitle"), { target: { value: "New chapter" } });
    fireEvent.change(within(form).getByLabelText("Parent"), { target: { value: "union" } });
    fireEvent.change(within(form).getByLabelText("Horizontal position"), { target: { value: "42" } });
    fireEvent.change(within(form).getByLabelText("Vertical position"), { target: { value: "72" } });
    fireEvent.change(within(form).getByLabelText("Order"), { target: { value: "3" } });
    fireEvent.submit(form);
    expect((await screen.findAllByText("South Chapter")).length).toBeGreaterThan(0);
    expect(screen.getByText("Saved.")).toBeInTheDocument();
  });

  it("adds relationship and topic progress from the Neuro Map", async () => {
    await openOrganizationView();
    fireEvent.click(screen.getByRole("button", { name: "Neuro Map" }));
    expect(screen.getByRole("img", { name: /4 people connected by 3 relationships/ })).toBeInTheDocument();
    const mapRole = [...document.querySelectorAll(".oi-map__person")].find((pill) => pill.textContent.includes("Sam Okafor")).querySelector("small");
    const rosterRole = document.querySelector(".oi-person small");
    expect(mapRole).toHaveTextContent("Steward");
    expect(mapRole.parentElement).toHaveClass("oi-map__person");
    expect(rosterRole).toHaveTextContent("Steward");
    expect(rosterRole.parentElement).toHaveClass("oi-person");

    const relationship = screen.getByRole("heading", { name: "Add relationship" }).closest("form");
    fireEvent.change(within(relationship).getByLabelText("From"), { target: { value: "maya" } });
    fireEvent.change(within(relationship).getByLabelText("To"), { target: { value: "nora" } });
    fireEvent.change(within(relationship).getByLabelText("Type"), { target: { value: "trusted_contact" } });
    fireEvent.change(within(relationship).getByLabelText("Strength"), { target: { value: "5" } });
    fireEvent.submit(relationship);
    await waitFor(() => expect(screen.getByText(/4 relationships/)).toBeInTheDocument());

    const topic = screen.getByRole("heading", { name: "Add topic progress" }).closest("form");
    fireEvent.change(within(topic).getByLabelText("Worker"), { target: { value: "maya" } });
    fireEvent.change(within(topic).getByLabelText("Topic key"), { target: { value: "contract" } });
    fireEvent.change(within(topic).getByLabelText("Topic"), { target: { value: "Contract leadership" } });
    fireEvent.change(within(topic).getByLabelText("State"), { target: { value: "ready" } });
    fireEvent.change(within(topic).getByLabelText("Progress"), { target: { value: "90" } });
    fireEvent.submit(topic);
    expect(await screen.findByText(/Contract leadership · Ready/)).toBeInTheDocument();
  });

  it("adds a sourced payroll timeline event and renders Spanish read-only copy", async () => {
    await openOrganizationView();
    fireEvent.click(screen.getByRole("button", { name: "Leadership & payroll" }));
    expect(screen.getByText(/Annual aggregate/)).toBeInTheDocument();
    expect(document.querySelector(".oi-timeline .oi-badge")).toHaveClass("oi-badge");
    expect(document.querySelector(".oi-timeline small")).toHaveTextContent(/Organization-provided payroll file/);
    const form = screen.getByRole("heading", { name: "Add timeline event" }).closest("form");
    fireEvent.change(within(form).getByLabelText("Type"), { target: { value: "payroll_snapshot" } });
    fireEvent.change(within(form).getByLabelText("Label"), { target: { value: "Quarterly payroll" } });
    fireEvent.change(within(form).getByLabelText("Detail"), { target: { value: "Aggregate only" } });
    fireEvent.change(within(form).getByLabelText("Effective date"), { target: { value: "2026-08-01" } });
    fireEvent.change(within(form).getByLabelText("End date"), { target: { value: "2026-08-31" } });
    fireEvent.change(within(form).getByLabelText("Amount"), { target: { value: "1234.56" } });
    fireEvent.change(within(form).getByLabelText("Amount basis"), { target: { value: "Quarterly aggregate" } });
    fireEvent.change(within(form).getByLabelText("Source"), { target: { value: "Payroll file" } });
    fireEvent.change(within(form).getByLabelText("Source as of"), { target: { value: "2026-08-01" } });
    fireEvent.submit(form);
    expect(await screen.findByText("Quarterly payroll")).toBeInTheDocument();

    cleanup();
    render(<OrganizationIntelligenceView actor={staff({ selectedHat: "steward", organizationRoles: ["steward"], mfaSatisfied: false })} preview lang="es" />);
    await screen.findByText("Inteligencia organizacional");
    expect(await screen.findByText(/Se requiere acceso de asesoría/)).toBeInTheDocument();
  });

  it("defaults the timeline effective date to the local calendar day and recomputes it after save", async () => {
    // Assigning process.env.TZ does not move the local clock in a
    // --pool=threads worker (the CI pool), so the device zone is supplied by a
    // Date whose local getters read America/New_York (product-hub pattern).
    const RealDate = Date;
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric" });
    const part = (date, type) => Number(parts.formatToParts(date).find((entry) => entry.type === type).value);
    let now = "2026-03-10T03:30:00Z"; // 23:30 EDT on 2026-03-09
    class EasternDate extends RealDate {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return new RealDate(now).getTime(); }
      getFullYear() { return part(this, "year"); }
      getMonth() { return part(this, "month") - 1; }
      getDate() { return part(this, "day"); }
    }
    vi.stubGlobal("Date", EasternDate);
    try {
      await openOrganizationView();
      fireEvent.click(screen.getByRole("button", { name: "Leadership & payroll" }));
      const form = screen.getByRole("heading", { name: "Add timeline event" }).closest("form");
      expect(within(form).getByLabelText("Effective date")).toHaveValue("2026-03-09");

      fireEvent.change(within(form).getByLabelText("Label"), { target: { value: "Evening term" } });
      fireEvent.submit(form);
      expect(await screen.findByText("Evening term")).toBeInTheDocument();
      expect(within(form).getByLabelText("Effective date")).toHaveValue("2026-03-09");

      now = "2026-03-10T08:00:00Z"; // 04:00 EDT on 2026-03-10
      fireEvent.change(within(form).getByLabelText("Label"), { target: { value: "Morning term" } });
      fireEvent.submit(form);
      expect(await screen.findByText("Morning term")).toBeInTheDocument();
      expect(within(form).getByLabelText("Effective date")).toHaveValue("2026-03-10");
    } finally {
      vi.unstubAllGlobals();
      cleanup();
    }
  });

  it("formats payroll amounts with the selected language locale", async () => {
    const amount = 184500;
    const english = new Intl.NumberFormat(localeFor("en"), { style: "currency", currency: "USD" }).format(amount);
    const spanish = new Intl.NumberFormat(localeFor("es"), { style: "currency", currency: "USD" }).format(amount);
    expect(spanish).not.toBe(english);
    const visibleMoney = (root = document) => (root.querySelector(".oi-money")?.textContent || "").replace(/\u00a0/g, " ");
    const visibleAmount = (value) => value.replace(/\u00a0/g, " ");

    await openOrganizationView();
    fireEvent.click(screen.getByRole("button", { name: "Leadership & payroll" }));
    expect(visibleMoney()).toContain(visibleAmount(english));

    cleanup();
    render(<OrganizationIntelligenceView actor={staff()} preview lang="es" />);
    fireEvent.click(await screen.findByRole("button", { name: "Liderazgo y nómina" }));
    expect(visibleMoney()).toContain(visibleAmount(spanish));
    expect(visibleMoney()).not.toContain(visibleAmount(english));
  });

  it("caps chart canvas expansion when valid coordinates leave a tiny normalized gap", async () => {
    const nodes = [
      { id: "west", positionX: -10000, positionY: -10000 },
      { id: "east", positionX: 10000, positionY: 10000 },
      { id: "near-west", positionX: -9999, positionY: -9999 },
    ];
    const positions = normalizedPositions(nodes);
    const xValues = [...new Set([...positions.values()].map((point) => point.x))].sort((a, b) => a - b);
    const uncapped = Math.ceil(180 * 100 / (xValues[1] - xValues[0]));
    expect(uncapped).toBeGreaterThan(1_000_000);
    expect(chartAxisSpan(positions, "x", 180, 480)).toBe(MAX_CHART_AXIS_PX);
    expect(chartAxisSpan(positions, "y", 150, 280)).toBe(MAX_CHART_AXIS_PX);
    expect(MAX_CHART_AXIS_PX).toBeLessThan(uncapped);

    await openOrganizationView();
    for (const chart of document.querySelectorAll(".oi-map--chart")) {
      expect(Number.parseFloat(chart.style.minWidth)).toBeLessThanOrEqual(MAX_CHART_AXIS_PX);
      expect(Number.parseFloat(chart.style.minHeight)).toBeLessThanOrEqual(MAX_CHART_AXIS_PX);
    }
  });

  it("shows empty and unauthorized fail-closed states with retry controls", async () => {
    render(<OrganizationIntelligenceView actor={staff({ organizationId: null })} preview />);
    expect(await screen.findByText("No organization is selected yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No organization is selected yet.")).toBeInTheDocument();

    cleanup();
    render(<OrganizationIntelligenceView actor={staff({ selectedHat: "member", organizationRoles: [] })} preview />);
    expect(await screen.findByText("Select an authorized staff role to open this workspace.")).toBeInTheDocument();
  });
});

function intelligenceSnapshot(organizationId, label) {
  return {
    organizationId,
    generatedAt: "2026-09-21T16:00:00Z",
    chartNodes: [
      {
        id: `${organizationId}-root`,
        chartKind: "union",
        nodeKind: "organization",
        label,
        positionX: 50,
        positionY: 8,
        sortOrder: 0,
      },
    ],
    relationshipNodes: [],
    relationships: [],
    topicProgress: [],
    timeline: [],
  };
}

async function findChartLabel(label) {
  expect((await screen.findAllByText(label)).length).toBeGreaterThan(0);
}

function expectChartLabel(label) {
  expect(screen.getAllByText(label).length).toBeGreaterThan(0);
}

function expectNoChartLabel(label) {
  expect(screen.queryAllByText(label)).toHaveLength(0);
}

function createDeferredFetchQueue() {
  const byOrg = new Map();
  const fetchIntelligence = vi.fn((actor) => {
    const organizationId = actor.organizationId;
    if (!byOrg.has(organizationId)) byOrg.set(organizationId, []);
    let resolve;
    const promise = new Promise((next) => { resolve = next; });
    byOrg.get(organizationId).push({ resolve, settled: false });
    return promise;
  });
  function settle(organizationId, snapshot) {
    let count = 0;
    for (const item of byOrg.get(organizationId) || []) {
      if (item.settled) continue;
      item.settled = true;
      item.resolve(snapshot);
      count += 1;
    }
    return count;
  }
  function openCount(organizationId) {
    return (byOrg.get(organizationId) || []).filter((item) => !item.settled).length;
  }
  return { fetchIntelligence, settle, openCount };
}

describe("organization intelligence snapshot sequencing", () => {
  it("derives one stable request key from normalized actors and adapter generation", () => {
    const adapter = {};
    const implicitDefaults = {
      userId: "staff-defaults",
      organizationId: "org-defaults",
      organizationRoles: ["admin"],
      membershipStatus: undefined,
      selectedHat: undefined,
      mfaSatisfied: false,
    };
    const explicitDefaults = {
      ...implicitDefaults,
      membershipStatus: "active",
      selectedHat: "member",
    };
    const initial = deriveOrganizationIntelligenceRequestScope({
      actor: implicitDefaults,
      scopedActor: explicitDefaults,
      adapter,
      client: null,
      preview: false,
    });
    const hydrated = deriveOrganizationIntelligenceRequestScope({
      actor: explicitDefaults,
      scopedActor: explicitDefaults,
      adapter,
      client: null,
      preview: false,
    }, initial);

    expect(hydrated.key).toBe(initial.key);
    expect(hydrated.adapterGeneration).toBe(0);
    expect(hydrated.actor).toMatchObject({ membershipStatus: "active", selectedHat: "member" });

    const adminActor = staff({ organizationId: "org-transition" });
    const memberActor = staff({
      organizationId: "org-transition",
      selectedHat: "member",
      organizationRoles: [],
      mfaSatisfied: false,
    });
    const adminScope = deriveOrganizationIntelligenceRequestScope({
      actor: adminActor,
      scopedActor: adminActor,
      adapter,
      client: null,
      preview: false,
    }, hydrated);
    const changingScope = deriveOrganizationIntelligenceRequestScope({
      actor: memberActor,
      scopedActor: adminActor,
      adapter,
      client: null,
      preview: false,
    }, adminScope);
    const repeatedRender = deriveOrganizationIntelligenceRequestScope({
      actor: memberActor,
      scopedActor: adminActor,
      adapter,
      client: null,
      preview: false,
    }, changingScope);
    const hydratedScope = deriveOrganizationIntelligenceRequestScope({
      actor: memberActor,
      scopedActor: { ...memberActor },
      adapter,
      client: null,
      preview: false,
    }, repeatedRender);

    expect(changingScope.waitingForScopedActor).toBe(true);
    expect(changingScope.actor.selectedHat).toBe("member");
    expect(repeatedRender.key).toBe(changingScope.key);
    expect(hydratedScope.waitingForScopedActor).toBe(false);
    expect(hydratedScope.key).toBe(changingScope.key);

    const replacedAdapter = deriveOrganizationIntelligenceRequestScope({
      actor: explicitDefaults,
      scopedActor: explicitDefaults,
      adapter: {},
      client: null,
      preview: false,
    }, hydratedScope);
    expect(replacedAdapter.adapterGeneration).toBe(1);
    expect(replacedAdapter.key).not.toBe(hydrated.key);
  });

  it("keeps a loaded model when implicit actor defaults hydrate to explicit equivalents", async () => {
    const fetchIntelligence = vi.fn(async () => intelligenceSnapshot("org-defaults", "Defaults union chart"));
    const adapter = createOrganizationIntelligenceAdapter({ fetchIntelligence });
    const implicitDefaults = staff({ organizationId: "org-defaults", membershipStatus: undefined });
    const explicitDefaults = staff({ organizationId: "org-defaults", membershipStatus: "active" });
    const { rerender } = render(<OrganizationIntelligenceView actor={implicitDefaults} adapter={adapter} />);
    await findChartLabel("Defaults union chart");

    rerender(<OrganizationIntelligenceView actor={explicitDefaults} adapter={adapter} />);

    expectChartLabel("Defaults union chart");
    expect(screen.queryByText("Loading organization intelligence…")).not.toBeInTheDocument();
    expect(fetchIntelligence).toHaveBeenCalledTimes(1);
  });

  it("drops a superseded snapshot and clears prior-scope content until the new scope resolves", async () => {
    const { fetchIntelligence, settle, openCount } = createDeferredFetchQueue();
    const adapter = createOrganizationIntelligenceAdapter({
      fetchIntelligence,
      saveChartNode: vi.fn(async () => {}),
    });
    const actorA = staff({ organizationId: "org-alpha", userId: "staff-alpha" });
    const actorB = staff({
      organizationId: "org-bravo",
      userId: "staff-bravo",
      selectedHat: "advisor",
      organizationRoles: ["advisor"],
    });
    const { rerender } = render(<OrganizationIntelligenceView actor={actorA} adapter={adapter} />);
    await waitFor(() => expect(openCount("org-alpha")).toBeGreaterThan(0));
    await act(async () => { settle("org-alpha", intelligenceSnapshot("org-alpha", "Alpha union chart")); });
    await findChartLabel("Alpha union chart");
    expect(screen.getByRole("heading", { name: "Add chart node" })).toBeInTheDocument();

    const form = screen.getByRole("heading", { name: "Add chart node" }).closest("form");
    fireEvent.change(within(form).getByLabelText("Label"), { target: { value: "Pending alpha node" } });
    fireEvent.submit(form);
    await waitFor(() => expect(openCount("org-alpha")).toBeGreaterThan(0));
    expectChartLabel("Alpha union chart");
    expect(screen.getByRole("heading", { name: "Add chart node" })).toBeInTheDocument();

    rerender(<OrganizationIntelligenceView actor={actorB} adapter={adapter} />);
    expectNoChartLabel("Alpha union chart");
    expect(screen.queryByRole("heading", { name: "Add chart node" })).not.toBeInTheDocument();
    expect(screen.getByText("Loading organization intelligence…")).toBeInTheDocument();

    await waitFor(() => expect(openCount("org-bravo")).toBeGreaterThan(0));
    await act(async () => { settle("org-alpha", intelligenceSnapshot("org-alpha", "Late alpha union chart")); });
    expectNoChartLabel("Alpha union chart");
    expectNoChartLabel("Late alpha union chart");
    expect(screen.queryByRole("heading", { name: "Add chart node" })).not.toBeInTheDocument();
    expect(screen.getByText("Loading organization intelligence…")).toBeInTheDocument();

    await act(async () => { settle("org-bravo", intelligenceSnapshot("org-bravo", "Bravo union chart")); });
    await findChartLabel("Bravo union chart");
    expectNoChartLabel("Alpha union chart");
    expectNoChartLabel("Late alpha union chart");
    expect(screen.getByRole("heading", { name: "Add chart node" })).toBeInTheDocument();
  });

  it("keeps the ready model mounted while a same-scope refresh is pending", async () => {
    const { fetchIntelligence, settle, openCount } = createDeferredFetchQueue();
    const adapter = createOrganizationIntelligenceAdapter({
      fetchIntelligence,
      saveChartNode: vi.fn(async () => {}),
    });
    render(<OrganizationIntelligenceView actor={staff({ organizationId: "org-keep" })} adapter={adapter} />);
    await waitFor(() => expect(openCount("org-keep")).toBeGreaterThan(0));
    await act(async () => { settle("org-keep", intelligenceSnapshot("org-keep", "Keep union chart")); });
    await findChartLabel("Keep union chart");
    const form = screen.getByRole("heading", { name: "Add chart node" }).closest("form");
    fireEvent.change(within(form).getByLabelText("Label"), { target: { value: "Refresh node" } });
    fireEvent.submit(form);
    await waitFor(() => expect(openCount("org-keep")).toBeGreaterThan(0));
    expectChartLabel("Keep union chart");
    expect(screen.getByRole("heading", { name: "Add chart node" })).toBeInTheDocument();
    expect(screen.getByText("Loading organization intelligence…")).toBeInTheDocument();
    await act(async () => { settle("org-keep", intelligenceSnapshot("org-keep", "Keep union chart refreshed")); });
    await findChartLabel("Keep union chart refreshed");
    expect(screen.getByRole("heading", { name: "Add chart node" })).toBeInTheDocument();
  });

  // The chart editor's Save keeps focus while the node is saved,
  // and a second submit in the same tick saves nothing more.
  const openChartForm = async (saveChartNode) => {
    const { fetchIntelligence, settle } = createDeferredFetchQueue();
    const adapter = createOrganizationIntelligenceAdapter({ fetchIntelligence, saveChartNode });
    render(<OrganizationIntelligenceView actor={staff({ organizationId: "org-shared", userId: "staff-shared" })} adapter={adapter} />);
    await waitFor(() => expect(fetchIntelligence).toHaveBeenCalledTimes(1));
    await act(async () => { settle("org-shared", intelligenceSnapshot("org-shared", "Admin union chart")); });
    await findChartLabel("Admin union chart");
    const form = screen.getByRole("heading", { name: "Add chart node" }).closest("form");
    fireEvent.change(within(form).getByLabelText("Label"), { target: { value: "New node" } });
    return within(form).getByRole("button", { name: "Save" });
  };

  it("keeps the chart editor's Save focused while the node is saved, and saves once", async () => {
    const saveChartNode = vi.fn(async () => ({}));
    await expectHeldWriteFocus(saveChartNode, await openChartForm(saveChartNode));
    expect(saveChartNode).toHaveBeenCalledTimes(1);
  });

  it("saves one chart node when Save is activated twice in one tick", async () => {
    const saveChartNode = vi.fn(async () => ({}));
    const save = await openChartForm(saveChartNode);
    await expectOneWriteFromOneTick(saveChartNode, [() => fireEvent.click(save), () => fireEvent.click(save)]);
  });

  // #8973 delta (record 8435): the chart lock is keyed by the request scope, as
  // its busy state is. A save held for one organization does not refuse the
  // next organization's ready Save.
  it("saves a chart node for the newly selected organization while the prior organization's save is held", async () => {
    const { fetchIntelligence, settle } = createDeferredFetchQueue();
    let releaseFirst;
    const saveChartNode = vi.fn()
      .mockImplementationOnce(() => new Promise((next) => { releaseFirst = next; }))
      .mockResolvedValue({});
    const adapter = createOrganizationIntelligenceAdapter({ fetchIntelligence, saveChartNode });
    const actorA = staff({ organizationId: "org-alpha", userId: "staff-alpha" });
    const actorB = staff({ organizationId: "org-bravo", userId: "staff-bravo" });
    const { rerender } = render(<OrganizationIntelligenceView actor={actorA} adapter={adapter} />);
    await waitFor(() => expect(fetchIntelligence).toHaveBeenCalledTimes(1));
    await act(async () => { settle("org-alpha", intelligenceSnapshot("org-alpha", "Alpha union chart")); });
    await findChartLabel("Alpha union chart");
    const alphaForm = screen.getByRole("heading", { name: "Add chart node" }).closest("form");
    fireEvent.change(within(alphaForm).getByLabelText("Label"), { target: { value: "Held alpha node" } });
    fireEvent.click(within(alphaForm).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveChartNode).toHaveBeenCalledTimes(1));
    rerender(<OrganizationIntelligenceView actor={actorB} adapter={adapter} />);
    await act(async () => { settle("org-bravo", intelligenceSnapshot("org-bravo", "Bravo union chart")); });
    await findChartLabel("Bravo union chart");
    const bravoForm = screen.getByRole("heading", { name: "Add chart node" }).closest("form");
    fireEvent.change(within(bravoForm).getByLabelText("Label"), { target: { value: "Ready bravo node" } });
    const ready = within(bravoForm).getByRole("button", { name: "Save" });
    expect(ready).not.toHaveAttribute("aria-disabled", "true");
    try {
      await act(async () => { fireEvent.click(ready); });
      expect(saveChartNode).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => { releaseFirst?.({}); });
    }
  });

  // #8973 delta 2 (record 8435): each scope activation has its own chart lock,
  // so returning to an organization is a new activation, not the held one.
  const switchChart = async (rerender, adapter, settle, actor, label) => {
    rerender(<OrganizationIntelligenceView actor={actor} adapter={adapter} />);
    await act(async () => { settle(actor.organizationId, intelligenceSnapshot(actor.organizationId, label)); });
    await findChartLabel(label);
    return screen.getByRole("heading", { name: "Add chart node" }).closest("form");
  };

  it("saves a ready chart node after A to B and back to A while A's first save is held", async () => {
    const { fetchIntelligence, settle } = createDeferredFetchQueue();
    let releaseFirst;
    const saveChartNode = vi.fn()
      .mockImplementationOnce(() => new Promise((next) => { releaseFirst = next; }))
      .mockResolvedValue({});
    const adapter = createOrganizationIntelligenceAdapter({ fetchIntelligence, saveChartNode });
    const actorA = staff({ organizationId: "org-alpha", userId: "staff-alpha" });
    const actorB = staff({ organizationId: "org-bravo", userId: "staff-bravo" });
    const { rerender } = render(<OrganizationIntelligenceView actor={actorA} adapter={adapter} />);
    await act(async () => { settle("org-alpha", intelligenceSnapshot("org-alpha", "Alpha union chart")); });
    await findChartLabel("Alpha union chart");
    const first = screen.getByRole("heading", { name: "Add chart node" }).closest("form");
    fireEvent.change(within(first).getByLabelText("Label"), { target: { value: "Held alpha node" } });
    fireEvent.click(within(first).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveChartNode).toHaveBeenCalledTimes(1));
    await switchChart(rerender, adapter, settle, actorB, "Bravo union chart");
    const back = await switchChart(rerender, adapter, settle, actorA, "Alpha union chart again");
    fireEvent.change(within(back).getByLabelText("Label"), { target: { value: "Ready alpha node" } });
    const ready = within(back).getByRole("button", { name: "Save" });
    expect(ready).not.toHaveAttribute("aria-disabled", "true");
    try {
      await act(async () => { fireEvent.click(ready); });
      expect(saveChartNode).toHaveBeenCalledTimes(2);
      expect(saveChartNode).toHaveBeenLastCalledWith(expect.objectContaining({ label: "Ready alpha node" }));
    } finally {
      await act(async () => { releaseFirst?.({}); });
    }
  });

  it("lets a late answer from A's earlier activation leave the returned A's pending save alone", async () => {
    const { fetchIntelligence, settle } = createDeferredFetchQueue();
    const releases = [];
    const saveChartNode = vi.fn(() => new Promise((next) => { releases.push(next); }));
    const adapter = createOrganizationIntelligenceAdapter({ fetchIntelligence, saveChartNode });
    const actorA = staff({ organizationId: "org-alpha", userId: "staff-alpha" });
    const actorB = staff({ organizationId: "org-bravo", userId: "staff-bravo" });
    const { rerender } = render(<OrganizationIntelligenceView actor={actorA} adapter={adapter} />);
    await act(async () => { settle("org-alpha", intelligenceSnapshot("org-alpha", "Alpha union chart")); });
    await findChartLabel("Alpha union chart");
    const first = screen.getByRole("heading", { name: "Add chart node" }).closest("form");
    fireEvent.change(within(first).getByLabelText("Label"), { target: { value: "Held alpha node" } });
    fireEvent.click(within(first).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveChartNode).toHaveBeenCalledTimes(1));
    await switchChart(rerender, adapter, settle, actorB, "Bravo union chart");
    const back = await switchChart(rerender, adapter, settle, actorA, "Alpha union chart again");
    fireEvent.change(within(back).getByLabelText("Label"), { target: { value: "Second alpha node" } });
    await act(async () => { fireEvent.click(within(back).getByRole("button", { name: "Save" })); });
    expect(saveChartNode).toHaveBeenCalledTimes(2);
    const loadsBefore = fetchIntelligence.mock.calls.length;
    try {
      await act(async () => { releases[0]({}); });
      const save = screen.getByRole("heading", { name: "Add chart node" }).closest("form").querySelector('button[type="submit"]');
      expect(save).toHaveTextContent("Saving");
      expect(save).toHaveAttribute("aria-disabled", "true");
      expect(fetchIntelligence).toHaveBeenCalledTimes(loadsBefore);
      expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
    } finally {
      await act(async () => { releases[1]?.({}); });
    }
  });

  it("does not let a prior-scope save reload steal the current request token", async () => {
    const { fetchIntelligence, settle, openCount } = createDeferredFetchQueue();
    let resolveSave;
    const saveChartNode = vi.fn(() => new Promise((next) => { resolveSave = next; }));
    const adapter = createOrganizationIntelligenceAdapter({ fetchIntelligence, saveChartNode });
    const actorAdmin = staff({ organizationId: "org-shared", userId: "staff-shared" });
    const actorMember = staff({
      organizationId: "org-shared",
      userId: "staff-shared",
      selectedHat: "member",
      organizationRoles: [],
      mfaSatisfied: false,
    });
    const { rerender } = render(<OrganizationIntelligenceView actor={actorAdmin} adapter={adapter} />);
    await waitFor(() => expect(fetchIntelligence).toHaveBeenCalledTimes(1));
    expect(openCount("org-shared")).toBe(1);
    await act(async () => { settle("org-shared", intelligenceSnapshot("org-shared", "Admin union chart")); });
    await findChartLabel("Admin union chart");
    expect(screen.getByRole("heading", { name: "Add chart node" })).toBeInTheDocument();

    const form = screen.getByRole("heading", { name: "Add chart node" }).closest("form");
    fireEvent.change(within(form).getByLabelText("Label"), { target: { value: "Pending admin node" } });
    fireEvent.submit(form);
    await waitFor(() => expect(saveChartNode).toHaveBeenCalled());

    rerender(<OrganizationIntelligenceView actor={actorMember} adapter={adapter} />);
    expectNoChartLabel("Admin union chart");
    expect(screen.queryByRole("heading", { name: "Add chart node" })).not.toBeInTheDocument();
    await waitFor(() => expect(fetchIntelligence).toHaveBeenCalledTimes(2));
    expect(openCount("org-shared")).toBe(1);

    await act(async () => { resolveSave(); });
    expect(fetchIntelligence).toHaveBeenCalledTimes(2);
    expectNoChartLabel("Admin union chart");
    expect(screen.queryByRole("heading", { name: "Add chart node" })).not.toBeInTheDocument();

    await act(async () => { settle("org-shared", intelligenceSnapshot("org-shared", "Late admin union chart")); });
    expectNoChartLabel("Admin union chart");
    expectNoChartLabel("Late admin union chart");
    expect(screen.queryByRole("heading", { name: "Add chart node" })).not.toBeInTheDocument();
    expect(await screen.findByText("Select an authorized staff role to open this workspace.")).toBeInTheDocument();
  });

  it("does not reload through a replaced adapter after its pending save resolves", async () => {
    let resolveSave;
    const oldFetchIntelligence = vi.fn()
      .mockResolvedValueOnce(intelligenceSnapshot("org-adapter", "Original adapter chart"))
      .mockResolvedValueOnce(intelligenceSnapshot("org-adapter", "Stale adapter chart"));
    const oldSaveChartNode = vi.fn(() => new Promise((next) => { resolveSave = next; }));
    const oldAdapter = createOrganizationIntelligenceAdapter({
      fetchIntelligence: oldFetchIntelligence,
      saveChartNode: oldSaveChartNode,
    });
    const currentFetchIntelligence = vi.fn(async () => intelligenceSnapshot("org-adapter", "Current adapter chart"));
    const currentAdapter = createOrganizationIntelligenceAdapter({ fetchIntelligence: currentFetchIntelligence });
    const actor = staff({ organizationId: "org-adapter" });
    const { rerender } = render(<OrganizationIntelligenceView actor={actor} adapter={oldAdapter} />);
    await findChartLabel("Original adapter chart");

    const form = screen.getByRole("heading", { name: "Add chart node" }).closest("form");
    fireEvent.change(within(form).getByLabelText("Label"), { target: { value: "Pending adapter node" } });
    fireEvent.submit(form);
    await waitFor(() => expect(oldSaveChartNode).toHaveBeenCalledTimes(1));

    rerender(<OrganizationIntelligenceView actor={actor} adapter={currentAdapter} />);
    await findChartLabel("Current adapter chart");
    expect(currentFetchIntelligence).toHaveBeenCalledTimes(1);

    await act(async () => { resolveSave(); });
    await waitFor(() => expect(oldFetchIntelligence).toHaveBeenCalledTimes(1));
    expectChartLabel("Current adapter chart");
    expectNoChartLabel("Original adapter chart");
    expectNoChartLabel("Stale adapter chart");
  });

  it("hides the ready model as soon as authorization is revoked in the same organization", async () => {
    const { fetchIntelligence, settle, openCount } = createDeferredFetchQueue();
    const adapter = createOrganizationIntelligenceAdapter({ fetchIntelligence });
    const writer = staff({ organizationId: "org-auth" });
    const revoked = staff({
      organizationId: "org-auth",
      selectedHat: "admin",
      organizationRoles: ["admin"],
      mfaSatisfied: false,
    });
    const { rerender } = render(<OrganizationIntelligenceView actor={writer} adapter={adapter} />);
    await waitFor(() => expect(openCount("org-auth")).toBeGreaterThan(0));
    await act(async () => { settle("org-auth", intelligenceSnapshot("org-auth", "Auth union chart")); });
    await findChartLabel("Auth union chart");
    expect(screen.getByRole("heading", { name: "Add chart node" })).toBeInTheDocument();

    rerender(<OrganizationIntelligenceView actor={revoked} adapter={adapter} />);
    expectNoChartLabel("Auth union chart");
    expect(screen.queryByRole("heading", { name: "Add chart node" })).not.toBeInTheDocument();
    expect(screen.getByText("Loading organization intelligence…")).toBeInTheDocument();

    await waitFor(() => expect(openCount("org-auth")).toBeGreaterThan(0));
    await act(async () => { settle("org-auth", intelligenceSnapshot("org-auth", "Revoked union chart")); });
    await findChartLabel("Revoked union chart");
    expect(screen.queryByRole("heading", { name: "Add chart node" })).not.toBeInTheDocument();
    expect(screen.getByText("Advisor, admin, or president access with two-step sign-in is required to edit.")).toBeInTheDocument();
  });
});

describe("collective actions web surface", () => {
  it("round-trips local schedule fields through explicit UTC instants", () => {
    const localValue = "2026-08-28T09:30";
    expect(localDateTimeInputValue(localDateTimeInputToIso(localValue))).toBe(localValue);
  });

  it("fails closed when an export payload cannot be downloaded", async () => {
    const adapter = { exportParticipants: vi.fn(async () => ({ actionId: "action-1", participationKind: "signature" })) };
    await expect(exportCollectiveActionParticipants(adapter, staff(), "action-1", "signature"))
      .rejects.toThrow("export unavailable");
  });

  it("lets a member join and withdraw from a published action", async () => {
    render(<CollectiveActionsView actor={staff({ selectedHat: "member", organizationRoles: [] })} preview />);
    const title = await screen.findByRole("heading", { name: "Safe staffing commitment" });
    const card = title.closest("article");
    expect(screen.queryByText("Worksite captains meeting")).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Join action" }));
    expect(await within(card).findByText(/You joined this action/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(within(card).queryByText(/You joined this action/)).not.toBeInTheDocument());
  });

  it("joins each published action under the participation kind its own kind records", async () => {
    expect(digitalActionParticipationKind("petition")).toBe("signature");
    expect(digitalActionParticipationKind("meeting")).toBe("attendee");
    expect(digitalActionParticipationKind("other")).toBe("volunteer");
    expect(digitalActionParticipationKind("unrecognized")).toBe("volunteer");

    render(<CollectiveActionsView actor={staff({ selectedHat: "member", organizationRoles: [] })} preview />);
    const petition = (await screen.findByRole("heading", { name: "Safe staffing commitment" })).closest("article");
    fireEvent.click(within(petition).getByRole("button", { name: "Join action" }));
    expect(await within(petition).findByText(/You joined this action\.\s*·\s*Signature/)).toBeInTheDocument();

    const rally = screen.getByRole("heading", { name: "Budget hearing turnout" }).closest("article");
    fireEvent.click(within(rally).getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(within(rally).queryByText(/You joined this action/)).not.toBeInTheDocument());
    fireEvent.click(within(rally).getByRole("button", { name: "Join action" }));
    expect(await within(rally).findByText(/You joined this action\.\s*·\s*Attendee/)).toBeInTheDocument();
  });

  // UX-UG-COLLECTIVE-ACTION-JOIN-OFFERED-OUTSIDE-PARTICIPATION-WINDOW-20260921:
  // toggle_digital_action_participation refuses with 55000 outside
  // [starts_at, ends_at], so the card must not offer that tap.
  async function publishAction(form, { title, starts = "", ends = "" }) {
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: title } });
    fireEvent.change(within(form).getByLabelText("Summary"), { target: { value: "Window test" } });
    fireEvent.change(within(form).getByLabelText("Status"), { target: { value: "published" } });
    fireEvent.change(within(form).getByLabelText("Starts"), { target: { value: starts } });
    fireEvent.change(within(form).getByLabelText("Ends"), { target: { value: ends } });
    fireEvent.submit(form);
    return (await screen.findByRole("heading", { name: title })).closest("article");
  }

  it("withholds Join outside the participation window and says when it opens or that it closed", async () => {
    render(<CollectiveActionsView actor={staff()} preview />);
    await screen.findByRole("heading", { name: "Safe staffing commitment" });
    const form = screen.getByRole("heading", { name: "Create action" }).closest("form");

    const upcoming = await publishAction(form, { title: "Future rally", starts: "2099-01-01T10:00" });
    expect(within(upcoming).queryByRole("button", { name: "Join action" })).not.toBeInTheDocument();
    expect(within(upcoming).getByText(`Opens ${formatDateTimeWithZone(localDateTimeInputToIso("2099-01-01T10:00"), "en")}`)).toBeInTheDocument();
    expect(within(upcoming).getByText("Published")).toBeInTheDocument();

    const ended = await publishAction(form, { title: "Past petition", starts: "2020-01-01T10:00", ends: "2020-01-02T10:00" });
    expect(within(ended).queryByRole("button", { name: "Join action" })).not.toBeInTheDocument();
    expect(within(ended).getByText("Participation closed")).toBeInTheDocument();

    const current = await publishAction(form, { title: "Open picket", starts: "2020-01-01T10:00", ends: "2099-01-01T10:00" });
    expect(within(current).getByRole("button", { name: "Join action" })).toBeEnabled();
  });

  it("names the opening date in Spanish", async () => {
    render(<CollectiveActionsView actor={staff()} preview lang="es" />);
    await screen.findByRole("heading", { name: "Safe staffing commitment" });
    const form = screen.getByRole("heading", { name: "Crear acción" }).closest("form");
    fireEvent.change(within(form).getByLabelText("Título"), { target: { value: "Mitin futuro" } });
    fireEvent.change(within(form).getByLabelText("Resumen"), { target: { value: "Prueba de ventana" } });
    fireEvent.change(within(form).getByLabelText("Estado"), { target: { value: "published" } });
    fireEvent.change(within(form).getByLabelText("Comienza"), { target: { value: "2099-01-01T10:00" } });
    fireEvent.submit(form);
    const card = (await screen.findByRole("heading", { name: "Mitin futuro" })).closest("article");
    expect(within(card).queryByRole("button", { name: "Unirse" })).not.toBeInTheDocument();
    // Spanish Intl output carries no-break spaces ("10:00 a. m."), which the
    // text matcher's whitespace normalizer would fold, so compare textContent.
    expect(card.querySelector(".oi-muted").textContent).toBe(`Abre el ${formatDateTimeWithZone(localDateTimeInputToIso("2099-01-01T10:00"), "es")}`);
  });

  it("answers a server window refusal with window copy, not the generic save failure", async () => {
    const client = {
      rpc: vi.fn(async (name) => {
        if (name === "get_collective_actions") {
          return { data: {
            organizationId: ORGANIZATION_INTELLIGENCE_PREVIEW_ORGANIZATION,
            generatedAt: "2026-08-28T12:00:00Z",
            actions: [{ id: "a1", kind: "petition", status: "published", title: "Clock skew petition", summary: "Window closes as the member taps.", targetCount: 10, participantCount: 1, viewerParticipation: null, viewerCanEdit: false, startsAt: "2020-01-01T00:00:00Z", endsAt: "2099-01-01T00:00:00Z" }],
          }, error: null };
        }
        if (name === "toggle_digital_action_participation") {
          return { data: null, error: { code: "55000", message: "digital action is not accepting participation" } };
        }
        if (name === "get_my_chapter_memberships") {
          return { data: [{ selected: true, organizationId: ORGANIZATION_INTELLIGENCE_PREVIEW_ORGANIZATION, organizationRoles: [], chapterRoles: [] }], error: null };
        }
        return { data: null, error: null };
      }),
    };
    render(<CollectiveActionsView actor={staff({ selectedHat: "member", organizationRoles: [] })} client={client} />);
    const card = (await screen.findByRole("heading", { name: "Clock skew petition" })).closest("article");
    fireEvent.click(within(card).getByRole("button", { name: "Join action" }));
    const notice = await screen.findByText("This action isn’t accepting participation right now.");
    expect(notice).toHaveAttribute("role", "status");
    expect(screen.queryByText("The change could not be saved.")).not.toBeInTheDocument();
    expect(screen.queryByText(/digital action is not accepting/)).not.toBeInTheDocument();
  });

  // REQ-UG-PLATFORM-ORG-PRODUCTION-20261012 (#5813): the server
  // withholds platform-owned participant totals as null; the card says so
  // instead of showing zero, and no determinate meter is rendered.
  // Pages are keyed by the requested offset: the view reloads page one when
  // the scoped actor settles, so call order alone cannot select a page.
  function actionsClient(pages) {
    const rpc = vi.fn(async (name, args) => {
      if (name === "get_collective_actions") {
        const current = pages[args.p_offset ?? 0];
        const data = typeof current === "function" ? await current(args) : current;
        return { data: { organizationId: ORGANIZATION_INTELLIGENCE_PREVIEW_ORGANIZATION, generatedAt: "2026-08-28T12:00:00Z", ...data }, error: null };
      }
      if (name === "get_my_chapter_memberships") {
        return { data: [{ selected: true, organizationId: ORGANIZATION_INTELLIGENCE_PREVIEW_ORGANIZATION, organizationRoles: [], chapterRoles: [] }], error: null };
      }
      return { data: null, error: null };
    });
    return { rpc };
  }
  const publishedAction = (id, title, extra = {}) => ({ id, kind: "petition", status: "published", title, summary: `${title} summary.`, targetCount: 10, participantCount: 3, viewerParticipation: null, viewerCanEdit: false, startsAt: "2020-01-01T00:00:00Z", endsAt: "2099-01-01T00:00:00Z", ...extra });

  it.each([
    ["en", "participation withheld", "people joined"],
    ["es", "participación reservada", "personas participan"],
  ])("renders a withheld participant count as withheld, not zero, in %s", async (lang, withheld, strength) => {
    const client = actionsClient({ 0: { actions: [publishedAction("a-withheld", "Platform petition", { participantCount: null }), publishedAction("a-counted", "Counted petition")] } });
    render(<CollectiveActionsView actor={staff({ selectedHat: "member", organizationRoles: [] })} client={client} lang={lang} />);
    const withheldCard = (await screen.findByRole("heading", { name: "Platform petition" })).closest("article");
    expect(within(withheldCard).getByText(withheld)).toBeInTheDocument();
    expect(within(withheldCard).queryByText(strength, { exact: false })).not.toBeInTheDocument();
    expect(within(withheldCard).queryByText("0")).not.toBeInTheDocument();
    expect(withheldCard.querySelector("progress")).toBeNull();
    const countedCard = screen.getByRole("heading", { name: "Counted petition" }).closest("article");
    expect(within(countedCard).getByText("3")).toBeInTheDocument();
    expect(within(countedCard).getByText(strength, { exact: false })).toBeInTheDocument();
    expect(countedCard.querySelector("progress")).toHaveAttribute("value", "30");
  });

  // Join keeps focus while its write runs, in the classic and the
  // alternate shell, and a second activation in the same tick is refused.
  it("keeps Join action focused while the member joins, and joins once", async () => {
    const client = actionsClient({ 0: { actions: [publishedAction("a-join", "Join petition")], nextOffset: null } });
    render(<CollectiveActionsView actor={staff({ selectedHat: "member", organizationRoles: [] })} client={client} />);
    const card = (await screen.findByRole("heading", { name: "Join petition" })).closest("article");
    await expectHeldWriteFocus(client.rpc, within(card).getByRole("button", { name: "Join action" }));
    expect(client.rpc.mock.calls.filter(([name]) => name !== "get_collective_actions" && name !== "get_my_chapter_memberships")).toHaveLength(1);
  });

  it("keeps the Campaign page's Join focused while the member joins, and joins once", async () => {
    const client = actionsClient({ 0: { actions: [publishedAction("a-join", "Join petition")], nextOffset: null } });
    render(<CollectiveActionsView alt actor={staff({ selectedHat: "member", organizationRoles: [] })} client={client} />);
    const join = await screen.findByRole("checkbox", { name: /Join action/ });
    await expectHeldWriteFocus(client.rpc, join);
    expect(client.rpc.mock.calls.filter(([name]) => name !== "get_collective_actions" && name !== "get_my_chapter_memberships")).toHaveLength(1);
  });

  it("joins once when Join action is activated twice in one tick", async () => {
    const client = actionsClient({ 0: { actions: [publishedAction("a-join", "Join petition")], nextOffset: null } });
    render(<CollectiveActionsView actor={staff({ selectedHat: "member", organizationRoles: [] })} client={client} />);
    const card = (await screen.findByRole("heading", { name: "Join petition" })).closest("article");
    const join = within(card).getByRole("button", { name: "Join action" });
    // Count the write only; the view's page reload as the
    // scoped actor settles can land inside the tick on the same rpc mock.
    await expectOneWriteFromOneTick(client.rpc, [() => fireEvent.click(join), () => fireEvent.click(join)],
      { isWrite: (name) => name === "toggle_digital_action_participation" });
  });

  it("loads the next page of actions behind the load-more button and keeps the first page", async () => {
    let releaseSecondPage;
    const secondPage = new Promise((resolve) => { releaseSecondPage = resolve; });
    const client = actionsClient({
      0: { actions: [publishedAction("a-first", "First page petition")], nextOffset: 25 },
      25: async () => { await secondPage; return { actions: [publishedAction("a-second", "Second page petition")], nextOffset: null }; },
    });
    render(<CollectiveActionsView actor={staff({ selectedHat: "member", organizationRoles: [] })} client={client} />);
    await screen.findByRole("heading", { name: "First page petition" });
    fireEvent.click(screen.getByRole("button", { name: "Load more actions" }));
    // Pending, not natively disabled (record 8435): a second click loads nothing more.
    const loadingMore = await screen.findByRole("button", { name: "Loading more…" });
    expect(loadingMore).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(loadingMore);
    releaseSecondPage();
    await screen.findByRole("heading", { name: "Second page petition" });
    expect(screen.getByRole("heading", { name: "First page petition" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Load more actions|Loading more/ })).not.toBeInTheDocument();
    const pageCalls = client.rpc.mock.calls.filter(([name]) => name === "get_collective_actions").map(([, args]) => args.p_offset);
    expect(pageCalls.filter((offset) => offset === 25)).toHaveLength(1);
    expect(pageCalls.every((offset) => offset === 0 || offset === 25)).toBe(true);
  });

  // #9463 (W4-19): a failed Load more used to swap the whole list for the
  // unavailable state; it keeps the first page and says so beside the button.
  it.each([["en", "More actions could not be loaded. Try again."], ["es", "No se pudieron cargar más acciones. Inténtelo de nuevo."]])("keeps the first page and says a failed Load more beside it (%s)", async (lang, message) => {
    const nextPage = vi.fn().mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce({ actions: [publishedAction("a-second", "Second page petition")] });
    const client = actionsClient({ 0: { actions: [publishedAction("a-first", "First page petition")], nextOffset: 25 }, 25: nextPage });
    render(<CollectiveActionsView actor={staff({ selectedHat: "member", organizationRoles: [] })} client={client} lang={lang} />);
    await screen.findByRole("heading", { name: "First page petition" });
    const more = screen.getByRole("button", { name: lang === "en" ? "Load more actions" : "Cargar más acciones" });
    fireEvent.click(more);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("alert").closest(".oi-load-more")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "First page petition" })).toBeInTheDocument();
    fireEvent.click(more);
    expect(await screen.findByRole("heading", { name: "Second page petition" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(nextPage.mock.calls.map(([args]) => args.p_offset)).toEqual([25, 25]);
  });

  it("releases Load more and retries the same offset when the adapter rejects", async () => {
    const firstPage = { state: "ready", actions: [publishedAction("a-first", "First page petition")], hasMore: true, nextOffset: 25 };
    const secondPage = { state: "ready", actions: [publishedAction("a-second", "Second page petition")], hasMore: false };
    const nextPage = vi.fn().mockRejectedValueOnce(new Error("adapter rejected")).mockResolvedValueOnce(secondPage);
    const loadActions = vi.fn((request) => request.offset ? nextPage(request.offset) : Promise.resolve(firstPage));
    const wired = vi.spyOn(organizationIntelligenceWiring, "createWiredOrganizationIntelligenceAdapter").mockReturnValue({ loadActions });
    try {
      render(<CollectiveActionsView actor={staff({ selectedHat: "member", organizationRoles: [] })} />);
      const more = await screen.findByRole("button", { name: "Load more actions" });
      fireEvent.click(more);
      expect(await screen.findByRole("alert")).toHaveTextContent("More actions could not be loaded. Try again.");
      expect(more).not.toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("heading", { name: "First page petition" })).toBeVisible();
      fireEvent.click(more);
      expect(await screen.findByRole("heading", { name: "Second page petition" })).toBeVisible();
      expect(nextPage.mock.calls).toEqual([[25], [25]]);
    } finally {
      wired.mockRestore();
    }
  });

  it("clears the actions on an explicit refusal to load more", async () => {
    const client = actionsClient({ 0: { actions: [publishedAction("a-first", "First page petition")], nextOffset: 25 } });
    const served = client.rpc.getMockImplementation();
    client.rpc.mockImplementation((name, args) => name === "get_collective_actions" && args.p_offset
      ? Promise.resolve({ data: null, error: { code: "42501" }, status: 403 })
      : served(name, args));
    render(<CollectiveActionsView actor={staff({ selectedHat: "member", organizationRoles: [] })} client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more actions" }));
    expect(await screen.findByRole("button", { name: "Try again" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "First page petition" })).not.toBeInTheDocument();
    expect(screen.queryByText("More actions could not be loaded. Try again.")).not.toBeInTheDocument();
  });

  it("ignores a late next page after the data scope changes", async () => {
    let settle;
    const oldPage = new Promise((resolve) => { settle = resolve; });
    const first = actionsClient({
      0: { actions: [publishedAction("a-first", "Previous workspace")], nextOffset: 25 },
      25: () => oldPage,
    });
    const second = actionsClient({ 0: { actions: [publishedAction("a-new", "Current workspace")] } });
    const actor = staff({ selectedHat: "member", organizationRoles: [] });
    const { rerender } = render(<CollectiveActionsView actor={actor} client={first} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more actions" }));
    rerender(<CollectiveActionsView actor={actor} client={second} />);
    await screen.findByRole("heading", { name: "Current workspace" });
    await act(async () => { settle({ actions: [publishedAction("a-old", "Late previous page")] }); });
    expect(screen.getByRole("heading", { name: "Current workspace" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Late previous page" })).not.toBeInTheDocument();
  });

  it("creates and edits actions and downloads each protected participant kind", async () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:export") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const createObjectURL = vi.mocked(URL.createObjectURL);
    const revokeObjectURL = vi.mocked(URL.revokeObjectURL);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<CollectiveActionsView actor={staff()} preview />);
    const existing = await screen.findByRole("heading", { name: "Safe staffing commitment" });
    const card = existing.closest("article");
    fireEvent.click(within(card).getByRole("button", { name: "Save action" }));

    const form = screen.getByRole("heading", { name: "Create action" }).closest("form");
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Updated staffing action" } });
    fireEvent.change(within(form).getByLabelText("Summary"), { target: { value: "Updated summary" } });
    fireEvent.change(within(form).getByLabelText("Type"), { target: { value: "meeting" } });
    fireEvent.change(within(form).getByLabelText("Status"), { target: { value: "published" } });
    fireEvent.change(within(form).getByLabelText("Participation goal"), { target: { value: "300" } });
    fireEvent.change(within(form).getByLabelText("Starts"), { target: { value: "2026-09-01T10:00" } });
    fireEvent.change(within(form).getByLabelText("Ends"), { target: { value: "2026-09-01T12:00" } });
    fireEvent.submit(form);
    expect(await screen.findByRole("heading", { name: "Updated staffing action" })).toBeInTheDocument();

    const updatedCard = screen.getByRole("heading", { name: "Updated staffing action" }).closest("article");
    fireEvent.click(within(updatedCard).getByText("Export participant list"));
    for (const label of ["Signature", "Attendee", "Volunteer"]) {
      fireEvent.click(within(updatedCard).getByRole("button", { name: label }));
      await waitFor(() => expect(screen.getByText("Protected export downloaded.")).toBeInTheDocument());
    }
    expect(createObjectURL).toHaveBeenCalledTimes(3);
    expect(click).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalled());
  });

  it("renders Spanish read-only management boundaries and the empty organization state", async () => {
    render(<CollectiveActionsView actor={staff({ selectedHat: "advisor", organizationRoles: ["advisor"], mfaSatisfied: true })} preview lang="es" />);
    await screen.findByRole("heading", { name: "Acciones colectivas" });
    expect((await screen.findAllByText(/Se requiere acceso de coordinación/)).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Crear acción" })).toBeInTheDocument();

    cleanup();
    render(<CollectiveActionsView actor={staff({ organizationId: null })} preview />);
    expect(await screen.findByText("No organization is selected yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  });

  it("labels every action and participation kind in Spanish while submitted and exported values stay the contract tokens", async () => {
    const kindLabels = { petition: "Petición", rally: "Concentración", picket: "Piquete", meeting: "Reunión", other: "Otra acción" };
    const participationLabels = { signature: "Firma", attendee: "Asistencia", volunteer: "Voluntariado" };
    expect(Object.keys(kindLabels)).toEqual([...DIGITAL_ACTION_KINDS]);
    expect(Object.keys(participationLabels)).toEqual([...DIGITAL_ACTION_PARTICIPATION_KINDS]);

    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:export") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const downloads = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function capture() { downloads.push(this.download); });

    render(<CollectiveActionsView actor={staff()} preview lang="es" />);
    const form = (await screen.findByRole("heading", { name: "Crear acción" })).closest("form");
    const type = within(form).getByLabelText("Tipo");
    expect([...type.options].map((option) => option.value)).toEqual([...DIGITAL_ACTION_KINDS]);
    expect([...type.options].map((option) => option.textContent)).toEqual(DIGITAL_ACTION_KINDS.map((kind) => kindLabels[kind]));

    for (const [kind, title] of [["petition", "Safe staffing commitment"], ["rally", "Budget hearing turnout"], ["picket", "Respect the schedule"], ["meeting", "Worksite captains meeting"]]) {
      const card = screen.getByRole("heading", { name: title }).closest("article");
      expect(within(card).getByText(kindLabels[kind])).toBeInTheDocument();
    }

    const rally = screen.getByRole("heading", { name: "Budget hearing turnout" }).closest("article");
    expect(within(rally).getByText(/Se unió a esta acción\.\s*·\s*Asistencia/)).toBeInTheDocument();
    const petition = screen.getByRole("heading", { name: "Safe staffing commitment" }).closest("article");
    fireEvent.click(within(petition).getByRole("button", { name: "Unirse" }));
    expect(await within(petition).findByText(/Se unió a esta acción\.\s*·\s*Firma/)).toBeInTheDocument();

    // "other"/"volunteer" are not in the preview snapshot: create the action the Spanish form submits.
    fireEvent.change(within(form).getByLabelText("Título"), { target: { value: "Acción voluntaria" } });
    fireEvent.change(within(form).getByLabelText("Resumen"), { target: { value: "Resumen de la acción voluntaria" } });
    fireEvent.change(type, { target: { value: "other" } });
    fireEvent.change(within(form).getByLabelText("Estado"), { target: { value: "published" } });
    fireEvent.submit(form);

    // The card only renders when the persisted kind is still the contract token: the model drops unknown kinds.
    const other = (await screen.findByRole("heading", { name: "Acción voluntaria" })).closest("article");
    expect(within(other).getByText(kindLabels.other)).toBeInTheDocument();
    fireEvent.click(within(other).getByRole("button", { name: "Unirse" }));
    expect(await within(other).findByText(/Se unió a esta acción\.\s*·\s*Voluntariado/)).toBeInTheDocument();

    fireEvent.click(within(other).getByText("Exportar participantes"));
    for (const kind of DIGITAL_ACTION_PARTICIPATION_KINDS) {
      fireEvent.click(within(other).getByRole("button", { name: participationLabels[kind] }));
      await waitFor(() => expect(screen.getByText("Se descargó la exportación protegida.")).toBeInTheDocument());
    }
    expect(downloads).toEqual(DIGITAL_ACTION_PARTICIPATION_KINDS.map((kind) => expect.stringMatching(new RegExp(`-${kind}\\.csv$`))));

    const shell = screen.getByRole("region", { name: "Espacio de acciones colectivas" });
    for (const token of [...DIGITAL_ACTION_KINDS, ...DIGITAL_ACTION_PARTICIPATION_KINDS]) {
      expect(within(shell).queryByText(token)).not.toBeInTheDocument();
    }
  });
});

// Design census 2026-10-02: the hosted demo organization has about 5,000
// members, 100 relationships along one chain (the SAMPLE seed,
// supabase/migrations/20260829031000_organization_intelligence_visible_graph_seed_repair.sql)
// and a 25-node agency chart five columns wide.
function snapshotAdapter(snapshot) {
  return createOrganizationIntelligenceAdapter({ fetchIntelligence: async () => snapshot });
}

function largeOrganization({ people = 5000, relationships = 100, topics = 100 } = {}) {
  const kinds = ["reports_to", "works_with", "mentors", "organizes_with", "trusted_contact"];
  return {
    ...ORGANIZATION_INTELLIGENCE_PREVIEW_SNAPSHOT,
    relationshipNodes: Array.from({ length: people }, (_, index) => ({
      id: `person-${index}`, label: `Member ${String(index).padStart(4, "0")}`, roleLabel: "Member",
    })),
    relationships: Array.from({ length: relationships }, (_, index) => ({
      id: `relationship-${index}`, sourceId: `person-${index}`, targetId: `person-${index + 1}`,
      kind: kinds[(index + 1) % 5], strength: 1 + ((index + 1) % 5),
    })),
    topicProgress: Array.from({ length: topics }, (_, index) => ({
      memberId: `person-${index}`, topicKey: "organization_readiness", topicLabel: "Organization readiness",
      state: ["introduced", "developing", "ready"][(index + 1) % 3], progress: 20 + ((index + 1) % 81),
    })),
  };
}

const reader = () => staff({ selectedHat: "steward", organizationRoles: ["steward"] });

// One person connected to everyone else: a focus neighbourhood larger than the cap.
function hubOrganization(contacts = 250) {
  return {
    ...ORGANIZATION_INTELLIGENCE_PREVIEW_SNAPSHOT,
    relationshipNodes: [{ id: "hub", label: "Hub Person", roleLabel: "Steward" }, ...Array.from({ length: contacts }, (_, index) => ({
      id: `contact-${index}`, label: `Contact ${String(index).padStart(3, "0")}`, roleLabel: "Member",
    }))],
    relationships: Array.from({ length: contacts }, (_, index) => ({
      id: `hub-${index}`, sourceId: "hub", targetId: `contact-${index}`, kind: "works_with", strength: 1 + (index % 5),
    })),
    topicProgress: [],
  };
}
async function openNeuroMap(snapshot, actor = reader()) {
  render(<OrganizationIntelligenceView actor={actor} adapter={snapshotAdapter(snapshot)} />);
  fireEvent.click(await screen.findByRole("button", { name: "Neuro Map" }));
}

describe("organization chart initial viewport (BUG-UG-WEB-ORG-CHART-OPENS-ON-EMPTY-CANVAS-20261002)", () => {
  it("clamps the centring scroll to the canvas", () => {
    expect(chartRootScrollLeft(50, 1125, 400)).toBe(363);
    expect(chartRootScrollLeft(18, 1125, 400)).toBe(3);
    expect(chartRootScrollLeft(5, 1125, 400)).toBe(0);
    expect(chartRootScrollLeft(95, 1125, 400)).toBe(725);
    expect(chartRootScrollLeft(50, 563, 2000)).toBe(0);
  });

  it("opens a chart wider than its card centred on the root and says it scrolls sideways", async () => {
    const frameWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockImplementation(function clientWidth() { return this.classList.contains("oi-map-scroll") ? 400 : 0; });
    try {
      render(<OrganizationIntelligenceView actor={reader()} adapter={snapshotAdapter({ ...ORGANIZATION_INTELLIGENCE_PREVIEW_SNAPSHOT, chartNodes: seededChartNodes })} />);
      for (const [chart, root] of [["Agency", "Human Services Agency"], ["Organization", "Statewide Council"]]) {
        const frame = await screen.findByRole("group", { name: `${chart} persisted layout` });
        const canvasWidth = Number.parseFloat(frame.querySelector(".oi-map--chart").style.minWidth);
        expect(canvasWidth).toBeGreaterThan(400);
        const rootCentre = (Number.parseFloat(within(frame).getByRole("button", { name: new RegExp(root) }).style.left) / 100) * canvasWidth;
        // The whole 150px root node is inside the 400px frame.
        expect(rootCentre - 75).toBeGreaterThanOrEqual(frame.scrollLeft);
        expect(rootCentre + 75).toBeLessThanOrEqual(frame.scrollLeft + 400);
        expect(frame.previousElementSibling).toHaveTextContent("Scroll sideways to see the whole chart.");
      }
    } finally {
      frameWidth.mockRestore();
    }
  });

  it("shows no scroll hint and keeps the left edge when the card is wider than the chart", async () => {
    const frameWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockImplementation(function clientWidth() { return this.classList.contains("oi-map-scroll") ? 2000 : 0; });
    try {
      await openOrganizationView(reader());
      const frame = screen.getByRole("group", { name: "Agency persisted layout" });
      expect(frame.scrollLeft).toBe(0);
      expect(screen.queryByText("Scroll sideways to see the whole chart.")).toBeNull();
    } finally {
      frameWidth.mockRestore();
    }
  });

  it("keeps each visible root contained when the same frame narrows, without undoing user panning", async () => {
    let visible = 635;
    const observers = [];
    const frameWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockImplementation(function clientWidth() { return this.classList.contains("oi-map-scroll") ? visible : 0; });
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
      disconnect() {}
    });
    try {
      render(<OrganizationIntelligenceView actor={reader()} adapter={snapshotAdapter({ ...ORGANIZATION_INTELLIGENCE_PREVIEW_SNAPSHOT, chartNodes: seededChartNodes })} />);
      const frames = await Promise.all(["Agency", "Organization"].map(chart => screen.findByRole("group", { name: `${chart} persisted layout` })));
      const roots = ["Human Services Agency", "Statewide Council"];
      const assertRootsVisible = () => frames.forEach((frame, index) => {
        const canvasWidth = Number.parseFloat(frame.querySelector(".oi-map--chart").style.minWidth);
        const root = within(frame).getByRole("button", { name: new RegExp(roots[index]) });
        const centre = Number.parseFloat(root.style.left) / 100 * canvasWidth;
        expect(centre - 75).toBeGreaterThanOrEqual(frame.scrollLeft);
        expect(centre + 75).toBeLessThanOrEqual(frame.scrollLeft + visible);
      });
      assertRootsVisible();
      for (const width of [316, 246]) {
        visible = width;
        act(() => observers.forEach(observer => observer.callback()));
        assertRootsVisible();
      }
      // A height-only observer notification must not recentre the chart.
      frames.forEach(frame => { frame.scrollLeft = 0; });
      act(() => observers.forEach(observer => observer.callback()));
      expect(frames.map(frame => frame.scrollLeft)).toEqual([0, 0]);
      // Resizing also retains an intentional pan away from the root.
      visible = 300;
      act(() => observers.forEach(observer => observer.callback()));
      expect(frames.map(frame => frame.scrollLeft)).toEqual([0, 0]);
    } finally {
      frameWidth.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe("Neuro Map drawing cap (BUG-UG-WEB-NEURO-MAP-DRAWS-EVERYONE-ON-ONE-RING-20261002)", () => {
  function chainGraph(snapshot) {
    return {
      nodes: snapshot.relationshipNodes,
      edges: snapshot.relationships.map((edge) => ({ id: edge.id, source: edge.sourceId, target: edge.targetId, strength: edge.strength })),
    };
  }
  const index = (node) => Number(node.id.split("-")[1]);

  it("draws every person who has a relationship, and nobody else, from 5,000 people and 100 relationships", () => {
    const sample = relationshipMapSample(chainGraph(largeOrganization()));
    expect(sample.connected).toBe(101);
    expect(sample.nodes.length).toBeLessThanOrEqual(RELATIONSHIP_MAP_CAP);
    expect(sample.nodes.map(index).sort((a, b) => a - b)).toEqual(Array.from({ length: 101 }, (_, i) => i));
    expect(sample.edges).toHaveLength(100);
    expect(sample.focus).toBeNull();
    expect(sample.people.map((node) => node.id)).toEqual(expect.arrayContaining(sample.nodes.map((node) => node.id)));
    // Drawing order follows the walk, so neighbours sit next to each other:
    // the most connected person first, then outward along the chain.
    expect(sample.nodes.slice(0, 5).map(index)).toEqual([3, 4, 2, 5, 1]);
  });

  it("stops at the cap on a stretch that keeps every drawn person on a drawn line", () => {
    const chain = relationshipMapSample(chainGraph(largeOrganization({ relationships: 300 })));
    expect(chain.connected).toBe(301);
    expect(chain.nodes).toHaveLength(RELATIONSHIP_MAP_CAP);
    const indexes = chain.nodes.map(index).sort((a, b) => a - b);
    expect(indexes.at(-1) - indexes[0]).toBe(RELATIONSHIP_MAP_CAP - 1);
    expect(chain.edges).toHaveLength(RELATIONSHIP_MAP_CAP - 1);

    const pairs = {
      nodes: Array.from({ length: 300 }, (_, i) => ({ id: `p-${i}`, label: `Pair ${String(i).padStart(3, "0")}` })),
      edges: Array.from({ length: 150 }, (_, i) => ({ id: `e-${i}`, source: `p-${2 * i}`, target: `p-${2 * i + 1}`, strength: 1 })),
    };
    const paired = relationshipMapSample(pairs);
    expect(paired.nodes).toHaveLength(RELATIONSHIP_MAP_CAP);
    expect(paired.edges).toHaveLength(RELATIONSHIP_MAP_CAP / 2);
    const drawn = new Set(paired.nodes.map((node) => node.id));
    expect(paired.edges.every((edge) => drawn.has(edge.source) && drawn.has(edge.target))).toBe(true);
    expect(paired.nodes.every((node) => paired.edges.some((edge) => edge.source === node.id || edge.target === node.id))).toBe(true);
  });

  it("walks from the most connected person along the strongest relationships first", () => {
    const star = {
      nodes: ["hub", ...Array.from({ length: 12 }, (_, i) => `leaf-${i}`), "a", "b"].map((id) => ({ id, label: id })),
      edges: [
        ...Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, source: "hub", target: `leaf-${i}`, strength: 1 + (i % 5) })),
        { id: "ab", source: "a", target: "b", strength: 1 },
      ],
    };
    const whole = relationshipMapSample(star);
    expect(whole.nodes.map((node) => node.id)).toEqual([
      "hub", "leaf-4", "leaf-9", "leaf-3", "leaf-8", "leaf-2", "leaf-7", "leaf-1", "leaf-11", "leaf-6", "leaf-0", "leaf-10", "leaf-5", "a", "b",
    ]);
    expect(whole.reach).toBe(15);
    const capped = relationshipMapSample(star, { cap: 8 });
    expect(capped.nodes.map((node) => node.id)).toEqual(["hub", "leaf-4", "leaf-9", "leaf-3", "leaf-8", "leaf-2", "leaf-7", "leaf-1"]);
    expect(capped.edges.every((edge) => edge.source === "hub")).toBe(true);
    const small = relationshipMapSample({ nodes: star.nodes, edges: [star.edges[4], star.edges[12]] });
    expect(small.nodes.map((node) => node.id)).toEqual(["hub", "leaf-4", "a", "b"]);
    // A relationship to someone missing from the roster draws nothing.
    const dangling = relationshipMapSample({ nodes: star.nodes.slice(0, 1), edges: [star.edges[0]] });
    expect(dangling.nodes).toEqual([]);
    expect(dangling.connected).toBe(0);
  });

  it("focuses on one person and everyone within two steps, nearest and strongest first", () => {
    const graph = chainGraph(largeOrganization());
    const focused = relationshipMapSample(graph, { focus: "person-50" });
    expect(focused.focus?.id).toBe("person-50");
    expect(focused.nodes.map(index)).toEqual([50, 51, 49, 52, 48]);
    expect(focused.edges).toHaveLength(4);
    expect(focused.reach).toBe(5);
    expect(focused.connected).toBe(101);
    // An unknown person, or one without a relationship, means no focus.
    expect(relationshipMapSample(graph, { focus: "person-4000" }).focus).toBeNull();
    expect(relationshipMapSample(graph, { focus: "nobody" }).nodes).toHaveLength(101);
    // A focus with more contacts than the cap still stops at the cap.
    const crowd = {
      nodes: ["hub", ...Array.from({ length: 250 }, (_, i) => `c-${i}`)].map((id) => ({ id, label: id })),
      edges: Array.from({ length: 250 }, (_, i) => ({ id: `e${i}`, source: "hub", target: `c-${i}`, strength: 3 })),
    };
    const crowded = relationshipMapSample(crowd, { focus: "hub" });
    expect(crowded.nodes).toHaveLength(RELATIONSHIP_MAP_CAP);
    expect(crowded.reach).toBe(251);
    expect(crowded.edges).toHaveLength(RELATIONSHIP_MAP_CAP - 1);
  });

  it("lays rows out from the measured width and snakes them so the walk stays adjacent", () => {
    const grid = relationshipGridLayout(101, 640, 54);
    expect([grid.columns, grid.rows, grid.height]).toEqual([4, 26, 26 * 66 + 32]);
    expect(grid.pillWidth).toBe("calc(25% - 12px)");
    expect(grid.positions[0]).toEqual({ x: 12.5, y: ((16 + 33) * 100) / grid.height });
    expect(grid.positions[3].x).toBe(87.5);
    expect(grid.positions[4]).toEqual({ x: 87.5, y: ((16 + 99) * 100) / grid.height });
    expect(grid.positions[7].x).toBe(12.5);
    expect(grid.positions[8].x).toBe(12.5);
    expect(grid.positions.every((point) => point.x > 0 && point.x < 100 && point.y > 0 && point.y < 100)).toBe(true);
    // Narrow cards, and an unmeasured one, keep two columns.
    expect(relationshipGridLayout(9, 299, 54).columns).toBe(2);
    expect(relationshipGridLayout(9, 0, 54).columns).toBe(2);
    expect(relationshipGridLayout(9, 450, 120).rows).toBe(3);
    expect(relationshipGridLayout(9, 450, 120).height).toBe(3 * 132 + 32);
  });

  it("never draws a person without a line when the cap falls on a component boundary", () => {
    const chain = (count, prefix) => ({
      nodes: Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, label: `${prefix} ${String(i).padStart(3, "0")}` })),
      edges: Array.from({ length: count - 1 }, (_, i) => ({ id: `${prefix}-e${i}`, source: `${prefix}-${i}`, target: `${prefix}-${i + 1}`, strength: 1 })),
    });
    const pair = chain(2, "b");
    const hasLine = (sample) => sample.nodes.every((node) => sample.edges.some((edge) => edge.source === node.id || edge.target === node.id));
    // 199 drawn from the first component leaves one place: the pair is skipped whole.
    const tight = relationshipMapSample({ nodes: [...chain(199, "a").nodes, ...pair.nodes], edges: [...chain(199, "a").edges, ...pair.edges] });
    expect(tight.nodes).toHaveLength(RELATIONSHIP_MAP_CAP - 1);
    expect(tight.nodes.every((node) => node.id.startsWith("a-"))).toBe(true);
    expect(hasLine(tight)).toBe(true);
    // Two places left: the pair is drawn with its line.
    const roomy = relationshipMapSample({ nodes: [...chain(198, "a").nodes, ...pair.nodes], edges: [...chain(198, "a").edges, ...pair.edges] });
    expect(roomy.nodes).toHaveLength(RELATIONSHIP_MAP_CAP);
    expect(roomy.nodes.filter((node) => node.id.startsWith("b-"))).toHaveLength(2);
    expect(hasLine(roomy)).toBe(true);
  });

  it("narrows the pills of a seven-person ring so the two lowest do not touch", () => {
    expect(ringPillWidth(7)).toBeLessThan(26);
    expect(ringPillWidth(7)).toBeGreaterThan(25);
    for (const count of [2, 3, 4, 5, 6, 8]) expect(ringPillWidth(count)).toBe(30);
  });

  it("scrolls the row frame back to the top when the focus changes", async () => {
    await openNeuroMap(hubOrganization());
    const frame = screen.getByRole("region", { name: "Relationship map rows" });
    expect(frame.querySelectorAll(".oi-map__person")).toHaveLength(RELATIONSHIP_MAP_CAP);
    frame.scrollTop = 500;
    const search = screen.getByRole("search");
    fireEvent.change(within(search).getByLabelText("Focus the map on one person"), { target: { value: "Contact 007" } });
    fireEvent.click(within(search).getByRole("button", { name: "Focus on Contact 007" }));
    // Contact 007, the hub one step away, then 198 of the hub's other contacts: still a grid in the same frame.
    expect(screen.getByRole("region", { name: "Relationship map rows" })).toBe(frame);
    const pills = [...frame.querySelectorAll(".oi-map__person strong")].map((name) => name.textContent);
    expect(pills).toHaveLength(RELATIONSHIP_MAP_CAP);
    expect(pills.slice(0, 2)).toEqual(["Contact 007", "Hub Person"]);
    expect(frame.querySelector(".oi-map__person--focus")).toHaveTextContent("Contact 007");
    expect(frame.scrollTop).toBe(0);
    expect(screen.getByText("The map shows Contact 007 and 199 of the 250 people within two steps of them. Everyone and every relationship is listed below.")).toBeInTheDocument();
    frame.scrollTop = 300;
    fireEvent.click(within(search).getByRole("button", { name: "Show everyone connected" }));
    expect(screen.getByRole("region", { name: "Relationship map rows" })).toBe(frame);
    expect(frame.querySelector(".oi-map__person strong")).toHaveTextContent("Hub Person");
    expect(frame.scrollTop).toBe(0);
  });

  it("scrolls to the top again when the person already in focus is chosen once more", async () => {
    await openNeuroMap(hubOrganization());
    const frame = screen.getByRole("region", { name: "Relationship map rows" });
    const search = screen.getByRole("search");
    const input = within(search).getByLabelText("Focus the map on one person");
    fireEvent.change(input, { target: { value: "Contact 007" } });
    fireEvent.click(within(search).getByRole("button", { name: "Focus on Contact 007" }));
    expect(frame.scrollTop).toBe(0);
    frame.scrollTop = 400;
    fireEvent.change(input, { target: { value: "Contact 007" } });
    fireEvent.click(within(search).getByRole("button", { name: "Focus on Contact 007" }));
    expect(screen.getByRole("region", { name: "Relationship map rows" })).toBe(frame);
    expect(frame.querySelector(".oi-map__person--focus")).toHaveTextContent("Contact 007");
    expect(frame.scrollTop).toBe(0);
    // Enter takes the same path.
    frame.scrollTop = 250;
    fireEvent.change(input, { target: { value: "Contact 007" } });
    fireEvent.submit(search);
    expect(frame.scrollTop).toBe(0);
  });

  it("numbers same-name people by id so a relationship edit cannot move the ordinal", () => {
    const tr = (_key, { n, total }) => `${n} of ${total}`;
    const people = [
      { id: "b", label: "María García", roleLabel: "Member" },
      { id: "a", label: "María García", roleLabel: "Member" },
      { id: "c", label: "José Ortega", roleLabel: "Member" },
    ];
    const before = sameNameDetails(people, tr, "en");
    expect(Object.fromEntries(before)).toEqual({ a: "Member, 1 of 2", b: "Member, 2 of 2" });
    // A reload that reorders the map by link count gives the same answers.
    expect(sameNameDetails([...people].reverse(), tr, "en")).toEqual(before);
  });

  it("reads an invisible zero-width character as nothing, not as a space", () => {
    // BUG-UG-NEURO-MAP-SEARCH-SHOULD-INSERT-SPACE-INVISIBLE-ZERO-20261013.
    for (const invisible of ["\uFEFF", "\u200B", "\u2060"]) {
      expect(foldName(`Ana${invisible}Marie`, "en")).toBe("anamarie");
    }
    expect(foldName("Ana Marie", "en")).toBe("ana marie");
    // Joiners keep their meaning (Persian, emoji sequences).
    expect(foldName("می\u200Cروم", "en")).not.toBe(foldName("میروم", "en"));
    const tr = (_key, { n, total }) => `${n} of ${total}`;
    const people = [
      { id: "a", label: "Ana\uFEFFMarie", roleLabel: "Member" },
      { id: "b", label: "Ana Marie", roleLabel: "Member" },
    ];
    // Different names: neither is numbered against the other.
    expect(sameNameDetails(people, tr, "en")).toEqual(new Map());
  });

  it("treats names that differ only in Unicode form or inner spacing as one name", async () => {
    // BUG-UG-NEURO-MAP-SAME-NAME-UNICODE-SPACING-20261008.
    const tr = (_key, { n, total }) => `${n} of ${total}`;
    const nfc = "Mar\u00eda Garc\u00eda";
    const nfd = nfc.normalize("NFD");
    expect(nfd).not.toBe(nfc);
    const details = sameNameDetails([
      { id: "a", label: nfc, roleLabel: "Member" },
      { id: "b", label: "Mar\u00eda  Garc\u00eda", roleLabel: "Member" },
      { id: "c", label: nfd, roleLabel: "Steward" },
      { id: "d", label: "Mar\u00eda\u00a0Garc\u00eda ", roleLabel: "Member" },
    ], tr, "en");
    expect(Object.fromEntries(details)).toEqual({ a: "Member, 1 of 4", b: "Member, 2 of 4", c: "Steward, 3 of 4", d: "Member, 4 of 4" });

    const extras = Array.from({ length: RELATIONSHIP_RING_MAX }, (_, index) => ({ id: `x-${index}`, label: `Extra ${index}`, roleLabel: "Member" }));
    const nodes = [{ id: "hub", label: "Hub Person", roleLabel: "Steward" }, { id: "a", label: nfc, roleLabel: "Member" }, { id: "b", label: "Mar\u00eda  Garc\u00eda", roleLabel: "Member" }, ...extras];
    await openNeuroMap({
      ...ORGANIZATION_INTELLIGENCE_PREVIEW_SNAPSHOT,
      relationshipNodes: nodes,
      relationships: nodes.slice(1).map((node) => ({ id: `h-${node.id}`, sourceId: "hub", targetId: node.id, kind: "works_with", strength: 2 })),
      topicProgress: [],
    });
    const search = screen.getByRole("search");
    fireEvent.change(within(search).getByLabelText("Focus the map on one person"), { target: { value: "maria garcia" } });
    const buttons = within(search).getAllByRole("button", { name: /^Focus on Mar/ }).map((button) => button.textContent);
    expect(buttons).toHaveLength(2);
    expect(buttons.every((name) => /\(Member, [12] of 2\)$/.test(name))).toBe(true);
    expect(new Set(buttons).size).toBe(2);
  });

  it("never leaves a same-name detail empty or equal to another person's", () => {
    const tr = (_key, { n, total }) => `${n} of ${total}`;
    const blank = sameNameDetails([
      { id: "a", label: "María García", roleLabel: "   " },
      { id: "b", label: "María García", roleLabel: "Member" },
    ], tr, "en");
    expect(blank.get("a")).toBe("1 of 2");
    const collide = sameNameDetails([
      { id: "a", label: "Ana Ruiz", roleLabel: "Member" },
      { id: "b", label: "Ana Ruiz", roleLabel: "Member" },
      { id: "c", label: "Ana Ruiz", roleLabel: "Member, 1 of 2" },
    ], tr, "en");
    expect(new Set(collide.values()).size).toBe(3);
  });

  it("never gives two Focus buttons one name, even when a label equals another person's generated name", async () => {
    // BUG-UG-NEURO-MAP-GENERATED-LABEL-COLLISION-20261008.
    const people = [
      { id: "a", label: "Ana Ruiz", roleLabel: "Member" },
      { id: "b", label: "Ana Ruiz", roleLabel: "Member" },
      { id: "c", label: "Ana Ruiz (Member, 1 of 2)", roleLabel: null },
    ];
    const tr = (key, vars) => (key === "focusOnDetail" ? `Focus on ${vars.name} (${vars.detail})`
      : key === "focusOn" ? `Focus on ${vars.name}` : `${vars.n} of ${vars.total}`);
    const names = focusButtonNames(people, tr, "en");
    expect(new Set(names.values()).size).toBe(3);
    expect(names.get("b")).toBe("Focus on Ana Ruiz (Member, 2 of 2)");
    // Same input, same names: the id token is stable across reloads.
    expect(focusButtonNames([...people].reverse(), tr, "en")).toEqual(names);
    // A label built to equal the appended form still ends up distinct.
    const chained = focusButtonNames([...people, { id: "d", label: `Ana Ruiz (Member, 1 of 2) (a)`, roleLabel: null }], tr, "en");
    expect(new Set(chained.values()).size).toBe(4);

    const extras = Array.from({ length: RELATIONSHIP_RING_MAX }, (_, index) => ({ id: `x-${index}`, label: `Extra ${index}`, roleLabel: "Member" }));
    const nodes = [{ id: "hub", label: "Hub Person", roleLabel: "Steward" }, ...people, ...extras];
    await openNeuroMap({
      ...ORGANIZATION_INTELLIGENCE_PREVIEW_SNAPSHOT,
      relationshipNodes: nodes,
      relationships: nodes.slice(1).map((node) => ({ id: `h-${node.id}`, sourceId: "hub", targetId: node.id, kind: "works_with", strength: 2 })),
      topicProgress: [],
    });
    const search = screen.getByRole("search");
    fireEvent.change(within(search).getByLabelText("Focus the map on one person"), { target: { value: "Ana" } });
    const buttons = within(search).getAllByRole("button", { name: /^Focus on Ana Ruiz/ }).map((button) => button.textContent);
    expect(buttons).toHaveLength(3);
    expect(new Set(buttons).size).toBe(3);
  });

  it("matches names without accents and pages matches past eight so every match can be chosen", async () => {
    const twins = Array.from({ length: 9 }, (_, index) => ({ id: `mg-${index}`, label: "María García", roleLabel: index % 2 ? "Steward" : "Member" }));
    await openNeuroMap({
      ...ORGANIZATION_INTELLIGENCE_PREVIEW_SNAPSHOT,
      relationshipNodes: [{ id: "hub", label: "Hub Person", roleLabel: "Steward" }, { id: "jose", label: "José Ortega", roleLabel: "Member" }, ...twins],
      relationships: [{ id: "h-jose", sourceId: "hub", targetId: "jose", kind: "works_with", strength: 2 }, ...twins.map((twin, index) => ({ id: `h-${index}`, sourceId: "hub", targetId: twin.id, kind: "works_with", strength: 1 + (index % 5) }))],
      topicProgress: [],
    });
    const search = screen.getByRole("search");
    const input = within(search).getByLabelText("Focus the map on one person");
    fireEvent.change(input, { target: { value: "jose" } });
    expect(within(search).getAllByRole("button", { name: /^Focus on/ }).map((button) => button.textContent)).toEqual(["Focus on José Ortega"]);
    fireEvent.change(input, { target: { value: "maria garcia" } });
    expect(within(search).getAllByRole("button", { name: /^Focus on María García/ })).toHaveLength(8);
    const more = within(search).getByRole("button", { name: "Show 1 more matches" });
    fireEvent.click(more);
    const twinButtons = within(search).getAllByRole("button", { name: /^Focus on María García/ });
    expect(twinButtons).toHaveLength(9);
    expect(within(search).queryByRole("button", { name: /more matches/ })).toBeNull();
    // BUG-UG-WEB-NEURO-MAP-FOCUS-SEARCH-LEFTOVERS-20261006: nine people
    // with one label get nine different buttons: role, then "n of k" in
    // person-id order across everyone sharing the label.
    expect(new Set(twinButtons.map((button) => button.textContent)).size).toBe(9);
    expect(twinButtons.map((button) => button.textContent).sort()).toEqual(
      twins.map((twin, index) => `Focus on María García (${twin.roleLabel}, ${index + 1} of 9)`).sort(),
    );
    // The ninth is selectable, and a new query starts again at eight.
    const ninth = twinButtons[8].textContent;
    fireEvent.click(twinButtons[8]);
    expect(screen.getByRole("img", { name: /connected by 10 relationships/ }).querySelector(".oi-map__person--focus")).toHaveTextContent("María García");
    fireEvent.change(input, { target: { value: "garc" } });
    expect(within(search).getAllByRole("button", { name: /^Focus on María García/ })).toHaveLength(8);
    expect(within(search).queryByRole("button", { name: ninth })).toBeNull();
    expect(within(search).getByRole("button", { name: "Show 1 more matches" })).toBeInTheDocument();
  });

  it("chooses the column count from the frame's outer width, not the map narrowed by a scrollbar", async () => {
    const outer = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function offsetWidth() { return this.classList.contains("oi-map-frame") ? 460 : 0; });
    const inner = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function clientWidth() { return this.classList.contains("oi-map") ? 445 : 0; });
    try {
      await openNeuroMap(largeOrganization());
      const pills = screen.getByRole("img", { name: "101 people connected by 100 relationships" }).querySelectorAll(".oi-map__person");
      expect(pills).toHaveLength(101);
      // Three columns from the 460px frame; the map alone (445px) would give two.
      expect(pills[0].style.width).toMatch(/^calc\(33\.333\d*% - 12px\)$/);
      expect(relationshipGridLayout(101, 445, 54).columns).toBe(2);
    } finally {
      outer.mockRestore();
      inner.mockRestore();
    }
  });

  it("grows the ring so neighbouring names do not cover each other", () => {
    expect(relationshipMapHeight(4)).toBe(440);
    expect(relationshipMapHeight(RELATIONSHIP_RING_MAX)).toBeGreaterThan(440);
    expect(relationshipMapHeight(RELATIONSHIP_RING_MAX)).toBeLessThan(900);
  });

  it("draws the 101 connected people of a 5,000-person organization on rows and says who is on the map", async () => {
    await openNeuroMap(largeOrganization());
    const map = screen.getByRole("img", { name: "101 people connected by 100 relationships" });
    const pills = [...map.querySelectorAll(".oi-map__person")];
    expect(pills).toHaveLength(101);
    expect(map.querySelectorAll("line")).toHaveLength(100);
    expect(new Set(pills.map((pill) => pill.querySelector("strong").textContent)).size).toBe(101);
    expect(pills.every((pill) => /^Member 0(0\d\d|100)$/.test(pill.querySelector("strong").textContent))).toBe(true);
    expect(pills.every((pill) => pill.style.width === "calc(50% - 12px)")).toBe(true);
    expect(Number.parseFloat(map.style.minHeight)).toBe(relationshipGridLayout(101, 0, 54).height);
    const frame = screen.getByRole("region", { name: "Relationship map rows" });
    expect(frame).toContainElement(map);
    expect(frame).toHaveAttribute("tabindex", "0");
    expect(screen.getByText("The map shows the 101 people who have a relationship. Everyone and every relationship is listed below.")).toBeInTheDocument();
  });

  it("says how many connected people are hidden past the cap", async () => {
    await openNeuroMap(largeOrganization({ relationships: 300 }));
    // The image is named for what it draws, and the legend says what is hidden.
    const map = screen.getByRole("img", { name: "200 people connected by 199 relationships" });
    expect(map.querySelectorAll(".oi-map__person")).toHaveLength(RELATIONSHIP_MAP_CAP);
    expect(map.querySelectorAll("line")).toHaveLength(199);
    const legend = "The map shows 200 of the 301 people who have a relationship, starting with the most connected; 101 are not drawn. Search for a name to focus the map on one person. Everyone and every relationship is listed below.";
    expect(screen.getByText(legend)).toBeInTheDocument();
    expect(map).toHaveAccessibleDescription(legend);
  });

  it("focuses the map on a searched person and returns to everyone", async () => {
    await openNeuroMap(largeOrganization());
    const search = screen.getByRole("search");
    const input = within(search).getByLabelText("Focus the map on one person");
    expect(input).toHaveAccessibleDescription("Type a name to draw that person and everyone within two steps of them.");
    fireEvent.change(input, { target: { value: "member 00" } });
    expect(within(search).getAllByRole("button", { name: /^Focus on Member/ })).toHaveLength(8);
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(within(search).getByText("No one with a relationship matches “zzz”.")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "member 0050" } });
    fireEvent.click(within(search).getByRole("button", { name: "Focus on Member 0050" }));

    const map = screen.getByRole("img", { name: "5 people connected by 4 relationships" });
    expect(map).toHaveAccessibleDescription("The map shows Member 0050 and the 4 people within two steps of them. Everyone and every relationship is listed below.");
    expect([...map.querySelectorAll(".oi-map__person strong")].map((name) => name.textContent)).toEqual(
      ["Member 0050", "Member 0051", "Member 0049", "Member 0052", "Member 0048"],
    );
    expect(map.querySelectorAll("line")).toHaveLength(4);
    expect(map.querySelector(".oi-map__person--focus")).toHaveTextContent("Member 0050");
    expect(screen.queryByRole("region", { name: "Relationship map rows" })).toBeNull();
    expect(Number.parseFloat(map.style.minHeight)).toBe(relationshipMapHeight(5));
    expect(input).toHaveValue("");
    expect(screen.getByText("The map shows Member 0050 and the 4 people within two steps of them. Everyone and every relationship is listed below.")).toBeInTheDocument();

    // Enter takes the first match; Show everyone goes back to the whole map.
    fireEvent.change(input, { target: { value: "Member 0007" } });
    fireEvent.submit(search);
    expect(map.querySelector(".oi-map__person--focus")).toHaveTextContent("Member 0007");
    fireEvent.click(within(search).getByRole("button", { name: "Show everyone connected" }));
    const whole = screen.getByRole("img", { name: "101 people connected by 100 relationships" });
    expect(whole.querySelectorAll(".oi-map__person")).toHaveLength(101);
    expect(whole.querySelector(".oi-map__person--focus")).toBeNull();
    expect(screen.getByRole("region", { name: "Relationship map rows" })).toContainElement(whole);
  });

  it("names a map with one drawn relationship in the singular", async () => {
    await openNeuroMap({
      ...ORGANIZATION_INTELLIGENCE_PREVIEW_SNAPSHOT,
      relationshipNodes: [{ id: "a", label: "Ana Ruiz", roleLabel: "Member" }, { id: "b", label: "Bo Chen", roleLabel: "Steward" }],
      relationships: [{ id: "a-b", sourceId: "a", targetId: "b", kind: "works_with", strength: 2 }],
      topicProgress: [],
    });
    expect(screen.getByRole("img", { name: "2 people connected by 1 relationship" })).toBeInTheDocument();
  });

  // BUG-UG-WEB-NEURO-MAP-FOCUS-SEARCH-LEFTOVERS-20261006: the control
  // names what one activation reveals, not the whole remainder.
  it("labels the more-matches control with the eight names one activation reveals", async () => {
    await openNeuroMap(largeOrganization());
    const search = screen.getByRole("search");
    fireEvent.change(within(search).getByLabelText("Focus the map on one person"), { target: { value: "Member" } });
    expect(within(search).getAllByRole("button", { name: /^Focus on Member/ })).toHaveLength(8);
    expect(within(search).queryByRole("button", { name: "Show 93 more matches" })).toBeNull();
    fireEvent.click(within(search).getByRole("button", { name: "Show 8 more matches" }));
    expect(within(search).getAllByRole("button", { name: /^Focus on Member/ })).toHaveLength(16);
    expect(within(search).getByRole("button", { name: "Show 8 more matches" })).toBeInTheDocument();
  });

  it("re-measures the row frame on a height-only resize so the scroll hint appears", async () => {
    const observed = [];
    const observers = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(target) { observed.push(target); }
      disconnect() {}
    });
    let frameHeight = 5000;
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function scrollHeight() { return this.classList.contains("oi-map-frame") ? 2000 : 0; });
    const client = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function clientHeight() { return this.classList.contains("oi-map-frame") ? frameHeight : 0; });
    try {
      await openNeuroMap(largeOrganization());
      const frame = screen.getByRole("region", { name: "Relationship map rows" });
      expect(observed).toContain(frame);
      expect(screen.queryByText("Scroll down inside the map to see every row.")).toBeNull();
      // The window gets shorter; neither the map nor a pill changes size.
      frameHeight = 600;
      act(() => observers.forEach((observer) => observer.callback([{ target: frame }])));
      expect(screen.getByText("Scroll down inside the map to see every row.")).toBeInTheDocument();
      // The hint mounts before the frame without remounting it, so the observer
      // stays on the frame on screen and a later resize still re-measures.
      expect(screen.getByRole("region", { name: "Relationship map rows" })).toBe(frame);
      frameHeight = 5000;
      act(() => observers.forEach((observer) => observer.callback([{ target: frame }])));
      expect(screen.queryByText("Scroll down inside the map to see every row.")).toBeNull();
      expect(screen.getByRole("region", { name: "Relationship map rows" })).toBe(frame);
    } finally {
      scroll.mockRestore();
      client.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("keeps a small connected organization whole on one ring with no legend and no search", async () => {
    await openOrganizationView(reader());
    fireEvent.click(screen.getByRole("button", { name: "Neuro Map" }));
    const map = screen.getByRole("img", { name: "4 people connected by 3 relationships" });
    expect(map).not.toHaveAttribute("aria-describedby");
    expect(map.querySelectorAll(".oi-map__person")).toHaveLength(4);
    expect(map.querySelectorAll("line")).toHaveLength(3);
    expect(map.className).not.toContain("oi-map--grid");
    expect(screen.queryByText(/The map shows/)).toBeNull();
    expect(screen.queryByRole("search")).toBeNull();
    expect(screen.queryByRole("region", { name: "Relationship map rows" })).toBeNull();
  });
});

describe("Neuro Map lists (BUG-UG-WEB-ORG-MAP-RELATIONSHIPS-LISTS-EVERY-PERSON-20261002)", () => {
  function walk(name, read) {
    const pager = screen.getByRole("navigation", { name });
    const seen = [];
    for (;;) {
      const rows = read();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(LIST_PAGE_SIZE);
      seen.push(...rows);
      const next = within(pager).getByRole("button", { name: "Next" });
      if (next.getAttribute("aria-disabled") === "true") break;
      fireEvent.click(next);
    }
    return { pager, seen };
  }

  it("renders the relationship rows before one page of people", async () => {
    await openNeuroMap(largeOrganization());
    const edges = document.querySelector(".oi-edge-list");
    const people = document.querySelector(".oi-people");
    expect(edges.compareDocumentPosition(people) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(edges.querySelectorAll("li")).toHaveLength(LIST_PAGE_SIZE);
    expect(document.querySelectorAll(".oi-progress")).toHaveLength(LIST_PAGE_SIZE);
    expect(document.querySelectorAll(".oi-person")).toHaveLength(LIST_PAGE_SIZE);
    expect(within(screen.getByRole("navigation", { name: "People pages" })).getByRole("status")).toHaveTextContent("1–25 of 5,000");
    expect(within(screen.getByRole("navigation", { name: "Relationship pages" })).getByRole("status")).toHaveTextContent("1–25 of 100");
    expect(within(screen.getByRole("navigation", { name: "Topic pages" })).getByRole("status")).toHaveTextContent("1–25 of 100");
  });

  it("reaches every person, relationship and topic one page at a time", async () => {
    await openNeuroMap(largeOrganization());
    const people = walk("People pages", () => [...document.querySelectorAll(".oi-person strong")].map((node) => node.textContent));
    expect(new Set(people.seen).size).toBe(5000);
    expect(within(people.pager).getByRole("status")).toHaveTextContent("4,976–5,000 of 5,000");
    // The boundary control stays focusable and says it cannot act.
    const next = within(people.pager).getByRole("button", { name: "Next" });
    expect(next).not.toBeDisabled();
    next.focus();
    fireEvent.click(next);
    expect(document.activeElement).toBe(next);
    expect(within(people.pager).getByRole("status")).toHaveTextContent("4,976–5,000 of 5,000");
    fireEvent.click(within(people.pager).getByRole("button", { name: "Previous" }));
    expect(within(people.pager).getByRole("status")).toHaveTextContent("4,951–4,975 of 5,000");

    const edges = walk("Relationship pages", () => [...document.querySelectorAll(".oi-edge-list li")].map((row) => row.textContent));
    expect(new Set(edges.seen).size).toBe(100);
    expect(edges.seen).toContain("Member 0099Reports to · 1/5Member 0100");
    const topics = walk("Topic pages", () => [...document.querySelectorAll(".oi-progress strong")].map((name) => name.textContent));
    expect(new Set(topics.seen).size).toBe(100);
  }, 30000);

  it("keeps short lists whole with no pager", async () => {
    await openOrganizationView(reader());
    fireEvent.click(screen.getByRole("button", { name: "Neuro Map" }));
    expect(document.querySelectorAll(".oi-person")).toHaveLength(4);
    expect(document.querySelectorAll(".oi-edge-list li")).toHaveLength(3);
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});
