import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, expect, it } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { buildCoordinationActor } from "../src/lib/mi1CoordinationWiring.js";
import { t } from "../src/lib/i18n.js";
import { OrganizationCoordinationDesk } from "../src/features/coordination/ui/OrganizationCoordinationDesk.jsx";

const css = (await Promise.all([
  "sg-tokens.css", "styles.css", "coordinator-theme.css", "motion.css",
  "features/coordination/ui/organizationCoordination.css",
].map(path => readFile(resolve("src", path), "utf8")))).join("\n");

const actor = buildCoordinationActor({
  userId: "user-1", organizationId: "org-1", chapterId: "wor",
  membershipStatus: "active", selectedHat: "coordinator",
  organizationRoles: ["coordinator"], mfaSatisfied: true, sessionScope: "resolved",
});
const model = {
  state: "ready", organizationId: "org-1", staff: true,
  records: [
    { id: "link-1", kind: "network_link", title: "Network link", status: "active", visibility: "participants", organizationId: "org-1" },
    { id: "conversation-1", kind: "network_conversation", title: "Conversation", status: "active", visibility: "participants", organizationId: "org-1", parentId: "link-1" },
    { id: "handshake-1", kind: "handshake_workspace_item", title: "Handshake work", status: "requested", visibility: "participants", organizationId: "org-1" },
  ],
  leaderboards: [], messages: [], resources: [], exportRuns: [], outreach: [],
};

let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });

// Expanded chapter and desktop rails occupy 272px + 248px. Viewport media
// queries alone cannot tell how much space the coordination desk has left.
for (const lang of ["en", "es"]) {
  it.each([1280, 1440, 1540, 1920])(`keeps complete ${lang} coordination labels inside desktop cards with expanded rails at %i px`, async width => {
    const view = render(<LanguageProvider lang={lang}><OrganizationCoordinationDesk actor={actor} model={model} status="ready" /></LanguageProvider>);
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    // Load only the shipped local fonts; never contact an external origin.
    await page.route("**/*", route => /^\/assets\/.*\.woff2$/.test(new URL(route.request().url()).pathname)
      ? route.fulfill({ path: resolve("public", new URL(route.request().url()).pathname.slice(1)), contentType: "font/woff2" })
      : route.abort());
    try {
      for (const tab of ["network", "operations"]) {
        fireEvent.click(screen.getByRole("tab", { name: t(lang, `coordination.tab.${tab}`), exact: true }));
        await page.setContent(`<base href="http://127.0.0.1/"><div class="sg-app sg-app--desktop"><main class="app-column" style="width:${width - 520}px">${view.container.innerHTML}</main></div>`);
        await page.addStyleTag({ content: css });
        await page.evaluate(() => document.fonts.ready);
        for (const theme of ["union-ground"]) {
          await page.locator(".sg-app").evaluate((node, value) => { node.dataset.workspaceTheme = value; }, theme);
          const measurements = await page.locator(".coord-card__head > .coord-badge, .coord-card__head > .coord-status").evaluateAll(nodes => nodes.map(node => {
            const pill = node.getBoundingClientRect();
            const card = node.closest(".coord-card").getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(node);
            const text = range.getBoundingClientRect();
            return {
              label: node.textContent, pillLeft: pill.left, pillRight: pill.right,
              cardLeft: card.left, cardRight: card.right,
              textLeft: text.left, textRight: text.right, textHeight: text.height,
              pillHeight: pill.height, whiteSpace: getComputedStyle(node).whiteSpace,
            };
          }));
          expect(measurements.length).toBeGreaterThan(0);
          if (lang === "es" && tab === "operations") {
            expect(measurements.some(row => row.label === "Trabajo del acuerdo")).toBe(true);
          }
          for (const row of measurements) {
            const context = `${width}px ${lang} ${tab} ${theme}: ${row.label}`;
            expect(row.whiteSpace, context).toBe("nowrap");
            expect(row.pillLeft, context).toBeGreaterThanOrEqual(row.cardLeft);
            expect(row.pillRight, context).toBeLessThanOrEqual(row.cardRight);
            expect(row.textLeft, context).toBeGreaterThanOrEqual(row.pillLeft);
            expect(row.textRight, context).toBeLessThanOrEqual(row.pillRight);
            expect(row.textHeight, context).toBeLessThanOrEqual(row.pillHeight);
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth), `${width}px ${theme} page reflow`).toBeLessThanOrEqual(width);
        }
      }
    } finally { await page.close(); }
  });
}
