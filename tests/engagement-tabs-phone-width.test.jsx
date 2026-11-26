// UX-UG-TABLET-RAIL-HAS-NO-CHAPTER-SWITCHER-AND-PHONE-WEB-LAYOUT-FAULTS-20261122
// (#9543, the A-39 class): the Engagement studio's six tabs broke inside words at
// phone width ("Sur/veys", "Preguntas se/ma/na/les"), the same fault as
// Coordination's: the routed app renders the shared <a class="workspace-routed-tab">,
// whose shared rule lets a label wrap anywhere, and the strip's own rules named
// only <button>. Each label now stays whole and the strip scrolls sideways.
// Because it scrolls, a tab reached by keyboard and the current tab on arrival
// (a deep link to Channels) are brought fully into the strip, moving the strip
// only, never the page (PR #9674 second read).
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { StaffEngagement } from "../src/features/engagement/StaffEngagement.jsx";
import { engagementApi } from "../src/features/engagement/api.js";

const css = (await Promise.all([
  "sg-tokens.css", "styles.css", "motion.css",
  "components/workspacePages.css", "components/routedTabs.css",
  "features/engagement/engagement.css",
].map((path) => readFile(resolve("src", path), "utf8")))).join("\n");
const revealSource = await readFile(resolve("src/lib/stripReveal.js"), "utf8");
const LABELS = ["engagement.surveys", "engagement.weeklyPool", "engagement.livePolls", "engagement.contextual", "engagement.delivery", "engagement.channels"];

let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.replaceState({}, "", "/"); });

for (const lang of ["en", "es"]) {
  it.each([390, 320])(`keeps every ${lang} Engagement tab label whole on one line at %i px`, async (width) => {
    vi.spyOn(engagementApi, "loadOrganizationSwitches").mockResolvedValue({ switches: {} });
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue({ surveys: [], livePolls: [], channels: [], pulsePrompts: [], members: [] });
    window.history.replaceState({}, "", "/m/engagement");
    const view = render(
      <LanguageProvider lang={lang}>
        <WorkspacePages view="admin" hat="admin" location={window.location.href} navigate={vi.fn()}>
          <StaffEngagement client={{}} />
        </WorkspacePages>
      </LanguageProvider>,
    );
    await screen.findByTestId("staff-engagement");
    const tabs = view.container.querySelectorAll(".eng-tabs > *");
    expect(tabs.length).toBe(LABELS.length);
    // The routed app renders anchors, as on the live site.
    expect([...tabs].every((tab) => tab.tagName === "A" && tab.classList.contains("workspace-routed-tab"))).toBe(true);
    const page = await browser.newPage({ viewport: { width, height: 844 }, reducedMotion: "reduce" });
    await page.route("**/*", (route) => (/^\/assets\/.*\.woff2$/.test(new URL(route.request().url()).pathname)
      ? route.fulfill({ path: resolve("public", new URL(route.request().url()).pathname.slice(1)), contentType: "font/woff2" })
      : route.abort()));
    try {
      await page.setContent(`<base href="http://127.0.0.1/"><div class="sg-app sg-app--phone"><main class="app-column" style="padding:0 16px">${view.container.innerHTML}</main></div>`);
      await page.addStyleTag({ content: css });
      await page.evaluate(() => document.fonts.ready);
      const result = await page.evaluate(() => {
        const labels = [...document.querySelectorAll(".eng-tabs > .workspace-routed-tab")].map((tab) => {
          // Text only: each tab also holds an icon, which is not a line of the label.
          const walker = document.createTreeWalker(tab, NodeFilter.SHOW_TEXT);
          const tops = new Set();
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) if (rect.width > 0) tops.add(Math.round(rect.top));
          }
          return { text: tab.textContent, lines: tops.size, clipped: tab.scrollWidth > tab.clientWidth + 1 };
        });
        return { labels, pageScroll: document.documentElement.scrollWidth > window.innerWidth };
      });
      expect(result.labels.map((label) => label.text)).toEqual(LABELS.map((key) => t(lang, key)));
      for (const label of result.labels) expect(label, label.text).toMatchObject({ lines: 1, clipped: false });
      expect(result.pageScroll).toBe(false);
    } finally {
      await page.close();
    }
  });
}

async function renderStudio(lang, path) {
  vi.spyOn(engagementApi, "loadOrganizationSwitches").mockResolvedValue({ switches: {} });
  vi.spyOn(engagementApi, "loadStaff").mockResolvedValue({ surveys: [], livePolls: [], channels: [], pulsePrompts: [], members: [] });
  window.history.replaceState({}, "", path);
  const view = render(
    <LanguageProvider lang={lang}>
      <WorkspacePages view="campaigns" hat="admin" location={window.location.href} navigate={vi.fn()}>
        <StaffEngagement client={{}} />
      </WorkspacePages>
    </LanguageProvider>,
  );
  await screen.findByTestId("staff-engagement");
  return view;
}

// Lays the rendered studio out in Chromium. At 320 px the phone shell; at
// 1,024 px the desktop shell, whose 248 px rail leaves a 664 px strip.
// `reveal` loads the shipped src/lib/stripReveal.js and wires it as
// StaffEngagement does (the jsdom cases below prove that wiring).
async function openStrip(html, width, reveal) {
  const page = await browser.newPage({ viewport: { width, height: 844 }, reducedMotion: "reduce" });
  await page.route("**/*", (route) => (/^\/assets\/.*\.woff2$/.test(new URL(route.request().url()).pathname)
    ? route.fulfill({ path: resolve("public", new URL(route.request().url()).pathname.slice(1)), contentType: "font/woff2" })
    : route.abort()));
  const shell = width >= 1024
    ? `<div class="sg-app"><main class="app-column" style="margin-left:248px;padding:0 28px">${html}</main></div>`
    : `<div class="sg-app sg-app--phone"><main class="app-column" style="padding:0 16px">${html}</main></div>`;
  await page.setContent(`<base href="http://127.0.0.1/">${shell}`);
  await page.addStyleTag({ content: css });
  await page.evaluate(() => document.fonts.ready);
  if (reveal) {
    await page.addScriptTag({ type: "module", content: `${revealSource}\nwindow.stripReveal = { revealCurrentInStrip, revealFocusedInStrip };` });
    await page.waitForFunction(() => window.stripReveal);
    await page.evaluate(() => {
      const strip = document.querySelector(".eng-tabs");
      window.stripReveal.revealFocusedInStrip(strip);
      window.stripReveal.revealCurrentInStrip(strip);
    });
  }
  return page;
}

// Where a tab sits against the strip, and whether the page moved.
function placement(page, index) {
  return page.evaluate((at) => {
    const strip = document.querySelector(".eng-tabs");
    const tab = strip.children[at];
    const box = strip.getBoundingClientRect();
    const rect = tab.getBoundingClientRect();
    return {
      text: tab.textContent,
      focused: document.activeElement === tab,
      inside: rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5,
      overflows: strip.scrollWidth > strip.clientWidth,
      pageScroll: document.documentElement.scrollWidth > window.innerWidth || window.scrollX !== 0,
    };
  }, index);
}

// Press Tab from the first tab to the last; report each tab as it takes focus.
async function tabThrough(page) {
  await page.focus(".eng-tabs > :first-child");
  const seen = [await placement(page, 0)];
  for (let index = 1; index < LABELS.length; index += 1) {
    await page.keyboard.press("Tab");
    seen.push(await placement(page, index));
  }
  return seen;
}

for (const lang of ["en", "es"]) {
  for (const width of [320, 1024]) {
    it(`brings each ${lang} Engagement tab fully into the strip when Tab reaches it, at ${width} px`, async () => {
      const view = await renderStudio(lang, "/m/campaigns/engagement");
      const html = view.container.innerHTML;
      const bare = await openStrip(html, width, false);
      try {
        // Without the reveal the strip overflows and Tab leaves a tab clipped.
        const before = await tabThrough(bare);
        expect(before[0].overflows).toBe(true);
        expect(before.some((tab) => !tab.inside)).toBe(true);
      } finally {
        await bare.close();
      }
      const page = await openStrip(html, width, true);
      try {
        const seen = await tabThrough(page);
        expect(seen.map((tab) => tab.text)).toEqual(LABELS.map((key) => t(lang, key)));
        for (const tab of seen) expect(tab, tab.text).toMatchObject({ focused: true, inside: true, pageScroll: false });
      } finally {
        await page.close();
      }
    });

    it(`shows the current ${lang} tab fully inside the strip on arrival at Channels, at ${width} px`, async () => {
      const view = await renderStudio(lang, "/m/campaigns/engagement/channels");
      const last = LABELS.length - 1;
      expect(view.container.querySelector(".eng-tabs > [aria-current=\"page\"]")?.textContent).toBe(t(lang, "engagement.channels"));
      const html = view.container.innerHTML;
      const bare = await openStrip(html, width, false);
      try {
        expect(await placement(bare, last)).toMatchObject({ inside: false, overflows: true });
      } finally {
        await bare.close();
      }
      const page = await openStrip(html, width, true);
      try {
        expect(await placement(page, last)).toMatchObject({ text: t(lang, "engagement.channels"), inside: true, pageScroll: false });
      } finally {
        await page.close();
      }
    });
  }
}

// jsdom has no layout, so these give the strip and its tabs fixed boxes (a 256
// px strip, 120 px tabs 130 px apart) and check that StaffEngagement itself
// moves the strip: on arrival at the last tab, and when a tab takes focus.
function stripBoxes() {
  const box = (left, width) => ({ left, right: left + width, top: 0, bottom: 48, width, height: 48, x: left, y: 0, toJSON() {} });
  return vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function boxes() {
    if (this.classList?.contains("eng-tabs")) return box(0, 256);
    const strip = this.parentElement;
    if (strip?.classList?.contains("eng-tabs")) return box([...strip.children].indexOf(this) * 130 - strip.scrollLeft, 120);
    return box(0, 0);
  });
}

it("scrolls the Engagement strip to the current tab when the studio opens on Channels", async () => {
  stripBoxes();
  const view = await renderStudio("en", "/m/campaigns/engagement/channels");
  const strip = view.container.querySelector(".eng-tabs");
  const channels = strip.lastElementChild;
  expect(channels.getAttribute("aria-current")).toBe("page");
  const rect = channels.getBoundingClientRect();
  expect(strip.scrollLeft).toBeGreaterThan(0);
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(256);
});

it("scrolls the Engagement strip to a tab when it takes focus", async () => {
  stripBoxes();
  const view = await renderStudio("en", "/m/campaigns/engagement");
  const strip = view.container.querySelector(".eng-tabs");
  expect(strip.scrollLeft).toBe(0);
  const channels = strip.lastElementChild;
  act(() => channels.focus());
  expect(document.activeElement).toBe(channels);
  const rect = channels.getBoundingClientRect();
  expect(strip.scrollLeft).toBeGreaterThan(0);
  expect(rect.right).toBeLessThanOrEqual(256);
  act(() => strip.firstElementChild.focus());
  expect(strip.scrollLeft).toBe(0);
});
