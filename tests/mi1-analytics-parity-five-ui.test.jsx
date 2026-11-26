import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AnalyticsCoreDesk } from "../src/features/analytics/ui/AnalyticsCoreDesk.jsx";
import { AnalyticsExplorerPanel, AnalyticsStudioPanel, ChapterChartsPanel } from "../src/features/analytics/ui/AnalyticsParityPanels.jsx";
import { MemberReportCard } from "../src/features/analytics/ui/MemberReportCard.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { USTED_MARKERS } from "./i18nRegisterMarkers.js";
import {
  createPreviewAnalyticsSnapshot,
  createPreviewAnalyticsViewer,
  createPreviewAnalyticsWorkspace,
} from "../src/features/analytics/index.js";
import { showAnalyticsView } from "./helpers/analyticsView.js";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

const ORG = "preview-analytics-org";
const workspace = {
  organizationId: ORG,
  privacyThreshold: 25,
  members: [{
    organizationId: ORG,
    id: "member-a:north",
    name: "Avery Chen",
    chapterId: "north",
    chapterName: "North Chapter",
    participationScore: 60,
    profileReadiness: 100,
    followThrough: 40,
    overallScore: 67,
    attention: "watch",
    activeCases: 2,
    overdueCases: 0,
  }],
  chapterHealth: [{
    organizationId: ORG,
    chapterId: "north",
    chapterName: "North Chapter",
    memberCount: 30,
    score: 72,
  }],
  datasets: [{
    organizationId: ORG,
    id: "chapter:north:health-trend",
    label: "North health trend",
    scope: "chapter",
    chapterId: "north",
    rows: [{ label: "August", value: 72 }],
  }],
  layouts: [{
    id: "layout-a",
    organizationId: ORG,
    name: "North scorecard",
    scope: "chapter",
    chapterId: "north",
    spec: { datasetId: "chapter:north:health-trend", chartType: "bar", title: "North scorecard" },
    canEdit: true,
  }],
};

describe("analytics parity web surfaces", () => {
  it("drills through health and explorer records and renders a shared chapter scorecard", () => {
    const props = {
      snapshot: createPreviewAnalyticsSnapshot(),
      workspace,
      viewer: createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] }),
    };
    render(<AnalyticsCoreDesk {...props} />);

    showAnalyticsView("Health tree");
    expect(screen.getByRole("heading", { name: "Organization health tree" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Avery Chen/ }));
    expect(screen.getByText("Profile readiness")).toBeInTheDocument();

    showAnalyticsView("Explorer");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search workers" }), { target: { value: "Avery" } });
    expect(screen.getByRole("button", { name: "Avery Chen" })).toBeInTheDocument();

    showAnalyticsView("Campaign charts");
    expect(screen.getByRole("heading", { name: "North scorecard" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "North health trend, bar chart" })).toBeInTheDocument();
  });

  it("names the Explorer member column separately from the search field", () => {
    const props = {
      snapshot: createPreviewAnalyticsSnapshot(),
      workspace,
      viewer: createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] }),
    };

    const { unmount } = render(<AnalyticsCoreDesk {...props} />);
    showAnalyticsView("Explorer");
    const englishExplorer = within(screen.getByRole("region", { name: "Analytics explorer" }));
    expect(englishExplorer.getByRole("searchbox", { name: "Search workers" })).toBeInTheDocument();
    const englishHeader = englishExplorer.getAllByRole("columnheader")[0];
    expect(englishHeader).toHaveAccessibleName("Worker");
    expect(englishHeader).not.toHaveAccessibleName("Search workers");
    unmount();

    render(<LanguageProvider lang="es"><AnalyticsCoreDesk {...props} /></LanguageProvider>);
    showAnalyticsView("Explorador");
    const spanishExplorer = within(screen.getByRole("region", { name: "Explorador de analítica" }));
    expect(spanishExplorer.getByRole("searchbox", { name: "Buscar trabajadores" })).toBeInTheDocument();
    const spanishHeader = spanishExplorer.getAllByRole("columnheader")[0];
    expect(spanishHeader).toHaveAccessibleName("Trabajador");
    expect(spanishHeader).not.toHaveAccessibleName("Buscar trabajadores");
  });

  it("shows a member who hid their Pulse score with no score and no support signal (#6774)", () => {
    const hidden = { ...workspace.members[0], id: "member-b:north", name: "Blair Hidden", scoreHidden: true,
      participationScore: null, profileReadiness: null, followThrough: null, overallScore: null, attention: null, lastActivityAt: null };
    render(<AnalyticsCoreDesk snapshot={createPreviewAnalyticsSnapshot()} workspace={{ ...workspace, members: [...workspace.members, hidden] }}
      viewer={createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] })} />);
    showAnalyticsView("Explorer");
    const explorer = within(screen.getByRole("region", { name: "Analytics explorer" }));
    const row = explorer.getByRole("row", { name: /Blair Hidden/ });
    expect(within(row).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["Blair Hidden", "North Chapter", "—", "—"]);
    const visible = explorer.getByRole("row", { name: /Avery Chen/ });
    expect(within(visible).getAllByRole("cell").at(-1).textContent).not.toBe("—");
  });

  it("saves and removes a chart layout through callback receipts", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "11111111-1111-4111-8111-111111111111" });
    const onSaveLayout = vi.fn(async () => ({ ok: true }));
    const onDeleteLayout = vi.fn(async () => ({ ok: true }));
    render(<AnalyticsCoreDesk
      snapshot={createPreviewAnalyticsSnapshot()}
      workspace={workspace}
      viewer={createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] })}
      onSaveLayout={onSaveLayout}
      onDeleteLayout={onDeleteLayout}
    />);
    showAnalyticsView("Charts studio");
    fireEvent.change(screen.getByRole("textbox", { name: "Layout name" }), { target: { value: "Health briefing" } });
    fireEvent.click(screen.getByRole("button", { name: "Save layout" }));
    await waitFor(() => expect(onSaveLayout).toHaveBeenCalledWith(expect.objectContaining({
      name: "Health briefing",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    })));
    expect(await screen.findByText("Layout saved.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(onDeleteLayout).toHaveBeenCalledWith({
      id: "layout-a",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    }));
    vi.unstubAllGlobals();
  });

  it("offers organization sharing only to organization leadership and labels every scope", () => {
    const renderStudio = (viewer, lang = "en") => render(<LanguageProvider lang={lang}><AnalyticsCoreDesk
      snapshot={createPreviewAnalyticsSnapshot()}
      workspace={workspace}
      viewer={viewer}
    /></LanguageProvider>);
    const optionLabels = () => [...screen.getByLabelText(/Sharing scope|Alcance compartido/).options].map((option) => option.textContent);

    for (const hat of ["steward", "advisor"]) {
      const { unmount } = renderStudio(createPreviewAnalyticsViewer({ selectedHat: hat, roles: [hat] }));
      showAnalyticsView("Charts studio");
      expect(optionLabels()).toEqual(["Only me", "Campaign"]);
      unmount();
    }

    const { unmount } = renderStudio(createPreviewAnalyticsViewer({ selectedHat: "coordinator", roles: ["coordinator"] }));
    showAnalyticsView("Charts studio");
    expect(optionLabels()).toEqual(["Only me", "Campaign", "Whole organization"]);
    expect(screen.getByText("Campaign · Bar")).toBeInTheDocument();
    unmount();

    renderStudio(createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] }), "es");
    showAnalyticsView("Estudio de gráficas");
    expect(optionLabels()).toEqual(["Solo yo", "Campaña", "Toda la organización"]);
  });

  it("reuses one idempotency key for a save intent until the server confirms it", async () => {
    const keys = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"];
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => keys.shift()) });
    const onSaveLayout = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "network" })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });
    render(<AnalyticsCoreDesk
      snapshot={createPreviewAnalyticsSnapshot()}
      workspace={workspace}
      viewer={createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] })}
      onSaveLayout={onSaveLayout}
      onDeleteLayout={vi.fn(async () => ({ ok: true }))}
    />);
    showAnalyticsView("Charts studio");
    const nameField = screen.getByRole("textbox", { name: "Layout name" });
    const saveButton = () => screen.getByRole("button", { name: "Save layout" });
    fireEvent.change(nameField, { target: { value: "Health briefing" } });
    fireEvent.click(saveButton());
    expect(await screen.findByText("The layout could not be saved.")).toBeInTheDocument();
    fireEvent.click(saveButton());
    expect(await screen.findByText("Layout saved.")).toBeInTheDocument();
    expect(onSaveLayout.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ]);

    fireEvent.change(nameField, { target: { value: "Health briefing" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaveLayout).toHaveBeenCalledTimes(3));
    expect(onSaveLayout.mock.calls[2][0].idempotencyKey).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    vi.unstubAllGlobals();
  });

  it("covers empty, localized, protected, filtered, and failure states", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "22222222-2222-4222-8222-222222222222" });
    const onSaveLayout = vi.fn(async () => ({ ok: false }));
    const onDeleteLayout = vi.fn(async () => ({ ok: false }));
    const protectedWorkspace = {
      ...workspace,
      chapters: [{
        ...workspace.chapterHealth[0],
        health: { protected: true, score: null },
        members: workspace.members,
      }],
      chapterCharts: [],
    };
    const { rerender } = render(<>
      <MemberReportCard value={null} lang="es" />
      <MemberReportCard value={{
        overall: 74,
        participation: 70,
        profileReadiness: 100,
        followThrough: 52,
        signals: [{ label: "Protected activities", value: 7 }],
      }} lang="es" />
      <AnalyticsCoreDesk
        snapshot={createPreviewAnalyticsSnapshot("invalid-date")}
        workspace={workspace}
        viewer={createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] })}
        onSaveLayout={onSaveLayout}
        onDeleteLayout={onDeleteLayout}
      />
    </>);
    expect(screen.getByText("Tu reporte aparecerá cuando haya señales protegidas de actividad.")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Reporte de participación").at(-1)).toHaveTextContent("Protected activities: 7");

    showAnalyticsView("Explorer");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search workers" }), { target: { value: "missing" } });
    expect(screen.getByText("No authorized records are available yet.")).toBeInTheDocument();

    showAnalyticsView("Charts studio");
    fireEvent.change(screen.getByLabelText("Chart type"), { target: { value: "table" } });
    fireEvent.change(screen.getByLabelText("Sharing scope"), { target: { value: "chapter" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Layout name" }), { target: { value: "Failure path" } });
    fireEvent.click(screen.getByRole("button", { name: "Save layout" }));
    expect(await screen.findByText("The layout could not be saved.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(onDeleteLayout).toHaveBeenCalled());
    expect(await screen.findByText("The layout could not be removed.")).toBeInTheDocument();

    rerender(<AnalyticsCoreDesk
      snapshot={createPreviewAnalyticsSnapshot()}
      workspace={{ ...workspace, members: [], chapterHealth: [], datasets: [], layouts: [] }}
      viewer={createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] })}
    />);
    showAnalyticsView("Health tree");
    expect(screen.getByText("No authorized records are available yet.")).toBeInTheDocument();
    showAnalyticsView("Campaign charts");
    expect(screen.getByText("No shared campaign layouts have been saved yet.")).toBeInTheDocument();

    rerender(<AnalyticsCoreDesk
      snapshot={createPreviewAnalyticsSnapshot()}
      workspace={{ state: "unavailable" }}
      viewer={createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] })}
    />);
    showAnalyticsView("Health tree");
    expect(screen.getByRole("heading", { name: "Not available here" })).toBeInTheDocument();
    expect(screen.getByText("This part of Analytics is not connected for this organization yet.")).toBeInTheDocument();

    expect(createPreviewAnalyticsWorkspace()).toMatchObject({
      organizationId: ORG,
      members: expect.arrayContaining([expect.objectContaining({ name: "Avery Chen" })]),
    });
    expect(protectedWorkspace.chapters[0].health.protected).toBe(true);
    vi.unstubAllGlobals();
  });

  // UX-UG-ANALYTICS-PRIVATE-CATALOGUES-ADDRESS-READER-IN-USTED-20260920:
  // the report card and the Explorer/Studio keep file-private es tables that no
  // catalogue register census reads. The rendered copy uses tú, and every es
  // string in both tables passes the shared usted markers.
  it("addresses the Spanish reader with tú in the private analytics catalogues", () => {
    const readyWorkspace = {
      state: "ready",
      members: [],
      chapters: [],
      datasets: [{ id: "chapter:north:health-trend", label: "North health trend", rows: [{ label: "August", value: 72 }] }],
      layouts: [],
    };
    render(<>
      <MemberReportCard value={null} lang="es" />
      <AnalyticsExplorerPanel workspace={readyWorkspace} lang="es" />
      <AnalyticsStudioPanel workspace={readyWorkspace} lang="es" />
    </>);
    const card = screen.getByRole("region", { name: "Reporte de participación" });
    expect(within(card).getByText("Solo tu propia actividad. La cantidad de casos nunca reduce esta puntuación.")).toBeInTheDocument();
    expect(within(card).getByText("Tu reporte aparecerá cuando haya señales protegidas de actividad.")).toBeInTheDocument();
    expect(screen.getByText("Busca e inspecciona señales autorizadas sin exportar contenido privado por persona.")).toBeInTheDocument();
    expect(screen.getByText("Crea una vista protegida con conjuntos agregados aprobados y guarda un diseño reutilizable.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Solo su propia|Su reporte|Busque|inspeccione|\bCree\b|\bguarde\b/);
  });

  it("keeps every es string of the private analytics catalogues out of usted", () => {
    for (const file of ["src/features/analytics/ui/MemberReportCard.jsx", "src/features/analytics/ui/AnalyticsParityPanels.jsx"]) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      const start = source.indexOf("\n  es: {");
      const end = source.indexOf("\n  },\n};", start);
      expect(start, file).toBeGreaterThan(0);
      expect(end, file).toBeGreaterThan(start);
      const spanish = [...source.slice(start, end).matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) => match[1]);
      expect(spanish.length, file).toBeGreaterThan(8);
      expect(spanish.filter((text) => USTED_MARKERS.test(text) || /(?<![\p{L}])(?:cree|guarde|inspeccione)(?![\p{L}])/iu.test(text)), file).toEqual([]);
    }
  });

  it("localizes support-signal filters and reports unavailable idempotency keys", async () => {
    vi.stubGlobal("crypto", {});
    const onSaveLayout = vi.fn(async () => ({ ok: true }));
    const onDeleteLayout = vi.fn(async () => ({ ok: true }));
    render(<LanguageProvider lang="es">
      <AnalyticsCoreDesk
        snapshot={createPreviewAnalyticsSnapshot()}
        workspace={workspace}
        viewer={createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] })}
        onSaveLayout={onSaveLayout}
        onDeleteLayout={onDeleteLayout}
      />
    </LanguageProvider>);

    showAnalyticsView("Explorador");
    const signalFilter = screen.getByRole("combobox", { name: "Señal de apoyo" });
    expect(signalFilter).toHaveTextContent("Urgente");
    expect(signalFilter).toHaveTextContent("Apoyo");
    expect(signalFilter).toHaveTextContent("Observar");
    expect(signalFilter).toHaveTextContent("Estable");
    // UX-UG-ANALYTICS-PARITY-RAW-ATTENTION-CHART-SCOPE-TOKENS-20260920: the
    // member's own signal reads as a word too, not the stored token.
    const explorerRow = screen.getByRole("row", { name: /Avery Chen/ });
    expect(explorerRow).toHaveTextContent("Observar");
    expect(explorerRow).not.toHaveTextContent(/\bwatch\b/);
    fireEvent.click(screen.getByRole("button", { name: "Avery Chen" }));
    expect(screen.getByText("Señal de apoyo: Observar")).toBeInTheDocument();

    showAnalyticsView("Árbol de salud");
    const healthMember = screen.getByRole("button", { name: /Avery Chen/ });
    expect(healthMember).toHaveTextContent("Observar");
    expect(healthMember).not.toHaveTextContent(/\bwatch\b/);

    showAnalyticsView("Estudio de gráficas");
    const chartType = screen.getByRole("combobox", { name: "Tipo de gráfica" });
    expect(within(chartType).getByRole("option", { name: "Barras" })).toHaveValue("bar");
    expect(within(chartType).getByRole("option", { name: "Barras apiladas" })).toHaveValue("stacked_bar");
    expect(within(chartType).getByRole("option", { name: "Tabla" })).toHaveValue("table");
    expect(chartType).not.toHaveTextContent(/stacked|_/);
    expect(screen.getByText("Campaña · Barras")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Nombre del diseño" }), { target: { value: "Informe" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar diseño" }));
    expect(await screen.findByText("No se pudo guardar el diseño.")).toBeInTheDocument();
    expect(onSaveLayout).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    expect(await screen.findByText("No se pudo eliminar el diseño.")).toBeInTheDocument();
    expect(onDeleteLayout).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("pages saved layouts and chapter charts at the product limit", () => {
    const layouts = Array.from({ length: 31 }, (_, index) => ({
      ...workspace.layouts[0],
      id: `layout-${index + 1}`,
      name: `Layout ${index + 1}`,
    }));
    render(<AnalyticsCoreDesk
      snapshot={createPreviewAnalyticsSnapshot()}
      workspace={{ ...workspace, layouts }}
      viewer={createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] })}
    />);

    showAnalyticsView("Charts studio");
    expect(screen.getByRole("status", { name: "Layout pages" })).toHaveTextContent("Page 1 of 3");
    expect(screen.getByRole("heading", { name: "Layout 1" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Layout 16" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByRole("heading", { name: "Layout 16" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Layout 1" })).not.toBeInTheDocument();

    showAnalyticsView("Campaign charts");
    expect(screen.getByRole("status", { name: "Layout pages" })).toHaveTextContent("Page 1 of 3");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByRole("heading", { name: "Layout 16" })).toBeInTheDocument();
  });

  it("renders a structurally distinct preview per chart type and describes it in the aria-label", () => {
    const layouts = [{
      ...workspace.layouts[0],
      id: "layout-line",
      name: "North trend line",
      spec: { datasetId: "chapter:north:health-trend", chartType: "line", title: "North trend line" },
    }];
    const lineWorkspace = { ...workspace, layouts };
    render(<AnalyticsCoreDesk
      snapshot={createPreviewAnalyticsSnapshot()}
      workspace={lineWorkspace}
      viewer={createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] })}
    />);

    const signature = (article) => {
      if (article.querySelector("table")) return "table";
      if (article.querySelector("svg polygon")) return "area";
      if (article.querySelector("svg polyline")) return "line";
      if (article.querySelector(".mi1-ana-chart__segment")) return "stacked_bar";
      if (article.querySelector(".mi1-ana-chart__track")) return "bar";
      return "none";
    };
    const studioPreview = () => {
      const heading = screen.getByRole("heading", { name: "North health trend" });
      return heading.closest("article");
    };

    showAnalyticsView("Charts studio");
    const chartTypeSelect = screen.getByLabelText("Chart type");
    const signatures = {};
    for (const type of ["bar", "stacked_bar", "line", "area", "table"]) {
      fireEvent.change(chartTypeSelect, { target: { value: type } });
      const article = studioPreview();
      signatures[type] = signature(article);
      expect(signatures[type]).toBe(type);
    }
    expect(Object.keys(signatures)).toHaveLength(5);
    expect(new Set(Object.values(signatures))).toHaveLength(5);

    const ariaLabel = (type) => {
      fireEvent.change(chartTypeSelect, { target: { value: type } });
      const graphic = studioPreview().querySelector('[role="img"]');
      return graphic ? graphic.getAttribute("aria-label") : null;
    };
    expect(ariaLabel("line")).toBe("North health trend, line chart");
    expect(ariaLabel("line")).not.toBe("line");
    expect(ariaLabel("stacked_bar")).toBe("North health trend, stacked bar chart");
    expect(ariaLabel("stacked_bar")).not.toBe("stacked_bar");
    expect(ariaLabel("area")).toBe("North health trend, area chart");

    showAnalyticsView("Campaign charts");
    const lineLayout = screen.getByRole("heading", { name: "North trend line" }).closest("article");
    expect(signature(lineLayout)).toBe("line");
    expect(lineLayout.querySelector(".mi1-ana-chart--line")).not.toBeNull();
    expect(lineLayout.querySelector(".mi1-ana-chart__track")).toBeNull();
    expect(lineLayout.querySelector('[role="img"]').getAttribute("aria-label")).toBe("North health trend, line chart");
  });

  it("renders seeded chapter-chart layouts with chartType line as a line graphic", () => {
    render(<AnalyticsCoreDesk
      snapshot={createPreviewAnalyticsSnapshot()}
      workspace={createPreviewAnalyticsWorkspace(new Date("2026-09-21T12:00:00Z"))}
      viewer={createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] })}
    />);
    showAnalyticsView("Campaign charts");
    const article = screen.getByRole("heading", { name: "North Campaign scorecard" }).closest("article");
    expect(article.querySelector(".mi1-ana-chart--line")).not.toBeNull();
    expect(article.querySelector("svg polyline")).not.toBeNull();
    expect(article.querySelector(".mi1-ana-chart__track")).toBeNull();
    expect(article.querySelector('[role="img"]').getAttribute("aria-label")).toBe("North Campaign health trend, line chart");
  });

  it("falls back to the bar graphic for an unknown persisted chart type", () => {
    render(<ChapterChartsPanel workspace={{
      state: "ready",
      datasets: workspace.datasets,
      chapters: [{ chapterId: "north", chapterName: "North Chapter" }],
      chapterCharts: [{
        id: "layout-unknown",
        name: "Legacy layout",
        chapterId: "north",
        spec: { datasetId: "chapter:north:health-trend", chartType: "sparkle", title: "Legacy layout" },
      }],
    }} />);
    const article = screen.getByRole("heading", { name: "Legacy layout" }).closest("article");
    expect(article.querySelector(".mi1-ana-chart--bar")).not.toBeNull();
    expect(article.querySelector(".mi1-ana-chart__track")).not.toBeNull();
    expect(article.querySelector("svg")).toBeNull();
    expect(article.querySelector('[role="img"]').getAttribute("aria-label")).toBe("North health trend, bar chart");
    expect(article.querySelector('[role="img"]').getAttribute("aria-label")).not.toContain("sparkle");
  });
});

// Record 8435: Save layout keeps focus while the layout is saved, and the
// studio's one lock refuses a second save or a removal in the same tick.
describe("chart layouts while one is saved", () => {
  const studio = (onSaveLayout, onDeleteLayout = vi.fn(async () => ({ ok: true }))) => {
    vi.stubGlobal("crypto", { randomUUID: () => "11111111-1111-4111-8111-111111111111" });
    render(<AnalyticsCoreDesk snapshot={createPreviewAnalyticsSnapshot()} workspace={workspace}
      viewer={createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] })} onSaveLayout={onSaveLayout} onDeleteLayout={onDeleteLayout} />);
    showAnalyticsView("Charts studio");
    fireEvent.change(screen.getByRole("textbox", { name: "Layout name" }), { target: { value: "Health briefing" } });
    return { save: screen.getByRole("button", { name: "Save layout" }), remove: screen.getByRole("button", { name: "Remove" }) };
  };

  it("keeps Save layout focused while the layout is saved, and saves once", async () => {
    const onSaveLayout = vi.fn(async () => ({ ok: true }));
    try {
      await expectHeldWriteFocus(onSaveLayout, studio(onSaveLayout).save);
      expect(onSaveLayout).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it("starts one layout write when Save layout and Remove are activated in one tick", async () => {
    const onSaveLayout = vi.fn(async () => ({ ok: true }));
    const onDeleteLayout = vi.fn(async () => ({ ok: true }));
    try {
      const { save, remove } = studio(onSaveLayout, onDeleteLayout);
      await expectOneWriteFromOneTick([onSaveLayout, onDeleteLayout], [() => fireEvent.click(save), () => fireEvent.click(save), () => fireEvent.click(remove)]);
    } finally { vi.unstubAllGlobals(); }
  });
});

