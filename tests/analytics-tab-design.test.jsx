// The staff Analytics page built to the October 2 design direction
// (REQ-UG-WEB-ANALYTICS-TAB-OCTOBER-DESIGN-20261002) and the seven
// census defects delivered with it. Each describe block names its record.
import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import {
  ANALYTICS_DESK_TABS,
  ANALYTICS_SECTION_IDS,
  ANALYTICS_SECTIONS,
  ANALYTICS_STATS_TABS,
} from "../src/features/analytics/contract.js";
import { createAnalyticsCoreAdapter } from "../src/features/analytics/adapter.js";
import {
  composeAnalyticsCore,
  createPreviewAnalyticsSnapshot,
  createPreviewAnalyticsViewer,
  createPreviewAnalyticsWorkspace,
} from "../src/features/analytics/index.js";
import { AnalyticsCoreDesk } from "../src/features/analytics/ui/AnalyticsCoreDesk.jsx";
import { SPA_ROUTE_PATHS } from "../src/lib/appRoutes.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { buildMi1AnalyticsActor, createAnalyticsSnapshotLoader, createAnalyticsWorkspaceLoader } from "../src/lib/mi1AnalyticsWiring.js";
import { TAB_PAGE_GROUPS, WORKSPACE_PATH_VIEWS } from "../src/lib/workspacePages.js";
import { AnalyticsCoreView } from "../src/views/AnalyticsCoreView.jsx";
import { analyticsViewOptions, showAnalyticsView } from "./helpers/analyticsView.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const css = readFileSync("src/features/analytics/analyticsCore.css", "utf8");
const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

function adminViewer(overrides = {}) {
  return createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"], ...overrides });
}

function renderDesk(props, lang = "en") {
  return render(<LanguageProvider lang={lang}><AnalyticsCoreDesk {...props} /></LanguageProvider>);
}

function tileTexts() {
  return [...document.querySelectorAll(".mi1-ana-tile")].map((tile) => tile.textContent);
}

afterEach(() => {
  window.history.replaceState({}, "", "/m");
  vi.useRealTimers();
});

describe("BUG-UG-WEB-ANALYTICS-SEVENTEEN-PILLS-IN-TWO-WRAPPING-TRAYS-20261002", () => {
  it("renders one level of section tabs and one labelled view selector, never two pill trays", () => {
    renderDesk({ snapshot: createPreviewAnalyticsSnapshot(), viewer: adminViewer() });
    const nav = screen.getByRole("navigation", { name: "Analytics sections" });
    expect(within(nav).getAllByRole("button").map((node) => node.textContent))
      .toEqual(["Stats", "Activity", "Patterns", "Charts"]);
    expect(screen.getAllByRole("combobox", { name: "Show" })).toHaveLength(1);
    expect(document.querySelector(".mwl-tabs, .mi1-ana__tabs, .mi1-ana__subtabs")).toBeNull();
    expect(screen.queryByRole("group", { name: "Organization analytics" })).toBeNull();
    expect(analyticsViewOptions()).toEqual(["Overview", "Campaigns", "Issue categories", "Issues", "Committee", "Participation", "Comparison"]);

    fireEvent.click(within(nav).getByRole("button", { name: "Charts" }));
    expect(analyticsViewOptions()).toEqual(["Explorer", "Charts studio", "Campaign charts"]);
  });

  it("keeps every former desk tab and stats tab reachable through exactly one section", () => {
    const views = ANALYTICS_SECTION_IDS.flatMap((id) => ANALYTICS_SECTIONS[id]);
    expect(new Set(views).size).toBe(views.length);
    expect([...views].sort()).toEqual(
      [...ANALYTICS_STATS_TABS, ...ANALYTICS_DESK_TABS.filter((id) => id !== "stats")].sort(),
    );
  });

  it("routes each section to its own address, served by the SPA rewrites", () => {
    expect(TAB_PAGE_GROUPS.analytics).toEqual({ view: "analytics", base: "/m/analytics", tabs: ["stats", "activity", "patterns", "charts"] });
    const sources = new Set(vercel.rewrites.map((entry) => entry.source));
    for (const id of ANALYTICS_SECTION_IDS) {
      expect(WORKSPACE_PATH_VIEWS[`/m/analytics/${id}`]).toBe("analytics");
      expect(SPA_ROUTE_PATHS).toContain(`/m/analytics/${id}`);
      expect(sources.has(`/m/analytics/${id}`)).toBe(true);
    }
  });

  it("shows the section from the URL and moves the URL when a section tab is used", () => {
    window.history.replaceState({}, "", "/m/analytics/patterns");
    function Host() {
      const [location, setLocation] = useState(window.location.pathname);
      const navigate = (_view, href) => {
        window.history.pushState({}, "", href);
        setLocation(href);
      };
      return (
        <LanguageProvider lang="en">
          <WorkspacePages view="analytics" hat="admin" location={location} navigate={navigate}>
            <AnalyticsCoreDesk snapshot={createPreviewAnalyticsSnapshot()} viewer={adminViewer()} />
          </WorkspacePages>
        </LanguageProvider>
      );
    }
    render(<Host />);
    const nav = screen.getByRole("navigation", { name: "Analytics sections" });
    const patterns = within(nav).getByRole("link", { name: "Patterns" });
    expect(patterns).toHaveAttribute("href", "/m/analytics/patterns");
    expect(patterns).toHaveAttribute("aria-current", "page");
    expect(analyticsViewOptions()).toEqual(["Insights", "Heatmaps", "Health tree"]);

    fireEvent.click(within(nav).getByRole("link", { name: "Activity" }));
    expect(window.location.pathname).toBe("/m/analytics/activity");
    expect(within(nav).getByRole("link", { name: "Activity" })).toHaveAttribute("aria-current", "page");
    expect(analyticsViewOptions()).toEqual(["Usage", "Engagement", "Attendance"]);
  });
});

describe("BUG-UG-WEB-ANALYTICS-PHONE-FIRST-SCREEN-HAS-NO-NUMBER-20261002", () => {
  it("puts only the header, one tab row and one selector before the stat tiles", () => {
    const viewer = createPreviewAnalyticsViewer({ selectedHat: "steward", roles: ["steward"] });
    renderDesk({ snapshot: createPreviewAnalyticsSnapshot(), viewer });
    const root = document.querySelector(".screen.mi1-ana");
    const ready = root.querySelector(".mi1-ana__ready");
    const beforeTiles = [...ready.children].slice(0, [...ready.children].findIndex((node) => node.classList.contains("mi1-ana__grid")));
    expect(beforeTiles.map((node) => node.className)).toEqual(["mi1-ana__sections", "mi1-ana__toolbar"]);
    const outside = [...root.children].filter((node) => node !== ready);
    expect(outside.map((node) => node.tagName)).toEqual(["HEADER", "P"]);
    expect(outside[1]).toHaveTextContent("PREVIEW figures");
  });

  it("reflows at 320px with 48px targets and nothing fixed-width (stylesheet contract)", () => {
    const touch = css.slice(css.indexOf("@media (pointer: coarse), (max-width: 767px)"));
    expect(touch).toMatch(/\.mi1-ana__button,\s*\.mi1-ana__view\s*\{\s*min-height:\s*48px;\s*\}/);
    expect(touch).toMatch(/\.mi1-ana__sections \.mi1-ana__section\s*\{[^}]*min-height:\s*48px;/);
    expect(touch).toMatch(/\.mi1-ana__sections \.mi1-ana__section\s*\{[^}]*min-width:\s*48px;/);
    const phone = css.slice(css.lastIndexOf("@media (max-width: 767px)"));
    expect(phone).toMatch(/\.mi1-ana__view\s*\{[^}]*min-width:\s*0;/);
    expect(phone).toMatch(/\.mi1-ana__grid\s*\{\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);\s*\}/);
    expect(css).not.toMatch(/\.mi1-ana__(?:sub)?tabs/);
    expect(rule(".mi1-ana__sections")).not.toMatch(/flex-wrap:\s*wrap/);
    const pageRules = css.slice(css.indexOf("October 2 page rules"), css.indexOf("@media (pointer: coarse), (max-width: 767px)"));
    expect(pageRules).not.toMatch(/(?:^|[\s;{])(?:min-)?width:\s*\d{3,}px/);
  });

  it("lets Spanish section labels wrap inside shrinkable cells in the single row", () => {
    renderDesk({ snapshot: createPreviewAnalyticsSnapshot(), viewer: adminViewer() }, "es");
    const nav = screen.getByRole("navigation", { name: "Apartados de analítica" });
    expect(within(nav).getAllByRole("button").map((node) => node.textContent))
      .toEqual(["Estadísticas", "Actividad", "Patrones", "Gráficas"]);
    const narrow = css.slice(css.lastIndexOf("@media (max-width: 767px)"));
    expect(rule(".mi1-ana__sections .mi1-ana__section")).toMatch(/min-width:\s*0;/);
    expect(narrow).toMatch(/\.mi1-ana__sections \.mi1-ana__section\s*\{[^}]*white-space:\s*normal;/);
    expect(narrow).toMatch(/\.mi1-ana__sections \.mi1-ana__section\s*\{[^}]*overflow-wrap:\s*anywhere;/);
    expect(rule(".mi1-ana__sections")).not.toMatch(/flex-wrap:\s*wrap/);
  });
});

describe("BUG-UG-WEB-ANALYTICS-EXPORT-NOTE-NO-GUTTER-OUTRANKS-SUBTITLE-20261002", () => {
  it("says why Export is missing inside the page header at the 13px meta size", () => {
    const viewer = createPreviewAnalyticsViewer({ selectedHat: "steward", roles: ["steward"] });
    renderDesk({ snapshot: createPreviewAnalyticsSnapshot(), viewer });
    const note = screen.getByText(t("en", "analytics.exportDenied"));
    expect(note.closest("header.phead")).not.toBeNull();
    expect(note).toHaveClass("mi1-ana__head-note");
    expect(screen.queryByRole("button", { name: "Export CSV" })).toBeNull();
    expect(rule(".mi1-ana__head-note")).toMatch(/font-size:\s*13px/);
    expect(rule(".mi1-ana__head .phead__sub")).toMatch(/font-size:\s*15px/);
  });
});

describe("BUG-UG-WEB-ANALYTICS-STAT-TILES-SHOW-ONLY-A-DASH-20261002", () => {
  const stewardPrivacy = { en: t("en", "analytics.tileHiddenStewards"), es: t("es", "analytics.tileHiddenStewards") };
  const casePrivacy = { en: t("en", "analytics.tileNoCaseGroups"), es: t("es", "analytics.tileNoCaseGroups") };

  function hostedLikeSnapshot({ smallChapter = true, stewardsWithheld = true, cases = true } = {}) {
    const snapshot = createPreviewAnalyticsSnapshot();
    delete snapshot.label;
    snapshot.chapters = snapshot.chapters.map((chapter, index) => ({
      ...chapter,
      memberCount: smallChapter && index === 3 ? null : chapter.memberCount,
      stewardCount: stewardsWithheld ? null : chapter.stewardCount,
    }));
    if (!cases) snapshot.cases = [];
    return snapshot;
  }

  it("shows the total over the published chapters instead of a dash when one chapter is under the floor", () => {
    const desk = composeAnalyticsCore({ snapshot: hostedLikeSnapshot(), viewer: adminViewer() });
    expect(desk.stats.overview.openCases).toBeNull();
    const published = desk.stats.chapters.rows.reduce((sum, row) => sum + row.openCases, 0);
    renderDesk({ model: desk });
    const texts = tileTexts();
    expect(texts).toHaveLength(6);
    for (const text of texts) expect(text).not.toMatch(/—/);
    expect(texts[0]).toContain(String(published));
    expect(texts[0]).toContain("In 3 of 4 campaigns");
    expect(texts[3]).toBe(`Committee${stewardPrivacy.en}`);
    expect(texts[5]).toBe("Campaigns4");
  });

  it.each(["en", "es"])("withholds totals for 30 published open cases and 20 omitted resolved cases (%s)", (lang) => {
    const snapshot = hostedLikeSnapshot();
    delete snapshot.caseGroupsComplete;
    snapshot.cases = [{ organizationId: snapshot.organizationId, chapterId: "north", status: "active", step: 0, workplaceKey: "contract", count: 30 }];
    const desk = composeAnalyticsCore({ snapshot, viewer: adminViewer() });
    expect(desk.stats.overview.publishedChapterTotals).toBeNull();
    const missing = lang === "en"
      ? "Issue totals are hidden because some groups may be withheld to protect small groups."
      : "Los totales de asuntos están ocultos porque algunos grupos pueden reservarse para proteger a grupos pequeños.";
    renderDesk({ model: desk }, lang);
    for (const index of [0, 1, 2, 4]) {
      const tile = document.querySelectorAll(".mi1-ana-tile")[index];
      expect(tile.querySelector(".mi1-ana-tile__value")).toBeNull();
      expect(tile).toHaveTextContent(index === 4 ? stewardPrivacy[lang] : missing);
    }
    showAnalyticsView(lang === "en" ? "Campaigns" : "Campañas");
    expect(screen.queryByText(missing)).toBeNull();
    const north = screen.getByRole("row", { name: "PREVIEW north 30" });
    expect(within(north).getAllByRole("cell")[1]).toHaveTextContent("30");
  });

  it.each([
    ["en", "snapshot"], ["es", "snapshot"], ["en", "chapters"], ["es", "chapters"],
  ])("shows scoped totals with completeness proven in %s by %s", (lang, source) => {
    const snapshot = hostedLikeSnapshot();
    if (source === "chapters") {
      delete snapshot.caseGroupsComplete;
      snapshot.chapters = snapshot.chapters.map((chapter) => ({
        ...chapter,
        caseGroupsComplete: chapter.memberCount != null,
      }));
    }
    snapshot.cases = [
      { organizationId: snapshot.organizationId, chapterId: "north", status: "active", step: 0, count: 30 },
      { organizationId: snapshot.organizationId, chapterId: "north", status: "resolved", step: 2, count: 20 },
    ];
    renderDesk({ snapshot, viewer: adminViewer() }, lang);
    const tiles = [...document.querySelectorAll(".mi1-ana-tile")];
    expect(tiles[0].querySelector(".mi1-ana-tile__value")).toHaveTextContent("30");
    expect(tiles[1].querySelector(".mi1-ana-tile__value")).toHaveTextContent("20");
    expect(tiles[2].querySelector(".mi1-ana-tile__value")).toHaveTextContent("40%");
    expect(tiles[0]).toHaveTextContent(lang === "en" ? "In 3 of 4 campaigns" : "En 3 de 4 campañas");
  });

  it.each(["en", "es"])("preserves Main's organization and chapter figures without completeness flags above the member floor (%s)", (lang) => {
    const snapshot = hostedLikeSnapshot({ smallChapter: false, stewardsWithheld: false });
    delete snapshot.caseGroupsComplete;
    snapshot.chapters = snapshot.chapters.map((chapter) => ({ ...chapter, memberCount: 100, stewardCount: 25 }));
    snapshot.cases = [
      { organizationId: snapshot.organizationId, chapterId: "north", status: "active", count: 30 },
      { organizationId: snapshot.organizationId, chapterId: "north", status: "resolved", count: 20 },
      { organizationId: snapshot.organizationId, chapterId: "south", status: "active", count: 50 },
      { organizationId: snapshot.organizationId, chapterId: "south", status: "resolved", count: 25 },
    ];
    const desk = composeAnalyticsCore({ snapshot, viewer: adminViewer() });
    expect(desk.stats.overview).toMatchObject({
      openCases: 80, resolvedCases: 45, resolutionRate: 36,
      stewardCount: 100, averageOpenPerSteward: 0.8, casesSuppressed: false,
      publishedChapterTotals: null, publishedChapterTotalsIncomplete: false,
    });
    const expectedRows = [
      { id: "south", openCases: 50, resolvedCases: 25, averageOpenPerSteward: 2 },
      { id: "north", openCases: 30, resolvedCases: 20, averageOpenPerSteward: 1.2 },
      { id: "east", openCases: 0, resolvedCases: 0, averageOpenPerSteward: 0 },
      { id: "west", openCases: 0, resolvedCases: 0, averageOpenPerSteward: 0 },
    ];
    expect(desk.stats.chapters.rows).toMatchObject(expectedRows);
    expect(desk.stats.comparison.rows).toMatchObject(expectedRows);
    expect(desk.stats.stewards).toMatchObject({ openCases: 80, stewardCount: 100, averageOpenPerSteward: 0.8 });
    renderDesk({ model: desk }, lang);
    const values = [...document.querySelectorAll(".mi1-ana-tile__value")].map((node) => node.textContent);
    expect(values).toEqual(["80", "45", "36%", "100", "0.8", "4"]);
    for (const view of lang === "en" ? ["Campaigns", "Comparison"] : ["Campañas", "Comparación"]) {
      showAnalyticsView(view);
      expect(screen.getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[1].textContent))
        .toEqual(["50", "30", "0", "0"]);
    }
  });

  it("says no case group reached the floor instead of a zero when no case rows arrive", () => {
    renderDesk({ model: composeAnalyticsCore({ snapshot: hostedLikeSnapshot({ smallChapter: false, cases: false }), viewer: adminViewer() }) });
    const texts = tileTexts();
    expect(texts[0]).toBe(`Open issues${casePrivacy.en}`);
    for (const text of texts) expect(text).not.toMatch(/—/);
  });

  it.each([
    ["en", "Committee"],
    ["es", "Comité"],
  ])("explains both publication floors for withheld steward counts (%s)", (lang, view) => {
    // A chapter with 100 members and 95 stewards is suppressed by the server:
    // its five other members remain below the complementary-group floor.
    const snapshot = hostedLikeSnapshot({ smallChapter: false });
    snapshot.chapters = snapshot.chapters.map((chapter) => ({ ...chapter, memberCount: 100 }));
    renderDesk({ model: composeAnalyticsCore({ snapshot, viewer: adminViewer() }) }, lang);
    expect(document.querySelectorAll(".mi1-ana-tile")[3]).toHaveTextContent(stewardPrivacy[lang]);
    showAnalyticsView(view);
    expect(document.querySelector(".mi1-ana-tile")).toHaveTextContent(stewardPrivacy[lang]);
  });

  it.each(["en", "es"])("keeps all case-derived tiles missing with published steward counts and no case rows (%s)", (lang) => {
    const snapshot = hostedLikeSnapshot({ smallChapter: false, stewardsWithheld: false, cases: false });
    snapshot.chapters = snapshot.chapters.map((chapter) => ({ ...chapter, memberCount: 100, stewardCount: 25 }));
    renderDesk({ model: composeAnalyticsCore({ snapshot, viewer: adminViewer() }) }, lang);
    const missing = casePrivacy[lang];
    const tiles = [...document.querySelectorAll(".mi1-ana-tile")];
    for (const index of [0, 1, 2, 4]) {
      expect(tiles[index].querySelector(".mi1-ana-tile__value")).toBeNull();
      expect(tiles[index]).toHaveTextContent(missing);
    }
    expect(tiles[3].querySelector(".mi1-ana-tile__value")).toHaveTextContent("100");
    expect(tiles[5].querySelector(".mi1-ana-tile__value")).toHaveTextContent("4");
    showAnalyticsView(lang === "en" ? "Committee" : "Comité");
    const stewardTiles = [...document.querySelectorAll(".mi1-ana-tile")];
    expect(stewardTiles[0].querySelector(".mi1-ana-tile__value")).toHaveTextContent("100");
    for (const tile of stewardTiles.slice(1)) {
      expect(tile.querySelector(".mi1-ana-tile__value")).toBeNull();
      expect(tile).toHaveTextContent(missing);
    }
  });

  it("retains a known zero for open cases when published case groups are all resolved", () => {
    const snapshot = hostedLikeSnapshot({ smallChapter: false, stewardsWithheld: false });
    snapshot.chapters = snapshot.chapters.map((chapter) => ({ ...chapter, memberCount: 100, stewardCount: 25 }));
    snapshot.cases = snapshot.cases.map((row) => ({ ...row, status: "resolved" }));
    renderDesk({ model: composeAnalyticsCore({ snapshot, viewer: adminViewer() }) });
    expect(tileTexts()[0]).toBe("Open issues0");
    expect(tileTexts()[4]).toBe("Open per committee member0");
    showAnalyticsView("Committee");
    expect(tileTexts().slice(1)).toEqual(["Open issues0", "Average open0"]);
  });

  it("never draws a dash in the usage, membership, engagement or attendance tiles", () => {
    const snapshot = createPreviewAnalyticsSnapshot();
    snapshot.usageWindows = { ...snapshot.usageWindows, dau: null, wau: null };
    snapshot.membership = { ...snapshot.membership, newIn90: null };
    renderDesk({ snapshot, viewer: adminViewer() });
    for (const view of ["Participation", "Usage", "Engagement", "Attendance"]) {
      showAnalyticsView(view);
      for (const text of tileTexts()) expect(text).not.toMatch(/—/);
    }
    showAnalyticsView("Usage");
    expect(tileTexts().filter((text) => text.includes("Hidden to protect small groups"))).toHaveLength(2);
  });
});

describe("BUG-UG-WEB-ANALYTICS-THIRD-FAILURE-PANEL-DESIGN-20261002", () => {
  it.each([
    ["empty", { viewer: { selectedHat: "admin", roles: ["admin"] } }, "No organization yet", false],
    ["unauthorized", { viewer: adminViewer({ selectedHat: "member" }), snapshot: createPreviewAnalyticsSnapshot() }, "Analytics isn't open to this role", false],
    ["unset", { viewer: adminViewer() }, "Analytics isn't connected here", false],
    ["error", { model: { state: "error", reason: "snapshot_failed" }, onRetry: () => {} }, "Analytics could not load", true],
  ])("renders the %s state as one state block under the page header", (_name, props, title, retry) => {
    renderDesk(props);
    const blocks = document.querySelectorAll("[data-state-block]");
    expect(blocks).toHaveLength(1);
    expect(document.querySelector(".empty-state")).toBeNull();
    const header = document.querySelector(".screen.mi1-ana > header.phead");
    expect(header.compareDocumentPosition(blocks[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(blocks[0]).getByRole("heading", { level: 2, name: title })).toBeInTheDocument();
    expect(within(blocks[0]).queryAllByRole("button")).toHaveLength(retry ? 1 : 0);
    if (retry) expect(blocks[0]).toHaveTextContent("This page only reads figures, so nothing was lost.");
  });
});

// BUG-UG-SAMPLE-ORGANIZATION-ANALYTICS-ALWAYS-TIMES-OUT-20261122 (#9556,
// unit 1): every analytics failure panel is a failed read, so it says the page
// only reads figures instead of "Nothing was changed", in both languages.
describe("analytics read failures say the page only reads (#9556)", () => {
  const COPY = {
    en: { safe: "This page only reads figures, so nothing was lost.", old: "Nothing was changed.", desk: "Analytics took too long", charts: "These charts took too long", view: "Health tree", retry: "Try again" },
    es: { safe: "Esta página solo lee cifras, así que no se perdió nada.", old: "No se cambió nada.", desk: "La analítica tardó demasiado", charts: "Estas gráficas tardaron demasiado", view: "Árbol de salud", retry: "Intentar de nuevo" },
  };

  it.each(["en", "es"])("says so when the desk read times out (%s)", (lang) => {
    const onRetry = vi.fn();
    renderDesk({ model: { state: "error", reason: "timed_out" }, onRetry }, lang);
    const block = document.querySelector("[data-state-block='error']");
    expect(within(block).getByRole("heading", { level: 2, name: COPY[lang].desk })).toBeInTheDocument();
    expect(block).toHaveTextContent(COPY[lang].safe);
    expect(block).not.toHaveTextContent(COPY[lang].old);
    fireEvent.click(within(block).getByRole("button", { name: COPY[lang].retry }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it.each(["en", "es"])("says so when a workspace view's read times out (%s)", async (lang) => {
    const desk = await createAnalyticsCoreAdapter({
      fetchSnapshot: async () => createPreviewAnalyticsSnapshot(),
      fetchWorkspace: () => new Promise(() => {}),
    }).loadDesk({ viewer: adminViewer(), deadlineMs: 20 });
    renderDesk({ model: desk, onRetry: () => {} }, lang);
    showAnalyticsView(COPY[lang].view);
    const block = document.querySelector("[data-state-block='error']");
    expect(within(block).getByRole("heading", { name: COPY[lang].charts })).toBeInTheDocument();
    expect(block).toHaveTextContent(COPY[lang].safe);
    expect(block).not.toHaveTextContent(COPY[lang].old);
  });
});

describe("BUG-UG-WEB-ANALYTICS-HOSTED-DEMO-NEVER-SHOWS-A-FIGURE-20261002", () => {
  it("keeps the snapshot's figures when the workspace read hangs past its own deadline", async () => {
    const snapshot = createPreviewAnalyticsSnapshot();
    delete snapshot.label;
    const adapter = createAnalyticsCoreAdapter({
      fetchSnapshot: async () => snapshot,
      fetchWorkspace: () => new Promise(() => {}),
    });
    const desk = await adapter.loadDesk({ viewer: adminViewer(), deadlineMs: 20 });
    expect(desk.state).toBe("ready");
    expect(desk.stats.overview.openCases).toEqual(expect.any(Number));
    expect(desk.workspace).toMatchObject({ state: "error", reason: "timed_out" });

    const onRetry = vi.fn();
    renderDesk({ model: desk, onRetry });
    expect(tileTexts()[0]).toContain(String(desk.stats.overview.openCases));
    showAnalyticsView("Health tree");
    const block = document.querySelector("[data-state-block='error']");
    expect(within(block).getByRole("heading", { name: "These charts took too long" })).toBeInTheDocument();
    fireEvent.click(within(block).getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows a ready workspace normally and a failed snapshot as the desk's error", async () => {
    const ready = await createAnalyticsCoreAdapter({
      fetchSnapshot: async () => createPreviewAnalyticsSnapshot(),
      fetchWorkspace: async () => createPreviewAnalyticsWorkspace(),
    }).loadDesk({ viewer: adminViewer(), deadlineMs: 50 });
    expect(ready.workspace.state).toBe("ready");

    const failed = await createAnalyticsCoreAdapter({
      fetchSnapshot: () => { throw new Error("boom"); },
      fetchWorkspace: async () => createPreviewAnalyticsWorkspace(),
    }).loadDesk({ viewer: adminViewer(), deadlineMs: 50 });
    expect(failed).toMatchObject({ state: "error", reason: "snapshot_failed" });
  });

  it("never substitutes PREVIEW figures on the hosted path when the live reads time out", async () => {
    const client = {
      rpc: vi.fn(async (name) => {
        if (name === "get_my_chapter_memberships") {
          return { data: [{ selected: true, organizationId: ORG, chapterId: "c1", organizationRoles: ["admin"], chapterRoles: [] }], error: null };
        }
        return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
      }),
    };
    render(
      <LanguageProvider lang="en">
        <AnalyticsCoreView
          viewer={buildMi1AnalyticsActor({ userId: "admin-a", organizationId: ORG, roles: ["admin"], mfaSatisfied: true, selectedHat: "admin" })}
          client={client}
        />
      </LanguageProvider>,
    );
    expect(await screen.findByRole("heading", { name: "Analytics took too long" })).toBeInTheDocument();
    expect(screen.queryByText(/PREVIEW/)).toBeNull();
    expect(client.rpc).toHaveBeenCalledWith("get_organization_analytics_snapshot");
  });
});

describe("BUG-UG-WEB-ANALYTICS-TIMEOUT-WORDED-AS-GENERIC-FAILURE-20261002", () => {
  describe.each(["en", "es"])("%s partial workspace refusals", (lang) => {
    it.each([
      ["role", { code: "42501", message: "not authorized" }, null],
      ["two-step", { code: "42501", message: "mfa required" }, null],
      ["unauthorized", null, { organizationId: "another-organization", privacyThreshold: 25 }],
    ])("explains a %s refusal in every workspace view while keeping snapshot figures", async (kind, error, workspace) => {
      const snapshot = createPreviewAnalyticsSnapshot();
      delete snapshot.label;
      const client = { rpc: async (name) => name === "get_organization_analytics_snapshot"
        ? { data: snapshot, error: null }
        : { data: workspace, error } };
      const desk = await createAnalyticsCoreAdapter({
        fetchSnapshot: createAnalyticsSnapshotLoader(client),
        fetchWorkspace: createAnalyticsWorkspaceLoader(client),
      }).loadDesk({ viewer: adminViewer() });
      expect(desk.state).toBe("ready");
      const title = kind === "two-step"
        ? (lang === "en" ? "Finish two-step sign-in" : "Termina el inicio de sesión en dos pasos")
        : (lang === "en" ? "Analytics isn't open to this role" : "La analítica no está abierta para este rol");
      const recovery = kind === "two-step"
        ? (lang === "en" ? "Complete two-step sign-in" : "Completa el inicio de sesión en dos pasos")
        : (lang === "en" ? "Ask an admin if your role is missing." : "Si falta tu rol, pídeselo a un administrador.");
      const views = lang === "en"
        ? ["Health tree", "Explorer", "Charts studio", "Campaign charts"]
        : ["Árbol de salud", "Explorador", "Estudio de gráficas", "Gráficas de campañas"];
      const onRetry = vi.fn();
      renderDesk({ model: desk, onRetry }, lang);
      const figures = tileTexts();
      expect(figures).toHaveLength(6);
      expect(document.querySelectorAll(".mi1-ana-tile__value")).toHaveLength(6);
      for (const view of views) {
        showAnalyticsView(view);
        const blocks = document.querySelectorAll("[data-state-block]");
        expect(blocks).toHaveLength(1);
        expect(within(blocks[0]).getByRole("heading", { name: title })).toBeInTheDocument();
        expect(blocks[0]).toHaveTextContent(recovery);
        expect(within(blocks[0]).queryAllByRole("button")).toHaveLength(0);
      }
      fireEvent.click(within(screen.getByRole("navigation", { name: /^(Analytics sections|Apartados de analítica)$/ })).getAllByRole("button")[0]);
      expect(tileTexts()).toEqual(figures);
      expect(onRetry).not.toHaveBeenCalled();
    });
  });

  it.each([
    [{ code: "57014", message: "canceling statement due to statement timeout" }, { error: "timed_out" }],
    [{ code: "42501", message: "not authorized" }, { unavailable: true, reason: "authorization_required" }],
    [{ code: "42501", message: "mfa required" }, { unavailable: true, reason: "mfa_required" }],
    [{ code: "XX000", message: "internal error" }, { error: "snapshot_failed" }],
  ])("maps snapshot RPC error %o to %o", async (error, expected) => {
    const load = createAnalyticsSnapshotLoader({ rpc: async () => ({ data: null, error }) });
    await expect(load()).resolves.toEqual(expected);
  });

  it("maps a workspace statement timeout to its own reason", async () => {
    const load = createAnalyticsWorkspaceLoader({ rpc: async () => ({ data: null, error: { code: "57014" } }) });
    await expect(load()).resolves.toEqual({ error: "timed_out" });
  });

  it.each([
    ["timed out", { state: "error", reason: "timed_out" }, "Analytics took too long", "The figures did not arrive in time. The server may be busy.", true],
    ["failed", { state: "error", reason: "snapshot_failed" }, "Analytics could not load", "Something went wrong while reading the figures.", true],
    ["refused", { state: "unauthorized", reason: "authorization_required" }, "Analytics isn't open to this role", "Organization analytics opens for the committee, campaign leads, advisors, admins and campaign chairs of this organization. Ask an admin if your role is missing.", false],
    ["two-step", { state: "unauthorized", reason: "mfa_required" }, "Finish two-step sign-in", "Complete two-step sign-in, then retry organization analytics.", false],
    ["empty", { state: "empty", reason: "no_organization" }, "No organization yet", "Analytics shows figures once your account belongs to an organization.", false],
  ])("words a %s desk for what happened", (_name, model, title, body, retry) => {
    renderDesk({ model, onRetry: () => {} });
    expect(screen.getByRole("heading", { level: 2, name: title })).toBeInTheDocument();
    expect(screen.getByText(body)).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: "Try again" })).toHaveLength(retry ? 1 : 0);
  });

  it("words the timeout in Spanish too", () => {
    renderDesk({ model: { state: "error", reason: "timed_out" }, onRetry: () => {} }, "es");
    expect(screen.getByRole("heading", { name: "La analítica tardó demasiado" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Intentar de nuevo" })).toBeInTheDocument();
  });

  it("says the page timed out when the load deadline passes", async () => {
    vi.useFakeTimers();
    const api = { loadDesk: vi.fn(() => new Promise(() => {})), exportDesk: vi.fn() };
    render(
      <LanguageProvider lang="en">
        <AnalyticsCoreView
          viewer={buildMi1AnalyticsActor({ userId: "admin-a", organizationId: ORG, roles: ["admin"], mfaSatisfied: true, selectedHat: "admin" })}
          client={null}
          api={api}
          loadDeadlineMs={100}
        />
      </LanguageProvider>,
    );
    expect(api.loadDesk).toHaveBeenCalledWith(expect.objectContaining({ deadlineMs: 100 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Analytics took too long" })).toBeInTheDocument());
  });
});
