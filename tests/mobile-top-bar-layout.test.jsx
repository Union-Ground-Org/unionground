import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { render } from "@testing-library/react";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MobileTopBar } from "../src/components/MobileTopBar.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { OrganizationNameProvider } from "../src/lib/organizationName.js";
import { t } from "../src/lib/i18n.js";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";

const css = (await Promise.all(["sg-tokens.css", "styles.css", "motion.css"].map(path => readFile(resolve("src", path), "utf8")))).join("\n");
const noop = () => {};
let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });

// Desktop Chromium functional reflow, using rendered production markup,
// stylesheet and local fonts. This is not a phone-browser pixel/device gate.
for (const lang of ["en", "es"]) {
  it.each([320, 390])(`keeps the ${lang} inner top bar controls visible without overlap at %i CSS px`, async width => {
    const view = render(
      <LanguageProvider lang={lang}>
        <OrganizationNameProvider value="An organization with a long name that must yield space to navigation controls">
          <div className="sg-app">
            <MobileTopBar onHome={noop} onFeatures={noop} onNotifications={noop} onProfile={noop} initials="AE" roleLabel="Member" />
          </div>
        </OrganizationNameProvider>
      </LanguageProvider>,
    );
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    await page.route("**/*", route => /^\/assets\/.*\.woff2$/.test(new URL(route.request().url()).pathname)
      ? route.fulfill({ path: resolve("public", new URL(route.request().url()).pathname.slice(1)), contentType: "font/woff2" })
      : route.abort());
    try {
      await page.setContent(`<base href="http://127.0.0.1/">${view.container.innerHTML}`);
      await page.addStyleTag({ content: css });
      await page.evaluate(() => document.fonts.ready);
      for (const theme of ["union-ground"]) {
        await page.locator(".sg-app").evaluate((node, value) => { node.dataset.workspaceTheme = value; }, theme);
        const menu = page.getByRole("button", { name: t(lang, "cardnav.features"), exact: true });
        expect(await menu.count()).toBe(1);
        expect(await menu.isVisible()).toBe(true);
        for (const button of [menu, page.getByRole("button", { name: t(lang, "nav.home"), exact: true })]) {
          const box = await button.boundingBox();
          expect(box.width).toBeGreaterThanOrEqual(48);
          expect(box.height).toBeGreaterThanOrEqual(48);
        }
        const boxes = await page.locator(".mobile-top > *").evaluateAll(nodes => nodes.map(node => {
          const box = node.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
        }));
        for (const box of boxes) {
          expect(box.left).toBeGreaterThanOrEqual(0);
          expect(box.right).toBeLessThanOrEqual(width);
        }
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
          }
        }
        const label = await menu.evaluate(node => {
          const range = document.createRange();
          range.selectNodeContents(node);
          const box = node.getBoundingClientRect();
          return [...range.getClientRects()].map(rect => ({ left: rect.left - box.left, right: rect.right - box.right, top: rect.top - box.top, bottom: rect.bottom - box.bottom }));
        });
        for (const rect of label) {
          expect(rect.left).toBeGreaterThanOrEqual(0);
          expect(rect.right).toBeLessThanOrEqual(0);
          expect(rect.top).toBeGreaterThanOrEqual(0);
          expect(rect.bottom).toBeLessThanOrEqual(0);
        }
        // The role row is full width on its own grid row: it wraps a long name
        // instead of clipping the office named after the hat (PR #4084).
        const role = await page.locator(".mobile-top__role").evaluate(node => ({ whiteSpace: getComputedStyle(node).whiteSpace, clipped: node.scrollWidth > node.clientWidth }));
        expect(role).toEqual({ whiteSpace: "normal", clipped: false });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        expect(await page.locator(".bottom-nav").count()).toBe(0);
      }
    } finally { await page.close(); }
  });
}
