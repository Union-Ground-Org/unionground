import { chromium } from "@playwright/test";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { StandaloneLanguageShell } from "../src/components/StandaloneLanguageShell.jsx";
import { GetAppView } from "../src/views/GetAppView.jsx";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";

const css = ["sg-tokens.css", "styles.css"].map((name) => readFileSync(`src/${name}`, "utf8")).join("\n");
let browser;
beforeAll(async () => { browser = await chromium.launch(); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });
afterEach(() => { cleanup(); localStorage.clear(); });

describe.each(["en", "es"])("get-app first screen (%s)", (lang) => {
  for (const theme of ["union-ground"]) {
    it.each([1440, 390, 320])(`fits the device choices with ${theme} at %i CSS px`, async (width) => {
      localStorage.setItem("sg-lang", lang);
      const { container } = render(<StandaloneLanguageShell languageSwitch>
        <GetAppView origin="https://unionground.net" userAgent="" />
      </StandaloneLanguageShell>);
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.setContent(`<div class="sg-app sg-app--public" data-workspace-theme="${theme}">${container.innerHTML}</div>`);
        await page.addStyleTag({ content: css });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        expect(await page.locator(".gapp-item").count()).toBe(3);
        if (width === 1440) {
          for (const item of await page.locator(".gapp-item, .gapp-qr svg, .gapp-qr p").all()) {
            const box = await item.boundingBox();
            expect(box.y).toBeGreaterThanOrEqual(0);
            expect(box.y + box.height).toBeLessThanOrEqual(900);
          }
        } else {
          expect(await page.locator(".gapp-qr").isVisible()).toBe(false);
        }
      } finally { await page.close(); }
    });
  }
});
