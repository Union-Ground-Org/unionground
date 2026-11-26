// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { readFile } from "node:fs/promises";

let browser;
const css = (await Promise.all(["sg-tokens.css", "styles.css", "coordinator-theme.css", "components/workspacePages.css"]
  .map(path => readFile(new URL(`../src/${path}`, import.meta.url), "utf8")))).join("\n");
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });

for (const theme of ["union-ground"]) {
  it.each([390, 1440])(`keeps routed and in-page coordinator tabs equivalent in ${theme} at %i px`, async (width) => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: "light" });
    try {
      await page.setContent(`<main class="sg-app" data-workspace-theme="${theme}"><section class="gq-screen" data-casework-theme="casefile-control"><div class="gq-views"><button type="button"><span class="gq-view__index">01</span>Queue<strong>0</strong></button><a href="#queue" class="workspace-routed-tab"><span class="gq-view__index">01</span>Queue<strong>0</strong></a></div></section></main>`);
      await page.addStyleTag({ content: css });
      await page.addStyleTag({ content: "*,*::before,*::after { transition: none !important; animation: none !important; }" });
      for (const state of ["default", "selected", "hover", "focus"]) {
        const measurements = [];
        for (const selector of ["button", "a"]) {
          const tab = page.locator(`.gq-views > ${selector}`);
          await page.mouse.move(width - 1, 899);
          await tab.evaluate(node => node.blur());
          await tab.evaluate((node, selected) => {
            const attribute = node.tagName === "A" ? "aria-current" : "aria-pressed";
            if (selected) node.setAttribute(attribute, node.tagName === "A" ? "page" : "true");
            else node.removeAttribute(attribute);
          }, state === "selected");
          if (state === "hover") await tab.hover();
          if (state === "focus") await tab.focus();
          measurements.push(await tab.evaluate(node => {
            const style = getComputedStyle(node);
            const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255)
              .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
              .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
            const foreground = luminance(getComputedStyle(node.querySelector(".gq-view__index")).color);
            const background = luminance(style.backgroundColor);
            const indexRatio = (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
            return { color: style.color, background: style.backgroundColor, border: style.borderBottomColor, indexRatio,
              index: getComputedStyle(node.querySelector(".gq-view__index")).color,
              count: getComputedStyle(node.querySelector("strong")).color,
              outline: style.outlineStyle, height: node.getBoundingClientRect().height };
          }));
        }
        expect(measurements[1], `${theme}/${width}/${state}`).toEqual(measurements[0]);
        expect(measurements[1].height).toBeGreaterThanOrEqual(44);
        expect(measurements[1].indexRatio, `${theme}/${width}/${state} index contrast`).toBeGreaterThanOrEqual(4.5);
        if (state === "focus") expect(measurements[1].outline).not.toBe("none");
      }
    } finally { await page.close(); }
  });
}
