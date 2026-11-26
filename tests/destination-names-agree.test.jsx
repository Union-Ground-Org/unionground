// UX-UG-ONE-PLACE-HAS-SEVERAL-NAMES-ACROSS-RAIL-PAGE-PALETTE-AND-NOTICES-20261122
// (#9527, findings B-10, B-24, A-32): a desktop rail row, the heading of the
// page it opens and the browser tab name one place with one name. This walks
// every rail row of the fixture demo under each hat, in English and Spanish,
// on the real shell, and fails when a row's page is headed or tabbed with a
// different name, unless that row is listed below with its reason. It also
// walks with an organization's renames set, since the Admin rename setting
// promises to rename "the menu and page names people see".
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import AltNowPage from "../src/alt/AltNowPage.jsx";
import { AltShellContext } from "../src/alt/altShellContext.js";
import { catalogue } from "../src/lib/i18n.js";
import { LanguageProvider, organizationTranslator } from "../src/lib/LanguageContext.jsx";
import { demoData } from "../src/data/demoData.js";
import { openCommandPalette } from "../src/lib/commandPalette.js";
import { primeDemoHat } from "./helpers/demoHat.js";

// Rows whose page heading is not the place's name, each with why.
const LISTED_REASONS = {
  // Home greets the member by name; the tab still says which page it is.
  "/m": "greeting",
  // Each staff desk's first row opens the desk overview, headed with the
  // desk's name (Casework desk, Case queue, Chapter health, Chapter admin,
  // Leadership overview).
  "/m/steward": "desk overview",
  "/m/coordinator": "desk overview",
  "/m/advisor": "desk overview",
  "/m/admin": "desk overview",
  "/m/vp": "desk overview",
  // Pages whose own name differs today and are left for a later unit of #9527
  // (named in its review): Dues says My dues. Pulse is named since #9981,
  // Civic since #9971 and Work since #9990.
  "/m/dues": "later unit",
  // The fixture draws no Requests panel, so this row falls back to Settings
  // here; on the demo the page is headed Requests (audit finding A-33).
  "/m/settings/requests": "fixture has no Requests panel",
};

// The pages this record's units renamed. Each keeps exactly one h1, and
// the line above it (the old description, where one was kept) is not a heading.
const CHANGED_PAGES = new Set([
  "/m/cases", "/m/rights", "/m/workload", "/m/settings", "/m/organize", "/m/support",
  "/m/events-desk", "/m/campaigns", "/m/organization-map", "/m/actions", "/m/messages", "/m/voting", "/m/guide", "/m/coordination", "/m/network",
]);

// Palette rows that are not desktop rail rows today, each with why. The
// Events, Appointments and Find my steward rows are B-36, a later unit.
const PALETTE_ONLY = new Set([
  "Events", "Eventos", "One-on-ones", "Reuniones individuales",
  "Find my committee contact", "Encontrar mi contacto del comité",
  "Union Ground Guide", "Guía de Union Ground",
]);
// The public rail uses shorter labels for these member destinations.
const HEADING_KEYS = {
  "/m/work": "work.heading",
  "/m/cases": "nav.myCases",
  "/m/rights": "nav.knowRights",
};

// One rename for every renamable key a changed heading reads. A rename is
// saved in English and applies to English only (LanguageContext.jsx).
const RENAMES = {
  "nav.myCases": "Campaign issues",
  "nav.knowRights": "Campaign rights",
  "nav.messages": "Member mail",
  "nav.inbox": "Staff inbox",
  "nav.myChapter": "Our local",
  "nav.settings": "Account settings",
};

function stubDesktop() {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: /min-width:\s*1024px/.test(query) || /min-width:\s*768px/.test(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
}

const realMatchMedia = window.matchMedia;
const fixtureOverrides = () => demoData().adminDesk.configuration;
let savedOverrides = null;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.scrollTo = vi.fn();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
  stubDesktop();
  savedOverrides = fixtureOverrides().labelOverrides;
});

afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
  window.localStorage.clear();
  fixtureOverrides().labelOverrides = savedOverrides;
});

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const railLinks = () => [...document.querySelectorAll(".desktop-rail a[href]")];
const labelOf = (link) => clean(link.querySelector(".desktop-rail__label")?.textContent ?? link.textContent);
const headings = () => [...(document.getElementById("main-content")?.querySelectorAll("h1") ?? [])];
const heading = () => clean(headings()[0]?.textContent);
const isHeading = (node) => Boolean(node) && (/^H[1-6]$/.test(node.tagName) || node.getAttribute("role") === "heading");

async function open(hat, lang) {
  if (lang === "es") window.localStorage.setItem("sg-lang", "es");
  primeDemoHat(hat);
  window.history.replaceState({}, "", "/m?demo=1");
  render(<App />);
  await waitFor(() => expect(railLinks().length).toBeGreaterThan(3), { timeout: 10000 });
}

async function visit(href) {
  const link = railLinks().find((candidate) => candidate.getAttribute("href") === href);
  if (!link) return false;
  await act(async () => { fireEvent.click(link); });
  return true;
}

async function walk(hat, lang) {
  await open(hat, lang);
  const rows = railLinks().map((link) => ({ label: labelOf(link), href: link.getAttribute("href") }));
  const mismatches = [];
  for (const row of rows) {
    if (LISTED_REASONS[row.href] || !(await visit(row.href))) continue;
    const headingKey = hat === "member" ? HEADING_KEYS[row.href] : null;
    const pageLabel = headingKey ? organizationTranslator(lang, savedOverrides)(headingKey) : row.label;
    let seen = "";
    try {
      await waitFor(() => {
        expect(window.location.pathname).toBe(row.href);
        seen = heading();
        expect(seen).toBe(pageLabel);
      }, { timeout: 3000 });
    } catch {
      mismatches.push(`${row.href}: rail "${row.label}", heading "${seen || heading()}"`);
      continue;
    }
    await waitFor(() => expect([row.label, pageLabel].some((label) => document.title.startsWith(`${label} · `))).toBe(true), { timeout: 2000 })
      .catch(() => mismatches.push(`${row.href}: rail "${row.label}", tab "${document.title}"`));
    if (CHANGED_PAGES.has(row.href)) {
      if (headings().length !== 1) mismatches.push(`${row.href}: ${headings().length} h1 elements`);
      if (isHeading(headings()[0]?.previousElementSibling)) mismatches.push(`${row.href}: the line above the h1 is a heading`);
      // Every rendered heading on the page, not only the h1: the page's name
      // is said once (the kept descriptions are not headings).
      const named = headings().filter((node) => clean(node.textContent) === pageLabel).length;
      if (named !== 1) mismatches.push(`${row.href}: ${named} headings read "${row.label}"`);
    }
  }
  return { rows, mismatches };
}

describe("one name per place: rail, page heading and tab (#9527)", () => {
  it.each([
    ["member", "en"], ["member", "es"],
    ["steward", "en"], ["steward", "es"],
    ["coordinator", "en"], ["coordinator", "es"],
    ["advisor", "en"], ["advisor", "es"],
    ["admin", "en"], ["admin", "es"],
    ["vp", "en"], ["vp", "es"],
  ])("%s hat in %s", async (hat, lang) => {
    const { rows, mismatches } = await walk(hat, lang);
    expect(rows.length).toBeGreaterThan(5);
    if (hat === "member") expect(rows).toContainEqual({ href: "/m/guide", label: catalogue[lang]["nav.siteGuide"] });
    if (hat === "steward" || hat === "coordinator") expect(rows).toContainEqual({ href: "/m/coordination", label: catalogue[lang]["nav.coordination"] });
    expect(mismatches).toEqual([]);
  }, 120000);
});

describe("an organization's rename names the page as well as the rail (#9527)", () => {
  it.each([
    ["member", { "nav.myCases": "/m/cases", "nav.knowRights": "/m/rights", "nav.messages": "/m/messages", "nav.myChapter": "/m/organize/organize", "nav.settings": "/m/settings" }],
    ["steward", { "nav.inbox": "/m/messages" }],
  ])("%s hat: rail, heading and tab all read the renamed name", async (hat, places) => {
    fixtureOverrides().labelOverrides = { ...savedOverrides, ...RENAMES };
    await open(hat, "en");
    for (const [key, href] of Object.entries(places)) {
      const name = RENAMES[key];
      const link = railLinks().find((candidate) => candidate.getAttribute("href") === href);
      const shorter = { "nav.myCases": "Issues", "nav.knowRights": "Rights" }[key];
      expect(labelOf(link)).toBe(shorter || name);
      await visit(href);
      await waitFor(() => expect(heading()).toBe(name), { timeout: 3000 });
      await waitFor(() => expect([name, shorter].filter(Boolean).some((label) => document.title.startsWith(`${label} · `))).toBe(true), { timeout: 2000 });
    }
  }, 60000);
});

describe("Inbox or Messages follows the hat worn, not the account (#9527)", () => {
  it("a staff account under the Member hat reads Messages; under Steward, Inbox", async () => {
    fixtureOverrides().labelOverrides = { ...savedOverrides, ...RENAMES };
    await open("member", "en");
    // The fixture account holds every staff role; the Member hat is worn.
    expect(document.querySelector(".sg-app")).not.toBeNull();
    await visit("/m/messages");
    await waitFor(() => expect(heading()).toBe("Member mail"), { timeout: 3000 });
    expect(railLinks().some((link) => labelOf(link) === "Staff inbox")).toBe(false);
    cleanup();
    await open("steward", "en");
    await visit("/m/messages");
    await waitFor(() => expect(heading()).toBe("Staff inbox"), { timeout: 3000 });
    expect(railLinks().some((link) => labelOf(link) === "Member mail")).toBe(false);
  }, 60000);
});

describe("the command palette uses the rail's names (#9527, B-32)", () => {
  it.each(["en", "es"])("Member palette rows in %s are rail rows", async (lang) => {
    await open("member", lang);
    const railNames = new Set([...railLinks().map(labelOf), ...Object.values(HEADING_KEYS).map((key) => organizationTranslator(lang, savedOverrides)(key))]);
    await act(async () => { openCommandPalette(); });
    const rows = await waitFor(() => {
      const found = [...document.querySelectorAll('[role="option"].command-palette__option')].map((row) => clean(row.querySelectorAll(":scope > span")[1]?.textContent));
      expect(found.length).toBeGreaterThan(5);
      return found;
    });
    const stray = rows.filter((name) => !railNames.has(name) && !PALETTE_ONLY.has(name));
    expect(stray).toEqual([]);
    expect(rows).toContain(lang === "es" ? "Votaciones" : "Voting");
  }, 60000);
});

describe("the command palette uses distinct rail glyphs (#9565)", () => {
  it.each(["member", "steward", "coordinator", "advisor", "admin", "vp"])("matches the %s rail and gives each command its own glyph", async (hat) => {
    await open(hat, "en");
    const railIcons = new Map([...document.querySelectorAll(".desktop-rail__row")].flatMap((row) => {
      const icon = row.querySelector("[data-rail-icon]");
      return icon ? [[labelOf(row), icon.innerHTML]] : [];
    }));
    await act(async () => { openCommandPalette(); });
    const rows = [...document.querySelectorAll(".command-palette__option")];
    expect(rows.length).toBeGreaterThan(10);
    const shapes = rows.map((row) => {
      const label = row.children[1].textContent;
      const icon = row.querySelector("svg[data-rail-icon]");
      expect(icon, label).toHaveAttribute("aria-hidden", "true");
      expect(icon.innerHTML, label).not.toBe("");
      if (railIcons.has(label)) expect(icon.innerHTML, label).toBe(railIcons.get(label));
      return icon.innerHTML;
    });
    expect(new Set(shapes).size).toBe(rows.length);
  }, 60000);
});

describe("the Alt Now ballot list is named for its ballots, not the Voting place (#9527)", () => {
  it.each(["en", "es"])("in %s the list group has its own label and the Voting button keeps the place's name", (lang) => {
    const data = {
      member: { id: "m1", fullName: "Alex Member", chapterId: "one", chapterName: "Chapter One" },
      events: [], planItems: [{ id: "b1", kind: "ballot", title: "Contract ratification" }], broadcasts: [], tasks: [],
      notifications: [], conversations: [], cases: [], metrics: { openCases: 0 }, rights: { lessons: [] },
      rewards: { totalPoints: 0, tierNumber: 1, tierName: "Starter", actionsYtd: 0 }, rewardsCatalog: { tiers: [] }, weekly: { done: 0, goal: 5 },
    };
    render(<LanguageProvider lang={lang}><AltShellContext.Provider value={{}}>
      <AltNowPage data={data} chapters={[{ id: "one", name: "Chapter One" }]} selectedChapterId="one" onPlanAction={vi.fn()} onNavigate={vi.fn()} />
    </AltShellContext.Provider></LanguageProvider>);
    const group = document.querySelector(".ug-ballot-list");
    // Its own key: a later change to the Voting place's name (nav.voting,
    // which changed in Spanish in this unit) does not reach the list.
    expect(group).toHaveAttribute("aria-label", catalogue[lang]["altShell.ballotList"]);
    expect(catalogue[lang]["altShell.ballotList"]).not.toBe(catalogue[lang]["nav.voting"]);
    // The Voting button reads the place's name, followed by the open-ballot count.
    expect([...document.querySelectorAll(".ug-band-foot button")].some((button) => button.textContent.startsWith(catalogue[lang]["nav.voting"])))
      .toBe(true);
  });
});
