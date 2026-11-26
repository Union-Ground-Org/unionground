// @vitest-environment node
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { createServer } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

let server;
let browser;
let origin;
const proofDir = process.env.W6_PROOF_DIR || resolve(tmpdir(), "union-ground-shared-components-proof");
// Let Playwright select its headless shell by default. Forcing full Chromium
// creates a SingletonSocket under TMPDIR that aborts on long task paths.
const chromePath = process.env.W6_CHROME_PATH;

describe("shared controls at desktop and narrow CSS widths", () => {
beforeAll(async () => {
  server = await createServer({
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    logLevel: "error",
    plugins: [{
      name: "shared-fixture-no-watch",
      // Vite's config merge drops inline null values. Apply this after the
      // merge so a static fixture never watches the repository's bulk evidence.
      configResolved(config) { config.server.watch = null; },
    }],
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  await mkdir(proofDir, { recursive: true });
}, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); await server?.close(); }, 30000);

  // 1280x900 and 768x1024 are the supported-functional web tier's proof
  // viewports (design workflow); 1440 is the census desktop capture size;
  // 390 and 320 are the functional reflow floors (no phone-web pixel gate).
  for (const [width, height] of [[1440, 900], [1280, 900], [768, 1024], [390, 900], [320, 900]]) {
    it(`mounts all components at ${width}x${height} with reachable targets and no sideways overflow`, async () => {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(`${origin}/tests/fixtures/w6-proof.html`, { waitUntil: "networkidle" });
      // The two-core coverage run can outlive Vitest's default 1s mount poll
      // (1/5 on both Main and PM1; 0/5 unpinned). Keep the same assertion and
      // local budget, with the standard runner's existing scheduling margin.
      await expect.poll(async () => page.locator(".sg-tracker-stage").count(), { timeout: runnerTimeout(1_000) }).toBe(1);
      expect(pageErrors).toEqual([]);
      const dimensions = await page.evaluate(() => {
        const h = (selector) => { const element = document.querySelector(selector); if (!element) throw new Error(`Missing ${selector}`); return Math.round(element.getBoundingClientRect().height); };
        const targets = [...document.querySelectorAll(".sg-button, .sg-field :is(input,select,textarea), .workspace-routed-tab, .sg-segments__item, .sg-filters__item, .sg-pager__number, .sg-tracker-stage__toggle, .sg-tracker-stage__show, .sg-tracker-row .kan-listrow__title, .sg-tracker-row .kan-listrow__cycle")].map((element) => {
          const { width, height } = element.getBoundingClientRect();
          return { name: element.getAttribute("aria-label") || element.textContent.trim(), width, height };
        });
        const trackerText = [...document.querySelectorAll(".sg-tracker-row *")].filter((element) =>
          !element.closest(".visually-hidden,.sg-visually-hidden,svg") && element.getClientRects().length &&
          [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()),
        ).map((element) => ({ text: element.textContent.trim(), fontSize: parseFloat(getComputedStyle(element).fontSize) }));
        return { overflow: document.documentElement.scrollWidth - window.innerWidth, targets, trackerText,
          button: h(".sg-button--primary"), small: h(".sg-button--small"), field: h(".sg-field input"),
          tab: h(".workspace-routed-tab"), segment: h(".sg-segments__item"), filter: h(".sg-filters__item"),
          stage: h(".sg-tracker-stage__toggle"), trackerAction: h(".sg-tracker-row .kan-listrow__cycle"),
          chip: h(".sg-chip"), pageNumber: h(".sg-pager__number"), ring: Math.round(document.querySelector(".sg-tracker-ring").getBoundingClientRect().width),
          titleSize: parseFloat(getComputedStyle(document.querySelector(".sg-page-header h1")).fontSize) };
      });
      await writeFile(resolve(proofDir, `measurements-${width}.json`), JSON.stringify(dimensions, null, 2));
      expect(dimensions.overflow).toBeLessThanOrEqual(0);
      expect(dimensions.targets.length).toBeGreaterThan(0);
      for (const target of dimensions.targets) {
        expect(target.width, `${target.name} width`).toBeGreaterThanOrEqual(48);
        expect(target.height, `${target.name} height`).toBeGreaterThanOrEqual(48);
      }
      expect(dimensions.trackerText.length).toBeGreaterThan(0);
      for (const text of dimensions.trackerText) expect(text.fontSize, text.text).toBeGreaterThanOrEqual(13);
      expect(dimensions.chip).toBeGreaterThanOrEqual(24);
      expect(dimensions.ring).toBe(20);
      expect(dimensions.titleSize).toBe(28);
      const shot = { 1440: "desktop.png", 1280: "desktop-1280.png", 768: "tablet-768.png", 390: "narrow-reflow.png" }[width];
      if (shot) await page.screenshot({ path: resolve(proofDir, shot), fullPage: true });
      const openView = page.getByRole("group", { name: "View" }).getByRole("button", { name: "Open" });
      await openView.focus(); await page.keyboard.press("Enter");
      expect(await openView.getAttribute("aria-pressed")).toBe("true");
      const allFilter = page.getByRole("group", { name: "Filter" }).getByRole("button", { name: /All ?30/ });
      await allFilter.focus(); await page.keyboard.press("Space");
      expect(await allFilter.getAttribute("aria-pressed")).toBe("true");
      const next = page.getByRole("button", { name: "Next" });
      await next.focus(); await page.keyboard.press("Enter");
      expect(await page.getByRole("button", { name: "Page 2" }).getAttribute("aria-current")).toBe("page");
      expect(await next.evaluate((element) => document.activeElement === element)).toBe(true);
      await page.close();
    }, 30000);
  }
});
