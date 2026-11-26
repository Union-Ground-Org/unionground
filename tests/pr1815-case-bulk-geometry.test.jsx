// PR1815 geometry and contrast evidence for the lane 5.6 surfaces: the shared
// bulk-action bar and its row checkbox, the @mention note composer, and the
// case-macro editor. Each check replicates the measurement a per-route
// browser acceptance check performs, in real
// Chromium, at the three acceptance viewports in both workspace themes.
//
// The lane shipped no harness cases. The three defects the first run of this
// file found are repaired in src/styles.css and src/components/: the row and
// select-all checkboxes were the browser default (~13px, far under the 44px
// target floor that selection — the feature's first interaction — has to
// clear), and the macro editor's card treatment was bound to the "Remove
// action" button instead of the action row it was written for.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CaseBulkActions } from "../src/components/CaseBulkActions.jsx";
import { CaseMacroEditor } from "../src/components/CaseMacroEditor.jsx";
import { CaseNoteBody, CaseNoteComposer } from "../src/components/CaseMentions.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { collectVisualMeasurements, classifyVisualMeasurements } from "../scripts/visual-audit.mjs";

const css = (await Promise.all(["sg-tokens.css", "styles.css", "coordinator-theme.css", "motion.css",
  "components/workspacePages.css"].map((path) => readFile(resolve("src", path), "utf8")))).join("\n");

const t = (key, vars = {}) => {
  const value = catalogue.en[key];
  if (value === undefined) throw new Error(`missing en key: ${key}`);
  return value.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
};

const ROWS = Array.from({ length: 4 }, (_, index) => ({
  id: `case-${index}`,
  reference: `GRV-2026-000${index}`,
  memberName: "Fictional Member With A Long Name",
  title: "Overtime assignment and schedule change review",
  deadline: "2026-09-24",
  status: "active",
}));
const VISIBLE = ROWS.map((row) => row.id);

const MENTIONS = [
  { userId: "u-1", fullName: "Ana Ruiz" },
  { userId: "u-2", fullName: "Benjamín Okonkwo-Vasquez" },
];

let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });

// Runs inside Chromium; returns the composited foreground/background contrast
// ratio for the first match, or null when the selector paints nothing.
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

async function pageFor(markup, width, theme, shellWidth = null) {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : width === 768 ? 1024 : 900 }, colorScheme: theme, reducedMotion: "reduce" });
  page.setDefaultTimeout(3000);
  await page.route("**/*", (route) => route.abort());
  await page.setContent(`<base href="http://127.0.0.1:56830/"><div class="sg-app" data-workspace-theme="union-ground" style="width:${shellWidth ?? width}px">${markup}</div>`);
  await page.addStyleTag({ content: css });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

const bulkApi = () => ({
  bulkUpdateCases: vi.fn().mockResolvedValue(4),
  // Union Ground issues have no grievance procedure: even an API that
  // still carries the step routine must not grow an Advance-step control.
  advanceCaseStep: vi.fn().mockResolvedValue({ id: "transition-1" }),
  assignCase: vi.fn().mockResolvedValue({}),
  addCaseNote: vi.fn().mockResolvedValue({}),
  loadAssignmentCandidates: vi.fn().mockResolvedValue([{ userId: "u-1", fullName: "Ana Ruiz", roles: ["steward"] }]),
  listMacros: vi.fn().mockResolvedValue([{ id: "m-1", name: "Close with a note", active: true, actions: [{ kind: "set_status", status: "resolved" }, { kind: "add_note", body: "Closed." }] }]),
  applyMacro: vi.fn().mockResolvedValue({ actionsApplied: 4, actionsSkipped: 0 }),
});

// Each state is a panel the bar can be in: the acceptance runner sweeps a
// painted page, so a control that only exists behind a button needs its own
// case or it is never measured.
const barStates = {
  "idle with a selection": async () => {
    const view = render(<main className="app-column"><CaseBulkActions rows={ROWS} visibleIds={VISIBLE} selection={VISIBLE} onSelectionChange={vi.fn()} api={bulkApi()} t={t} /></main>);
    // The resting bar has no panel to wait on. Sibling states already refuse
    // to return until their panel is in the document; this state has to refuse
    // until the bar root itself is, or the geometry sweep below measures nothing.
    await waitFor(() => expect(view.container.querySelector(".case-bulk"), "case bulk actions root").toBeTruthy());
    // The resting bar offers status, assign, note and macros, and no step.
    const actions = [...view.container.querySelectorAll(".case-bulk__actions button")].map((button) => button.textContent);
    expect(actions).toEqual([t("caseBulk.setStatus"), t("caseBulk.assign"), t("caseBulk.addNote"), t("caseBulk.macros")]);
    for (const label of actions) expect(label).not.toMatch(/advance|step/i);
    return view;
  },
  "status panel open": async () => {
    const view = render(<main className="app-column"><CaseBulkActions rows={ROWS} visibleIds={VISIBLE} selection={VISIBLE} onSelectionChange={vi.fn()} api={bulkApi()} t={t} /></main>);
    fireEvent.click(view.getByText(t("caseBulk.setStatus")));
    await waitFor(() => expect(view.container.querySelector(".case-bulk__form select[name='status'] option")).toBeTruthy());
    expect(view.container.querySelector(".case-bulk__form select[name='step'], .case-bulk__form textarea[name='outcome']")).toBeNull();
    return view;
  },
  "assign panel open": async () => {
    const view = render(<main className="app-column"><CaseBulkActions rows={ROWS} visibleIds={VISIBLE} selection={VISIBLE} onSelectionChange={vi.fn()} api={bulkApi()} t={t} /></main>);
    fireEvent.click(view.getByText(t("caseBulk.assign")));
    await waitFor(() => expect(view.container.querySelector(".case-bulk__confirm")).toBeTruthy());
    return view;
  },
  "macro menu open": async () => {
    const view = render(<main className="app-column"><CaseBulkActions rows={ROWS} visibleIds={VISIBLE} selection={VISIBLE} onSelectionChange={vi.fn()} api={bulkApi()} t={t} /></main>);
    fireEvent.click(view.getByText(t("caseBulk.macros")));
    await waitFor(() => expect(view.container.querySelector(".case-bulk__macros button")).toBeTruthy());
    return view;
  },
  "mixed-status refusal": async () => {
    const mixed = [ROWS[0], { ...ROWS[1], status: "resolved" }];
    const view = render(<main className="app-column"><CaseBulkActions rows={mixed} visibleIds={mixed.map((row) => row.id)} selection={mixed.map((row) => row.id)} onSelectionChange={vi.fn()} api={bulkApi()} t={t} /></main>);
    fireEvent.click(view.getByText(t("caseBulk.setStatus")));
    await waitFor(() => expect(view.container.querySelector(".case-bulk__hint")).toBeTruthy());
    return view;
  },
};

for (const [state, build] of Object.entries(barStates)) {
  for (const theme of ["light"]) {
    it.each([390, 768, 1280])(`audits the case bulk bar clean with the ${state} in ${theme} at %i px`, async (width) => {
      const view = await build();
      const page = await pageFor(view.container.innerHTML, width, theme);
      try {
        // classifyVisualMeasurements returns no failures when the page measured
        // nothing, so an absent bar would pass the list below. The idle matrix
        // is the state with no other painted control to hang that proof on.
        if (state === "idle with a selection") {
          const root = await page.locator(".case-bulk").boundingBox();
          expect(root, "case bulk actions root").toBeTruthy();
        }
        const report = classifyVisualMeasurements(await page.evaluate(collectVisualMeasurements));
        expect(report.failures.map((row) => `${row.rule}: ${(row.selectors || [row.selector]).join(" | ")}`), state).toEqual([]);
      } finally { await page.close(); view.unmount(); }
    });
  }
}

// Selection is the feature's first interaction. The row box and the
// select-all box both have to clear the 44px floor the runner enforces, at
// every viewport, in both themes.
for (const theme of ["light"]) {
  it.each([390, 768, 1280])(`keeps both selection checkboxes at 44px in ${theme} at %i px`, async (width) => {
    const { CaseSelectBox } = await import("../src/components/CaseBulkActions.jsx");
    const view = render(<main className="app-column">
      <CaseBulkActions rows={ROWS} visibleIds={VISIBLE} selection={[ROWS[0].id]} onSelectionChange={vi.fn()} api={bulkApi()} t={t} />
      <article className="gq-row"><CaseSelectBox id={ROWS[0].id} selection={[]} onSelectionChange={vi.fn()} label="Select case GRV-2026-0000" /><button type="button" className="gq-row__btn">row</button></article>
    </main>);
    const page = await pageFor(view.container.innerHTML, width, theme);
    try {
      for (const selector of [".case-bulk__all input[type='checkbox']", ".case-select input[type='checkbox']"]) {
        const box = await page.locator(selector).first().boundingBox();
        expect(box, selector).toBeTruthy();
        expect(box.width, `${selector} width`).toBeGreaterThanOrEqual(44);
        expect(box.height, `${selector} height`).toBeGreaterThanOrEqual(44);
      }
      expect(classifyVisualMeasurements(await page.evaluate(collectVisualMeasurements)).failures.filter((row) => row.rule === "small-target")).toEqual([]);
    } finally { await page.close(); view.unmount(); }
  });
}

// The mention chip is new ink on a new surface, so it is measured rather than
// assumed: `mark` carries the meaning when there is no page to link to, and a
// chip nobody can read is not a chip.
for (const theme of ["light"]) {
  it.each([390, 768, 1280])(`keeps the mention chip above AA and the composer clean in ${theme} at %i px`, async (width) => {
    const view = render(<main className="app-column">
      <CaseNoteBody body="Following up with @Ana Ruiz and @Benjamín Okonkwo-Vasquez before the step-two deadline." mentions={MENTIONS} />
      <CaseNoteComposer caseId="case-0" candidates={MENTIONS} onSubmit={vi.fn()} t={t} />
    </main>);
    const composer = view.container.querySelector(".case-note-composer textarea");
    fireEvent.change(composer, { target: { value: "Handing this to @An" } });
    await waitFor(() => expect(view.container.querySelector(".case-note-composer__mentions button")).toBeTruthy());
    const page = await pageFor(view.container.innerHTML, width, theme);
    try {
      const ratio = await page.evaluate(pairRatio, "mark.case-mention");
      expect(ratio, `mention chip contrast in ${theme}`).toBeGreaterThanOrEqual(4.5);
      const report = classifyVisualMeasurements(await page.evaluate(collectVisualMeasurements));
      expect(report.failures.map((row) => `${row.rule}: ${(row.selectors || [row.selector]).join(" | ")}`)).toEqual([]);
    } finally { await page.close(); view.unmount(); }
  });
}

// The macro editor is a whole page (/m/coordinator/macros), and its action
// rows are the densest layout the lane ships.
for (const theme of ["light"]) {
  it.each([390, 768, 1280])(`audits the case macro editor clean in ${theme} at %i px`, async (width) => {
    const api = { listMacros: vi.fn().mockResolvedValue([{ id: "m-1", name: "Close with a note", chapterId: "wor", active: true, actions: [{ kind: "set_status", status: "resolved" }] }]), saveMacro: vi.fn().mockResolvedValue({}) };
    const view = render(<LanguageProvider lang="en"><main className="app-column"><CaseMacroEditor api={api} chapterId="wor" /></main></LanguageProvider>);
    await waitFor(() => expect(view.container.querySelector(".case-macros__list")).toBeTruthy());
    fireEvent.click(view.container.querySelector(".case-macros__new"));
    await waitFor(() => expect(view.container.querySelector(".case-macros__actions li")).toBeTruthy());
    fireEvent.change(view.container.querySelector(".case-macros__actions select"), { target: { value: "add_alert" } });
    await waitFor(() => expect(view.container.querySelectorAll(".case-macros__actions select").length).toBeGreaterThan(1));
    const page = await pageFor(view.container.innerHTML, width, theme);
    try {
      const report = classifyVisualMeasurements(await page.evaluate(collectVisualMeasurements));
      expect(report.failures.map((row) => `${row.rule}: ${(row.selectors || [row.selector]).join(" | ")}`)).toEqual([]);
    } finally { await page.close(); view.unmount(); }
  });
}

// Additive cases for the two repaired controls
// (UX-UG-CASE-MACRO-EDITOR-RAW-IDS-AND-FREE-TEXT-STEP-20260917 and
// A11Y-UG-CASE-NOTE-MENTION-PICKER-NOT-COMBOBOX-20260917). The macro
// editor's assign and status rows are menus, and the mention list is a
// listbox whose active option carries a ring instead of a focus outline: both
// are new geometry on an audited surface, so both are measured rather than
// assumed. The advance_step row is gone: Union Ground issues have no
// grievance procedure (owner decision, 2026-10-13).
const macroPickerApi = () => ({
  listMacros: vi.fn().mockResolvedValue([{ id: "m-1", name: "Close with a note", chapterId: "wor", active: true, actions: [{ kind: "set_status", status: "resolved" }] }]),
  saveMacro: vi.fn().mockResolvedValue({}),
  loadStaffCandidates: vi.fn().mockResolvedValue([
    { userId: "u-1", fullName: "Ana Ruiz", roles: ["steward"] },
    { userId: "u-2", fullName: "Benjamín Okonkwo-Vasquez", roles: ["coordinator", "steward"] },
  ]),
  listProcedures: vi.fn(),
});

for (const theme of ["light", "dark"]) {
  it.each([390, 768, 1280])(`keeps the macro editor's assign and status menus at 44px in ${theme} at %i px`, async (width) => {
    const api = macroPickerApi();
    const view = render(<LanguageProvider lang="en"><main className="app-column"><CaseMacroEditor api={api} chapterId="wor" /></main></LanguageProvider>);
    await waitFor(() => expect(view.container.querySelector(".case-macros__list")).toBeTruthy());
    fireEvent.click(view.container.querySelector(".case-macros__new"));
    // A new draft opens on a status action; no step menu is offered or read.
    await waitFor(() => expect(view.container.querySelectorAll(".case-macros__actions li select")).toHaveLength(2));
    expect(view.container.querySelector(".case-macros__actions select optgroup, .case-macros__actions option[value='advance_step']")).toBeNull();
    expect(api.listProcedures).not.toHaveBeenCalled();
    fireEvent.click(view.getByText(t("caseMacros.addAction")));
    await waitFor(() => expect(view.container.querySelectorAll(".case-macros__actions li")).toHaveLength(2));
    const rows = view.container.querySelectorAll(".case-macros__actions li");
    fireEvent.change(rows[1].querySelector("select"), { target: { value: "assign" } });
    await waitFor(() => expect(rows[1].querySelectorAll("select")).toHaveLength(3));

    const page = await pageFor(view.container.innerHTML, width, theme);
    try {
      const boxes = await page.locator(".case-macros__actions select").all();
      expect(boxes.length).toBe(5);
      for (const control of boxes) {
        const box = await control.boundingBox();
        expect(box, "macro action menu").toBeTruthy();
        expect(box.height, "macro action menu height").toBeGreaterThanOrEqual(44);
      }
      const report = classifyVisualMeasurements(await page.evaluate(collectVisualMeasurements));
      expect(report.failures.map((row) => `${row.rule}: ${(row.selectors || [row.selector]).join(" | ")}`)).toEqual([]);
    } finally { await page.close(); view.unmount(); }
  });
}

for (const theme of ["light"]) {
  it.each([390, 768, 1280])(`keeps the mention listbox rows at 44px and readable in ${theme} at %i px`, async (width) => {
    const view = render(<main className="app-column">
      <CaseNoteBody body="Following up with @Ana Ruiz and @Benjamín Okonkwo-Vasquez before the step-two deadline." mentions={MENTIONS} />
      <CaseNoteComposer caseId="case-0" candidates={MENTIONS} onSubmit={vi.fn()} t={t} />
    </main>);
    const composer = view.container.querySelector(".case-note-composer textarea");
    fireEvent.change(composer, { target: { value: "Handing this to @" } });
    await waitFor(() => expect(view.container.querySelector("[role='listbox'] [role='option']")).toBeTruthy());
    // ArrowDown marks the second row active, so the ring is painted too.
    fireEvent.keyDown(composer, { key: "ArrowDown" });
    await waitFor(() => expect(view.container.querySelector(".case-note-composer__mentions .is-active")).toBeTruthy());

    const page = await pageFor(view.container.innerHTML, width, theme);
    try {
      for (const option of await page.locator("[role='listbox'] [role='option']").all()) {
        const box = await option.boundingBox();
        expect(box, "mention option").toBeTruthy();
        expect(box.height, "mention option height").toBeGreaterThanOrEqual(44);
      }
      const ratio = await page.evaluate(pairRatio, ".case-note-composer__mentions .is-active");
      expect(ratio, `active mention option contrast in ${theme}`).toBeGreaterThanOrEqual(4.5);
      const report = classifyVisualMeasurements(await page.evaluate(collectVisualMeasurements));
      expect(report.failures.map((row) => `${row.rule}: ${(row.selectors || [row.selector]).join(" | ")}`)).toEqual([]);
    } finally { await page.close(); view.unmount(); }
  });
}
