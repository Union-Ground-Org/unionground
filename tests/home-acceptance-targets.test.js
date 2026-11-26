// @vitest-environment node
import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { ScreenHeader } from "../src/components/Primitives.jsx";

it("keeps the phone President title clear of actions when the shared top bar hides its avatar", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  // Rendered from the real ScreenHeader component (not a hand-typed fixture)
  // so a class rename or markup restructuring in Primitives.jsx breaks this
  // proof the same day it ships, instead of leaving it silently stale.
  const headerHtml = renderToStaticMarkup(createElement(
    LanguageProvider,
    { lang: "en" },
    createElement(ScreenHeader, {
      initials: "TM",
      eyebrow: "Chapter leadership",
      title: "Leadership overview",
      compact: true,
      onAssistant: () => {},
    }),
  ));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`<div class="sg-app"><div class="mobile-top"></div><main>${headerHtml}<section class="campaigns-screen"><header class="phead"><h1>Weekly pool</h1></header></section></main></div>`);
    await page.addStyleTag({ content: css });
    const title = await page.locator('.screen-header__copy').boundingBox();
    const actions = await page.locator('.screen-header__actions').boundingBox();
    expect(title.width).toBeGreaterThan(200);
    expect(title.x + title.width).toBeLessThanOrEqual(actions.x);
    expect(await page.locator('.campaigns-screen h1').isVisible()).toBe(true);
  } finally { await browser.close(); }
});

it("keeps Home chips, the phone hat chooser and Coordinator header actions at least 44 pixels tall with the shipped styles", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [390, 1440]) for (const theme of ["union-ground"]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.setContent(`<div class="sg-app" data-workspace-theme="${theme}">
        <div class="card-nav card-nav--at-home"><header class="card-nav__chrome"><label class="card-nav__hat"><select aria-label="Switch hat"><option>Member</option></select></label></header></div>
        <main style="padding-top:180px"><div class="home-chips"><button class="home-chip">Points</button><button class="home-chip home-chip--tier">Tier</button><button class="home-chip home-chip--dark">My role</button></div><button class="gq-hbtn" aria-label="Open Compass">✦</button></main></div>`);
      await page.addStyleTag({ content: css });
      const targets = page.locator("button.home-chip, .card-nav__hat select, .gq-hbtn");
      for (const target of await targets.all()) {
        if (!await target.isVisible()) continue;
        const rect = await target.boundingBox();
        expect(rect.height, `${width}/${theme} ${await target.textContent()}`).toBeGreaterThanOrEqual(44);
        expect(rect.width).toBeGreaterThanOrEqual(44);
        expect(await target.evaluate(node => { const r=node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.left+r.width/2,r.bottom-1)); })).toBe(true);
        if (await target.evaluate(node => node.tagName === "BUTTON")) {
          await target.hover();
          await page.mouse.down();
          await target.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
          expect((await target.boundingBox()).height, "pressed target").toBeGreaterThanOrEqual(44);
          await page.mouse.move(0, 899);
          await page.mouse.up();
        }
      }
      await page.close();
    }
  } finally { await browser.close(); }
});
