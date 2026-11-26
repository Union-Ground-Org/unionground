import { chromium } from "@playwright/test";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { OfficerMemberDirectory } from "../src/components/OfficerMemberDirectory.jsx";
import { MemberRequestsPanel } from "../src/features/requests/MemberRequestsPanel.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { StaffFeatureGuide } from "../src/features/onboardingGuideEngine/StaffGuides.jsx";
import { staffFeatureGuides } from "../src/features/onboardingGuideEngine/staffGuides.js";
import { SettingsView } from "../src/views/SettingsView.jsx";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";

// A card title that repeats its
// page title is kept as a visually hidden h2. On Settings Language and on
// Requests that h2 was the only child of .setin-card__head, and a stylesheet
// rule hid such a head with display: none, which took the h2 out of the
// screen-reader heading list (h1, then h3). A failed member directory showed
// an empty head bar. jsdom applies no stylesheet, so these pages are drawn in
// Chromium with the app's own CSS, where the browser decides what a screen
// reader is given.

const css = ["sg-tokens.css", "styles.css", "components/workspacePages.css"]
  .map((name) => readFileSync(`src/${name}`, "utf8")).join("\n");
const ORGANIZATION_ID = "a1b2c3d4-0000-4000-8000-000000000001";

let browser;
beforeAll(async () => { browser = await chromium.launch(); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });
afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); });

function onPage(path, view, hat, child, lang = "en") {
  window.history.replaceState({}, "", path);
  return render(<LanguageProvider lang={lang}>
    <WorkspacePages view={view} hat={hat} location={window.location.href} navigate={vi.fn()}>{child}</WorkspacePages>
  </LanguageProvider>);
}

const settingsData = { member: { id: "u-sam", fullName: "Samuel Adeyemi", initials: "SA", chapterName: "Main Floor" }, roles: [], metrics: {}, cases: [], events: [], forms: [], product: { spaces: [] } };
const requestsApi = () => ({
  submit: vi.fn(), decide: vi.fn(), invite: vi.fn(),
  listMine: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
  listToDecide: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
});
const settings = (lang, extra = {}) => <SettingsView data={settingsData} onNavigate={vi.fn()} onProfile={vi.fn()} onAssistant={vi.fn()} lang={lang} onLanguage={vi.fn()} {...extra}
  requestsPanel={<MemberRequestsPanel api={requestsApi()} lang={lang} onNotice={vi.fn()} />} />;

// Each case paints a page whose card head held only the repeated title.
const CASES = {
  "Settings Requests": {
    title: { en: "Requests", es: "Solicitudes" },
    draw: (lang) => onPage("/m/settings/requests", "settings", "member", settings(lang), lang),
    ready: () => document.querySelector(".member-requests"),
  },
  // The site view card's h3 follows the Language card's hidden h2.
  "Settings Language": {
    title: { en: "Language", es: "Idioma" },
    draw: (lang) => onPage("/m/settings/language", "settings", "member", settings(lang, { siteView: { alt: false, onChange: vi.fn() } }), lang),
    ready: () => document.querySelector(".site-view-card h3") && document.querySelector("[id$='-lang-title']"),
  },
  "a failed member directory": {
    title: { en: "Worker directory", es: "Directorio de trabajadores" },
    draw: (lang) => {
      const failing = { rpc: vi.fn(async (name) => {
        if (name === "get_member_directory_access") return { data: { canRead: true, scope: "campaign", chapterId: "north" }, error: null };
        throw new TypeError("network down");
      }) };
      return onPage("/m/vp/member-directory", "vp", "vp", <>
        <h1>{lang === "es" ? "Directorio de trabajadores" : "Worker directory"}</h1>
        <OfficerMemberDirectory client={failing} sectionName="vp-member-directory" />
      </>, lang);
    },
    ready: () => document.querySelector("[role=alert]"),
  },
  // B-52: the feature guide card on the Advisor's Campaign health page.
  "the guide card on Campaign health": {
    title: { en: "Campaign health", es: "Salud de la campaña" },
    guide: { en: "About Campaign health", es: "Sobre Salud de la campaña" },
    draw: (lang) => {
      const view = staffFeatureGuides({ payload: { state: "active", organizationId: ORGANIZATION_ID, roles: [{ role: "advisor", scope: "organization" }], steps: [] }, hat: "advisor", path: "/m/advisor" }).view;
      return render(<LanguageProvider lang={lang}><h1>{lang === "es" ? "Salud de la campaña" : "Campaign health"}</h1><StaffFeatureGuide guides={view} onPrimary={vi.fn()} onGotIt={vi.fn()} /></LanguageProvider>);
    },
    ready: () => document.querySelector(".member-guide-card"),
  },
};

describe.each(["en", "es"])("a card head that held only its title (%s)", (lang) => {
  it.each(Object.keys(CASES))("%s keeps its h2 for a screen reader and draws no empty head", async (name) => {
    const { title, draw, ready } = CASES[name];
    const { container } = draw(lang);
    await screen.findByRole("heading", { level: 1 });
    await vi.waitFor(() => expect(ready()).not.toBeNull());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });
    try {
      await page.setContent(`<!doctype html><html lang="${lang}"><head><style>${css}</style></head><body><div class="sg-app" data-workspace-theme="union-ground"><main>${container.innerHTML}</main></div></body></html>`);
      // The heading list a screen reader is given: what the browser leaves
      // in the accessibility tree once the stylesheet applies.
      const headings = await page.getByRole("heading").evaluateAll((nodes) => nodes.map((node) => ({ level: Number(node.tagName.slice(1)), text: node.textContent.trim() })));
      expect(headings[0]).toEqual({ level: 1, text: title[lang] });
      expect(headings.filter((heading) => heading.level === 2).map((heading) => heading.text)).toContain(CASES[name].guide?.[lang] ?? title[lang]);
      // The page title is in the heading list once as visible text.
      const visibleTitles = await page.getByRole("heading", { name: title[lang], exact: true }).evaluateAll((nodes) => nodes.filter((node) => !node.classList.contains("visually-hidden")).length);
      expect(visibleTitles).toBe(1);
      headings.forEach((heading, index) => {
        if (index) expect(heading.level - headings[index - 1].level, JSON.stringify(headings)).toBeLessThanOrEqual(1);
      });
      // No card head on screen is left with nothing to read: text kept only
      // for a screen reader (.visually-hidden) does not count.
      const emptyHeads = await page.locator(".setin-card__head, .xus-cardhead").evaluateAll((nodes) => nodes
        .filter((node) => node.checkVisibility() && node.getBoundingClientRect().height > 0)
        .filter((node) => {
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          for (let text = walker.nextNode(); text; text = walker.nextNode()) {
            if (text.textContent.trim() && !text.parentElement.closest(".visually-hidden") && text.parentElement.checkVisibility()) return false;
          }
          return true;
        })
        .map((node) => node.outerHTML.slice(0, 120)));
      expect(emptyHeads).toEqual([]);
    } finally {
      await page.close();
    }
  });
});

// At 320 CSS px in English: no page-level horizontal scroll, nothing wider
// than the screen, and every stop of a full Tab walk is something a sighted
// keyboard user can see (the hidden h2 takes no focus). The layout is read at
// rest: the .screen entry animation slides the page in from the side.
describe("the changed cards at 320 px with a keyboard (en)", () => {
  it.each(Object.keys(CASES))("%s", async (name) => {
    const { draw, ready } = CASES[name];
    const { container } = draw("en");
    await screen.findByRole("heading", { level: 1 });
    await vi.waitFor(() => expect(ready()).not.toBeNull());
    const page = await browser.newPage({ viewport: { width: 320, height: 720 }, colorScheme: "light" });
    try {
      await page.setContent(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><style>${css}</style><style>*, *::before, *::after { animation: none !important; transition: none !important; }</style></head><body><div class="sg-app" data-workspace-theme="union-ground"><main>${container.innerHTML}</main></div></body></html>`);
      const layout = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth > window.innerWidth,
        wide: [...document.querySelectorAll("main *")]
          .filter((node) => node.checkVisibility() && !node.closest(".visually-hidden") && node.getBoundingClientRect().right > window.innerWidth + 1)
          .map((node) => `${node.tagName}.${node.className}`.slice(0, 80)),
      }));
      expect(layout).toEqual({ scroll: false, wide: [] });
      const focusable = await page.locator("a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])").count();
      const stops = [];
      for (let index = 0; index < focusable + 1; index += 1) {
        await page.keyboard.press("Tab");
        const stop = await page.evaluate(() => {
          const node = document.activeElement;
          if (!node || node === document.body) return null;
          const box = node.getBoundingClientRect();
          return { tag: node.tagName, hidden: Boolean(node.closest(".visually-hidden")), seen: node.checkVisibility() && box.width > 2 && box.height > 2 };
        });
        if (!stop) break;
        stops.push(stop);
      }
      expect(stops.filter((stop) => stop.hidden || !stop.seen)).toEqual([]);
      expect(stops.some((stop) => stop.tag === "H2")).toBe(false);
    } finally {
      await page.close();
    }
  });
});
