// PR1815 wave-A6 focused-page geometry regressions (local Chromium evidence,
// not hosted acceptance). Each check replicates the measurement a per-route
// browser acceptance check performs.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WorkloadView } from "../src/views/WorkloadView.jsx";
import { StewardView } from "../src/views/StewardView.jsx";
import { CaseworkHubPanel } from "../src/components/CaseworkHubPanel.jsx";
import { CaseList } from "../src/components/CaseList.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { ProductHubView } from "../src/views/ProductHubView.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { OrganizationIntelligenceView } from "../src/views/OrganizationIntelligenceView.jsx";
import { ORGANIZATION_INTELLIGENCE_PREVIEW_ORGANIZATION } from "./fixtures/retired-pre-bot/src/features/organizationIntelligence/preview.js";
import { collectVisualMeasurements, classifyVisualMeasurements } from "../scripts/visual-audit.mjs";

const css = (await Promise.all(["sg-tokens.css", "styles.css", "coordinator-theme.css", "motion.css",
  "components/workspacePages.css", "features/organizationIntelligence/organization-intelligence.css",
  "components/Dialog.css", "components/caseworkHubPanel.css", "views/stewardRequests.css"]
  .map(path => readFile(resolve("src", path), "utf8")))).join("\n");

let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });

// Runs inside Chromium via page.evaluate; returns the composited
// foreground/background contrast ratio for the first match, or null.
function pairRatio(selector) {
  const rgb = (value) => {
    const match = value.match(/^rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\)$/);
    return match ? [+match[1], +match[2], +match[3], match[4] === undefined ? 1 : +match[4]] : null;
  };
  const luminance = (channels) => channels.slice(0, 3).map((channel) => { const s = channel / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const element = document.querySelector(selector);
  if (!element) return null;
  const style = getComputedStyle(element);
  const fg = rgb(style.color);
  let bg = [255, 255, 255, 1];
  const chain = [];
  for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) chain.unshift(ancestor);
  for (const node of chain) {
    const color = rgb(getComputedStyle(node).backgroundColor);
    if (color) bg = color.slice(0, 3).map((channel, index) => channel * color[3] + bg[index] * (1 - color[3]));
  }
  if (!fg) return null;
  const painted = fg.slice(0, 3).map((channel, index) => channel * fg[3] + bg[index] * (1 - fg[3]));
  const a = luminance(painted), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function pageFor(markup, width, theme, shellWidth = null, webFonts = false, workspaceTheme = null) {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : width === 768 ? 1024 : 900 }, colorScheme: theme, reducedMotion: "reduce" });
  page.setDefaultTimeout(3000);
  // font-display: swap means the runner can measure either the fallback or the
  // shipped face, so audited geometry is asserted in both font states.
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return webFonts && /^\/assets\/.*\.woff2$/.test(url.pathname)
      ? route.fulfill({ path: resolve("public", url.pathname.slice(1)), contentType: "font/woff2" })
      : route.abort();
  });
  await page.setContent(`<base href="http://127.0.0.1:56810/"><div class="sg-app" data-workspace-theme="${workspaceTheme ?? "union-ground"}" style="width:${shellWidth ?? width}px">${markup}</div>`);
  await page.addStyleTag({ content: css });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

// FIX-UG-PAGE-WORKLOAD-SUBMIT-20260910: the pressed employment/leave chip
// painted hard-coded white on --green. Night-shift repoints --green to the
// pale periwinkle tint, so the pair measured 1.18:1 and every dark-theme
// submit case failed the runner's full-page CONTRAST sweep. The chip now uses
// the semantic foreground token that tracks each theme's green pairing.
for (const theme of ["light"]) {
  it.each([390, 768, 1440])(`keeps the pressed workload submit chip above AA in ${theme} at %i px`, async (width) => {
    const view = render(<main className="app-column"><WorkloadView data={{ workload: { entries: [], stats: { enoughData: false }, reminders: null } }} onLogWork={vi.fn()} /></main>);
    fireEvent.click(view.container.querySelector(".mwl-chip"));
    await waitFor(() => expect(view.container.querySelector(".mwl-chip[aria-pressed='true']")).toBeTruthy());
    const page = await pageFor(view.container.innerHTML, width, theme);
    try {
      const chip = page.locator(".mwl-chip[aria-pressed='true']").first();
      await chip.waitFor();
      const ratio = await page.evaluate(pairRatio, ".mwl-chip[aria-pressed='true']");
      expect(ratio).not.toBeNull();
      expect(ratio, `${theme} pressed chip ratio`).toBeGreaterThanOrEqual(4.5);
      const box = await chip.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(classifyVisualMeasurements(await page.evaluate(collectVisualMeasurements)).failures.filter((row) => row.rule === "small-target")).toEqual([]);
    } finally { await page.close(); view.unmount(); }
  });
}

// FIX-UG-PAGE-STEWARD-QA-20260910 / FIX-UG-PAGE-STEWARD-CASEWORK-HUB-20260910:
// the steward plane header's assistant button (.cwk-iconbtn) measured 38x38
// above the 600px breakpoint (the phone media query already bumped it), so
// every desktop steward-desk case failed the runner's TARGET_SIZE check.
const desk = { queue: [], threads: [], broadcasts: [], formsInbox: [], kpis: { openRequests: 0, membersCovered: 0, awaitingReply: 0, broadcasts30d: 0 } };
function stewardApi() {
  return { loadDesk: vi.fn().mockResolvedValue(desk), listEmailIntakes: vi.fn().mockResolvedValue([]) };
}
for (const theme of ["light"]) {
  it.each([390, 768, 1440])(`keeps the steward plane-header assistant target at 44px in ${theme} at %i px`, async (width) => {
    const view = render(<main className="app-column"><StewardView data={{ member: { initials: "SO", chapterId: "chapter-1" } }} api={stewardApi()} onNotice={() => {}} onAssistant={vi.fn()} officerQa={<div />} /></main>);
    await waitFor(() => expect(view.container.querySelector(".cwk-iconbtn")).toBeTruthy());
    const page = await pageFor(view.container.innerHTML, width, theme);
    try {
      const button = page.locator(".cwk-iconbtn");
      await button.waitFor();
      const box = await button.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    } finally { await page.close(); view.unmount(); }
  });
}

// FIX-UG-PAGE-ORGANIZATION-MAP-CHARTS-20260910: chart node subtitles and
// tree labels painted --sg-color-muted (#8a938c, 3.17:1 on the white card).
// They now use --sg-color-sec, the same token the relationship roster labels
// carry, which clears AA on the card in both the light and night-shift themes.
const actor = { userId: "staff", organizationId: ORGANIZATION_INTELLIGENCE_PREVIEW_ORGANIZATION, chapterId: "chapter", selectedHat: "admin", organizationRoles: ["admin"], chapterRoles: [], organizationStatus: "active", membershipStatus: "active", mfaSatisfied: true };
for (const theme of ["light"]) {
  it(`keeps chart node and tree subtitles above AA in ${theme}`, async () => {
    const view = render(<OrganizationIntelligenceView actor={actor} preview />);
    await waitFor(() => expect(view.container.querySelectorAll(".oi-map__node").length).toBeGreaterThan(0));
    const page = await pageFor(view.container.innerHTML, 768, theme);
    try {
      for (const selector of [".oi-map__node small", ".oi-tree__node small"]) {
        const ratio = await page.evaluate(pairRatio, selector);
        expect(ratio, `${selector} in ${theme}`).not.toBeNull();
        expect(ratio, `${selector} in ${theme}`).toBeGreaterThanOrEqual(4.5);
      }
    } finally { await page.close(); view.unmount(); }
  });
}

// Union Ground's coordinator queue carried a grievance-step chip (.gq-step in
// a .gq-c-step metadata cell) whose 120-character labels once overflowed the
// row. Union Ground issues have no grievance steps: no web screen renders
// the step chip, and no stylesheet paints it.
it("renders no grievance-step chip on any casework screen", async () => {
  const sources = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(jsx|js)$/.test(entry.name)) sources.push({ path, text: await readFile(path, "utf8") });
    }
  };
  await walk(resolve("src"));
  expect(sources.length).toBeGreaterThan(0);
  expect(sources.filter(({ text }) => /["'\s]gq-(c-)?step["'\s]/.test(text)).map(({ path }) => path)).toEqual([]);
  expect(css).not.toMatch(/\.gq-(c-)?step\b/);
});

// BUG-UG-PR1815-STEWARD-CASEWORK-HUB-VISUAL-AUDIT-INTERMITTENT-20260916:
// /m/steward/casework-hub failed PR1815_VISUAL_AUDIT in roughly 40% of SAMPLE
// cases, in both themes and at every viewport. The overlap is not intermittent
// — the bargaining workspace header paints one — but its detection is: the
// runner audits as soon as an h1 is visible and no .loading-screen remains, so
// a run that measures before the hub read paints (or before the webfont swaps)
// sees no workspaces and passes. .cwk-chip was an inline box with 3px vertical
// padding inside a 15.4px line box, so it bled into the display:block title
// above it; classifyVisualMeasurements reports that as element-collision.
// Every async state the runner can catch must audit clean.
const hubWorkspaces = [1, 2].map((ordinal) => ({
  id: `workspace-${ordinal}`, title: `Negotiation workspace 0${ordinal}`,
  status: ordinal === 1 ? "live" : "tentative_agreement",
  starts_at: new Date(Date.now() + ordinal * 86400000).toISOString(),
  proposals: [{ id: `proposal-${ordinal}`, side: "union", title: "Scheduling safeguards", status: "proposed",
    body: "A realistic fictional proposal records the current position, supporting rationale, and response path.",
    response_due_at: new Date(Date.now() + 3600000).toISOString() }],
  events: [{ id: `event-${ordinal}`, event_type: "pulse", pulse: "urgent", created_at: new Date(Date.now() - 60000).toISOString(),
    body: "Session note 3 records movement, open questions, and the next caucus action." }],
}));
const hubData = {
  workspaces: hubWorkspaces,
  drafts: [{ id: "draft-1", case_id: "case-1", revision: 3, updated_at: new Date(Date.now() - 3600000).toISOString(), payload: { title: "Draft intake", notes: "Recovered notes" } }],
  patterns: [{ id: "pattern-1", subject_label: "Fictional Manager", report_count: 4, status: "investigating", disposition: "Coordinated follow-up is documented.",
    casework_retaliation_pattern_notes: [{ id: "note-1", body: "The review note distinguishes shared facts from assumptions." }] }],
  templates: [{ id: "template-1", title: "Filing checklist", case_type: "grievance", step: "Intake", items: [{ label: "Confirm deadline" }] }],
};
const hubHistory = { rows: [{ id: "case-1", reference: "UNIONDEMO-PG-0001", title: "Overtime review and schedule change", case_type: "grievance", step: "Investigation", status: "active", is_restricted: true, member: { full_name: "Fictional Member" } }], total: 1, page: 0, pageSize: 50 };
const pending = () => new Promise(() => {});
function hubApi(overrides = {}) {
  return { loadCaseworkHub: () => Promise.resolve(hubData), loadCaseworkHistory: () => Promise.resolve(hubHistory),
    createChecklistTemplate: () => Promise.resolve({}), saveIntakeDraft: () => Promise.resolve({}), scanRetaliationPatterns: () => Promise.resolve({}),
    setBargainingStatus: () => Promise.resolve({}), transitionBargainingProposal: () => Promise.resolve({}), addBargainingProposal: () => Promise.resolve({}),
    addBargainingEvent: () => Promise.resolve({}), createBargainingWorkspace: () => Promise.resolve({}), reviewRetaliationPattern: () => Promise.resolve({}),
    bulkUpdateCases: () => Promise.resolve({}), ...overrides };
}
const hubStates = {
  "hub pending": { api: () => hubApi({ loadCaseworkHub: pending, loadCaseworkHistory: pending }), painted: (view) => view.container.querySelector(".cwk-empty") },
  "history pending": { api: () => hubApi({ loadCaseworkHistory: pending }), painted: (view) => view.container.querySelector("#casework-center .thread-message section > p") },
  "history loaded": { api: () => hubApi(), painted: (view) => view.container.querySelector(".cwk-row") },
};
for (const [state, spec] of Object.entries(hubStates)) {
  for (const theme of ["light"]) {
    it.each([390, 768, 1440])(`audits the steward casework hub clean with ${state} in ${theme} at %i px`, async (width) => {
      const view = render(<LanguageProvider lang="en"><main className="app-column"><h1>Casework center</h1>
        <CaseworkHubPanel chapterId="chapter-1" caseOptions={[{ id: "case-1", reference: "GRV-2", title: "Related case" }]} api={spec.api()} />
      </main></LanguageProvider>);
      await waitFor(() => expect(spec.painted(view)).toBeTruthy());
      // Stage checklists are left out: a template the hub read still carries
      // is never painted, and no template authoring is offered.
      expect(view.container.textContent).not.toMatch(/Filing checklist|Checklist templates|Create template/);
      for (const webFonts of [false, true]) {
        const page = await pageFor(view.container.innerHTML, width, theme, width === 1440 ? 920 : width, webFonts);
        try {
          if (webFonts) await page.evaluate(() => document.fonts.ready);
          const report = classifyVisualMeasurements(await page.evaluate(collectVisualMeasurements));
          expect(report.failures.map((row) => `${row.rule}: ${(row.selectors || [row.selector]).join(" | ")}`), `${state} webFonts=${webFonts}`).toEqual([]);
          const header = await page.evaluate(() => {
            const paragraph = document.querySelector("#casework-center .thread-message section > p");
            if (!paragraph) return null;
            const box = (node) => { const rect = node.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom }; };
            return { title: box(paragraph.querySelector("strong")), chip: box(paragraph.querySelector(".cwk-chip")), stamp: box(paragraph.querySelector("small")) };
          });
          if (header) {
            expect(header.chip.top, `chip clears the workspace title, webFonts=${webFonts}`).toBeGreaterThanOrEqual(header.title.bottom - 0.5);
            expect(header.stamp.top, `session stamp clears the chip, webFonts=${webFonts}`).toBeGreaterThanOrEqual(header.chip.bottom - 0.5);
          }
        } finally { await page.close(); }
      }
      view.unmount();
    });
  }
}

// REQ-UG-CASEWORK-CONSOLE-52-SAVED-VIEW-LIST-20260917: the shared faceted
// case list serves the coordinator queue (inside the casefile-control screen)
// and the steward caseload. The record requires the list to pass the PR1815
// geometry/contrast sweep in both themes at 390, 768 and 1280, so every
// secondary register the list introduces (count, facet labels, sort headers,
// row sub-lines, overdue text, the delete-view button) is measured against
// the composited surface, the phone reflow is asserted to need no sideways
// scroll, and the runner's own sweep must audit clean.
const caseListRows = [
  { id: "case-1", memberName: "Fictional Member One", memberInitials: "FO", reference: "UNIONDEMO-PG-0001", title: "Overtime review and schedule change", caseType: "Grievance", step: "Investigation", status: "active", deadline: "2000-01-01", deadlineLabel: "Jan 1", overdue: true, assigneeId: "steward-1", assigneeName: "Fictional Steward", chapterId: "chapter-1", chapterName: "Chapter One", urgency: "danger" },
  { id: "case-2", memberName: "Fictional Member Two", memberInitials: "FT", reference: "UNIONDEMO-PG-0002", title: "Leave denial", caseType: "Contract", step: "x".repeat(120), status: "active", deadline: "2999-12-31", deadlineLabel: "Dec 31", overdue: false, assigneeId: "steward-1", assigneeName: "Fictional Steward", chapterId: "chapter-1", chapterName: "Chapter One", urgency: "gold" },
  { id: "case-3", memberName: "Fictional Member Three", memberInitials: "FM", reference: "UNIONDEMO-PG-0003", title: "Pay issue", caseType: "Contract", step: "Resolved", status: "resolved", deadline: "", deadlineLabel: "", overdue: false, chapterId: "chapter-2", chapterName: "Chapter Two", urgency: "purple" },
  { id: "case-4", memberName: "Fictional Member Four", memberInitials: "FF", reference: "UNIONDEMO-PG-0004", title: "Schedule bid", caseType: "Grievance", step: "Step 1", status: "active", deadline: "2999-11-30", deadlineLabel: "Nov 30", overdue: false, assigneeId: "steward-2", assigneeName: "Second Steward", chapterId: "chapter-2", chapterName: "Chapter Two", urgency: "green" },
];
// The coordinator plane supplies the urgency reason the queue row has always
// painted; the tone classes are exercised one per fixture row so every chip
// pairing is measured on the composited surface.
const caseListUrgency = (row) => (row.urgency ? { tone: row.urgency, label: `Priority ${row.urgency}` } : null);
const caseListViewsApi = () => ({
  listSavedViews: () => Promise.resolve([{ id: "view-1", name: "Everything", isDefault: true, definition: { filters: {}, sorting: [{ id: "member", desc: false }] } }]),
  saveSavedView: () => Promise.resolve({}), deleteSavedView: () => Promise.resolve(),
});
const caseListPlanes = {
  coordinator: { urgency: caseListUrgency, wrap: (list) => <div className="gq-screen" data-casework-theme="casefile-control"><section className="gq-cases">{list}</section></div> },
  // The steward caseload sits in the 1.6fr column of the desk grid, which
  // is ~460px on a 768px tablet: the list must reflow by its own width.
  steward: { urgency: null, wrap: (list) => <div className="cwk-grid"><div className="cwk-col"><section className="cwk-panel">{list}</section></div><div className="cwk-col" /></div> },
};
const caseListContrastPairs = [".case-list__count", ".case-list__facet label", ".case-list__sort", ".case-list__open .gq-name", ".case-list__open small", ".case-list__table td[data-column='title'] small", ".gq-due--over", ".gq-status--over", ".case-list__default", ".case-list__btn--danger", ".case-list__btn", ".case-list__av", ".case-list__caveat"];
// Restored queue-row registers: the initials avatar and each urgency tone.
const caseListChipPairs = [".gq-reason--danger", ".gq-reason--gold", ".gq-reason--purple", ".gq-reason--green"];
for (const [plane, { wrap, urgency }] of Object.entries(caseListPlanes)) {
  for (const theme of ["light"]) {
    it.each([390, 768, 1280])(`audits the ${plane} case list clean with AA secondary text in ${theme} at %i px`, async (width) => {
      // A deep-linked view selects it in the switcher, which is the only state
      // that paints the delete-view button — the one destructive register.
      window.history.replaceState({}, "", `/m/${plane}?caseView=view-1`);
      const view = render(<LanguageProvider lang="en">{wrap(<CaseList plane={plane} rows={caseListRows} onOpenCase={() => {}} expandedCaseId="case-1" renderDetail={() => <p className="gq-detail">Detail</p>} savedViewsApi={caseListViewsApi()} urgencyOf={urgency} countsWindowed canLoadMore onLoadMore={() => {}} />)}</LanguageProvider>);
      try {
        await waitFor(() => expect(view.container.querySelector(".case-list__btn--danger")).toBeTruthy());
        const page = await pageFor(view.container.innerHTML, width, theme);
        try {
          const report = classifyVisualMeasurements(await page.evaluate(collectVisualMeasurements));
          expect(report.failures.map((row) => `${row.rule}: ${(row.selectors || [row.selector]).join(" | ")}`), `${plane} ${theme} ${width}`).toEqual([]);
          for (const selector of [...caseListContrastPairs, ...(urgency ? caseListChipPairs : [])]) {
            const ratio = await page.evaluate(pairRatio, selector);
            expect(ratio, `${selector} in ${theme} at ${width}`).not.toBeNull();
            expect(ratio, `${selector} in ${theme} at ${width}`).toBeGreaterThanOrEqual(4.5);
          }
          const geometry = await page.evaluate(() => {
            const scroll = document.querySelector(".case-list__scroll");
            const list = document.querySelector(".case-list").getBoundingClientRect();
            const box = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, height: r.height, text: node.textContent.slice(0, 16) }; };
            return {
              sideways: scroll.scrollWidth > scroll.clientWidth + 1,
              list: { left: list.left, right: list.right },
              triggers: [...document.querySelectorAll(".case-list__open")].map(box),
              controls: [...document.querySelectorAll(".case-list__control, .case-list__sort")].map(box),
              steps: [...document.querySelectorAll(".case-list .gq-step, .case-list [data-column='step']")].map(box),
            };
          });
          expect(geometry.sideways, "the list reflows to stacked records instead of scrolling sideways").toBe(false);
          for (const target of [...geometry.triggers, ...geometry.controls]) {
            expect(target.height, `${target.text} is a 44px target`).toBeGreaterThanOrEqual(44 - 0.5);
            expect(target.left, `${target.text} stays inside the list`).toBeGreaterThanOrEqual(geometry.list.left - 0.5);
            expect(target.right, `${target.text} is not clipped`).toBeLessThanOrEqual(geometry.list.right + 0.5);
          }
          // Union Ground issues have no grievance steps: the rows' legacy
          // step values must not surface as a step column or step chip.
          expect(geometry.steps, "no step column or step chip").toEqual([]);
          expect(view.container.textContent).not.toMatch(/Investigation|Step 1|x{120}/);
        } finally { await page.close(); }
      } finally { view.unmount(); window.history.replaceState({}, "", "/"); }
    });
  }
}

// The full-page AA sweep: every text-bearing visible element under main or
// .app-column, composited over its ancestor chain, against the floor its font
// size earns. It runs inside the page through page.evaluate.
const measureContrastPairs = () => {
  const rgb = (value) => {
    const match = value.match(/^rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\)$/);
    return match ? [+match[1], +match[2], +match[3], match[4] === undefined ? 1 : +match[4]] : null;
  };
  const luminance = (channels) => channels.slice(0, 3).map((channel) => { const s = channel / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  let checked = 0, failed = 0;
  for (const element of document.querySelectorAll("main *, .app-column *")) {
    if (![...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) continue;
    const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    if (box.width < 2 || box.height < 2 || box.bottom <= 0 || box.top >= innerHeight || style.visibility !== "visible" || style.opacity !== "1") continue;
    let bg = [255, 255, 255, 1]; const chain = []; let ancestor = element;
    while (ancestor) { chain.unshift(ancestor); ancestor = ancestor.parentElement; }
    let valid = true;
    for (const node of chain) {
      const css = getComputedStyle(node), color = rgb(css.backgroundColor);
      if (!color || css.backgroundImage !== "none") { valid = false; break; }
      bg = color.slice(0, 3).map((channel, index) => channel * color[3] + bg[index] * (1 - color[3])).concat(1);
    }
    const fg = rgb(style.color); if (!valid || !fg) { failed++; continue; }
    const painted = fg.slice(0, 3).map((channel, index) => channel * fg[3] + bg[index] * (1 - fg[3]));
    const a = luminance(painted), b = luminance(bg), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
    checked++; if (ratio + 0.01 < (large ? 3 : 4.5)) failed++;
  }
  return { checked, failed };
};

// FIX-UG-PAGE-ORGANIZE-{ORGANIZE,VOICE,LIBRARY,RECORD,PARTNERS,GOVERNANCE}-20260910:
// every /m/organize tab failed the runner's dark-theme CONTRAST sweep. The hub
// shell was built from the light prototype's literal paint rather than from the
// theme aliases: .hub2-card sat on #ffffff and .hub2-thread/.hub2-legal on a
// near-white gradient, so night-shift's --ink/--sec text landed on a white
// card; .hub2-tab[aria-pressed] and .hub2-btn--primary painted #ffffff on
// --green, which night-shift repoints to the pale periwinkle tint; and
// .hub2-chip--terra kept the light terracotta ink on the dark ember inset. A
// literal background also defeats the sweep outright — the runner composites
// the ancestor chain and fails closed on any background-image, so the gradient
// cards were refused in BOTH themes. The repair is in the hub's own tokens, so
// all six tabs are measured here rather than the three that were sampled.
//
// This replicates the contrast loop of measureContrastPairs above: every
// text-bearing visible element under
// main/.app-column, composited over its ancestor chain, against the AA floor
// its own font size earns. It reports the offending selectors so a regression
// names the rule that broke instead of a count.
function contrastSweep() {
  const rgb = (value) => {
    const match = value.match(/^rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\)$/);
    return match ? [+match[1], +match[2], +match[3], match[4] === undefined ? 1 : +match[4]] : null;
  };
  const luminance = (channels) => channels.slice(0, 3).map((channel) => { const s = channel / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const name = (element) => `${element.tagName.toLowerCase()}${[...element.classList].map((entry) => `.${entry}`).join("")}`;
  let checked = 0; const failures = [];
  for (const element of document.querySelectorAll("main *, .app-column *")) {
    if (![...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) continue;
    const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    if (box.width < 2 || box.height < 2 || box.bottom <= 0 || box.top >= innerHeight || style.visibility !== "visible" || style.opacity !== "1") continue;
    let bg = [255, 255, 255, 1]; const chain = []; let ancestor = element;
    while (ancestor) { chain.unshift(ancestor); ancestor = ancestor.parentElement; }
    let valid = true;
    for (const node of chain) {
      const css = getComputedStyle(node), color = rgb(css.backgroundColor);
      if (!color || css.backgroundImage !== "none") { valid = false; break; }
      bg = color.slice(0, 3).map((channel, index) => channel * color[3] + bg[index] * (1 - color[3])).concat(1);
    }
    const fg = rgb(style.color);
    if (!valid || !fg) { failures.push(`${name(element)}: unreadable paint`); continue; }
    const painted = fg.slice(0, 3).map((channel, index) => channel * fg[3] + bg[index] * (1 - fg[3]));
    const a = luminance(painted), b = luminance(bg), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
    checked++;
    if (ratio + 0.01 < (large ? 3 : 4.5)) failures.push(`${name(element)}: ${ratio.toFixed(2)}:1`);
  }
  return { checked, failures };
}

// One fixture that paints every hub surface the member hat reaches: flush list
// cards with neutral chips, the thread cards Voice/Partners/Governance share,
// all three chip tones including terra, the record timeline and the legal strip.
const organizeProduct = {
  spaces: [{ id: "space-1", name: "Workplace issues", description: "Ongoing scheduling and safety issues.", visibility: "chapter",
    threads: [{ id: "thread-1", title: "Overtime scheduling", kind: "issue", status: "open", posts: [{ id: "post-1", body: "Initial report" }] }] }],
  intake: [
    { id: "intake-1", title: "Break room temperature", status: "new", category: "safety", created_at: "2026-09-01T12:00:00Z", details: "A fictional report records the condition and the date it was observed." },
    { id: "intake-2", title: "Schedule retaliation", status: "escalated", category: "retaliation", created_at: "2026-09-02T12:00:00Z", thread_id: "thread-1", details: "A second fictional report carries the hot status, so the terra chip paints." },
  ],
  documents: [{ id: "doc-1", document_type: "contract", title: "Master agreement", version: 3, status: "published", summary: "The current agreement and its side letters." }],
  compassKnowledge: [{ id: "article-1", title: "Filing a grievance", ref: "KB-001", version: 2, status: "published" }],
  records: [
    { id: "record-1", title: "Chapter founded", record_type: "milestone", occurred_at: "2026-01-04T12:00:00Z", body: "The founding record carries a short fictional note." },
    { id: "record-2", title: "First agreement ratified", record_type: "vote", occurred_at: "2025-06-04T12:00:00Z" },
  ],
  handshakes: [{ id: "handshake-1", title: "Regional data sharing", status: "declined", partner_org_id: "org-2", data_scope: "aggregate", purpose: "A fictional handshake states its scope and its purpose." }],
  governance: [{ id: "governance-1", request_type: "export", status: "resolved", details: "A fictional request records what was asked for.", response: "The response is quoted back to the member." }],
  partnerOrgs: [],
};
const organizeData = { member: { id: "user-1", initials: "MV", fullName: "Member Voice", chapterId: "chapter-1" }, roles: [], product: organizeProduct };
// The runner reaches each tab by its own URL, and the routed tab strip paints a
// different selected rule than the unrouted button fallback, so the harness
// mounts the real WorkspacePages context on the tab's own path.
const ORGANIZE_TABS = { organize: "Topics", voice: "Be heard", library: "Library", record: "The record", partners: "Partners", governance: "Data rights" };

for (const theme of ["light"]) {
  it.each([390, 768])(`keeps every /m/organize tab above AA in ${theme} at %i px`, async (width) => {
    // Every tab is measured before the assertion so one repaired tab cannot
    // hide the next: this defect was hub-wide and its report named three tabs.
    const measured = {};
    for (const [tab, label] of Object.entries(ORGANIZE_TABS)) {
      window.history.pushState({}, "", `/m/organize/${tab}`);
      const view = render(<LanguageProvider lang="en">
        <WorkspacePages view="hub" location={`/m/organize/${tab}`} navigate={() => {}} hat="member">
          <main className="app-column"><ProductHubView data={organizeData} staffAccess={false} triageAccess={false} onAssistant={vi.fn()} /></main>
        </WorkspacePages>
      </LanguageProvider>);
      await waitFor(() => expect(view.container.querySelector('.hub2-tab[aria-current="page"]')?.textContent).toBe(label));
      const page = await pageFor(view.container.innerHTML, width, theme);
      try {
        const sweep = await page.evaluate(contrastSweep);
        expect(sweep.checked, `${tab} measured no text in ${theme} at ${width}`).toBeGreaterThan(0);
        measured[tab] = sweep.failures;
      } finally { await page.close(); view.unmount(); }
    }
    expect(measured, `${theme} at ${width}`).toEqual(Object.fromEntries(Object.keys(ORGANIZE_TABS).map((tab) => [tab, []])));
  });
}

// FIX-UG-PAGE-STEWARD-FORMS-20260910: /m/steward/forms failed
// PR1815_CONTRAST at light 390 on one element — the "N waiting" count chip in
// the forms panel header. Not a dim pair: .cwk-count--wait painted
// color-mix(in srgb, var(--gold) 22%, transparent), which Chromium serialises
// as color(srgb ...), and the runner's sweep fails closed on any background it
// cannot parse as rgb()/rgba(). So the chip counted as a failure while being
// perfectly legible, and no ratio in the evidence could explain it. The chip
// now carries the audited --sg-color-warn-soft / --amber-ink pair its sibling
// .cwk-chip--new already uses (scripts/contrast-audit.mjs pins it at 5.09:1),
// which every ledger theme defines.
//
// Measured with the runner's own exported sweep rather than a copy of it, so a
// future divergence in what the runner can parse fails here first. The steward
// plane pinned Harbor Ledger in both colour schemes when this failed, which is
// why the failing case was light-only while the chip is theme-neutral; since
// the owner's ruling of November 3, 2026 it renders the identity like every hat.
const formsDesk = {
  queue: [], threads: [], broadcasts: [],
  formsInbox: [
    { id: "f1", userId: "u2", memberInitials: "JM", memberName: "Fictional Member", templateKey: "grievance", status: "submitted", submittedAt: "2026-07-21T16:40:00Z", answers: {} },
    { id: "f2", userId: "u3", memberInitials: "AR", memberName: "Second Fictional Member", templateKey: "alt_work", status: "in_review", submittedAt: "2026-07-20T13:05:00Z", answers: {} },
  ],
  kpis: { openRequests: 2, membersCovered: 38, awaitingReply: 1, broadcasts30d: 1 },
};
function formsApi() {
  return { loadDesk: vi.fn().mockResolvedValue(formsDesk), listEmailIntakes: vi.fn().mockResolvedValue([]),
    formFilingStatus: vi.fn().mockResolvedValue({ filerSigned: true, attachments: [] }) };
}
for (const theme of ["light"]) {
  it(`sweeps the steward forms page clean, waiting count included, in ${theme} at 390 px`, async () => {
    window.history.pushState({}, "", "/m/steward/forms");
    // WorkspaceSection renders its children when there is no workspace context,
    // so the provider is what reproduces the focused page: without it the whole
    // steward plane renders and the forms panel sits below the 844px fold,
    // where the runner does not measure it.
    const view = render(<LanguageProvider lang="en"><main className="app-column">
      <WorkspacePages view="steward" hat="steward" location="/m/steward/forms" navigate={vi.fn()}>
        <StewardView data={{ member: { initials: "SO", chapterId: "chapter-1" } }} api={formsApi()} onNotice={() => {}} onAssistant={vi.fn()} officerQa={<div />} />
      </WorkspacePages>
    </main></LanguageProvider>);
    await waitFor(() => expect(view.container.querySelector(".cwk-count--wait")).toBeTruthy());
    const page = await pageFor(view.container.innerHTML, 390, theme);
    try {
      const chip = await page.evaluate(() => {
        const node = document.querySelector(".cwk-count--wait");
        const box = node.getBoundingClientRect();
        return { background: getComputedStyle(node).backgroundColor, measured: box.top < innerHeight && box.bottom > 0 && box.width >= 2 && box.height >= 2 };
      });
      expect(chip.measured, "the waiting count is inside the measured viewport").toBe(true);
      // The full-page sweep first, then what the chip itself measures.
      const contrast = await page.evaluate(measureContrastPairs);
      expect(contrast.checked).toBeGreaterThan(0);
      expect(contrast, `full-page sweep in ${theme}`).toEqual({ checked: contrast.checked, failed: 0 });
      expect(chip.background, "a background the sweep can parse, not color-mix()").toMatch(/^rgba?\(/);
      const ratio = await page.evaluate(pairRatio, ".cwk-count--wait");
      expect(ratio, `waiting count in ${theme}`).toBeGreaterThanOrEqual(4.5);
    } finally { await page.close(); view.unmount(); }
  });
}

// REQ-UG-CASEWORK-CONSOLE-54-CASE-DASHBOARDS-20260917: the dashboard
// tiles (three in Union Ground: due soon, overdue and by assignee; the
// open-by-step and median-days-per-step tiles are left out) are mounted as a routed tab inside the casefile-control screen and as
// a full-width section on the steward hub. The record asks the charts to pass
// contrast in both themes and to expose data tables; the PR1815 runner will
// additionally sweep the tab for 44px targets, clipping and sideways scroll.
// So every secondary register the tiles paint is measured on the composited
// surface, every categorical series is measured at 1.4.11's 3:1 against both
// the tile surface and the track it sits on, and the runner's own sweep must
// audit clean with the data tables closed and open, on both planes.
import { CaseDashboards } from "../src/components/CaseDashboards.jsx";

// byStep and medianDays ride along as a legacy aggregate would send them: the
// tiles must still not render them.
const dashboardAggregates = {
  byStep: [{ step: "Step 2", caseCount: 7 }, { step: "Step 1", caseCount: 3 }, { step: "x".repeat(120), caseCount: 1 }],
  dueSoon: [{ daysOut: 0, deadlineCount: 2, caseCount: 2 }, { daysOut: 3, deadlineCount: 1, caseCount: 1 }, { daysOut: 6, deadlineCount: 4, caseCount: 3 }],
  overdue: [{ kind: "response", deadlineCount: 5, caseCount: 4, oldestDueAt: "2026-08-02T12:00:00Z" }, { kind: "follow_up", deadlineCount: 1, caseCount: 1, oldestDueAt: "2026-09-01T12:00:00Z" }],
  byAssignee: [{ role: "steward", userId: "user-steward-1", name: "Fictional Steward With A Long Display Name", caseCount: 6 }, { role: "coordinator", userId: "user-coord-1", name: "Fictional Coordinator", caseCount: 4 }, { role: "unassigned", userId: null, name: "", caseCount: 2 }],
  medianDays: [{ step: "Step 1", medianDays: 4.5, transitionCount: 12 }, { step: "Step 2", medianDays: 11.25, transitionCount: 9 }, { step: "Step 3", medianDays: 2, transitionCount: 3 }],
};
// Titles of the tiles Union Ground left out, read through the catalogue
// only to prove they are not rendered.
const removedDashboardTitles = [t("en", "caseDash.stepTitle"), t("en", "caseDash.medianTitle")];
const dashboardPlanes = {
  coordinator: (tiles) => <div className="screen gq-screen" data-casework-theme="casefile-control">{tiles}</div>,
  steward: (tiles) => <div className="cwk-plane">{tiles}</div>,
};
const dashboardTextPairs = [".cdash__eyebrow", ".cdash__sub", ".cdash-chart__sub", ".cdash-chart__total", ".cdash-bars__name", ".cdash-bars__value", ".cdash-columns__value", ".cdash-columns__label", ".cdash-chart__toggle", ".cdash-chart__data caption", ".cdash-chart__data th", ".cdash-chart__data td", ".cdash-chart__empty"];
// Series marks against the surface they sit on: each bar fill against the
// tile and against its track, each column against the tile, the polyline
// stroke and dots against the tile.
function seriesRatios() {
  const rgb = (value) => {
    const match = value.match(/^rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\)$/);
    return match ? [+match[1], +match[2], +match[3], match[4] === undefined ? 1 : +match[4]] : null;
  };
  const luminance = (channels) => channels.slice(0, 3).map((channel) => { const s = channel / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const surface = (element) => {
    let bg = [255, 255, 255];
    const chain = [];
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) chain.unshift(ancestor);
    for (const node of chain) {
      const color = rgb(getComputedStyle(node).backgroundColor);
      if (color) bg = color.slice(0, 3).map((channel, index) => channel * color[3] + bg[index] * (1 - color[3]));
    }
    return bg;
  };
  const ratio = (a, b) => { const la = luminance(a), lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  const paint = (element, property) => { const color = rgb(getComputedStyle(element)[property]); return color ? color.slice(0, 3) : null; };
  const rows = [];
  for (const fill of document.querySelectorAll(".cdash-bars__fill")) {
    const tile = fill.closest(".cdash-chart");
    rows.push({ mark: "bar", against: "tile", ratio: ratio(paint(fill, "backgroundColor"), surface(tile)) });
    rows.push({ mark: "bar", against: "track", ratio: ratio(paint(fill, "backgroundColor"), surface(fill.parentElement)) });
  }
  for (const column of document.querySelectorAll(".cdash-columns__bar:not([data-empty])")) {
    rows.push({ mark: "column", against: "tile", ratio: ratio(paint(column, "backgroundColor"), surface(column.closest(".cdash-chart"))) });
  }
  const path = document.querySelector(".cdash-line__path");
  if (path) rows.push({ mark: "line", against: "tile", ratio: ratio(paint(path, "stroke"), surface(path.closest(".cdash-chart"))) });
  const dot = document.querySelector(".cdash-line__dot");
  if (dot) rows.push({ mark: "dot", against: "tile", ratio: ratio(paint(dot, "fill"), surface(dot.closest(".cdash-chart"))) });
  return rows;
}
for (const [plane, wrap] of Object.entries(dashboardPlanes)) {
  for (const tables of ["closed", "open"]) {
    for (const theme of ["light"]) {
      it.each([390, 768, 1280])(`audits the ${plane} case dashboards clean with tables ${tables} in ${theme} at %i px`, async (width) => {
        window.history.replaceState({}, "", plane === "coordinator" ? "/m/coordinator/cases/dashboards" : "/m/steward");
        const api = { loadCaseDashboards: () => Promise.resolve(dashboardAggregates) };
        const view = render(<LanguageProvider lang="en"><main className="app-column"><h1>Casework</h1>{wrap(<CaseDashboards api={api} caseListPath={plane === "coordinator" ? "/m/coordinator/cases/queue" : "/m/steward"} />)}</main></LanguageProvider>);
        try {
          await waitFor(() => expect(view.container.querySelectorAll(".cdash-chart").length).toBe(3));
          // No by-step or median-per-step tile, no step line chart, no step label.
          for (const title of removedDashboardTitles) expect(view.container.textContent).not.toContain(title);
          expect(view.container.querySelector(".cdash-line")).toBeNull();
          expect(view.container.textContent).not.toMatch(/Step [123]|x{120}/);
          if (tables === "open") for (const toggle of view.container.querySelectorAll(".cdash-chart__toggle")) fireEvent.click(toggle);
          const page = await pageFor(view.container.innerHTML, width, theme);
          try {
            const report = classifyVisualMeasurements(await page.evaluate(collectVisualMeasurements));
            expect(report.failures.map((row) => `${row.rule}: ${(row.selectors || [row.selector]).join(" | ")}`), `${plane} ${tables} ${theme} ${width}`).toEqual([]);
            for (const selector of dashboardTextPairs) {
              if (selector === ".cdash-chart__empty") continue;
              const ratio = await page.evaluate(pairRatio, selector);
              expect(ratio, `${selector} in ${theme} at ${width}`).not.toBeNull();
              expect(ratio, `${selector} in ${theme} at ${width}`).toBeGreaterThanOrEqual(4.5);
            }
            const series = await page.evaluate(seriesRatios);
            expect(series.length, "every mark was measured").toBeGreaterThanOrEqual(8);
            expect([...new Set(series.map((row) => row.mark))].sort(), "every mark kind was measured").toEqual(["bar", "column"]);
            for (const row of series) expect(row.ratio, `${row.mark} against ${row.against} in ${theme} at ${width} (${plane})`).toBeGreaterThanOrEqual(3);
            const geometry = await page.evaluate(() => {
              const root = document.querySelector(".cdash").getBoundingClientRect();
              const box = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, height: r.height, text: node.textContent.slice(0, 16), overflow: node.scrollWidth > node.clientWidth + 1 }; };
              return {
                sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
                root: { left: root.left, right: root.right },
                targets: [...document.querySelectorAll(".cdash a, .cdash button")].map(box),
                names: [...document.querySelectorAll(".cdash-bars__name")].map(box),
                tables: [...document.querySelectorAll(".cdash-chart__data table")].map(box),
              };
            });
            expect(geometry.sideways, "the tiles reflow instead of scrolling sideways").toBe(false);
            for (const target of geometry.targets) {
              expect(target.left, `${target.text} stays inside the section`).toBeGreaterThanOrEqual(geometry.root.left - 0.5);
              expect(target.right, `${target.text} is not clipped`).toBeLessThanOrEqual(geometry.root.right + 0.5);
              expect(target.height, `${target.text} is a 44px target`).toBeGreaterThanOrEqual(44 - 0.5);
            }
            for (const name of geometry.names) expect(name.overflow, `${name.text} wraps instead of overflowing`).toBe(false);
            if (tables === "open") for (const table of geometry.tables) expect(table.right, "an open data table stays inside the section").toBeLessThanOrEqual(geometry.root.right + 0.5);
          } finally { await page.close(); }
        } finally { view.unmount(); window.history.replaceState({}, "", "/"); }
      });
    }
  }
}
for (const theme of ["light"]) {
  it(`keeps the empty-window copy of a dashboard tile above AA in ${theme}`, async () => {
    const api = { loadCaseDashboards: () => Promise.resolve({ byStep: [], dueSoon: [], overdue: [], byAssignee: [], medianDays: [] }) };
    const view = render(<LanguageProvider lang="en"><main className="app-column"><div className="cwk-plane"><CaseDashboards api={api} caseListPath="/m/steward" /></div></main></LanguageProvider>);
    try {
      await waitFor(() => expect(view.container.querySelectorAll(".cdash-chart__empty").length).toBe(2));
      const page = await pageFor(view.container.innerHTML, 768, theme);
      try {
        const ratio = await page.evaluate(pairRatio, ".cdash-chart__empty");
        expect(ratio).not.toBeNull();
        expect(ratio, `.cdash-chart__empty in ${theme}`).toBeGreaterThanOrEqual(4.5);
        const report = classifyVisualMeasurements(await page.evaluate(collectVisualMeasurements));
        expect(report.failures.map((row) => `${row.rule}: ${(row.selectors || [row.selector]).join(" | ")}`)).toEqual([]);
      } finally { await page.close(); }
    } finally { view.unmount(); }
  });
}
