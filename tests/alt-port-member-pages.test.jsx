import { readFileSync } from "node:fs";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AltPageHero, { PAGE_LEDES } from "../src/alt/AltPageHero.jsx";
import AltPageKpis, { pageKpis } from "../src/alt/AltPageKpis.jsx";
import { memberPageTitle } from "../src/alt/nav.js";
import { altShellCatalogue } from "../src/lib/i18n/altShell.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";

// REQ-UG-ALT-PORT-MEMBER-PAGES-20261030: every member page under the
// alternate shell opens with the prototype's page hero.

describe("memberPageTitle", () => {
  it("names a worker destination by its own label, and nothing a worker item does not mount", () => {
    const en = (key, vars) => t("en", key, vars);
    expect(memberPageTitle(en, "events")).toBe("Meetings");
    expect(memberPageTitle(en, "voting")).toBe(t("en", "nav.voting"));
    expect(memberPageTitle(en, "memberSupport")).toBe(t("en", "nav.memberSupport"));
    expect(memberPageTitle(en, "steward")).toBeNull();
  });
});

describe("AltPageHero", () => {
  it("draws crumbs, the title for sight only and the prototype page's lede", () => {
    const onOpenHome = vi.fn();
    render(<LanguageProvider lang="en"><AltPageHero title="Meetings" view="events" onOpenHome={onOpenHome} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("link", { name: "Now" }));
    expect(onOpenHome).toHaveBeenCalled();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(document.querySelector(".ug-alt-hero-title")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText(altShellCatalogue.en["altShell.pageLede_calendar"])).toBeInTheDocument();
  });
  it("has no lede for a page the prototype did not have, and renders nothing without a title", () => {
    const { container, rerender } = render(<LanguageProvider lang="es"><AltPageHero title="Tarjeta" view="card" /></LanguageProvider>);
    expect(container.querySelector(".ug-lede")).toBeNull();
    expect(screen.getByText("Ahora")).toBeInTheDocument();
    rerender(<LanguageProvider lang="es"><AltPageHero title={null} view="card" /></LanguageProvider>);
    expect(container).toBeEmptyDOMElement();
  });
  it("carries every lede in English and Spanish", () => {
    for (const key of Object.values(PAGE_LEDES)) {
      expect(altShellCatalogue.en[key], key).toBeTruthy();
      expect(altShellCatalogue.es[key], key).toBeTruthy();
    }
  });
});

const NOW = new Date("2026-10-30T12:00:00Z");
const value = (rows, key) => rows.find((row) => row.key === key)?.value;

describe("pageKpis", () => {
  it("counts the worker's votes, votes and open surveys", () => {
    const rows = pageKpis("voting", {
      planItems: [
        { kind: "ballot" },
        { kind: "ballot", receiptCode: "R1" },
        { kind: "ballot", closed: true, receiptCode: "R2" },
        { kind: "pulse" },
        // Pulse items carry closed, never done (BUG-UG-ALT-EVENTS-DEADLINE-COUNT-AND-CIVIC-TITLE-20261102).
        { kind: "pulse", closed: true },
      ],
    }, NOW);
    expect(rows.map((row) => row.key)).toEqual(["open", "voted", "closed", "surveys"]);
    expect([value(rows, "open"), value(rows, "voted"), value(rows, "closed"), value(rows, "surveys")]).toEqual([1, 2, 1, 1]);
  });
  it("counts upcoming meetings, RSVPs, this year's check-ins and deadlines, skipping cancelled ones", () => {
    const rows = pageKpis("events", {
      events: [
        { rsvpStatus: "going", eventKind: "meeting" },
        { eventKind: "deadline" },
        // A date-only event is a calendar day, not a deadline.
        { eventKind: "date_only" },
        { eventKind: "meeting", cancelledAt: "2026-10-01" },
        { isPast: true, checkedIn: true, startsAt: "2026-03-02T10:00:00Z" },
        { isPast: true, checkedIn: true, eventDate: "2025-03-02" },
      ],
    }, NOW);
    expect([value(rows, "upcoming"), value(rows, "going"), value(rows, "attended"), value(rows, "deadlines")]).toEqual([3, 1, 1, 1]);
  });
  it("reads the worker's numbers, campaigns and support figures, leaving unknown ones empty", () => {
    expect(pageKpis("numbers", { metrics: { casesHandled: 4, openCases: 1, resolvedCases: 3, tasksDone: 7 } }, NOW).map((row) => row.value)).toEqual([4, 1, 3, 7]);
    expect(pageKpis("numbers", {}, NOW).map((row) => row.value)).toEqual([0, 0, 0, 0]);
    const hub = pageKpis("hub", { member: { chapterMemberships: [{}, {}], sinceYear: 2019 }, chapterStewards: [{}], events: [{}, { eventKind: "deadline" }] }, NOW);
    expect(hub.map((row) => row.value)).toEqual([2, 1, 1, 2019]);
    expect(value(pageKpis("hub", { member: { chapterId: "c1" } }, NOW), "chapters")).toBe(1);
    expect(value(pageKpis("hub", {}, NOW), "since")).toBeNull();
    const rights = pageKpis("rights", { rights: { lessonRecords: [{ steps: [1, 2], completedSteps: [1, 2] }, { steps: [1], completedSteps: [] }, {}] } }, NOW);
    expect([value(rights, "lessons"), value(rights, "lessonsDone"), value(rights, "stewards"), value(rights, "openCases")]).toEqual([3, 1, 0, 0]);
    expect(pageKpis("memberSupport", {}, NOW).map((row) => row.key)).toEqual(["lessons", "lessonsDone", "stewards", "openCases"]);
    const settings = pageKpis("settings", { rewards: { totalPoints: 1200 }, planItems: [{ kind: "ballot", receiptCode: "R" }] }, NOW);
    expect(settings.map((row) => row.value)).toEqual([0, 1, 1200, null]);
    expect(pageKpis("card", {}, NOW)).toBeNull();
  });
});

describe("AltPageKpis", () => {
  it("draws the row as a labelled description list, a dash for an unknown figure and the year as written", () => {
    render(<LanguageProvider lang="en"><AltPageKpis view="hub" data={{ member: { sinceYear: 2019 } }} now={NOW} /></LanguageProvider>);
    const region = screen.getByRole("region", { name: altShellCatalogue.en["altShell.kpisLabel"] });
    expect(region.querySelectorAll(".ug-kpi")).toHaveLength(4);
    expect(screen.getByText(altShellCatalogue.en["altShell.kpi_since"])).toBeInTheDocument();
    expect(screen.getByText("2019")).toBeInTheDocument();
    render(<LanguageProvider lang="es"><AltPageKpis view="settings" data={{}} /></LanguageProvider>);
    expect(screen.getAllByText("—")).toHaveLength(2);
  });
  it("renders nothing on a page without figures", () => {
    const { container } = render(<LanguageProvider lang="en"><AltPageKpis view="card" data={{}} /></LanguageProvider>);
    expect(container).toBeEmptyDOMElement();
  });
  it("carries every figure label in English and Spanish", () => {
    const views = ["voting", "events", "numbers", "hub", "rights", "settings"];
    const keys = new Set(views.flatMap((view) => pageKpis(view, {}, NOW).map((row) => `altShell.kpi_${row.key}`)));
    for (const key of [...keys, "altShell.kpisLabel"]) {
      expect(altShellCatalogue.en[key], key).toBeTruthy();
      expect(altShellCatalogue.es[key], key).toBeTruthy();
    }
  });
});

describe("the hero's hidden page heading", () => {
  const pagesCss = readFileSync("src/alt/styles/pages.css", "utf8");
  const appSource = readFileSync("src/App.jsx", "utf8");
  function headingPosition(pageClass) {
    const style = document.createElement("style");
    style.textContent = pagesCss;
    document.head.append(style);
    document.body.innerHTML = `<div class="ugalt"><div class="ug-legacy-page ${pageClass}"><div class="ug-wrap ug-legacy"><h1>Your officials</h1></div></div></div>`;
    const position = getComputedStyle(document.querySelector("h1")).position;
    style.remove();
    document.body.innerHTML = "";
    return position;
  }

  it("hides a page h1 the hero repeats but keeps Civic's own page title visible", () => {
    expect(headingPosition("ug-with-hero")).toBe("absolute");
    expect(headingPosition("ug-with-hero ug-keep-h1")).not.toBe("absolute");
    expect(appSource).toMatch(/const HERO_KEEPS_PAGE_H1 = new Set\(\["civic"\]\);/);
    expect(appSource).toContain('${HERO_KEEPS_PAGE_H1.has(altView) ? " ug-keep-h1" : ""}');
  });
});
