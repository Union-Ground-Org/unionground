// UX-UG-TABLET-RAIL-HAS-NO-CHAPTER-SWITCHER-AND-PHONE-WEB-LAYOUT-FAULTS-20261122
// (#9543, site audit A-39): at phone width the six Coordination tabs squeezed
// into one row and broke inside words ("Mis/sio/ns", "Net/wor/k"). In the
// routed app each tab is the shared <a class="workspace-routed-tab">, whose
// shared rule lets a label wrap anywhere; the Coordination strip's own
// no-wrap rule only named <button>. Each label now stays whole on one line and
// the strip scrolls sideways, with no page-level horizontal scroll at 320 px.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { buildCoordinationActor } from "../src/lib/mi1CoordinationWiring.js";
import { t } from "../src/lib/i18n.js";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { OrganizationCoordinationDesk } from "../src/features/coordination/ui/OrganizationCoordinationDesk.jsx";
import { COORDINATION_TABS } from "../src/features/coordination/contract.js";

const css = (await Promise.all([
  "sg-tokens.css", "styles.css", "coordinator-theme.css", "motion.css",
  "components/workspacePages.css", "components/routedTabs.css",
  "features/coordination/ui/organizationCoordination.css",
].map((path) => readFile(resolve("src", path), "utf8")))).join("\n");

const actor = buildCoordinationActor({
  userId: "user-1", organizationId: "org-1", chapterId: "wor",
  membershipStatus: "active", selectedHat: "admin",
  organizationRoles: ["admin"], mfaSatisfied: true, sessionScope: "resolved",
});
const model = { state: "ready", organizationId: "org-1", staff: true, records: [], leaderboards: [], messages: [], resources: [], exportRuns: [], outreach: [] };

let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });
afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); });

for (const lang of ["en", "es"]) {
  it.each([390, 320])(`keeps every ${lang} Coordination tab label whole on one line at %i px`, async (width) => {
    window.history.replaceState({}, "", "/m/coordination");
    const view = render(
      <LanguageProvider lang={lang}>
        <WorkspacePages view="admin" hat="admin" location={window.location.href} navigate={vi.fn()}>
          <OrganizationCoordinationDesk actor={actor} model={model} status="ready" />
        </WorkspacePages>
      </LanguageProvider>,
    );
    const tabs = view.container.querySelectorAll(".coord-tabs > *");
    expect(tabs.length).toBe(COORDINATION_TABS.length);
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
        const labels = [...document.querySelectorAll(".coord-tabs > .workspace-routed-tab")].map((tab) => {
          const range = document.createRange();
          range.selectNodeContents(tab);
          const tops = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
          return { text: tab.textContent, lines: tops.size, clipped: tab.scrollWidth > tab.clientWidth + 1 };
        });
        return { labels, pageScroll: document.documentElement.scrollWidth > window.innerWidth };
      });
      expect(result.labels.map((label) => label.text)).toEqual(COORDINATION_TABS.map((tab) => t(lang, `coordination.tab.${tab.id}`)));
      for (const label of result.labels) expect(label, label.text).toMatchObject({ lines: 1, clipped: false });
      expect(result.pageScroll).toBe(false);
    } finally {
      await page.close();
    }
  });
}
