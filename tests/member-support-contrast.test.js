// @vitest-environment node
import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("keeps scenario descriptions readable in default, hover, focus and selected states", async () => {
  const css = (await Promise.all(["../src/sg-tokens.css", "../src/styles.css", "../src/coordinator-theme.css", "../src/motion.css", "../src/features/memberSupport/member-support.css"].map(path => readFile(new URL(path, import.meta.url), "utf8")))).join("\n");
  const browser = await chromium.launch({ headless: true });
  try {
    for (const theme of ["union-ground"]) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.setContent(`<main class="sg-app" data-workspace-theme="${theme}"><button class="member-support-choice" aria-pressed="false"><strong>Disciplinary meeting</strong><span>Ask whether it could lead to discipline and ask for a coworker to be present.</span></button></main>`);
      await page.addStyleTag({ content: css });
      await page.mouse.move(389, 843);
      const button = page.locator("button");
      for (const state of ["default", "hover", "focus", "selected"]) {
        if (state === "hover") await button.hover();
        if (state === "focus") { await page.mouse.move(389, 843); await page.keyboard.press("Tab"); await button.focus(); }
        if (state === "selected") await button.evaluate(node => node.setAttribute("aria-pressed", "true"));
        await button.evaluate(node => Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished)));
        const ratio = await button.locator("span").evaluate(node => {
          const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          const rgb = value => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
          const luminance = color => rgb(color).map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((sum, x, i) => sum + x * [.2126, .7152, .0722][i], 0);
          const fg = luminance(getComputedStyle(node).color), bg = luminance(getComputedStyle(node.parentElement).backgroundColor);
          return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
        });
        expect(ratio, `${theme}/${state}`).toBeGreaterThanOrEqual(4.5);
      }
      await page.close();
    }
  } finally { await browser.close(); }
});
