// PR1815 member-hat contrast regressions (local Chromium evidence, not
// hosted acceptance). Each case replays the exact text/background sweep
// a per-route browser acceptance check runs — every element in
// `main *, .app-column *` that owns a text node, composited over its ancestor
// chain, 4.5:1 (3:1 for large text); unsupported colours and any ancestor
// background-image fail closed, the same way the runner does.
//
//   FIX-UG-PAGE-WORKLOAD-REMINDERS-20260910  /m/workload/reminders
//   FIX-UG-PAGE-SETTINGS-SHORTCUTS-20260910  /m/settings/shortcuts
//   FIX-UG-PAGE-VOTING-BALLOTS-20260910      /m/voting/ballots
//   FIX-UG-PAGE-VOTING-PAST-20260910         /m/voting/past
//
// Night-shift 390/768 failures were hard-coded colours beside a token that
// the theme repoints. The 1440 voting failure is a different pair: desktop
// .voting-stat cards painted linear-gradient(#fefefe, var(--sg-color-card)),
// which the runner cannot composite, so both themes failed at desktop width.
// Colour is locale-invariant here, so the sweep runs EN; the runner's ES
// cases paint the same tokens.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WorkloadView } from "../src/views/WorkloadView.jsx";
import { VotingView } from "../src/views/VotingView.jsx";
import { SettingsView } from "../src/views/SettingsView.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

const css = (await Promise.all(["sg-tokens.css", "styles.css", "coordinator-theme.css", "motion.css",
  "components/workspacePages.css"].map((path) => readFile(resolve("src", path), "utf8")))).join("\n");

let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });

// The runner's sweep, with the failing pairs named instead of counted so a
// regression says which element and which ratio rather than "failed: 1".
function contrastSweep() {
  const rgb = (value) => {
    const match = value.match(/^rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\)$/);
    return match ? [+match[1], +match[2], +match[3], match[4] === undefined ? 1 : +match[4]] : null;
  };
  const luminance = (channels) => channels.slice(0, 3).map((channel) => { const s = channel / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const describe = (node) => {
    const parts = [];
    for (let walk = node; walk && walk.tagName && parts.length < 3; walk = walk.parentElement) {
      parts.unshift(walk.tagName.toLowerCase() + (typeof walk.className === "string" && walk.className.trim() ? `.${walk.className.trim().split(/\s+/).join(".")}` : ""));
    }
    return parts.join(" > ");
  };
  const failures = [];
  let checked = 0;
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
    checked++;
    // The runner fails closed on a pair it cannot composite (an unsupported
    // colour, or a background-image anywhere in the chain), so this does too.
    if (!valid || !fg) { failures.push(`${describe(element)}: uncompositable pair`); continue; }
    const painted = fg.slice(0, 3).map((channel, index) => channel * fg[3] + bg[index] * (1 - fg[3]));
    const a = luminance(painted), b = luminance(bg), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
    if (ratio + 0.01 < (large ? 3 : 4.5)) failures.push(`${describe(element)}: ${style.color} on rgb(${bg.slice(0, 3).map(Math.round).join(",")}) = ${ratio.toFixed(2)}:1`);
  }
  return { checked, failures };
}

async function pageFor(markup, width, theme) {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : width === 768 ? 1024 : 900 }, colorScheme: theme, reducedMotion: "reduce" });
  page.setDefaultTimeout(3000);
  await page.route("**/*", (route) => route.abort());
  await page.setContent(`<base href="http://127.0.0.1:56810/"><div class="sg-app" data-workspace-theme="union-ground" style="width:${width}px">${markup}</div>`);
  await page.addStyleTag({ content: css });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

// Composited foreground/background ratio for one selector, so each repaired
// pair is named in its own assertion alongside the whole-page sweep.
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
  if (!fg) return null;
  let bg = [255, 255, 255, 1]; const chain = [];
  for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) chain.unshift(ancestor);
  for (const node of chain) {
    const color = rgb(getComputedStyle(node).backgroundColor);
    if (color) bg = color.slice(0, 3).map((channel, index) => channel * color[3] + bg[index] * (1 - color[3]));
  }
  const painted = fg.slice(0, 3).map((channel, index) => channel * fg[3] + bg[index] * (1 - fg[3]));
  const a = luminance(painted), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function expectPageClean(markup, width, theme, pairs) {
  const page = await pageFor(markup, width, theme);
  try {
    for (const [selector, label] of Object.entries(pairs)) {
      const ratio = await page.evaluate(pairRatio, selector);
      expect(ratio, `${label} is painted in ${theme} at ${width}px`).not.toBeNull();
      expect(ratio, `${label} ratio in ${theme} at ${width}px`).toBeGreaterThanOrEqual(4.5);
    }
    const sweep = await page.evaluate(contrastSweep);
    expect(sweep.failures, `${theme} at ${width}px`).toEqual([]);
    expect(sweep.checked).toBeGreaterThan(0);
  } finally { await page.close(); }
}

// FIX-UG-PAGE-WORKLOAD-REMINDERS-20260910: the reminders card's Save
// button and the checked "email me" box both painted hard-coded white on
// --green. Night-shift repoints --green to the pale periwinkle tint (the
// .mwl-chip trap FIX-UG-PAGE-WORKLOAD-SUBMIT-20260910 already hit), so
// both pairs measured 1.18:1 and every dark reminders case failed the sweep.
describe("member workload reminders", () => {
  const reminders = { available: true, enabled: true, cadence: "weekly", weekday: 1, localHour: 9,
    timezone: "America/New_York", nextDueAt: "2026-09-21T13:00:00.000Z" };
  async function remindersMarkup() {
    const view = render(<LanguageProvider lang="en"><main className="app-column">
      <WorkloadView data={{ workload: { entries: [], stats: { enoughData: false }, reminders } }}
        onLogWork={vi.fn()} onSaveReminder={vi.fn()} />
    </main></LanguageProvider>);
    fireEvent.click([...view.container.querySelectorAll(".mwl-tab")].at(-1));
    await waitFor(() => expect(view.container.querySelector(".mwl-reminder")).toBeTruthy());
    // The schedule arrives enabled, so the checked box paints its ✓ on the
    // --green fill exactly as the runner finds it on a member's own schedule.
    await waitFor(() => expect(view.container.querySelector(".mwl-checkrow[aria-pressed='true']")).toBeTruthy());
    const markup = view.container.innerHTML;
    view.unmount();
    return markup;
  }
  for (const theme of ["light"]) {
    it.each([390, 768, 1280])(`sweeps the reminders schedule clean in ${theme} at %i px`, async (width) => {
      await expectPageClean(await remindersMarkup(), width, theme, {
        ".mwl-btn--primary": "reminders Save button",
        ".mwl-checkrow[aria-pressed='true'] .mwl-checkbox": "checked reminder box",
      });
    }, 60000);
  }
});

// FIX-UG-PAGE-VOTING-BALLOTS-20260910 / FIX-UG-PAGE-VOTING-PAST-20260910:
// below 1024px both routes render the one phone stack (the tab strip is the
// desktop layout's), so both failed on the same element — the selected poll
// scope chip, which fills with --sg-color-ink and wrote its label as
// hard-coded white. Night-shift repoints --sg-color-ink to the bone
// foreground, so the pair measured 1.1:1.
describe("member voting phone stack", () => {
  // SAMPLE's member has no OPEN ballot, which is the state the runner
  // measures: the ratify hero never paints and the past list does.
  const closed = { ...fallbackData, planItems: (fallbackData.planItems || []).map((item) => (
    item.kind === "ballot" ? { ...item, closed: true } : item)) };
  function votingMarkup() {
    const view = render(<LanguageProvider lang="en"><main className="app-column">
      <VotingView data={closed} demo desktop={false} onPlanAction={vi.fn()} onMessageSteward={vi.fn()} onSuggestPoll={vi.fn()} />
    </main></LanguageProvider>);
    const markup = view.container.innerHTML;
    view.unmount();
    return markup;
  }
  for (const theme of ["light"]) {
    it.each([390, 768, 1280])(`sweeps the voting stack clean in ${theme} at %i px`, async (width) => {
      await expectPageClean(votingMarkup(), width, theme, { ".voting-scope--on": "selected poll scope chip" });
    }, 60000);
  }
});

// Same two records at the runner's 1440x900 desktop tree. App.jsx passes
// desktop={wideScreen && !embedPhone}, so 1440 mounts .voting-stat cards
// instead of the phone stack. Those cards painted
// linear-gradient(180deg, #fefefe, var(--sg-color-card)); the runner cannot
// composite a background-image, so every text node inside them failed as
// an uncompositable pair in BOTH themes (light: #fefefe on #ffffff; dark:
// the same hard-coded #fefefe stop on the night card rgb(21,31,52)). Phone
// 390/768 stay on .voting-card and are covered above.
describe("member voting desktop layout at 1440", () => {
  const closed = { ...fallbackData, planItems: (fallbackData.planItems || []).map((item) => (
    item.kind === "ballot" ? { ...item, closed: true } : item)) };
  function desktopMarkup(tab) {
    const view = render(<LanguageProvider lang="en"><main className="app-column">
      <VotingView data={closed} demo desktop onPlanAction={vi.fn()} onMessageSteward={vi.fn()} onSuggestPoll={vi.fn()} />
    </main></LanguageProvider>);
    if (tab === "past") {
      const pastTab = [...view.container.querySelectorAll(".voting-tab")].find((node) => node.textContent.includes("Past"));
      fireEvent.click(pastTab);
    }
    const markup = view.container.innerHTML;
    view.unmount();
    return markup;
  }
  const routes = [
    { tab: "ballots", pairs: { ".voting-none__title": "no-open heading on the desktop voting-stat card", ".voting-rail__head": "how-it-works rail heading" } },
    { tab: "past", pairs: { ".voting-pastlist__head": "past-list heading on the desktop voting-stat card", ".voting-rail__head": "how-it-works rail heading" } },
  ];
  for (const theme of ["light"]) {
    it.each(routes)(`sweeps /m/voting/$tab clean in ${theme} at 1440 px`, async ({ tab, pairs }) => {
      const page = await pageFor(desktopMarkup(tab), 1440, theme);
      try {
        const statImage = await page.evaluate(() => {
          const card = [...document.querySelectorAll(".voting-stat")].find((node) => !node.classList.contains("voting-rail-dark"));
          return card ? getComputedStyle(card).backgroundImage : null;
        });
        expect(statImage, `${tab} .voting-stat background-image in ${theme}`).toBe("none");
        for (const [selector, label] of Object.entries(pairs)) {
          const ratio = await page.evaluate(pairRatio, selector);
          expect(ratio, `${label} is painted in ${theme} at 1440px`).not.toBeNull();
          expect(ratio, `${label} ratio in ${theme} at 1440px`).toBeGreaterThanOrEqual(4.5);
        }
        const sweep = await page.evaluate(contrastSweep);
        expect(sweep.failures, `${theme} at 1440px on /m/voting/${tab}`).toEqual([]);
        expect(sweep.checked).toBeGreaterThan(0);
      } finally { await page.close(); }
    }, 60000);
  }
});

// FIX-UG-PAGE-SETTINGS-SHORTCUTS-20260910: the shortcut rows' count
// badges. --morehub-alert is a hard-coded brick red (2.77:1 on the night
// panel) and --morehub-draft resolves var(--amber-ink) at :root, so it kept
// the LIGHT bronze (2.83:1) no matter what the theme repointed --amber-ink to.
// Both badges were data-driven. Union Ground has no points economy, so the
// Contributions row carries no points badge even when stale reward data is
// present; the draft-forms badge still renders once a member has a draft form.
describe("member settings shortcuts", () => {
  const data = { member: { initials: "MV", fullName: "Fictional Member" }, roles: [],
    rewards: { totalPoints: 240 }, events: [{ id: "event-1" }, { id: "event-2" }],
    forms: [{ id: "form-1", status: "draft" }] };
  async function shortcutsMarkup() {
    window.history.pushState({}, "", "/m/settings/shortcuts");
    const view = render(<LanguageProvider lang="en"><main className="app-column">
      <WorkspacePages view="settings" location="/m/settings/shortcuts" navigate={vi.fn()} hat="member">
        <SettingsView data={data} lang="en" onLanguage={vi.fn()} onProfile={vi.fn()} onAssistant={vi.fn()} onNavigate={vi.fn()} />
      </WorkspacePages>
    </main></LanguageProvider>);
    await waitFor(() => expect(view.container.querySelector(".morehub-row__badge--gold")).toBeTruthy());
    expect(view.container.querySelector(".morehub-row__badge:not(.morehub-row__badge--gold)")).toBeNull();
    expect(view.container.textContent).not.toMatch(/240|points/i);
    const markup = view.container.innerHTML;
    view.unmount();
    return markup;
  }
  for (const theme of ["light"]) {
    it.each([390, 768, 1280])(`sweeps the shortcuts page clean in ${theme} at %i px`, async (width) => {
      await expectPageClean(await shortcutsMarkup(), width, theme, {
        ".morehub-row__badge--gold": "draft forms badge",
      });
    }, 60000);
  }
});
