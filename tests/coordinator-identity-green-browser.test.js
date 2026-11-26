// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";

// REQ-UG-WEB-IDENTITY-TOKENS-UNION-GREEN-20261103, gate round 2:
// src/coordinator-theme.css declares the --casework-* roles at :root, where
// var() resolves against the root ledger palette, so the identity's ledger
// restatements never reached the coordinator desk and its header stayed
// aubergine (#6b2d68); the dark form hard-coded Night Shift violet. The
// contrast audit resolves names through merged scopes and cannot see that
// :root trap, so this measures what a browser actually computes on the
// Casefile Control screen in each form of the identity. The header is a
// PageHeader, so its own .sg-page-header rules load too: they painted the
// header copy --ink on the command slab until the coordinator plane took it back.
let browser;
const css = (await Promise.all(["sg-tokens.css", "styles.css", "coordinator-theme.css", "components/pageHeader.css"]
  .map((path) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8")))).join("\n");
const hex = (value) => {
  const [r, g, b] = value.match(/\d+/g).slice(0, 3).map(Number);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
};
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });

const EXPECTED = {
  "union-ground": { header: "#0e4034", headerInk: "#ffffff", canvas: "#f4f2ec", ink: "#0a2f26", secondary: "#dce9e2", secondaryInk: "#0e4034" },
};

for (const [theme, expected] of Object.entries(EXPECTED)) {
  it(`paints the coordinator desk with the Union green roles under ${theme}`, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.setContent(`<!doctype html><html lang="en"><body>
        <main class="sg-app" data-workspace-theme="${theme}">
          <section class="gq-screen" data-casework-theme="casefile-control">
            <header class="phead sg-page-header"><div class="phead__copy"><span class="phead__eyebrow">Casefile control</span><h1 class="phead__title">Case queue</h1><p class="phead__sub">85 open</p></div><label class="gq-search"><input class="gq-search__input" aria-label="Search cases"></label><button type="button" class="gq-hbtn">Ask</button></header>
            <header class="gq-cases__head"><strong class="gq-cases__title">Action queue</strong><span class="gq-count">3</span></header>
          </section>
        </main></body></html>`);
      await page.addStyleTag({ content: css });
      // Header controls animate their colours; read the settled values.
      await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
      // Gate r3g1 on #6988: tab into the header search and read the ring and
      // the control edges the browser actually paints on the header.
      await page.focus(".gq-search__input");
      const read = await page.evaluate(() => {
        const screen = document.querySelector(".gq-screen");
        const head = getComputedStyle(screen.querySelector(".phead"));
        // The procedure board is left out of this edition; the queue's count
        // chip carries the same secondary role.
        const count = getComputedStyle(screen.querySelector(".gq-count"));
        const vars = getComputedStyle(screen);
        return {
          header: head.backgroundColor, headerInk: head.color,
          canvas: getComputedStyle(screen).backgroundColor, ink: getComputedStyle(screen).color,
          secondary: count.backgroundColor, secondaryInk: count.color,
          primary: vars.getPropertyValue("--casework-primary").trim(),
          eyebrow: getComputedStyle(screen.querySelector(".phead__eyebrow")).color,
          title: getComputedStyle(screen.querySelector(".phead__title")).color,
          sub: getComputedStyle(screen.querySelector(".phead__sub")).color,
          searchRing: getComputedStyle(screen.querySelector(".gq-search")).outlineColor,
          searchEdge: getComputedStyle(screen.querySelector(".gq-search")).borderTopColor,
          buttonEdge: getComputedStyle(screen.querySelector(".gq-hbtn")).borderTopColor,
        };
      });
      const rendered = Object.fromEntries(Object.entries(read).map(([key, value]) => [key, value.startsWith("#") ? value.toLowerCase() : hex(value)]));
      expect(rendered).toMatchObject(expected);
      if (theme === "union-ground") expect(rendered.primary).toBe("#0e4034");
      const lum = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
        .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
      for (const part of ["eyebrow", "title", "sub"]) {
        expect(ratio(rendered[part], rendered.header), `${theme} header ${part}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const part of ["searchRing", "searchEdge", "buttonEdge"]) {
        expect(ratio(rendered[part], rendered.header), `${theme} header ${part} ${rendered[part]} on ${rendered.header}`).toBeGreaterThanOrEqual(3);
      }
      // No aubergine (light) or Night Shift violet and navy (dark) survives.
      for (const retired of ["#6b2d68", "#43164b", "#2b1831", "#f7f2f7", "#ece2fb", "#8b78f6", "#0d1424", "#151f34", "#1d2a45", "#241f45", "#a594ff"]) {
        expect(Object.values(rendered), retired).not.toContain(retired);
      }
    } finally {
      await page.close();
    }
  }, 30000);
}
