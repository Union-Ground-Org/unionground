import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { expect, it } from "vitest";

it("keeps the root at the same origin when the crawl fallback becomes the app", async () => {
  const html = readFileSync("index.html", "utf8");
  const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 760 } });
    await page.setContent(`<style>${style}</style><div id="root"><main class="crawl-fallback"><h1>Union Ground</h1></main></div>`);
    const before = await page.locator("#root").boundingBox();
    await page.evaluate(() => { document.getElementById("root").innerHTML = '<main>Member Home</main>'; });
    const after = await page.locator("#root").boundingBox();
    expect(before.y).toBe(0);
    expect(after.y).toBe(before.y);
  } finally { await browser.close(); }
});
